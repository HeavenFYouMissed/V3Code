import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';
import type { Env } from '../src/env.js';

/*--------------------------------------------------------------------------------------
 *  R2 chunk_text offload. Full-mode content lives in R2 (content-addressed by
 *  casKey, namespaced per workspace), not DO SQLite — keeps the DO small so a big
 *  repo can't wedge it. Reads fall back to legacy chunk_text so workspaces indexed
 *  BEFORE the offload keep serving snippets with no migration.
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
function chunk(id: string, over: Partial<WireChunk> = {}): WireChunk {
	return {
		id, casKey: `cas-${id}`, file: 'src/a.ts', startLine: 1, endLine: 3,
		kind: 'function', name: id, language: 'typescript', scored: true,
		content: `export function ${id}() { return widget(${id}); }`,
		...over,
	};
}

describe('R2 chunk_text offload', () => {
	it('serves full-mode snippets from R2, with nothing in DO chunk_text', async () => {
		const WS = 'r2-ws';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write);
		const begin = await call(BASE, '/sync/begin', { files: { 'src/a.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', { syncId: begin.body.syncId, chunks: [chunk('greetWidget')], fileHashes: { 'src/a.ts': 'h1' }, done: true }, write);

		const ret = await call(BASE, '/retrieve', { query: 'greet widget' }, read);
		expect(ret.body.hits.length).toBeGreaterThan(0);
		expect(ret.body.hits[0].snippet).toContain('greetWidget'); // hydrated from R2

		const dbg = await call(BASE, '/debug/text-rows', { id: 'greetWidget' }, read);
		expect(dbg.body.rows).toBe(0); // not in DO SQLite
		expect(dbg.body.r2).toBe(1);   // in R2
	});

	it('falls back to legacy chunk_text for pre-offload chunks (no migration needed)', async () => {
		const WS = 'r2-legacy';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');
		await call(BASE, '/init', { privacyMode: 'full' }, write); // creates schema

		// Simulate a chunk indexed BEFORE the R2 offload: content only in chunk_text.
		const stub = typedEnv.WORKSPACE.get(typedEnv.WORKSPACE.idFromName(WS));
		await runInDurableObject(stub, (_i, state) => {
			const sql = state.storage.sql;
			sql.exec('INSERT INTO chunks(id, cas_key, file, start_line, end_line, kind, name, language, scored) VALUES (?,?,?,?,?,?,?,?,1)',
				'legacy1', 'cas-legacy1', 'src/legacy.ts', 1, 3, 'function', 'legacyFunc', 'typescript');
			sql.exec('INSERT INTO chunk_fts(id, body) VALUES (?, ?)', 'legacy1', 'legacy func widget');
			sql.exec('INSERT INTO chunk_text(id, content) VALUES (?, ?)', 'legacy1', 'export function legacyFunc() { return widget; }');
		});

		const ret = await call(BASE, '/retrieve', { query: 'legacy func' }, read);
		const hit = ret.body.hits.find((h: any) => h.chunkId === 'legacy1');
		expect(hit).toBeTruthy();
		expect(hit.snippet).toContain('legacyFunc'); // served from chunk_text fallback

		const dbg = await call(BASE, '/debug/text-rows', { id: 'legacy1' }, read);
		expect(dbg.body.rows).toBe(1); // legacy content still in chunk_text
		expect(dbg.body.r2).toBe(0);   // never went to R2
	});
});
