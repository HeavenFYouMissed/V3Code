import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';
import type { Env } from '../src/env.js';

/*--------------------------------------------------------------------------------------
 *  P1 embed-failure recovery + sync safety.
 *    #5/#6 — abandoned embed jobs are marked embed_failed (visible in /status)
 *            instead of vanishing; the flag clears on vectorDone / requeue; the
 *            backstop keeps recovery text (only redundant/7d-abandoned rows go).
 *    #7   — syncBegin stages removals and only prunes at /chunks {done:true};
 *            an empty manifest against a populated index is rejected.
 *  /embed-failed and /vector-done are DO-internal (queue-consumer only), so they
 *  are exercised via a direct stub like the real consumer does, not SELF.fetch.
 *--------------------------------------------------------------------------------------*/

const typedEnv = env as unknown as Env;
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
		id, casKey: `cas-${id}`, file: 'src/svc.ts', startLine: 1, endLine: 8,
		kind: 'function', name: id, language: 'typescript', scored: true,
		content: `export function ${id}() { return run(${id}); }`,
		...over,
	};
}

describe('embed-failure observability (P1 #5/#6)', () => {
	it('marks abandoned chunks embed_failed → /status surfaces them; vectorDone clears it', async () => {
		const WS = 'rel-fail-1';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/svc.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: begin.body.syncId, chunks: [chunk('stuck')], fileHashes: { 'src/svc.ts': 'h1' }, done: true }, write);

		// The DLQ consumer marks the abandoned id (simulated here via the internal route).
		const marked = await doCall(WS, '/embed-failed', { ids: ['stuck'] });
		expect(marked.body.marked).toBe(1);
		const s1 = await call(BASE, '/status', undefined, read, 'GET');
		expect(s1.body.embedFailed).toBe(1);

		// Vector eventually lands (e.g. via /requeue) → flag clears, coverage counts it.
		await doCall(WS, '/vector-done', { ids: ['stuck'] });
		const s2 = await call(BASE, '/status', undefined, read, 'GET');
		expect(s2.body.embedFailed).toBe(0);
		expect(s2.body.vectors).toBe(1);
	});

	it('/embed-failed no-ops on an already-embedded id (has_vector guard blocks mis-marking on redelivery)', async () => {
		const WS = 'rel-fail-2';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/svc.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: begin.body.syncId, chunks: [chunk('done1')], fileHashes: { 'src/svc.ts': 'h1' }, done: true }, write);

		await doCall(WS, '/vector-done', { ids: ['done1'] }); // succeeded
		const marked = await doCall(WS, '/embed-failed', { ids: ['done1'] }); // stale DLQ redelivery
		expect(marked.body.marked).toBe(0);
		const s = await call(BASE, '/status', undefined, read, 'GET');
		expect(s.body.embedFailed).toBe(0);
	});

	it('requeue clears embed_failed on the ids it re-drives', async () => {
		const WS = 'rel-fail-3';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/svc.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: begin.body.syncId, chunks: [chunk('reqtest')], fileHashes: { 'src/svc.ts': 'h1' }, done: true }, write);

		await doCall(WS, '/embed-failed', { ids: ['reqtest'] });
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.embedFailed).toBe(1);

		const rq = await call(BASE, '/requeue', {}, write);
		expect(rq.body.requeued).toBeGreaterThanOrEqual(1);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.embedFailed).toBe(0);
	});

	it('re-uploading an abandoned chunk with new content clears embed_failed (back in flight)', async () => {
		const WS = 'rel-fail-4';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const b1 = await call(BASE, '/sync/begin', { files: { 'src/svc.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: b1.body.syncId, chunks: [chunk('reup')], fileHashes: { 'src/svc.ts': 'h1' }, done: true }, write);
		await doCall(WS, '/embed-failed', { ids: ['reup'] });
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.embedFailed).toBe(1);

		// New content for the same id → fresh embed job; the abandoned flag must reset.
		const b2 = await call(BASE, '/sync/begin', { files: { 'src/svc.ts': 'h2' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b2.body.syncId,
			chunks: [chunk('reup', { casKey: 'cas-reup2', content: 'export function reup() { return run(reup, reup); }' })],
			fileHashes: { 'src/svc.ts': 'h2' }, done: true,
		}, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.embedFailed).toBe(0);
	});
});

describe('sync safety: deferred prune + manifest guard (P1 #7)', () => {
	const files = { 'src/a.ts': 'ha', 'src/b.ts': 'hb' } as Record<string, string>;
	async function seed(WS: string, write: string) {
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [chunk('ca', { file: 'src/a.ts' }), chunk('cb', { file: 'src/b.ts' })],
			fileHashes: files, done: true,
		}, write);
		return BASE;
	}

	it('does not prune a dropped file until the sync is finalized with done:true', async () => {
		const WS = 'rel-prune-1';
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		const BASE = await seed(WS, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.chunks).toBe(2);

		// New sync drops src/b.ts. Removal is reported but NOT yet applied.
		const begin2 = await call(BASE, '/sync/begin', { files: { 'src/a.ts': 'ha' }, embedIdentity: 'x' }, write);
		expect(begin2.body.removedFiles).toEqual(['src/b.ts']);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.chunks).toBe(2); // still there

		// Finalizing the sync applies the staged removal.
		const fin = await call(BASE, '/chunks', { syncId: begin2.body.syncId, chunks: [], fileHashes: {}, done: true }, write);
		expect(fin.body.removed).toBe(1);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.chunks).toBe(1);
	});

	it('an abandoned sync (never done) leaves the staged removal unapplied', async () => {
		const WS = 'rel-prune-2';
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		const BASE = await seed(WS, write);

		// Sync that would drop b, but the client never finalizes it; a fresh sync
		// with the full manifest supersedes it — b must survive.
		await call(BASE, '/sync/begin', { files: { 'src/a.ts': 'ha' }, embedIdentity: 'x' }, write);
		await call(BASE, '/sync/begin', { files, embedIdentity: 'x' }, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.chunks).toBe(2);
	});

	it('rejects an empty manifest against a populated index and leaves it intact', async () => {
		const WS = 'rel-prune-3';
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		const BASE = await seed(WS, write);

		const bad = await call(BASE, '/sync/begin', { files: {}, embedIdentity: 'x' }, write);
		expect(bad.status).toBe(500);
		expect(JSON.stringify(bad.body)).toMatch(/empty manifest/);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.chunks).toBe(2); // nothing pruned
	});

	it('allows an empty manifest on a fresh (empty) index', async () => {
		const WS = 'rel-prune-4';
		const write = await deriveToken('test-master-secret', WS, 'write');
		await call(`https://v3index.test/v1/ws/${WS}`, '/init', { privacyMode: 'full' }, write);
		const ok = await call(`https://v3index.test/v1/ws/${WS}`, '/sync/begin', { files: {}, embedIdentity: 'x' }, write);
		expect(ok.status).toBe(200);
		expect(ok.body.removedFiles).toEqual([]);
	});
});
