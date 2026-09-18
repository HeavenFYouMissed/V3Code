import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { normalizeFileFilter, verifySessionToken } from '../src/index.js';
import type { WireChunk } from '../src/sync/protocol.js';

const SECRET = 'test-session-secret-that-is-at-least-32-bytes';
const CROSS_RUNTIME_SECRET = 'cross-runtime-session-secret-at-least-32-bytes';
const NODE_SIGNED_TOKEN = 'v3s_eyJ2IjoxLCJpc3MiOiJzdXBlcmNsYXciLCJhdWQiOiJ2M2luZGV4Iiwic3ViIjoiY3Jvc3MtcnVudGltZS11c2VyIiwid3MiOiJpZHhfY3Jvc3NfcnVudGltZV93b3Jrc3BhY2UiLCJzY29wZSI6InJlYWQiLCJwcm9maWxlIjoiYWR2YW5jZWQiLCJwcml2YWN5IjoiZXBoZW1lcmFsIiwiaWF0IjoyMDAwMDAwMDAwLCJleHAiOjIwMDAwMDA5MDAsImp0aSI6ImNyb3NzLXJ1bnRpbWUtdGVzdC1qdGkifQ.qhlfD6ttdY69yDgTuHVcRfACBKwpuWMCk5qj8dMdczM';

