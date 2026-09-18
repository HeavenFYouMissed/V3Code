import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { deriveToken } from '../src/index.js';

const ROOT = () => deriveToken('test-master-secret', '*', 'admin');
const ADMIN = 'https://v3index.test/v1/admin/keys';

async function rootCall(path: string, body?: unknown, method = 'POST') {
	const res = await SELF.fetch(`${ADMIN}${path}`, {
		method,
		body: body === undefined ? undefined : JSON.stringify(body),
		headers: { authorization: `Bearer ${await ROOT()}`, 'content-type': 'application/json' },
	});
	return { status: res.status, body: await res.json<any>() };
}

describe('key registry', () => {
	it('rejects admin routes without root auth', async () => {
		const res = await SELF.fetch(ADMIN, { method: 'POST', body: '{}' });
		expect(res.status).toBe(401);
	});

	it('create → use → list → revoke → 401', async () => {
		const created = await rootCall('', { workspaceId: 'reg-ws', scope: 'read', label: 'ci-bot' });
		expect(created.status).toBe(200);
		expect(created.body.token).toMatch(/^v3k_[0-9a-f]{48}$/);

		// Use the key on its workspace.
		const ok = await SELF.fetch('https://v3index.test/v1/ws/reg-ws/status', {
			headers: { authorization: `Bearer ${created.body.token}` },
		});
		expect(ok.status).toBe(200);

		// Read key cannot write; wrong workspace rejected.
		const write = await SELF.fetch('https://v3index.test/v1/ws/reg-ws/chunks', {
			method: 'POST', body: '{"syncId":"x","chunks":[]}',
			headers: { authorization: `Bearer ${created.body.token}` },
		});
		expect(write.status).toBe(401);
		const cross = await SELF.fetch('https://v3index.test/v1/ws/other-ws/status', {
			headers: { authorization: `Bearer ${created.body.token}` },
		});
		expect(cross.status).toBe(401);

		// Listed with hash, no token.
		const list = await rootCall('?workspaceId=reg-ws', undefined, 'GET');
		expect(list.body.keys.some((k: any) => k.tokenHash === created.body.tokenHash)).toBe(true);
		expect(JSON.stringify(list.body)).not.toContain(created.body.token);

		// Revoke → key stops working.
		const rev = await rootCall('/revoke', { tokenHash: created.body.tokenHash });
		expect(rev.body.revoked).toBe(true);
		const after = await SELF.fetch('https://v3index.test/v1/ws/reg-ws/status', {
			headers: { authorization: `Bearer ${created.body.token}` },
		});
		expect(after.status).toBe(401);
	});

	it('org-wide key (workspaceId "*") reaches any workspace', async () => {
		const created = await rootCall('', { workspaceId: '*', scope: 'write', label: 'org' });
		const res = await SELF.fetch('https://v3index.test/v1/ws/any-ws-at-all/status', {
			headers: { authorization: `Bearer ${created.body.token}` },
		});
		expect(res.status).toBe(200);
	});
});
