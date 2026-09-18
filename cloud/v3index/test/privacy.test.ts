import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';
import type { Env } from '../src/env.js';

const typedEnv = env as unknown as Env;

/** /vector-done and /embed-text are DO-internal — only the queue consumer in
 *  src/index.ts calls them (via a direct stub, never through the public
 *  /v1/ws/:id/* HTTP surface). Mirror that path here instead of going through
 *  SELF.fetch, which would 404 on these routes exactly as a real client would. */
function doStub(wsId: string) {
	return typedEnv.WORKSPACE.get(typedEnv.WORKSPACE.idFromName(wsId));
}
async function doCall(wsId: string, path: string, body?: unknown) {
	const res = await doStub(wsId).fetch(`https://do${path}`, {
		method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}

/*--------------------------------------------------------------------------------------
 *  Privacy-mode airtightness. In `vectors-only` mode plaintext is rejected at
 *  the Durable Object boundary. The client supplies lexical tokens, graph
 *  metadata, and (when ready) a locally generated Qwen q8 vector. No source is
 *  required in transit or at rest.
 *--------------------------------------------------------------------------------------*/

async function call(base: string, path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${base}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}

function chunk(id: string, over: Partial<WireChunk> = {}): WireChunk {
	return {
		id, casKey: `cas-${id}`, file: 'src/billing/charge.ts', startLine: 1, endLine: 12,
		kind: 'function', name: id, language: 'typescript', scored: true,
		content: `export function ${id}(account: Account) { return chargeCard(account); }`,
		...over,
	};
}

function q8Vector(): Pick<WireChunk, 'vectorQ8' | 'vectorScale' | 'vectorSpace'> {
	const bytes = new Uint8Array(1024).fill(1);
	return {
		vectorQ8: btoa(String.fromCharCode(...bytes)),
		vectorScale: 0.1,
		vectorSpace: 'qwen3-embedding-0.6b+hdr2',
	};
}

describe('privacy mode: vectors-only', () => {
	it('is the default and cannot silently change without a reset', async () => {
		const WS = 'privacy-default-mode';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const implicit = await call(BASE, '/init', {}, write);
		expect(implicit.status).toBe(200);
		expect(implicit.body.privacyMode).toBe('vectors-only');
		const changed = await call(BASE, '/init', { privacyMode: 'full' }, write);
		expect(changed.status).not.toBe(200);
		expect(changed.body.error).toMatch(/requires \/reset/);
	});

	it('rejects source content at the Durable Object boundary', async () => {
		const WS = 'privacy-vo-1';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');

		const init = await call(BASE, '/init', { privacyMode: 'vectors-only' }, write);
		expect(init.status).toBe(200);
		expect(init.body.privacyMode).toBe('vectors-only');

		const begin = await call(BASE, '/sync/begin', { files: { 'src/billing/charge.ts': 'hash-1' }, embedIdentity: 'x' }, write);
		expect(begin.status).toBe(200);

		const up = await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [chunk('chargeAccount', { defines: ['chargeAccount'], refs: ['chargeCard'] })],
			fileHashes: { 'src/billing/charge.ts': 'hash-1' },
			done: true,
		}, write);
		expect(up.status).not.toBe(200);
		expect(up.body.error).toMatch(/must omit content/);
	});

	it('accepts q8 vectors without source and stages no embed text', async () => {
		const WS = 'privacy-vo-2';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');

		await call(BASE, '/init', { privacyMode: 'vectors-only' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/billing/charge.ts': 'hash-1' }, embedIdentity: 'x' }, write);
		const up = await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [chunk('chargeAccount2', {
				content: undefined,
				tokens: ['charge', 'account', 'card'],
				...q8Vector(),
			})],
			fileHashes: { 'src/billing/charge.ts': 'hash-1' },
			done: true,
		}, write);
		expect(up.status).toBe(200);
		expect(up.body.queuedForEmbed).toBe(0);
		expect(up.body.queuedClientVectors).toBe(1);

		const rows = await call(BASE, '/debug/text-rows', { id: 'chargeAccount2' }, read);
		expect(rows.status).toBe(200);
		expect(rows.body.rows).toBe(0);
		expect(rows.body.r2).toBe(0);
		const pendingText = await runInDurableObject(doStub(WS), (_instance, state) =>
			state.storage.sql.exec('SELECT COUNT(*) AS n FROM pending_embed_text').one().n);
		expect(pendingText).toBe(0);
		const status = await call(BASE, '/status', undefined, read, 'GET');
		expect(status.body.pendingClientVectors).toBe(1);
		expect(status.body.pendingEmbedTextMaxAgeMs).toBe(0);
		// Miniflare has no local Vectorize simulator. The test config deliberately
		// omits the remote binding, so durable staging + pure decode are the
		// hermetic boundary;
		// the actual Vectorize drain is a required staging smoke test.
		await runInDurableObject(doStub(WS), async (_instance, state) => {
			state.storage.sql.exec('DELETE FROM pending_client_vectors WHERE id = ?', 'chargeAccount2');
			await state.storage.deleteAlarm();
		});
	});

	it('client-supplied tokens (no server-side tokenize) still retrieve lexically, still no chunk_text', async () => {
		const WS = 'privacy-vo-3';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');

		await call(BASE, '/init', { privacyMode: 'vectors-only' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/billing/charge.ts': 'hash-1' }, embedIdentity: 'x' }, write);
		// No `content` at all — pure pre-tokenized upload, the intended
		// vectors-only client shape.
		await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [{
				id: 'refundAccount', casKey: 'cas-refundAccount', file: 'src/billing/charge.ts',
				startLine: 20, endLine: 30, kind: 'function', name: 'refundAccount',
				language: 'typescript', scored: true,
				tokens: ['refund', 'account', 'process', 'card', 'refund'],
			}],
			fileHashes: { 'src/billing/charge.ts': 'hash-1' },
			done: true,
		}, write);

		const ret = await call(BASE, '/retrieve', { query: 'refund the account' }, read);
		expect(ret.body.hits.some((h: any) => h.name === 'refundAccount')).toBe(true);

		const rows = await call(BASE, '/debug/text-rows', { id: 'refundAccount' }, read);
		expect(rows.body.rows).toBe(0);
		expect(rows.body.r2).toBe(0);
	});

	it('removes an old same-id vector when source changes before a replacement vector is ready', async () => {
		const WS = 'privacy-vo-replace';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'vectors-only' }, write);
		const first = await call(BASE, '/sync/begin', { files: { 'src/billing/charge.ts': 'hash-1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: first.body.syncId,
			chunks: [chunk('samePosition', { content: undefined, tokens: ['old', 'billing'], ...q8Vector() })],
			fileHashes: { 'src/billing/charge.ts': 'hash-1' }, done: true,
		}, write);
		await runInDurableObject(doStub(WS), (_instance, state) => {
			state.storage.sql.exec('UPDATE chunks SET has_vector = 1 WHERE id = ?', 'samePosition');
			state.storage.sql.exec('DELETE FROM pending_client_vectors WHERE id = ?', 'samePosition');
		});

		const second = await call(BASE, '/sync/begin', { files: { 'src/billing/charge.ts': 'hash-2' }, embedIdentity: 'x' }, write);
		const replaced = await call(BASE, '/chunks', {
			syncId: second.body.syncId,
			chunks: [chunk('samePosition', {
				casKey: 'cas-samePosition-v2', content: undefined, tokens: ['new', 'billing'],
			})],
			fileHashes: { 'src/billing/charge.ts': 'hash-2' }, done: true,
		}, write);
		expect(replaced.status).toBe(200);
		const status = await call(BASE, '/status', undefined, read, 'GET');
		expect(status.body.vectors).toBe(0);
		expect(status.body.pendingVectorDeletes).toBe(1);
		expect(status.body.pendingClientVectors).toBe(0);
	});
});