function b64url(bytes: Uint8Array): string {
	let raw = '';
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sessionToken(
	workspaceId: string,
	scope: 'read' | 'write',
	overrides: Partial<{ sub: string; iat: number; exp: number; jti: string; profile: 'standard' | 'advanced'; privacy: 'vectors-only' | 'ephemeral'; legacy: boolean }> = {},
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		v: 1,
		iss: 'superclaw',
		aud: 'v3index',
		sub: overrides.sub ?? 'paid-user-1',
		ws: workspaceId,
		scope,
		...(overrides.legacy ? {} : {
			profile: overrides.profile ?? 'standard',
			privacy: overrides.privacy ?? 'vectors-only',
		}),
		iat: overrides.iat ?? now,
		exp: overrides.exp ?? now + 900,
		jti: overrides.jti ?? 'session-test-jti',
	};
	const encoded = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	const key = await crypto.subtle.importKey(
		'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
	return `v3s_${encoded}.${b64url(new Uint8Array(signature))}`;
}

async function call(workspaceId: string, path: string, body: unknown, token: string, method = 'POST') {
	const response = await SELF.fetch(`https://v3index.test/v1/ws/${workspaceId}${path}`, {
		method,
		body: method === 'POST' ? JSON.stringify(body) : undefined,
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	return { status: response.status, body: await response.json<any>().catch(() => undefined) };
}

describe('paid-plan session credentials', () => {
	it('accepts the backend Node signer byte-for-byte in the Worker verifier', async () => {
		const claims = await verifySessionToken(NODE_SIGNED_TOKEN, CROSS_RUNTIME_SECRET, 'idx_cross_runtime_workspace', 2_000_000_001);
		expect(claims?.sub).toBe('cross-runtime-user');
		expect(claims?.scope).toBe('read');
		expect(claims?.profile).toBe('advanced');
		expect(claims?.privacy).toBe('ephemeral');
	});

	it('accepts exact-workspace scoped tokens and never promotes read to write', async () => {
		const workspaceId = 'session-ws';
		const advanced = { profile: 'advanced', privacy: 'ephemeral' } as const;
		const write = await sessionToken(workspaceId, 'write', advanced);
		const read = await sessionToken(workspaceId, 'read', advanced);
		expect((await call(workspaceId, '/init', { privacyMode: 'full' }, write)).status).toBe(200);
		expect((await call(workspaceId, '/status', undefined, read, 'GET')).status).toBe(200);
		expect((await call(workspaceId, '/init', { privacyMode: 'full' }, read)).status).toBe(401);
	});

	it('maps pre-profile rolling-deploy sessions to Standard source-free claims', async () => {
		const token = await sessionToken('legacy-session-ws', 'read', { legacy: true });
		const claims = await verifySessionToken(token, SECRET, 'legacy-session-ws');
		expect(claims?.profile).toBe('standard');
		expect(claims?.privacy).toBe('vectors-only');
	});

	it('makes the paid session profile authoritative over the client init body', async () => {
		const workspaceId = 'session-advanced-ws';
		const write = await sessionToken(workspaceId, 'write', { profile: 'advanced', privacy: 'ephemeral' });
		const initialized = await call(workspaceId, '/init', { privacyMode: 'full', indexProfile: 'standard' }, write);
		expect(initialized.status).toBe(200);
		expect(initialized.body.privacyMode).toBe('ephemeral');
		expect(initialized.body.indexProfile).toBe('advanced');
	});

	it('rejects wrong-workspace, expired, overlong, and tampered sessions', async () => {
		const now = Math.floor(Date.now() / 1000);
		const good = await sessionToken('session-ws', 'read');
		expect(await verifySessionToken(good, SECRET, 'other-ws', now)).toBeNull();
		expect(await verifySessionToken(await sessionToken('session-ws', 'read', { iat: now - 901, exp: now - 1 }), SECRET, 'session-ws', now)).toBeNull();
		expect(await verifySessionToken(await sessionToken('session-ws', 'read', { iat: now, exp: now + 901 }), SECRET, 'session-ws', now)).toBeNull();
		expect(await verifySessionToken(`${good}x`, SECRET, 'session-ws', now)).toBeNull();
	});
});

describe('file-scoped retrieval', () => {
	it('normalizes safe paths and rejects traversal or oversized scopes', () => {
		expect(normalizeFileFilter(['./src\\auth.ts', 'src/auth.ts'])).toEqual({ files: ['src/auth.ts'] });
		expect(normalizeFileFilter(['@roots/2-api/src/auth.ts'])).toEqual({ files: ['@roots/2-api/src/auth.ts'] });
		expect(normalizeFileFilter(['../secret.ts']).error).toBeTruthy();
		expect(normalizeFileFilter(Array.from({ length: 501 }, (_, index) => `src/${index}.ts`)).error).toBeTruthy();
	});

	it('returns hits only from the requested files, including an empty scope', async () => {
		const workspaceId = 'file-scope-ws';
		const advanced = { profile: 'advanced', privacy: 'ephemeral' } as const;
		const write = await sessionToken(workspaceId, 'write', advanced);
		const read = await sessionToken(workspaceId, 'read', advanced);
		await call(workspaceId, '/init', { privacyMode: 'full' }, write);
		const files = { 'src/allowed.ts': 'h1', 'src/blocked.ts': 'h2' };
		const manifestRoot = '6370897ba749249736d110ade1dbff040547328f5e0dc8e57914eaf8e07be8ef';
		const mismatched = await call(workspaceId, '/sync/begin', { files, embedIdentity: 'x', manifestRoot: 'a'.repeat(64) }, write);
		expect(mismatched.status).toBe(500);
		expect(mismatched.body.error).toContain('does not match');
		const begin = await call(workspaceId, '/sync/begin', { files, embedIdentity: 'x', manifestRoot }, write);
		const chunks: WireChunk[] = [
			{
				id: 'allowed', casKey: 'cas-allowed', file: 'src/allowed.ts', startLine: 1, endLine: 3,
				kind: 'function', name: 'allowedNeedle', language: 'typescript', scored: true,
				content: 'export function allowedNeedle() { return sharedNeedle; }',
			},
			{
				id: 'blocked', casKey: 'cas-blocked', file: 'src/blocked.ts', startLine: 1, endLine: 3,
				kind: 'function', name: 'blockedNeedle', language: 'typescript', scored: true,
				content: 'export function blockedNeedle() { return sharedNeedle; }',
			},
		];
		await call(workspaceId, '/chunks', {
			syncId: begin.body.syncId, chunks, fileHashes: files, fileChunkIds: {
				'src/allowed.ts': ['allowed'], 'src/blocked.ts': ['blocked'],
			}, done: true,
		}, write);
		const status = await call(workspaceId, '/status', undefined, read, 'GET');
		expect(status.body.manifestRoot).toBe(manifestRoot);

		const scoped = await call(workspaceId, '/retrieve', { query: 'shared needle', files: ['src/allowed.ts'] }, read);
		expect(scoped.status).toBe(200);
		expect(scoped.body.hits.length).toBeGreaterThan(0);
		expect(new Set(scoped.body.hits.map((hit: { file: string }) => hit.file))).toEqual(new Set(['src/allowed.ts']));

		const empty = await call(workspaceId, '/retrieve', { query: 'shared needle', files: [] }, read);
		expect(empty.status).toBe(200);
		expect(empty.body.hits).toEqual([]);

		const legacyBegin = await call(workspaceId, '/sync/begin', { files, embedIdentity: 'x' }, write);
		await call(workspaceId, '/chunks', { syncId: legacyBegin.body.syncId, chunks: [], done: true }, write);
		const legacyStatus = await call(workspaceId, '/status', undefined, read, 'GET');
		expect(legacyStatus.body.manifestRoot).toBeNull();
	});
});
