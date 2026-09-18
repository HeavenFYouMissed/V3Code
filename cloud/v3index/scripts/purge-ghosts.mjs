/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// One-time ghost-vector purge for the shared Vectorize index.
//
// Ghosts = vector ids present in Vectorize but absent from every live
// workspace's SQLite chunks table. They accumulate from every pre-fix
// removeFile()/reset() (which deleted SQLite rows but never vectors) and from
// edit-orphaned chunk ids. This script diffs the index against live chunk ids
// and deletes the difference.
//
//   node scripts/purge-ghosts.mjs \
//     --base https://v3index.kevinbakon463.workers.dev \
//     --ws <workspaceId>:<writeToken> [--ws ...] \
//     [--index v3index-chunks] [--apply] [--limit N] [--all-workspaces-listed]
//
// Dry-run by default: prints counts only. --apply deletes.
//
// SAFETY MODEL — the index is shared by ALL workspaces:
//   * If the list API returns a namespace per id, only ids in the namespaces you
//     passed via --ws are ever considered; unknown-namespace ids are reported
//     and left untouched.
//   * If it does NOT return namespaces, a ghost can only be computed as
//     "id not live in ANY passed workspace" — correct ONLY when every live
//     workspace is passed. --apply then additionally requires
//     --all-workspaces-listed as an explicit attestation.
//
// Auth: uses the REST API when CLOUDFLARE_API_TOKEN is set (fast); otherwise
// shells out to `npx wrangler` (works with `wrangler login` OAuth, slower).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ACCOUNT_ID = 'ccc21ee52b1ee0531162c3b2215e2f85'; // wrangler.jsonc account_id
const WORKER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIST_PAGE = 1000;   // list-vectors max per call
const DELETE_BATCH = 100; // delete_by_ids hard cap ("max id count is 100", code 40007)

