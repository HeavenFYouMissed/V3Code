import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';
import type { Env } from '../src/env.js';

/*--------------------------------------------------------------------------------------
 *  Incremental-sync cost fix: a scored chunk that is re-uploaded UNCHANGED (same
 *  casKey) and already vectorized must NOT be re-embedded — its has_vector is
 *  preserved and no embed job is re-queued. A content change (new casKey) resets
 *  has_vector and re-queues. This is the #1 recurring cost/latency leak.
 *--------------------------------------------------------------------------------------*/

const typedEnv = env as unknown as Env;
async function doCall(wsId: string, path: string, body?: unknown) {
	const res = await typedEnv.WORKSPACE.get(typedEnv.WORKSPACE.idFromName(wsId)).fetch(`https://do${path}`, {
		method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
	});
	return res.json<any>().catch(() => undefined);
}
async function call(base: string, path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${base}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}
function chunk(id: string, casKey: string, content: string): WireChunk {
	return {
		id, casKey, file: 'src/x.ts', startLine: 1, endLine: 4,
		kind: 'function', name: id, language: 'typescript', scored: true, content,
	};
}

describe('incremental sync: skip re-embed of unchanged chunks', () => {
	it('re-uploading an unchanged, already-vectorized chunk does not re-queue; a content change does', async () => {
		const WS = 'inc-ws';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');

		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/x.ts': 'h1' }, embedIdentity: 'x' }, write);
		const sid = begin.body.syncId;

		// First upload: scored chunk → queued for embed.
		const up1 = await call(BASE, '/chunks', { syncId: sid, chunks: [chunk('c1', 'k1', 'function c1(){ return a; }')] }, write);
		expect(up1.body.queuedForEmbed).toBe(1);

		// Simulate the vector landing (what the queue consumer does after Vectorize).
		await doCall(WS, '/vector-done', { ids: ['c1'] });
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.vectors).toBe(1);

		// Re-upload IDENTICAL content (same casKey) → skipped: no re-queue, vector kept.
		const up2 = await call(BASE, '/chunks', { syncId: sid, chunks: [chunk('c1', 'k1', 'function c1(){ return a; }')] }, write);
		expect(up2.body.queuedForEmbed).toBe(0);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.vectors).toBe(1);

		// Re-upload CHANGED content (new casKey) → re-queued, has_vector reset.
		const up3 = await call(BASE, '/chunks', { syncId: sid, chunks: [chunk('c1', 'k2', 'function c1(){ return b + c; }')] }, write);
		expect(up3.body.queuedForEmbed).toBe(1);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.vectors).toBe(0);
	});

	it('a chunk that never vectorized is still re-embedded on re-upload (not falsely skipped)', async () => {
		const WS = 'inc-ws-2';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/x.ts': 'h1' }, embedIdentity: 'x' }, write);
		const sid = begin.body.syncId;

		const up1 = await call(BASE, '/chunks', { syncId: sid, chunks: [chunk('c2', 'k1', 'function c2(){}')] }, write);
		expect(up1.body.queuedForEmbed).toBe(1);
		// No vector-done — has_vector is still 0. Re-upload same casKey must re-queue.
		const up2 = await call(BASE, '/chunks', { syncId: sid, chunks: [chunk('c2', 'k1', 'function c2(){}')] }, write);
		expect(up2.body.queuedForEmbed).toBe(1);
	});
});
