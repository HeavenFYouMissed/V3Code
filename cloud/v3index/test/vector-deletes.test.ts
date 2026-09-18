import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';
import type { Env } from '../src/env.js';

/*--------------------------------------------------------------------------------------
 *  Ghost-vector fix: removing a chunk row must also remove its Vectorize vector.
 *  The live failure this locks against: removeFile()/reset() deleted SQLite +
 *  FTS + edges but never touched Vectorize, so every pruned file (and every
 *  edit-orphaned chunk id) left its vector live forever in the SHARED index —
 *  ghosts crowded the per-namespace topK and collapsed RRF ranking, and the 5M
 *  platform-wide cap filled with garbage. Deletions are staged transactionally
 *  in pending_vector_deletes and flushed (bounded) by the alarm chain.
 *
 *  NOTE on coverage: Miniflare has no local Vectorize simulation, so the test
 *  config deliberately omits that binding and every env.VECTORS call fails.
 *  These tests
 *  cover the queue bookkeeping (staging, cancel-on-re-add, reset collection) and
 *  the OUTAGE path (a failing flush must neither crash the alarm chain nor drop
 *  queued rows). The happy-path "vector actually gone after flush" is verified
 *  against real Vectorize by the post-deploy smoke: /status pendingVectorDeletes
 *  draining to 0 proves deleteByIds succeeded (rows are cleared only on success).
 *--------------------------------------------------------------------------------------*/

const typedEnv = env as unknown as Env;

async function call(base: string, path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${base}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}
async function doCall(wsId: string, path: string, body?: unknown) {
	const res = await typedEnv.WORKSPACE.get(typedEnv.WORKSPACE.idFromName(wsId)).fetch(`https://do${path}`, {
		method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
	});
	return res.json<any>().catch(() => undefined);
}
function chunksFor(file: string, tag: string, n = 3): WireChunk[] {
	return Array.from({ length: n }, (_, k) => ({
		id: `${tag}-${k}`, casKey: `cas-${tag}-${k}`, file, startLine: k * 3 + 1, endLine: k * 3 + 3,
		kind: 'function', name: `fn_${tag}_${k}`, language: 'typescript', scored: true,
		content: `function fn_${tag}_${k}() { return '${tag}'; }`,
	}));
}