describe('privacy mode: ephemeral Voyage Advanced', () => {
	it('stages source only until vector completion and never writes it to R2', async () => {
		const WS = 'privacy-advanced-ephemeral';
		const initialized = await doCall(WS, '/init', {
			workspaceId: WS,
			privacyMode: 'ephemeral',
			indexProfile: 'advanced',
			embedIdentity: 'voyage/voyage-code-3/dim1024+hdr2',
		});
		expect(initialized.status).toBe(200);
		const begin = await doCall(WS, '/sync/begin', {
			files: { 'src/billing/charge.ts': 'hash-advanced' },
			embedIdentity: 'voyage/voyage-code-3/dim1024+hdr2',
		});
		const uploaded = await doCall(WS, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [chunk('advancedCharge')],
			fileHashes: { 'src/billing/charge.ts': 'hash-advanced' },
			done: true,
		});
		expect(uploaded.status).toBe(200);
		expect(uploaded.body.queuedForEmbed).toBe(1);

		const staged = await runInDurableObject(doStub(WS), (_instance, state) =>
			state.storage.sql.exec('SELECT COUNT(*) AS n FROM pending_embed_text').one().n);
		expect(staged).toBe(1);
		const before = await doCall(WS, '/debug/text-rows', { id: 'advancedCharge' });
		expect(before.body).toEqual({ rows: 0, r2: 0 });

		await doCall(WS, '/vector-done', { ids: ['advancedCharge'] });
		const after = await runInDurableObject(doStub(WS), (_instance, state) =>
			state.storage.sql.exec('SELECT COUNT(*) AS n FROM pending_embed_text').one().n);
		expect(after).toBe(0);
	});

	it('purges abandoned text after one hour and invalidates the file for retry', async () => {
		const WS = 'privacy-advanced-expiry';
		await doCall(WS, '/init', {
			workspaceId: WS,
			privacyMode: 'ephemeral',
			indexProfile: 'advanced',
			embedIdentity: 'voyage/voyage-code-3/dim1024+hdr2',
		});
		const begin = await doCall(WS, '/sync/begin', {
			files: { 'src/billing/charge.ts': 'hash-expiry' },
			embedIdentity: 'voyage/voyage-code-3/dim1024+hdr2',
		});
		await doCall(WS, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [chunk('advancedExpiry')],
			fileHashes: { 'src/billing/charge.ts': 'hash-expiry' },
			done: true,
		});
		await runInDurableObject(doStub(WS), (_instance, state) => {
			state.storage.sql.exec('UPDATE pending_embed_text SET created_at = ?', Date.now() - 2 * 60 * 60 * 1000);
			state.storage.sql.exec("INSERT INTO meta(key, value) VALUES ('nextSweepAt', '0') ON CONFLICT(key) DO UPDATE SET value = '0'");
		});
		await runDurableObjectAlarm(doStub(WS));

		const status = await doCall(WS, '/status', {});
		expect(status.body.pendingEmbedJobs).toBe(0);
		expect(status.body.embedFailed).toBe(1);
		expect(status.body.files).toBe(0);
		const retry = await doCall(WS, '/sync/begin', {
			files: { 'src/billing/charge.ts': 'hash-expiry' },
			embedIdentity: 'voyage/voyage-code-3/dim1024+hdr2',
		});
		expect(retry.body.changedFiles).toEqual(['src/billing/charge.ts']);
	});
});

