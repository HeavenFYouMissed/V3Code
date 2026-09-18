import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import { DependencyGraph } from '../src/core/dependencyGraph.js';
import { SqlGraph, edgeRowsForChunk } from '../src/retrieve/sqlGraph.js';
import type { EdgeRow } from '../src/retrieve/sqlGraph.js';
import type { IndexedChunk } from '../src/core/browserIndexTypes.js';
import type { WireChunk } from '../src/sync/protocol.js';
import type { Env } from '../src/env.js';

/*--------------------------------------------------------------------------------------
 *  Graph on SQL edges (the DO fix for the 39k-chunk /retrieve 500).
 *
 *  The in-memory DependencyGraph (an editor port) blew DO CPU/memory at real
 *  corpus sizes. Edges now live in symbol_edges and retrieval does bounded
 *  symbol lookups. These tests pin:
 *    (parity)  SqlGraph reproduces DependencyGraph scoring byte-for-byte.
 *    (a)       edges are written on upload and removed on file removal.
 *    (b)       retrieve over a few-thousand-chunk workspace completes and
 *              returns hits carrying graph signals (the scale regression).
 *    (c)       reindex-graph backfill on pre-existing chunks yields the same
 *              retrieval boost as a fresh upload.
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

// ---- Parity: SqlGraph must match DependencyGraph exactly. ---------------------

/** In-memory EdgeSource backed by edgeRowsForChunk — the same write-time
 *  projection the DO persists — so a parity test needs no Durable Object. */
function edgeSourceFrom(chunks: IndexedChunk[]) {
	const rows: EdgeRow[] = [];
	for (const c of chunks) rows.push(...edgeRowsForChunk(c));
	return {
		edgesForSymbols: (symbols: string[]) => {
			const want = new Set(symbols);
			return rows.filter(r => want.has(r.symbol));
		},
	};
}

function ichunk(id: string, over: Partial<IndexedChunk> = {}): IndexedChunk {
	return {
		id, file: `src/${id}.ts`, startLine: 1, endLine: 10, kind: 'function', name: id,
		language: 'typescript', content: '', tokens: new Set(), scored: true, ...over,
	} as IndexedChunk;
}

describe('SqlGraph ↔ DependencyGraph parity', () => {
	// A corpus mixing: shared symbols (edges), a query-token match, an over-fanout
	// symbol (>40 definers → must be dropped on both sides), short/generic symbols
	// (text-filtered), and LSP edges (bypass the filter).
	function corpus(): IndexedChunk[] {
		const cs: IndexedChunk[] = [];
		cs.push(ichunk('caller', { refs: ['validateToken', 'chargeCard', 'go', 'map'], defines: ['handleRequest'] }));
		cs.push(ichunk('validator', { defines: ['validateToken'], refs: ['decodeJwt'] }));
		cs.push(ichunk('charger', { defines: ['chargeCard'], refs: ['validateToken'] }));
		cs.push(ichunk('jwt', { defines: ['decodeJwt'] }));
		cs.push(ichunk('lspNode', { lspDefines: ['go'], lspRefs: ['handleRequest'] })); // lsp bypasses filter
		// Over-fanout: 45 chunks all define `Common` → symbol dropped on def side.
		for (let i = 0; i < 45; i++) cs.push(ichunk(`common${i}`, { defines: ['Common'], refs: ['handleRequest'] }));
		return cs;
	}

	function toMap(chunks: IndexedChunk[]): Map<string, IndexedChunk> {
		return new Map(chunks.map(c => [c.id, c]));
	}

	it('propagateFromSeeds is identical (weights, fan-out drop, query boost, alpha)', () => {
		const chunks = corpus();
		const byId = toMap(chunks);
		const mem = new DependencyGraph();
		mem.ensure(chunks);
		const sql = new SqlGraph(edgeSourceFrom(chunks));

		const seeds = [{ id: 'caller', score: 1.0 }, { id: 'charger', score: 0.5 }];
		const queryTokens = ['validatetoken']; // matches validateToken → ×4 edge boost

		const a = mem.propagateFromSeeds(seeds, byId, queryTokens);
		const b = sql.propagateFromSeeds(seeds, byId, queryTokens);

		expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
		for (const [id, score] of a) expect(b.get(id)).toBeCloseTo(score, 12);
		// The over-fanout `Common` symbol was dropped → no chunk reached only via it.
		expect(a.has('common0')).toBe(false);
		expect(b.has('common0')).toBe(false);
	});

	it('neighborsOf is identical (LSP-first, then text, bounded)', () => {
		const chunks = corpus();
		const mem = new DependencyGraph();
		mem.ensure(chunks);
		const sql = new SqlGraph(edgeSourceFrom(chunks));
		for (const c of chunks) {
			expect(sql.neighborsOf(c, 10)).toEqual(mem.neighborsOf(c, 10));
		}
	});

	it('degrades to no-graph-signal when no edges exist (empty source)', () => {
		const sql = new SqlGraph({ edgesForSymbols: () => [] });
		const c = ichunk('x', { refs: ['validateToken'], defines: ['foo'] });
		expect(sql.propagateFromSeeds([{ id: 'x', score: 1 }], new Map([['x', c]]), []).size).toBe(0);
		expect(sql.neighborsOf(c, 10)).toEqual([]);
	});
});

