import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { chunksBatchError, chunkArr, MAX_CHUNKS_PER_BATCH, MAX_BATCH_CONTENT_BYTES, deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';

/*--------------------------------------------------------------------------------------
 *  Ingest hardening (editor E2E /chunks 500). Proves: the batch-size guard, that
 *  a pathological (minified/all-caps) chunk ingests fast instead of killing the
 *  isolate, that a large batch commits atomically and quickly, and that a
 *  malformed body returns structured JSON — never a Cloudflare HTML page.
 *--------------------------------------------------------------------------------------*/

async function call(base: string, path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${base}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.json<any>().catch(() => undefined) };
}
function chunk(id: string, over: Partial<WireChunk> = {}): WireChunk {
	return {
		id, casKey: `cas-${id}`, file: 'src/x.ts', startLine: 1, endLine: 4,
		kind: 'function', name: id, language: 'typescript', scored: true,
		content: `export function ${id}() { return run(${id}); }`,
		...over,
	};
}

describe('chunksBatchError', () => {
	it('accepts a valid array up to the cap', () => {
		expect(chunksBatchError({ chunks: [] })).toBeNull();
		expect(chunksBatchError({ chunks: Array.from({ length: MAX_CHUNKS_PER_BATCH }, () => ({})) })).toBeNull();
	});
	it('rejects oversized batches and non-arrays', () => {
		expect(chunksBatchError({ chunks: Array.from({ length: MAX_CHUNKS_PER_BATCH + 1 }, () => ({})) })).toMatch(/batch too large/);
		expect(chunksBatchError({ chunks: 'nope' })).toMatch(/must be an array/);
		expect(chunksBatchError({})).toMatch(/must be an array/);
	});
	it('rejects a batch whose total content exceeds the byte cap', () => {
		const big = 'x'.repeat(Math.ceil(MAX_BATCH_CONTENT_BYTES / 3) + 1);
		expect(chunksBatchError({ chunks: [{ content: big }, { content: big }, { content: big }] })).toMatch(/content exceeds/);
		// A few small chunks are fine.
		expect(chunksBatchError({ chunks: [{ content: 'abc' }, { content: 'def' }] })).toBeNull();
	});
});

describe('chunkArr', () => {
	it('splits into fixed-size groups (Vectorize upsert ≤1000 cap)', () => {
		const a = Array.from({ length: 1200 }, (_, i) => i);
		const groups = chunkArr(a, 500);
		expect(groups.map(g => g.length)).toEqual([500, 500, 200]);
		expect(chunkArr([], 500)).toEqual([]);
		expect(chunkArr([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
	});
});

describe('ingest hardening (integration)', () => {
	const WS = 'ingest-ws';
	const BASE = `https://v3index.test/v1/ws/${WS}`;

	it('rejects an oversized batch with a clean 413 JSON (not a killed isolate)', async () => {
		const write = await deriveToken('test-master-secret', WS, 'write');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/x.ts': 'h1' }, embedIdentity: 'x' }, write);
		const chunks = Array.from({ length: MAX_CHUNKS_PER_BATCH + 5 }, (_, i) => chunk(`big${i}`));
		const res = await call(BASE, '/chunks', { syncId: begin.body.syncId, chunks, done: false }, write);
		expect(res.status).toBe(413);
		expect(res.contentType).toContain('application/json');
		expect(res.body.error).toMatch(/batch too large/);
	});

	it('ingests a pathological all-caps / minified chunk fast instead of hanging', async () => {
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/x.ts': 'h1' }, embedIdentity: 'x' }, write);
		// A chunk whose content is a long uppercase run — the exact input that made
		// the old O(n^2) tokenizer burn the DO CPU budget and kill the isolate.
		const patho = chunk('pathoChunk', { content: 'const X = "' + 'A'.repeat(60_000) + '";' });
		const t0 = Date.now();
		const res = await call(BASE, '/chunks', { syncId: begin.body.syncId, chunks: [patho], fileHashes: { 'src/x.ts': 'h1' }, done: true }, write);
		expect(Date.now() - t0).toBeLessThan(3000);
		expect(res.status).toBe(200);
		expect(res.body.upserted).toBe(1);
		// Still lexically retrievable (name tokens indexed).
		const ret = await call(BASE, '/retrieve', { query: 'patho chunk' }, read);
		expect(ret.body.hits.length).toBeGreaterThan(0);
	});

	it('commits a large batch atomically and quickly (transactionSync)', async () => {
		const WS2 = 'ingest-ws-big';
		const B2 = `https://v3index.test/v1/ws/${WS2}`;
		const write = await deriveToken('test-master-secret', WS2, 'write');
		const read = await deriveToken('test-master-secret', WS2, 'read');
		await call(B2, '/init', { privacyMode: 'full' }, write);
		const begin = await call(B2, '/sync/begin', { files: { 'src/x.ts': 'h1' }, embedIdentity: 'x' }, write);
		const chunks = Array.from({ length: MAX_CHUNKS_PER_BATCH }, (_, i) => chunk(`c${i}`));
		const t0 = Date.now();
		const res = await call(B2, '/chunks', { syncId: begin.body.syncId, chunks, fileHashes: { 'src/x.ts': 'h1' }, done: true }, write);
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(res.status).toBe(200);
		expect(res.body.upserted).toBe(MAX_CHUNKS_PER_BATCH);
		expect((await call(B2, '/status', undefined, read, 'GET')).body.chunks).toBe(MAX_CHUNKS_PER_BATCH);
	});

	it('returns structured JSON (not Cloudflare HTML) for a malformed body', async () => {
		const write = await deriveToken('test-master-secret', WS, 'write');
		const res = await SELF.fetch(`${BASE}/chunks`, {
			method: 'POST',
			headers: { authorization: `Bearer ${write}`, 'content-type': 'application/json' },
			body: '{ this is not valid json',
		});
		const ct = res.headers.get('content-type') ?? '';
		expect(ct).toContain('application/json');
		const parsed = await res.json<any>();
		expect(parsed.error).toBeTruthy();
		expect([400, 500]).toContain(res.status);
	});

	it('ingests a ref-heavy chunk without blowing the DO SQLite variable cap', async () => {
		// 60 refs → 60 edge rows. writeEdges once batched 100 rows × 3 params = 300
		// bound variables and 500'd with "too many SQL variables at offset 433" on any
		// chunk with 34+ edges — the real bug that stalled big-repo syncs at ~96%.
		const write = await deriveToken('test-master-secret', WS, 'write');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/hub.ts': 'h1' }, embedIdentity: 'x' }, write);
		const refs = Array.from({ length: 60 }, (_, i) => `symbolRef${i}`);
		const res = await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [chunk('hub1', { file: 'src/hub.ts', refs, defines: ['hub1'] })],
			fileHashes: { 'src/hub.ts': 'h1' }, done: true,
		}, write);
		expect(res.status).toBe(200);
		expect(res.body.upserted).toBe(1);
	});
});