const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }
function opt(name, fallback) {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
function optAll(name) {
	const out = [];
	for (let i = 0; i < args.length - 1; i++) if (args[i] === `--${name}`) out.push(args[i + 1]);
	return out;
}

const BASE = opt('base', 'https://v3index.kevinbakon463.workers.dev').replace(/\/+$/, '');
const INDEX = opt('index', 'v3index-chunks');
const APPLY = flag('apply');
const LIMIT = Number(opt('limit', '0')) || 0; // 0 = no cap
const ALL_WS_LISTED = flag('all-workspaces-listed');
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const wsSpecs = optAll('ws').map(spec => {
	const sep = spec.indexOf(':');
	if (sep <= 0) { console.error(`bad --ws value (want <workspaceId>:<writeToken>): ${spec}`); process.exit(1); }
	return { id: spec.slice(0, sep), token: spec.slice(sep + 1) };
});
if (wsSpecs.length === 0) {
	console.error('usage: node scripts/purge-ghosts.mjs --base <url> --ws <wsId>:<writeToken> [--ws ...] [--apply] [--limit N] [--all-workspaces-listed]');
	process.exit(1);
}

// ---- live chunk ids per workspace (ground truth) ------------------------------
async function liveIdsFor(ws) {
	const ids = new Set();
	let afterId;
	for (;;) {
		const res = await fetch(`${BASE}/v1/ws/${ws.id}/debug/chunk-ids`, {
			method: 'POST',
			headers: { authorization: `Bearer ${ws.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ afterId, limit: 10000 }),
		});
		if (!res.ok) throw new Error(`/debug/chunk-ids ${ws.id} → ${res.status}: ${await res.text()}`);
		const page = await res.json();
		for (const id of page.ids) ids.add(id);
		if (page.done) break;
		afterId = page.lastId;
	}
	return ids;
}

// ---- Vectorize id enumeration (REST fast path, wrangler fallback) --------------
function parseListPage(data) {
	// Tolerate both the REST envelope ({result: {...}}) and wrangler --json output.
	// Documented shape: { vectors: [{id}], nextCursor, isTruncated, totalCount, count }.
	const body = data?.result ?? data;
	const rawVectors = body?.vectors ?? body?.ids ?? [];
	const vectors = rawVectors.map(v => typeof v === 'string' ? { id: v } : { id: v.id, namespace: v.namespace });
	const cursor = body?.nextCursor ?? body?.cursor ?? undefined;
	const truncated = body?.isTruncated;
	return { vectors, cursor: cursor || undefined, truncated, totalCount: body?.totalCount };
}

/** Fetch with bounded retries — a 520-page listing WILL hit transient API
 *  hiccups (observed live: a one-off "cursor appears to be corrupted" 400 that
 *  succeeded verbatim on retry). */
async function fetchJsonWithRetry(url, init, what) {
	let lastErr;
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
		try {
			const res = await fetch(url, init);
			if (!res.ok) { lastErr = new Error(`${what} → ${res.status}: ${await res.text()}`); continue; }
			return await res.json();
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

async function listAllVectorIds() {
	const all = [];
	let cursor;
	let pages = 0;
	for (;;) {
		let data;
		if (API_TOKEN) {
			// GET .../vectorize/v2/indexes/{name}/list — the documented list-vectors path.
			const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX}/list`);
			url.searchParams.set('count', String(LIST_PAGE));
			if (cursor) url.searchParams.set('cursor', cursor);
			data = await fetchJsonWithRetry(url, { headers: { authorization: `Bearer ${API_TOKEN}` } }, 'list_vectors');
		} else {
			const cmd = ['wrangler', 'vectorize', 'list-vectors', INDEX, '--json', '--count', String(LIST_PAGE)];
			if (cursor) cmd.push('--cursor', cursor);
			const run = spawnSync('npx', cmd, { cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
			if (run.status !== 0) throw new Error(`wrangler list-vectors failed: ${run.stderr || run.stdout}`);
			const jsonStart = run.stdout.indexOf('{');
			const jsonArr = run.stdout.indexOf('[');
			const start = jsonArr >= 0 && (jsonArr < jsonStart || jsonStart < 0) ? jsonArr : jsonStart;
			if (start < 0) throw new Error(`wrangler list-vectors: no JSON in output:\n${run.stdout.slice(0, 500)}`);
			data = JSON.parse(run.stdout.slice(start));
		}
		const page = parseListPage(data);
		all.push(...page.vectors);
		pages++;
		if (pages % 25 === 0) console.log(`  …listed ${all.length} ids (${pages} pages${page.totalCount ? ` of ~${page.totalCount} total` : ''})`);
		if (page.truncated === false || !page.cursor || page.vectors.length === 0) break;
		cursor = page.cursor;
	}
	return all;
}

async function deleteIds(ids) {
	if (API_TOKEN) {
		const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX}/delete_by_ids`;
		await fetchJsonWithRetry(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
			body: JSON.stringify({ ids }),
		}, 'delete_by_ids');
		return;
	}
	const run = spawnSync('npx', ['wrangler', 'vectorize', 'delete-vectors', INDEX, '--ids', ...ids], {
		cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
	});
	if (run.status !== 0) throw new Error(`wrangler delete-vectors failed: ${run.stderr || run.stdout}`);
}

// ---- main ----------------------------------------------------------------------
console.log(`index: ${INDEX} · base: ${BASE} · auth: ${API_TOKEN ? 'REST token' : 'wrangler (OAuth)'} · mode: ${APPLY ? 'APPLY' : 'dry-run'}`);

// ORDER MATTERS: enumerate Vectorize FIRST, live SQLite ids SECOND. A chunk
// ingested+embedded during the (minutes-long) listing is then either absent
// from the older listing or present in the newer live set — never a false
// ghost. The reverse order deleted vectors embedded mid-run (review finding);
// this order at worst MISSES a ghost, which the DO's own flush handles.
console.log('listing Vectorize ids…');
const indexVectors = await listAllVectorIds();

const live = new Map(); // wsId → Set of live chunk ids
for (const ws of wsSpecs) {
	live.set(ws.id, await liveIdsFor(ws));
	console.log(`live ids: ${ws.id} → ${live.get(ws.id).size}`);
}
const liveUnion = new Set();
for (const s of live.values()) for (const id of s) liveUnion.add(id);
const hasNamespaces = indexVectors.some(v => v.namespace !== undefined);
console.log(`index ids: ${indexVectors.length} · namespaces in list output: ${hasNamespaces ? 'yes' : 'NO'}`);

let ghosts = [];
let unknownNs = 0;
let liveMatched = 0;
if (hasNamespaces) {
	for (const v of indexVectors) {
		const wsLive = live.get(v.namespace);
		if (wsLive === undefined) { unknownNs++; continue; } // not our tenant — untouched
		if (wsLive.has(v.id)) liveMatched++;
		else ghosts.push(v.id);
	}
} else {
	for (const v of indexVectors) {
		if (liveUnion.has(v.id)) liveMatched++;
		else ghosts.push(v.id);
	}
}

console.log('---');
console.log(`live SQLite ids (union): ${liveUnion.size}`);
console.log(`matched live in index:   ${liveMatched}`);
console.log(`unknown-namespace ids:   ${unknownNs} (left untouched)`);
console.log(`GHOSTS to delete:        ${ghosts.length}${LIMIT ? ` (capped to ${LIMIT} by --limit)` : ''}`);
if (LIMIT) ghosts = ghosts.slice(0, LIMIT);

if (!APPLY) {
	console.log('dry-run: nothing deleted. Re-run with --apply to purge.');
	process.exit(0);
}
if (!hasNamespaces && !ALL_WS_LISTED) {
	console.error('REFUSING to apply: list output has no namespaces, so "ghost" can only mean');
	console.error('"not live in any PASSED workspace". If any live workspace was not passed via');
	console.error('--ws, its vectors would be destroyed. Pass --all-workspaces-listed to attest');
	console.error('that every live workspace is included.');
	process.exit(1);
}

let deleted = 0;
for (let i = 0; i < ghosts.length; i += DELETE_BATCH) {
	const batch = ghosts.slice(i, i + DELETE_BATCH);
	await deleteIds(batch);
	deleted += batch.length;
	if ((i / DELETE_BATCH) % 20 === 0 || deleted === ghosts.length) {
		console.log(`  deleted ${deleted}/${ghosts.length}`);
	}
}
console.log(`PURGE DONE: ${deleted} ghost vectors deleted. Vectorize mutations apply asynchronously —`);
console.log('`wrangler vectorize info` counts converge within a few minutes; re-run this script');
console.log('as a dry-run afterwards to confirm 0 ghosts.');
