import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import type { Env } from '../src/env.js';

const typedEnv = env as unknown as Env;

/*--------------------------------------------------------------------------------------
 *  Deferred prune, bounded + alarm-continued. The live failure this locks against:
 *  a workspace whose server manifest held ~28k stale files (pre-watcher-fix sync)
 *  diffed against a ~14.5k-file local index — done:true then ran 28k removeFile()
 *  calls in ONE invocation and the DO died to its CPU limit on every sync, forever.
 *  Now done:true drains one bounded batch and alarm invocations (fresh CPU budget
 *  each) drain the rest; /sync/begin must NOT drop the in-flight queue.
 *--------------------------------------------------------------------------------------*/

async function call(base: string, path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${base}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}

/** 10 chunks per file: the drain budgets by CHUNK count (1500/invocation), so
 *  500 files × 10 chunks = 5000 chunk rows ≈ 4 bounded drain invocations. */
const CHUNKS_PER_FILE = 10;
function chunksFor(file: string, i: number) {
	return Array.from({ length: CHUNKS_PER_FILE }, (_, k) => ({
		id: `c-${i}-${k}`, casKey: `k-${i}-${k}`, file, startLine: k * 3 + 1, endLine: k * 3 + 3, kind: 'function',
		name: `fn${i}_${k}`, language: 'typescript', scored: true, content: `function fn${i}_${k}() { return ${i}; }`,
	}));
}

describe('bounded prune with alarm continuation', () => {
	// 20s (vs the 5s default): this is the suite's heaviest stress test — 500 files
	// × 10 chunks seeded, then a full-workspace removal storm across 5 alarm ticks.
	// Each tick's vector-delete flush issues a deleteByIds against the deliberately
	// absent test binding (Miniflare has no local Vectorize simulator), exercising
	// the outage path without touching Cloudflare.
	it('a removal storm at done:true drains in batches instead of one CPU-killing pass', async () => {
		const WS = 'prune-ws';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);

		// Seed 500 files × 10 chunks — the future "stale" population.
		const seedManifest: Record<string, string> = {};
		for (let i = 0; i < 500; i++) seedManifest[`old/f${i}.ts`] = `h${i}`;
		const seed = await call(BASE, '/sync/begin', { files: seedManifest, embedIdentity: 'x' }, write);
		for (let i = 0; i < 500; i += 50) {
			const slice = Array.from({ length: 50 }, (_, j) => chunksFor(`old/f${i + j}.ts`, i + j)).flat();
			const hashes = Object.fromEntries(Array.from({ length: 50 }, (_, j) => [`old/f${i + j}.ts`, `h${i + j}`]));
			const res = await call(BASE, '/chunks', { syncId: seed.body.syncId, chunks: slice, fileHashes: hashes, done: false }, write);
			expect(res.status).toBe(200);
		}
		await call(BASE, '/chunks', { syncId: seed.body.syncId, chunks: [], fileHashes: seedManifest, done: true }, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.files).toBe(500);

		// The storm: a new sync whose manifest keeps only ONE file → 500 staged removals.
		const begin = await call(BASE, '/sync/begin', { files: { 'keep.ts': 'hk' }, embedIdentity: 'x' }, write);
		expect(begin.body.removedFiles.length).toBe(500);
		const done = await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			chunks: chunksFor('keep.ts', 9999).slice(0, 1),
			fileHashes: { 'keep.ts': 'hk' },
			done: true,
		}, write);
		expect(done.status).toBe(200);
		// Bounded by CHUNK budget: ~150 files (1500 chunks / 10 per file) pruned
		// now, remainder queued for the alarm chain.
		expect(done.body.removed).toBeGreaterThan(0);
		expect(done.body.removed).toBeLessThan(500);
		expect(done.body.pruneRemaining).toBe(500 - done.body.removed);

		// A NEW /sync/begin mid-drain must not drop the queue.
		await call(BASE, '/sync/begin', { files: { 'keep.ts': 'hk' }, embedIdentity: 'x' }, write);
		const mid = await call(BASE, '/status', undefined, read, 'GET');
		expect(mid.body.pruneRemaining).toBe(done.body.pruneRemaining);

		// Alarm invocations (fresh CPU budget each) drain the rest.
		const stub = typedEnv.WORKSPACE.get(typedEnv.WORKSPACE.idFromName(WS));
		for (let i = 0; i < 5 && (await call(BASE, '/status', undefined, read, 'GET')).body.pruneRemaining > 0; i++) {
			await runDurableObjectAlarm(stub);
		}
		const after = await call(BASE, '/status', undefined, read, 'GET');
		expect(after.body.pruneRemaining).toBe(0);
		expect(after.body.files).toBe(1);
		expect(after.body.chunks).toBe(1);
	}, 20_000);
});
