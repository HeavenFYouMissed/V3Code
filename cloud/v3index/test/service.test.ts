import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';

const WS = 'test-ws';
const BASE = `https://v3index.test/v1/ws/${WS}`;

async function call(path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${BASE}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}

function chunk(id: string, over: Partial<WireChunk> = {}): WireChunk {
	return {
		id, casKey: `cas-${id}`, file: 'src/auth/login.ts', startLine: 1, endLine: 12,
		kind: 'function', name: id, language: 'typescript', scored: true,
		content: `export function ${id}(user: User) { return validateCredentials(user); }`,
		...over,
	};
}

describe('V3Index service', () => {
	it('rejects missing and wrong bearer tokens', async () => {
		const res = await SELF.fetch(`${BASE}/status`);
		expect(res.status).toBe(401);
		const bad = await call('/status', undefined, 'not-a-real-token', 'GET');
		expect(bad.status).toBe(401);
	});

	it('read-scope tokens cannot write', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		const res = await call('/chunks', { syncId: 'x', chunks: [] }, read);
		expect(res.status).toBe(401);
	});

	it('init → sync → upload → lexical retrieve round-trip', async () => {
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');

		const init = await call('/init', { privacyMode: 'full' }, write);
		expect(init.status).toBe(200);

		const begin = await call('/sync/begin', { files: { 'src/auth/login.ts': 'hash-1' }, embedIdentity: 'x' }, write);
		expect(begin.status).toBe(200);
		expect(begin.body.changedFiles).toEqual(['src/auth/login.ts']);

		const up = await call('/chunks', {
			syncId: begin.body.syncId,
			chunks: [
				chunk('loginUser', { defines: ['loginUser'], refs: ['validateCredentials'] }),
				chunk('validateCredentials', {
					startLine: 14, endLine: 30, defines: ['validateCredentials'],
					content: 'export function validateCredentials(user: User) { return user.token !== undefined; }',
				}),
			],
			fileHashes: { 'src/auth/login.ts': 'hash-1' },
			done: true,
		}, write);
		expect(up.status).toBe(200);
		expect(up.body.upserted).toBe(2);

		// Second sync with same manifest → no changed files (Merkle-style skip).
		const again = await call('/sync/begin', { files: { 'src/auth/login.ts': 'hash-1' }, embedIdentity: 'x' }, write);
		expect(again.body.changedFiles).toEqual([]);

		// CAS check: server knows these keys now.
		const check = await call('/chunks/check', { casKeys: ['cas-loginUser', 'cas-nope'] }, write);
		expect(check.body.known).toEqual(['cas-loginUser']);

		// Retrieval — embedder unavailable in tests, so this exercises the
		// lexical-only degradation path (by design, never a hard failure).
		const ret = await call('/retrieve', { query: 'where do we validate user credentials on login?' }, read);
		expect(ret.status).toBe(200);
		expect(ret.body.hits.length).toBeGreaterThan(0);
		const files = ret.body.hits.map((h: any) => h.file);
		expect(files).toContain('src/auth/login.ts');
		expect(ret.body.hits[0].snippet).toContain('function');

		const status = await call('/status', undefined, 'read' === 'read' ? read : write, 'GET');
		expect(status.body.chunks).toBe(2);
	});

	it('serves MCP tools/list and tools/call over the per-workspace endpoint', async () => {
		const read = await deriveToken('test-master-secret', WS, 'read');
		const rpc = async (payload: unknown) => {
			const res = await SELF.fetch(`${BASE}/mcp`, {
				method: 'POST',
				body: JSON.stringify(payload),
				headers: { authorization: `Bearer ${read}`, 'content-type': 'application/json' },
			});
			return res.json<any>();
		};
		const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
		expect(init.result.serverInfo.name).toBe(`v3index:${WS}`);

		const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const names = list.result.tools.map((t: any) => t.name);
		expect(names).toContain('search_codebase');
		expect(names).toContain('index_status');

		const call1 = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'index_status', arguments: {} } });
		expect(call1.result.content[0].text).toContain('chunks');
	});
});

it('lexical channel splits camelCase identifiers (greetUser found by "greet")', async () => {
	const token = await deriveToken('test-master-secret', 'camel-ws', 'write');
	const call = (path: string, body: unknown) => SELF.fetch(`https://v3index.test/v1/ws/camel-ws${path}`, {
		method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` },
	});
	await call('/init', { privacyMode: 'full' });
	const begin = await (await call('/sync/begin', { files: { 'a.ts': 'h1' }, embedIdentity: '' })).json<any>();
	await call('/chunks', {
		syncId: begin.syncId, done: true, fileHashes: { 'a.ts': 'h1' },
		chunks: [{
			id: 'c1', casKey: 'k1', file: 'a.ts', startLine: 1, endLine: 3, kind: 'function',
			name: 'greetUser', language: 'typescript', scored: true,
			content: 'export function greetUser(name: string) { return `hello ${name}`; }',
		}],
	});
	const ret = await (await call('/retrieve', { query: 'where do we greet the user' })).json<any>();
	expect(ret.hits.length).toBeGreaterThan(0);
	expect(ret.hits[0].name).toBe('greetUser');
	// Embed jobs must carry the DO's name back to it — a blank workspaceId
	// silently routed every job to the empty-named DO (prod bug, 2026-07-02).
	const status = await (await SELF.fetch('https://v3index.test/v1/ws/camel-ws/status', {
		headers: { authorization: `Bearer ${token}` },
	})).json<any>();
	expect(status.workspaceId).toBe('camel-ws');
});
