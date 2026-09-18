/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// One-time migration: re-key existing Vectorize vectors from bare chunk ids to
// workspace-salted ids (`${namespace}:${id}`) — the scheme the deployed worker
// now writes. NO re-embedding: values are fetched from the index and re-upserted
// unchanged. Idempotent + resumable: already-salted ids (containing ':') are
// skipped, so re-running finishes whatever a previous run left.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/migrate-vector-ids.mjs [--apply] [--index v3index-chunks] [--limit N]
//
// Dry-run by default (counts unsalted vectors). --apply migrates.
//
// Per batch: get_by_ids (fetch values+namespace+metadata) → upsert under the
// salted id → deleteByIds the bare id. Upsert-BEFORE-delete: a mid-batch failure
// leaves BOTH the salted and bare vector (a harmless dup — namespace-filtered
// queries dedupe by stripped id in the DO), never a gap. Safe to run while the
// editor syncs: a concurrently re-embedded chunk is already written salted, and
// its bare copy (if any) is just another unsalted id this migration will re-key.

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCOUNT_ID) { console.error('set CLOUDFLARE_ACCOUNT_ID'); process.exit(1); }
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes`;
const LIST_PAGE = 1000;
const ACCUM = 100;        // ids accumulated per migrateBatch (drives upsert/delete calls)
const GET_BATCH = 20;     // ids per get_by_ids (hard cap, code 40007)
const UPSERT_BATCH = 100; // vectors per upsert (values are 1024 floats — keep modest)
const DELETE_BATCH = 100; // deleteByIds hard cap

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const idx = i => args.indexOf(i) >= 0 && args[args.indexOf(i) + 1];
const INDEX = idx('--index') || 'v3index-chunks';
const LIMIT = Number(idx('--limit') || '0') || 0;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('set CLOUDFLARE_API_TOKEN'); process.exit(1); }

const isSalted = id => id.includes(':'); // wsId + hex chunk id — neither contains ':'

async function api(path, init, what) {
	let lastErr;
	for (let attempt = 0; attempt < 5; attempt++) {
		if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
		try {
			const res = await fetch(`${API}/${INDEX}/${path}`, {
				...init,
				headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers || {}) },
			});
			const j = await res.json();
			if (!res.ok || j.success === false) { lastErr = new Error(`${what} → ${res.status}: ${JSON.stringify(j.errors ?? j).slice(0, 200)}`); continue; }
			return j.result ?? j;
		} catch (err) { lastErr = err; }
	}
	throw lastErr;
}

async function* listBareIds() {
	let cursor;
	let pages = 0;
	for (;;) {
		const q = new URLSearchParams({ count: String(LIST_PAGE) });
		if (cursor) q.set('cursor', cursor);
		const r = await api(`list?${q}`, { method: 'GET' }, 'list');
		pages++;
		for (const v of r.vectors ?? []) if (!isSalted(v.id)) yield v.id;
		if (pages % 25 === 0) console.log(`  …scanned ${pages} pages (~${pages * LIST_PAGE} ids), ${r.totalCount ?? '?'} total`);
		if (r.isTruncated === false || !r.nextCursor) break;
		cursor = r.nextCursor;
	}
}

function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function migrateBatch(ids) {
	// Fetch full vectors (values + namespace + metadata), get_by_ids capped at 20 —
	// the sub-fetches are independent, so run them in parallel.
	const gots = await Promise.all(chunk(ids, GET_BATCH).map(g =>
		api('get_by_ids', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: g }) }, 'get_by_ids')));
	const vectors = [];
	for (const got of gots) {
		for (const v of (Array.isArray(got) ? got : got.vectors ?? [])) {
			if (v && Array.isArray(v.values) && v.namespace) vectors.push(v);
		}
	}
	if (vectors.length === 0) return 0;
	// Upsert under the salted id FIRST (so a failure before delete leaves a dup, not a gap).
	const salted = vectors.map(v => ({ id: `${v.namespace}:${v.id}`, values: v.values, namespace: v.namespace, metadata: v.metadata }));
	for (const g of chunk(salted, UPSERT_BATCH)) {
		await api('upsert', { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: g.map(v => JSON.stringify(v)).join('\n') }, 'upsert');
	}
	// Then delete the bare originals.
	for (const g of chunk(vectors.map(v => v.id), DELETE_BATCH)) {
		await api('delete_by_ids', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: g }) }, 'delete_by_ids');
	}
	return vectors.length;
}

const CONCURRENCY = 6; // batches in flight; retry/backoff self-throttles if the API rate-limits

console.log(`index: ${INDEX} · mode: ${APPLY ? 'APPLY' : 'dry-run'}${LIMIT ? ` · limit ${LIMIT}` : ''} · concurrency ${CONCURRENCY}`);
console.log('scanning for bare (unsalted) vector ids…');

const bare = [];
for await (const id of listBareIds()) {
	bare.push(id);
	if (LIMIT && bare.length >= LIMIT) break;
}
console.log(`bare (unsalted) vectors found: ${bare.length}${LIMIT ? ` (capped at --limit ${LIMIT})` : ''}`);

if (!APPLY) {
	console.log('dry-run: nothing changed. Re-run with --apply to migrate.');
	process.exit(0);
}

// Process ACCUM-sized batches through a fixed worker pool.
const batches = chunk(bare, ACCUM);
let migrated = 0, doneBatches = 0, next = 0;
async function worker() {
	while (next < batches.length) {
		const my = batches[next++];
		migrated += await migrateBatch(my);
		doneBatches++;
		if (doneBatches % 20 === 0) console.log(`  migrated ${migrated} (${doneBatches}/${batches.length} batches)`);
	}
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`MIGRATION DONE: ${migrated} vectors re-keyed to salted ids. Mutations apply asynchronously;`);
console.log('re-run as a dry-run in a few minutes to confirm 0 bare ids remain.');
