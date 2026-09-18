import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { clampTopK, queryError, filterVectorMatches, VEC_FLOOR, deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';

/*--------------------------------------------------------------------------------------
 *  P0 read-path hardening regression tests (V3INDEX review). Three fixes:
 *    1. topK clamped to [1,50] on the retrieve path (index.ts).
 *    2. Query strings > 8KB rejected with 400 (and the O(n^2) tokenizer never runs).
 *    3. Vectorize hits below VEC_FLOOR (0.25) cosine dropped before fusion.
 *  Pure helpers are unit-tested directly; the request surface is exercised through
 *  SELF.fetch so a regression in wiring (not just the helper) is also caught.
 *--------------------------------------------------------------------------------------*/

// ── 1. topK clamp (unit) ─────────────────────────────────────────────────────
describe('clampTopK', () => {
	it('caps absurd values at 50', () => {
		expect(clampTopK(1_000_000)).toBe(50);
		expect(clampTopK(51)).toBe(50);
		expect(clampTopK(50)).toBe(50);
	});
	it('floors values at 1', () => {
		expect(clampTopK(1)).toBe(1);
		expect(clampTopK(0)).toBe(1);
		expect(clampTopK(-5)).toBe(1);
	});
	it('truncates fractionals and passes in-range values through', () => {
		expect(clampTopK(3.7)).toBe(3);
		expect(clampTopK(15)).toBe(15);
		expect(clampTopK('20')).toBe(20);
	});
	it('falls back to the default on non-numeric / NaN input', () => {
		expect(clampTopK(NaN)).toBe(30);
		expect(clampTopK(undefined)).toBe(30);
		expect(clampTopK('abc')).toBe(30);
		expect(clampTopK(null)).toBe(30);
	});
});

// ── 2. query length / shape (unit) ───────────────────────────────────────────
describe('queryError', () => {
	it('accepts a normal query and one exactly at the 8192-char limit', () => {
		expect(queryError('where do we charge the account')).toBeNull();
		expect(queryError('a'.repeat(8192))).toBeNull();
	});
	it('rejects over-limit, empty, and non-string queries', () => {
		expect(queryError('a'.repeat(8193))).toBeTruthy();
		expect(queryError('')).toBeTruthy();
		expect(queryError(123 as unknown)).toBeTruthy();
		expect(queryError(null)).toBeTruthy();
		expect(queryError(undefined)).toBeTruthy();
	});
	it('rejects the quadratic-backtracking ReDoS payload before it can reach tokenize()', () => {
		// 'A'*n + '.' is the confirmed O(n^2) trigger; the length cap fires first.
		expect(queryError('A'.repeat(110_000) + '.')).toBeTruthy();
	});
});

// ── 3. vector-score floor (unit) ─────────────────────────────────────────────
describe('filterVectorMatches', () => {
	it('drops matches below VEC_FLOOR and preserves best-first order', () => {
		const matches = [
			{ id: 'a', score: 0.9 },
			{ id: 'b', score: 0.25 }, // exactly at floor → kept
			{ id: 'c', score: 0.2499 }, // just under → dropped
			{ id: 'd', score: 0.1 },
			{ id: 'e', score: 0 },
		];
		expect(filterVectorMatches(matches)).toEqual(['a', 'b']);
	});
	it('honours an explicit floor and handles the empty case', () => {
		expect(filterVectorMatches([{ id: 'x', score: 0.4 }], 0.5)).toEqual([]);
		expect(filterVectorMatches([])).toEqual([]);
	});
	it('exposes the parity floor constant', () => {
		expect(VEC_FLOOR).toBe(0.25);
	});
});

// ── integration: the real /retrieve + MCP request surface ────────────────────
const WS = 'limits-ws';
const BASE = `https://v3index.test/v1/ws/${WS}`;

async function call(path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${BASE}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}

/** 80 standalone chunks that all share the token "widget" — enough that an
 *  unclamped topK would return far more than the clamped ceiling. */
function widgetChunks(n: number): WireChunk[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `w${i}`, casKey: `cas-w${i}`, file: `src/w${i}.ts`, startLine: 1, endLine: 3,
		kind: 'function', name: `widget${i}`, language: 'typescript', scored: true,
		content: `export function widget${i}() { return widget(${i}); }`,
	}));
}

describe('read-path limits (integration)', () => {
	it('clamps a huge topK so retrieval cannot fuse/return the whole corpus', async () => {
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		const chunks = widgetChunks(80);
		const manifest = Object.fromEntries(chunks.map(c => [c.file, 'h1']));

		await call('/init', { privacyMode: 'full' }, write);
		const begin = await call('/sync/begin', { files: manifest, embedIdentity: 'x' }, write);
		const up = await call('/chunks', { syncId: begin.body.syncId, chunks, fileHashes: manifest, done: true }, write);
		expect(up.body.upserted).toBe(80);

		// topK=1e6: pre-fix this returned all 80; clamp caps primaries at 50, so the
		// response is bounded at topK + NEIGHBOR_MAX (60) regardless of corpus size.
		const ret = await call('/retrieve', { query: 'widget', topK: 1_000_000 }, read);
		expect(ret.status).toBe(200);
		expect(ret.body.hits.length).toBeGreaterThan(0);
		expect(ret.body.hits.length).toBeLessThanOrEqual(60);
		expect(ret.body.hits.length).toBeLessThan(80); // proves the clamp actually bit
	});

	it('accepts a garbage/negative topK without erroring (clamped, not crashed)', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		const neg = await call('/retrieve', { query: 'widget', topK: -5 }, read);
		expect(neg.status).toBe(200);
		const nan = await call('/retrieve', { query: 'widget', topK: 'lots' }, read);
		expect(nan.status).toBe(200);
	});

	it('rejects an over-8KB query with 400 and never runs the tokenizer on it', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		// The confirmed ReDoS payload — must be rejected fast, not fused.
		const started = Date.now();
		const big = await call('/retrieve', { query: 'A'.repeat(110_000) + '.', topK: 5 }, read);
		expect(big.status).toBe(400);
		expect(big.body.error).toMatch(/exceeds/);
		// If the tokenizer had run on 110KB this would take tens of seconds; the
		// reject path is effectively instant. Generous bound to avoid CI flakiness.
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('accepts a normal-length query (regression guard on the cap boundary)', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		const ok = await call('/retrieve', { query: 'widget', topK: 5 }, read);
		expect(ok.status).toBe(200);
		const empty = await call('/retrieve', { query: '', topK: 5 }, read);
		expect(empty.status).toBe(400);
	});

	it('MCP search_codebase surfaces an oversized query as a tool error, not a hang', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		const res = await SELF.fetch(`${BASE}/mcp`, {
			method: 'POST',
			headers: { authorization: `Bearer ${read}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0', id: 1, method: 'tools/call',
				params: { name: 'search_codebase', arguments: { query: 'A'.repeat(20_000) } },
			}),
		});
		const rpc = await res.json<any>();
		expect(rpc.result.isError).toBe(true);
		expect(rpc.result.content[0].text).toMatch(/exceeds/);
	});
});
