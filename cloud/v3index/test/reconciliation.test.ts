import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';

/*--------------------------------------------------------------------------------------
 *  Per-file chunk reconciliation. id = hash(file:start:end), so editing a file —
 *  deleting a function, or a line shift that relocates chunks — mints new ids and
 *  orphans the old ones. removeFile only fires for WHOLE-file removal (file absent
 *  from the manifest), so an edited-but-present file used to leak its departed
 *  chunk rows + live vectors forever. The client now sends the complete current
 *  id set per file (fileChunkIds); the server deletes the departed rows and queues
 *  their vectors. The id-aware /chunks/check is the other half: a relocated chunk
 *  (new id, same content) must NOT be skipped, or its new-id row never lands.
 *--------------------------------------------------------------------------------------*/

async function call(base: string, path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${base}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}
function chunk(id: string, casKey: string, file: string, startLine: number): WireChunk {
	return {
		id, casKey, file, startLine, endLine: startLine + 2, kind: 'function',
		name: id, language: 'typescript', scored: true, content: `function ${id.replace(/[^a-z0-9]/gi, '_')}() { return 1; }`,
	};
}

describe('per-file chunk reconciliation', () => {
	it('drops a file\'s departed chunks (deleted function) and queues their vectors, keeping the survivors', async () => {
		const WS = 'recon-ws';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		const file = 'src/a.ts';
		const b1 = await call(BASE, '/sync/begin', { files: { [file]: 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b1.body.syncId,
			chunks: [chunk('a1', 'k1', file, 1), chunk('a2', 'k2', file, 4), chunk('a3', 'k3', file, 7)],
			fileHashes: { [file]: 'h1' }, fileChunkIds: { [file]: ['a1', 'a2', 'a3'] }, done: true,
		}, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.chunks).toBe(3);

		// Edit: a3's function is deleted; a1/a2 unchanged. Client re-syncs the file
		// with the new complete id set {a1, a2}. a3 must be removed + its vector queued.
		const b2 = await call(BASE, '/sync/begin', { files: { [file]: 'h2' }, embedIdentity: 'x' }, write);
		const up = await call(BASE, '/chunks', {
			syncId: b2.body.syncId,
			chunks: [chunk('a1', 'k1', file, 1), chunk('a2', 'k2', file, 4)],
			fileHashes: { [file]: 'h2' }, fileChunkIds: { [file]: ['a1', 'a2'] }, done: true,
		}, write);
		expect(up.body.reconciled).toBe(1);

		const status = (await call(BASE, '/status', undefined, read, 'GET')).body;
		expect(status.chunks).toBe(2);
		expect(status.pendingVectorDeletes).toBe(1); // a3's vector queued for deletion
		const outline = (await call(BASE, '/outline', { file }, read)).body;
		expect(outline.chunks.map((c: any) => c.chunkId).sort()).toEqual(['a1', 'a2']);
	});

	it('line-shift: id-aware /chunks/check keeps the relocated chunk uploadable, reconciliation drops the old position', async () => {
		const WS = 'recon-ws-2';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		const file = 'src/b.ts';
		// Chunk lives at lines 1-3 → id hash(b:1:3) modelled as 'b_1_3', content casKey 'kc'.
		const b1 = await call(BASE, '/sync/begin', { files: { [file]: 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b1.body.syncId, chunks: [chunk('b_1_3', 'kc', file, 1)],
			fileHashes: { [file]: 'h1' }, fileChunkIds: { [file]: ['b_1_3'] }, done: true,
		}, write);

		// A blank line at the top shifts the chunk to lines 2-4 → NEW id 'b_2_4', SAME
		// content casKey 'kc'. The id-aware check must NOT report the new id as known
		// (only the OLD id is present) so the client uploads it.
		const check = await call(BASE, '/chunks/check', {
			have: [{ id: 'b_2_4', casKey: 'kc' }, { id: 'b_1_3', casKey: 'kc' }],
		}, write);
		expect(check.body.known).toEqual(['b_1_3']); // old id known; relocated new id is NOT

		const b2 = await call(BASE, '/sync/begin', { files: { [file]: 'h2' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b2.body.syncId, chunks: [chunk('b_2_4', 'kc', file, 2)],
			fileHashes: { [file]: 'h2' }, fileChunkIds: { [file]: ['b_2_4'] }, done: true,
		}, write);

		const outline = (await call(BASE, '/outline', { file }, read)).body;
		expect(outline.chunks.map((c: any) => c.chunkId)).toEqual(['b_2_4']); // old position gone, new present
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.chunks).toBe(1);
	});

	it('reconciling with the full set before all chunks land keeps not-yet-uploaded ids', async () => {
		const WS = 'recon-ws-3';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		const file = 'src/c.ts';
		const b1 = await call(BASE, '/sync/begin', { files: { [file]: 'h1' }, embedIdentity: 'x' }, write);
		// First batch carries only c1 but declares the full set {c1,c2}. c2 is not
		// yet uploaded — reconciliation must NOT delete it (it's in the declared set).
		await call(BASE, '/chunks', {
			syncId: b1.body.syncId, chunks: [chunk('c1', 'k1', file, 1)],
			fileChunkIds: { [file]: ['c1', 'c2'] }, done: false,
		}, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.chunks).toBe(1);
		// Second batch delivers c2 (still declaring {c1,c2}). Both survive.
		await call(BASE, '/chunks', {
			syncId: b1.body.syncId, chunks: [chunk('c2', 'k2', file, 4)],
			fileHashes: { [file]: 'h1' }, fileChunkIds: { [file]: ['c1', 'c2'] }, done: true,
		}, write);
		const outline = (await call(BASE, '/outline', { file }, read)).body;
		expect(outline.chunks.map((c: any) => c.chunkId).sort()).toEqual(['c1', 'c2']);
	});

	it('legacy casKey-mode /chunks/check still works (back-compat for a pre-fix client)', async () => {
		const WS = 'recon-ws-4';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const file = 'src/d.ts';
		const b1 = await call(BASE, '/sync/begin', { files: { [file]: 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b1.body.syncId, chunks: [chunk('d1', 'kd', file, 1)],
			fileHashes: { [file]: 'h1' }, done: true,
		}, write);
		const check = await call(BASE, '/chunks/check', { casKeys: ['kd', 'nope'] }, write);
		expect(check.body.known).toEqual(['kd']);
	});
});