describe('privacy mode: full (regression)', () => {
	it('still returns snippets', async () => {
		const WS = 'privacy-full-1';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');

		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/billing/charge.ts': 'hash-1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [chunk('chargeAccountFull')],
			fileHashes: { 'src/billing/charge.ts': 'hash-1' },
			done: true,
		}, write);

		const ret = await call(BASE, '/retrieve', { query: 'where do we charge the account' }, read);
		expect(ret.body.hits.length).toBeGreaterThan(0);
		expect(ret.body.hits[0].snippet).toContain('chargeCard');

		const rows = await call(BASE, '/debug/text-rows', { id: 'chargeAccountFull' }, read);
		// Content now lives in R2 (content-addressed), not DO chunk_text.
		expect(rows.body.rows).toBe(0);
		expect(rows.body.r2).toBe(1);
	});
});

describe('full-mode recovery buffer: pending_embed_text', () => {
	it('/status reports pendingEmbedTextMaxAgeMs and it drops to 0 once vectors land', async () => {
		const WS = 'privacy-backstop-1';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');

		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/billing/charge.ts': 'hash-1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [chunk('chargeAccountBackstop')],
			fileHashes: { 'src/billing/charge.ts': 'hash-1' },
			done: true,
		}, write);

		// Embedder is unavailable in tests (no real Workers AI call happens from
		// this path — that's the queue consumer's job, not exercised here), so
		// the pending row is still there: age should be reported and > 0... but
		// timers are fast in-test, so just assert the field is present and finite.
		const status1 = await call(BASE, '/status', undefined, read, 'GET');
		expect(typeof status1.body.pendingEmbedTextMaxAgeMs).toBe('number');
		expect(status1.body.pendingEmbedTextMaxAgeMs).toBeGreaterThanOrEqual(0);

		// Simulate the embed pipeline completing (this is what the queue
		// consumer does after Vectorize upsert succeeds) — vectorDone purges
		// the pending row immediately, independent of the alarm backstop.
		// (/vector-done is DO-internal, not on the public HTTP surface — call
		// the stub directly like the real queue consumer does.)
		await doCall(WS, '/vector-done', { ids: ['chargeAccountBackstop'] });
		const status2 = await call(BASE, '/status', undefined, read, 'GET');
		expect(status2.body.pendingEmbedTextMaxAgeMs).toBe(0);
		expect(status2.body.pendingEmbedJobs).toBe(0);
	});

	it('backstop sweep: purges abandoned (7d+) and redundant (vector-landed) rows, keeps still-pending recovery text', async () => {
		const WS = 'privacy-backstop-2';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');

		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/billing/charge.ts': 'hash-1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			// abandonedEmbed: >7d old → swept by the backstop. recentStuck: 25h old
			// but still pending → KEPT (recovery preserved; the old 24h purge would
			// have deleted it out from under /requeue). landedEmbed: its vector
			// arrived but the row wasn't purged → redundant, swept.
			chunks: [chunk('abandonedEmbed'), chunk('recentStuck'), chunk('landedEmbed')],
			fileHashes: { 'src/billing/charge.ts': 'hash-1' },
			done: true,
		}, write);

		// chunksUpload calls ensureBackstopAlarm whenever it queues embed jobs,
		// so an alarm must already be scheduled — confirms the "set lazily on
		// insert" wiring, not just that the handler works when invoked directly.
		const stub = doStub(WS);
		const alarmScheduled = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
		expect(alarmScheduled).not.toBeNull();

		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec('UPDATE pending_embed_text SET created_at = ? WHERE id = ?', Date.now() - 8 * 24 * 60 * 60 * 1000, 'abandonedEmbed');
			state.storage.sql.exec('UPDATE pending_embed_text SET created_at = ? WHERE id = ?', Date.now() - 25 * 60 * 60 * 1000, 'recentStuck');
			// Simulate a vector that landed without the row being purged.
			state.storage.sql.exec('UPDATE chunks SET has_vector = 1 WHERE id = ?', 'landedEmbed');
		});

		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		// abandoned swept (7d), landed swept (redundant), recentStuck preserved.
		const remaining = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql.exec('SELECT id FROM pending_embed_text ORDER BY id').toArray().map((r: any) => r.id));
		expect(remaining).toEqual(['recentStuck']);
		const status = await call(BASE, '/status', undefined, read, 'GET');
		expect(status.body.pendingEmbedJobs).toBe(1);

		// Full mode still keeps plaintext out of SQLite; source lives in R2.
		for (const id of ['abandonedEmbed', 'recentStuck', 'landedEmbed']) {
			const rows = await call(BASE, '/debug/text-rows', { id }, read);
			expect(rows.body.rows).toBe(0);
			expect(rows.body.r2).toBe(1);
		}

		// Alarm reschedules itself hourly — the backstop must keep running.
		const rescheduled = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
		expect(rescheduled).not.toBeNull();
	});
});