// ---- (a) edges written on upload, removed on file removal --------------------

function wchunk(id: string, over: Partial<WireChunk> = {}): WireChunk {
	return {
		id, casKey: `cas-${id}`, file: 'src/graph/a.ts', startLine: 1, endLine: 8,
		kind: 'function', name: id, language: 'typescript', scored: true,
		content: `export function ${id}() { return validateToken(); }`,
		...over,
	};
}

describe('symbol_edges maintenance', () => {
	it('writes edges on upload and removes them when the file is pruned', async () => {
		const WS = 'graph-edges-1';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		const b1 = await call(BASE, '/sync/begin', { files: { 'src/graph/a.ts': 'h1', 'src/graph/b.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b1.body.syncId,
			chunks: [
				wchunk('mkA', { file: 'src/graph/a.ts', defines: ['handleLogin'], refs: ['validateToken'] }),
				wchunk('mkB', { file: 'src/graph/b.ts', defines: ['validateToken'], refs: ['decodeJwt'] }),
				// Noise: short + generic symbols must NOT produce text edges.
				wchunk('noisy', { file: 'src/graph/b.ts', defines: ['x'], refs: ['get', 'map'] }),
			],
			fileHashes: { 'src/graph/a.ts': 'h1', 'src/graph/b.ts': 'h1' }, done: true,
		}, write);

		// mkA: 1 define + 1 ref = 2 edges. noisy: all filtered → 0 edges.
		expect((await call(BASE, '/debug/edge-count', { chunkId: 'mkA' }, read)).body.edges).toBe(2);
		expect((await call(BASE, '/debug/edge-count', { chunkId: 'noisy' }, read)).body.edges).toBe(0);
		const total = (await call(BASE, '/debug/edge-count', {}, read)).body.edges;
		expect(total).toBe(4); // mkA(2) + mkB(2)

		// Drop src/graph/b.ts → its edges go with it, a.ts edges remain.
		const b2 = await call(BASE, '/sync/begin', { files: { 'src/graph/a.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: b2.body.syncId, chunks: [], fileHashes: {}, done: true }, write);
		expect((await call(BASE, '/debug/edge-count', { chunkId: 'mkB' }, read)).body.edges).toBe(0);
		expect((await call(BASE, '/debug/edge-count', {}, read)).body.edges).toBe(2); // only mkA left
	});

	it('re-uploading a chunk replaces its edges (no stale rows)', async () => {
		const WS = 'graph-edges-2';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const b1 = await call(BASE, '/sync/begin', { files: { 'src/graph/a.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b1.body.syncId,
			chunks: [wchunk('rep', { defines: ['alpha'], refs: ['beta', 'gamma'] })],
			fileHashes: { 'src/graph/a.ts': 'h1' }, done: true,
		}, write);
		expect((await call(BASE, '/debug/edge-count', { chunkId: 'rep' }, read)).body.edges).toBe(3);

		// New content → fewer symbols; the old edges must be gone, not accumulated.
		const b2 = await call(BASE, '/sync/begin', { files: { 'src/graph/a.ts': 'h2' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: b2.body.syncId,
			chunks: [wchunk('rep', { casKey: 'cas-rep2', defines: ['alpha'] })],
			fileHashes: { 'src/graph/a.ts': 'h2' }, done: true,
		}, write);
		expect((await call(BASE, '/debug/edge-count', { chunkId: 'rep' }, read)).body.edges).toBe(1);
	});
});

// ---- (b) scale regression: a few thousand chunks -----------------------------

describe('scale regression (the 39k-chunk /retrieve 500)', () => {
	it('retrieve over a few thousand small chunks completes and carries graph signals', async () => {
		const WS = 'graph-scale-1';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		// vectors-only keeps chunk_text empty (less memory) — graph edges are still
		// written from defines/refs, and retrieval degrades to lexical+graph since
		// the embedder is unavailable in tests. Exactly the prod read path minus
		// the vector channel.
		await call(BASE, '/init', { privacyMode: 'vectors-only' }, write);

		const N = 3000;
		const files: Record<string, string> = {};
		// Synthetic corpus: each chunk defines its own symbol and references the
		// PREVIOUS chunk's symbol → a dense, realistic edge chain. A shared hub
		// symbol on every 50th chunk exercises the query-token boost path.
		const chunks: WireChunk[] = [];
		for (let i = 0; i < N; i++) {
			const file = `src/gen/f${Math.floor(i / 20)}.ts`; // ~20 chunks/file
			files[file] = 'h1';
			chunks.push({
				id: `c${i}`, casKey: `cas-${i}`, file, startLine: (i % 20) * 10 + 1, endLine: (i % 20) * 10 + 8,
				kind: 'function', name: `handler${i}`, language: 'typescript', scored: true,
				tokens: ['handler', `sym${i}`, 'process', 'request'],
				defines: [`sym${i}`, 'processRequest'],
				refs: i > 0 ? [`sym${i - 1}`, 'processRequest'] : ['processRequest'],
			});
		}

		const begin = await call(BASE, '/sync/begin', { files, embedIdentity: 'x' }, write);
		expect(begin.status).toBe(200);
		// Upload in batches like a real client (keeps each request small).
		for (let i = 0; i < chunks.length; i += 500) {
			const slice = chunks.slice(i, i + 500);
			const up = await call(BASE, '/chunks', {
				syncId: begin.body.syncId, chunks: slice,
				fileHashes: i + 500 >= chunks.length ? files : undefined,
				done: i + 500 >= chunks.length,
			}, write);
			expect(up.status).toBe(200);
		}
		const status = await call(BASE, '/status', undefined, read, 'GET');
		expect(status.body.chunks).toBe(N);
		// Edges: 'processRequest' appears in every chunk (>40 fan-out) so it is a
		// query-time drop, but the per-chunk sym edges are all persisted.
		expect((await call(BASE, '/debug/edge-count', {}, read)).body.edges).toBeGreaterThan(N);

		// THE regression: this used to 500 (full-table scan + in-memory graph).
		const t0 = Date.now();
		const ret = await call(BASE, '/retrieve', { query: 'sym1500 processRequest handler', topK: 20 }, read);
		const took = Date.now() - t0;
		expect(ret.status).toBe(200);
		expect(ret.body.hits.length).toBeGreaterThan(0);
		// The exact-symbol chunk should surface, and graph signals should appear on
		// at least one hit (propagation/neighbor pulled edge-linked chunks in).
		const ids = ret.body.hits.map((h: any) => h.chunkId);
		expect(ids).toContain('c1500');
		const anyGraphSignal = ret.body.hits.some((h: any) => h.signals && (h.signals.graphBoost || h.signals.neighbor));
		expect(anyGraphSignal).toBe(true);
		// Sanity: bounded work, not a corpus-scan. Generous ceiling for CI noise.
		expect(took).toBeLessThan(5000);
	});
});

// ---- (c) reindex-graph backfill == fresh upload ------------------------------

describe('reindex-graph backfill', () => {
	it('backfills edges for pre-existing chunks and yields the same retrieval as a fresh upload', async () => {
		// Two workspaces, identical chunks. FRESH gets edges at upload (normal
		// path). BARE simulates a pre-existing index: we upload the same chunks,
		// then WIPE its edges, then rebuild them via the /reindex-graph loop. The
		// two retrievals must match.
		const chunks: WireChunk[] = [];
		for (let i = 0; i < 60; i++) {
			chunks.push({
				id: `k${i}`, casKey: `cas-k${i}`, file: `src/bf/f${Math.floor(i / 10)}.ts`,
				startLine: 1, endLine: 8, kind: 'function', name: `svc${i}`, language: 'typescript',
				scored: true, tokens: ['svc', `op${i}`, 'run'],
				defines: [`operation${i}`], refs: i > 0 ? [`operation${i - 1}`] : [],
			});
		}
		const filesOf = () => {
			const f: Record<string, string> = {};
			for (const c of chunks) f[c.file] = 'h1';
			return f;
		};

		async function seed(WS: string): Promise<{ base: string; read: string; write: string }> {
			const base = `https://v3index.test/v1/ws/${WS}`;
			const write = await deriveToken('test-master-secret', WS, 'write');
			const read = await deriveToken('test-master-secret', WS, 'read');
			await call(base, '/init', { privacyMode: 'vectors-only' }, write);
			const begin = await call(base, '/sync/begin', { files: filesOf(), embedIdentity: 'x' }, write);
			await call(base, '/chunks', { syncId: begin.body.syncId, chunks, fileHashes: filesOf(), done: true }, write);
			return { base, read, write };
		}

		const fresh = await seed('graph-bf-fresh');
		const bare = await seed('graph-bf-bare');

		const freshEdges = (await call(fresh.base, '/debug/edge-count', {}, fresh.read)).body.edges;
		expect(freshEdges).toBeGreaterThan(0);

		// Simulate a pre-schema index: destroy BARE's edges. Retrieval must still
		// work (degrade to no-graph-signal), just without the graph boost.
		await wipeEdges('graph-bf-bare');
		expect((await call(bare.base, '/debug/edge-count', {}, bare.read)).body.edges).toBe(0);
		const degraded = await call(bare.base, '/retrieve', { query: 'operation30 svc run', topK: 15 }, bare.read);
		expect(degraded.status).toBe(200);
		expect(degraded.body.hits.length).toBeGreaterThan(0); // no error, still returns hits

		// Backfill loop — caller iterates until done, small pages.
		let after: string | undefined;
		let guard = 0;
		for (;;) {
			const r = await call(bare.base, '/reindex-graph', { afterId: after, limit: 25 }, bare.write);
			expect(r.status).toBe(200);
			if (r.body.done) break;
			after = r.body.lastId;
            if (++guard > 100) throw new Error('reindex-graph loop did not terminate');
		}
		expect((await call(bare.base, '/debug/edge-count', {}, bare.read)).body.edges).toBe(freshEdges);

		// Now the two retrievals must agree — same hits, same graph signals.
		const q = { query: 'operation30 svc run', topK: 15 };
		const rf = await call(fresh.base, '/retrieve', q, fresh.read);
		const rb = await call(bare.base, '/retrieve', q, bare.read);
		expect(rb.body.hits.map((h: any) => h.chunkId)).toEqual(rf.body.hits.map((h: any) => h.chunkId));
		const graphIds = (r: any) => r.body.hits.filter((h: any) => h.signals?.graphBoost || h.signals?.neighbor).map((h: any) => h.chunkId).sort();
		expect(graphIds(rb)).toEqual(graphIds(rf));
	});
});

/** Zero out a workspace's symbol_edges via the DO stub — simulates an index
 *  that predates the edge schema (chunks present, no edges). No public route
 *  drops edges wholesale, so we drive the DO directly like the queue consumer. */
async function wipeEdges(wsId: string): Promise<void> {
	const stub = typedEnv.WORKSPACE.get(typedEnv.WORKSPACE.idFromName(wsId));
	await runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec('DELETE FROM symbol_edges');
	});
}
