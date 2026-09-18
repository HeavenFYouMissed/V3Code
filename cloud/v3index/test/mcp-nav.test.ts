import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';

/*--------------------------------------------------------------------------------------
 *  Graph navigation tools (symbol_lookup / find_references / graph_neighbors /
 *  file_outline) — deterministic go-to-def / find-refs / neighbors / outline over
 *  symbol_edges, exposed to agents via MCP and REST. Distinct from semantic search.
 *--------------------------------------------------------------------------------------*/

const WS = 'nav-ws';
const BASE = `https://v3index.test/v1/ws/${WS}`;

async function call(path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${BASE}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}

async function seed() {
	const write = await deriveToken('test-master-secret', WS, 'write');
	await call('/init', { privacyMode: 'full' }, write);
	const begin = await call('/sync/begin', { files: { 'src/auth/login.ts': 'h1' }, embedIdentity: 'x' }, write);
	const chunks: WireChunk[] = [
		{
			id: 'loginUser', casKey: 'cas-loginUser', file: 'src/auth/login.ts', startLine: 1, endLine: 12,
			kind: 'function', name: 'loginUser', language: 'typescript', scored: true,
			defines: ['loginUser'], refs: ['validateCredentials'],
			content: 'export function loginUser(u: User) { return validateCredentials(u); }',
		},
		{
			id: 'validateCredentials', casKey: 'cas-vc', file: 'src/auth/login.ts', startLine: 14, endLine: 30,
			kind: 'function', name: 'validateCredentials', language: 'typescript', scored: true,
			defines: ['validateCredentials'],
			content: 'export function validateCredentials(u: User) { return u.token !== undefined; }',
		},
	];
	await call('/chunks', { syncId: begin.body.syncId, chunks, fileHashes: { 'src/auth/login.ts': 'h1' }, done: true }, write);
}

describe('graph navigation (REST)', () => {
	it('symbol_lookup finds the definition', async () => {
		await seed();
		const read = await deriveToken('test-master-secret', WS, 'read');
		const res = await call('/symbol', { symbol: 'validateCredentials', which: 'def' }, read);
		expect(res.status).toBe(200);
		expect(res.body.matches.map((m: any) => m.chunkId)).toContain('validateCredentials');
		expect(res.body.matches[0].file).toBe('src/auth/login.ts');
	});

	it('find_references finds the caller', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		const res = await call('/symbol', { symbol: 'validateCredentials', which: 'ref' }, read);
		expect(res.body.matches.map((m: any) => m.chunkId)).toContain('loginUser');
	});

	it('graph_neighbors expands from a hit to its callee', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		const res = await call('/neighbors', { chunkId: 'loginUser' }, read);
		expect(res.body.neighbors.map((n: any) => n.chunkId)).toContain('validateCredentials');
	});

	it('file_outline lists a file\'s chunks in order', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		const res = await call('/outline', { file: 'src/auth/login.ts' }, read);
		expect(res.body.chunks.map((c: any) => c.chunkId)).toEqual(['loginUser', 'validateCredentials']);
		expect(res.body.chunks[0].startLine).toBe(1);
	});

	it('requires read scope and handles unknown symbols/files gracefully', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		expect((await call('/symbol', { symbol: 'doesNotExist', which: 'def' }, read)).body.matches).toEqual([]);
		expect((await call('/outline', { file: 'nope.ts' }, read)).body.chunks).toEqual([]);
		expect((await call('/neighbors', { chunkId: 'nope' }, read)).body.neighbors).toEqual([]);
		// unauthenticated → 401
		const anon = await SELF.fetch(`${BASE}/symbol`, { method: 'POST', body: '{"symbol":"x"}' });
		expect(anon.status).toBe(401);
	});
});

describe('graph navigation (MCP)', () => {
	it('exposes the four navigation tools and they invoke', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		const rpc = async (payload: unknown) => {
			const res = await SELF.fetch(`${BASE}/mcp`, {
				method: 'POST', body: JSON.stringify(payload),
				headers: { authorization: `Bearer ${read}`, 'content-type': 'application/json' },
			});
			return res.json<any>();
		};
		const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const names = list.result.tools.map((t: any) => t.name);
		for (const n of ['search_codebase', 'symbol_lookup', 'find_references', 'graph_neighbors', 'file_outline', 'index_status']) {
			expect(names).toContain(n);
		}
		const callTool = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find_references', arguments: { symbol: 'validateCredentials' } } });
		expect(callTool.result.content[0].text).toContain('loginUser');
	});
});