describe('vector deletes follow chunk removal', () => {
	it('pruning a file stages its vector deletions; a failing flush neither crashes the alarm nor drops them', async () => {
		const WS = 'vdel-ws';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		const keep = chunksFor('src/keep.ts', 'vdel-keep');
		const drop = chunksFor('src/drop.ts', 'vdel-drop');
		const begin = await call(BASE, '/sync/begin', { files: { 'src/keep.ts': 'hk', 'src/drop.ts': 'hd' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: begin.body.syncId, chunks: [...keep, ...drop],
			fileHashes: { 'src/keep.ts': 'hk', 'src/drop.ts': 'hd' }, done: true,
		}, write);
		await doCall(WS, '/vector-done', { ids: [...keep, ...drop].map(c => c.id) });

		// Drop one file via manifest diff → prune at done:true stages its ids for
		// vector deletion. The done-path only ARMS the alarm (flush stays off the
		// editor's critical path), so the deletions are owed but not yet issued.
		const begin2 = await call(BASE, '/sync/begin', { files: { 'src/keep.ts': 'hk' }, embedIdentity: 'x' }, write);
		expect(begin2.body.removedFiles).toEqual(['src/drop.ts']);
		await call(BASE, '/chunks', { syncId: begin2.body.syncId, chunks: [], fileHashes: { 'src/keep.ts': 'hk' }, done: true }, write);
		const mid = await call(BASE, '/status', undefined, read, 'GET');
		expect(mid.body.pendingVectorDeletes).toBe(drop.length);

		// Vectorize is deliberately absent from this hermetic harness,
		// so the flush FAILS — the alarm must survive (no crash-retry loop) and the
		// queued rows must remain for the next attempt. This is the outage path.
		const stub = typedEnv.WORKSPACE.get(typedEnv.WORKSPACE.idFromName(WS));
		await expect(runDurableObjectAlarm(stub)).resolves.toBeTruthy();
		const after = await call(BASE, '/status', undefined, read, 'GET');
		expect(after.body.pendingVectorDeletes).toBe(drop.length);

		// /prune/kick reports the failure instead of 500ing (the prune part of the
		// kick already committed) and keeps the rows queued.
		const kick = await call(BASE, '/prune/kick', {}, write);
		expect(kick.status).toBe(200);
		expect(kick.body.vectorDeletesRemaining).toBe(drop.length);
		expect(kick.body.vectorError).toBeTruthy();
	});

	it('re-adding a pruned file before the flush cancels its queued deletions (no hole punched)', async () => {
		const WS = 'vdel-ws-2';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		const file = chunksFor('src/flap.ts', 'vdel-flap');
		const ids = file.map(c => c.id);
		const b1 = await call(BASE, '/sync/begin', { files: { 'src/flap.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: b1.body.syncId, chunks: file, fileHashes: { 'src/flap.ts': 'h1' }, done: true }, write);
		await doCall(WS, '/vector-done', { ids });

		// Remove the file (stages deletions), then re-add it BEFORE any flush —
		// the flap a rename-and-back or a branch switch produces.
		const b2 = await call(BASE, '/sync/begin', { files: { 'src/other.ts': 'ho' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b2.body.syncId, chunks: chunksFor('src/other.ts', 'vdel-other', 1),
			fileHashes: { 'src/other.ts': 'ho' }, done: true,
		}, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.pendingVectorDeletes).toBe(ids.length);

		const b3 = await call(BASE, '/sync/begin', { files: { 'src/other.ts': 'ho', 'src/flap.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: b3.body.syncId, chunks: file, fileHashes: { 'src/flap.ts': 'h1' }, done: true }, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.pendingVectorDeletes).toBe(0);
	});

	it('/reset queues every live chunk id AND the already-staged delete backlog before wiping', async () => {
		const WS = 'vdel-ws-3';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		const keep = chunksFor('src/all.ts', 'vdel-reset', 5);
		const drop = chunksFor('src/gone.ts', 'vdel-reset-gone', 2);
		const b1 = await call(BASE, '/sync/begin', { files: { 'src/all.ts': 'h1', 'src/gone.ts': 'h2' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b1.body.syncId, chunks: [...keep, ...drop],
			fileHashes: { 'src/all.ts': 'h1', 'src/gone.ts': 'h2' }, done: true,
		}, write);
		await doCall(WS, '/vector-done', { ids: [...keep, ...drop].map(c => c.id) });

		// Stage a delete backlog first (prune src/gone.ts; the flush cannot run —
		// Vectorize is unreachable here — so the rows sit queued, exactly the
		// wedged-DO state reset is the recovery hatch for).
		const b2 = await call(BASE, '/sync/begin', { files: { 'src/all.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: b2.body.syncId, chunks: [], fileHashes: { 'src/all.ts': 'h1' }, done: true }, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.pendingVectorDeletes).toBe(drop.length);

		const reset = await call(BASE, '/reset', {}, write);
		expect(reset.body.reset).toBe(true);
		// Live chunks AND the staged backlog survive the wipe — deleteAll drops the
		// queue table, and the backlog's ids exist NOWHERE else (their chunk rows
		// are already gone), so losing them would leak permanent ghosts.
		expect(reset.body.vectorDeletesQueued).toBe(keep.length + drop.length);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.pendingVectorDeletes).toBe(keep.length + drop.length);
	});

	it('/vector-done for a pruned chunk queues the resurrected ghost for deletion', async () => {
		const WS = 'vdel-ws-5';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		const live = chunksFor('src/live.ts', 'vdel-race', 1);
		const b1 = await call(BASE, '/sync/begin', { files: { 'src/live.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: b1.body.syncId, chunks: live, fileHashes: { 'src/live.ts': 'h1' }, done: true }, write);

		// The race: a chunk is pruned while its embed job is in flight; the queue
		// consumer's upsert lands AFTER the prune and acks ids the DO no longer
		// has rows for. Those acks must stage deletions, not vanish silently.
		const done = await doCall(WS, '/vector-done', { ids: [live[0]!.id, 'pruned-in-flight-a', 'pruned-in-flight-b'] });
		expect(done.orphaned).toBe(2);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.pendingVectorDeletes).toBe(2);
		// The live chunk itself is untouched — vector flag set, nothing queued for it.
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.vectors).toBe(1);
	});

	it('/debug/chunk-ids pages through live ids (write scope only)', async () => {
		const WS = 'vdel-ws-4';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		const file = chunksFor('src/ids.ts', 'vdel-ids', 5);
		const b1 = await call(BASE, '/sync/begin', { files: { 'src/ids.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: b1.body.syncId, chunks: file, fileHashes: { 'src/ids.ts': 'h1' }, done: true }, write);

		// Read scope is refused (ids are opaque hashes but stay write-gated).
		expect((await call(BASE, '/debug/chunk-ids', {}, read)).status).toBe(401);

		const seen: string[] = [];
		let afterId: string | undefined;
		for (let i = 0; i < 10; i++) {
			const page = await call(BASE, '/debug/chunk-ids', { afterId, limit: 2 }, write);
			expect(page.status).toBe(200);
			seen.push(...page.body.ids);
			if (page.body.done) break;
			afterId = page.body.lastId;
		}
		expect(seen.sort()).toEqual(file.map(c => c.id).sort());
	});
});
