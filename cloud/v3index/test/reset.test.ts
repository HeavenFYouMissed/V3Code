import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';

/*--------------------------------------------------------------------------------------
 *  Workspace reset — recovery hatch for a wedged/bloated DO. Wipes all storage
 *  and re-creates the schema. Also covers the lightweight /init (no COUNT scans).
 *--------------------------------------------------------------------------------------*/

async function call(base: string, path: string, body: unknown, token: string, method = 'POST') {
	const res = await SELF.fetch(`${base}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>().catch(() => undefined) };
}

describe('workspace reset + lightweight init', () => {
	it('/init is lightweight (200, carries privacyMode, no crash) and /reset wipes everything', async () => {
		const WS = 'reset-ws';
		const BASE = `https://v3index.test/v1/ws/${WS}`;
		const write = await deriveToken('test-master-secret', WS, 'write');
		const read = await deriveToken('test-master-secret', WS, 'read');

		const init = await call(BASE, '/init', { privacyMode: 'full' }, write);
		expect(init.status).toBe(200);
		expect(init.body.privacyMode).toBe('full');
		expect(init.body.ok).toBe(true);

		const begin = await call(BASE, '/sync/begin', { files: { 'a.ts': 'h1' }, embedIdentity: 'x' }, write);
		await call(BASE, '/chunks', {
			syncId: begin.body.syncId,
			chunks: [{ id: 'c1', casKey: 'k1', file: 'a.ts', startLine: 1, endLine: 3, kind: 'function', name: 'foo', language: 'typescript', scored: true, content: 'function foo(){ return bar; }' }],
			fileHashes: { 'a.ts': 'h1' }, done: true,
		}, write);
		expect((await call(BASE, '/status', undefined, read, 'GET')).body.chunks).toBe(1);

		const reset = await call(BASE, '/reset', {}, write);
		expect(reset.body.reset).toBe(true);

		// Everything gone; schema intact so /status still answers (0 rows).
		const after = await call(BASE, '/status', undefined, read, 'GET');
		expect(after.status).toBe(200);
		expect(after.body.chunks).toBe(0);
		expect(after.body.files).toBe(0);
	});

	it('/reset requires write scope', async () => {
		const WS = 'reset-ws-2';
		const read = await deriveToken('test-master-secret', WS, 'read');
		const res = await SELF.fetch(`https://v3index.test/v1/ws/${WS}/reset`, {
			method: 'POST', headers: { authorization: `Bearer ${read}` },
		});
		expect(res.status).toBe(401);
	});
});
