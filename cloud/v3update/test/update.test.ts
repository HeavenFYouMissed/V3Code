import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env, ReleaseManifest } from '../src/env.js';

/*--------------------------------------------------------------------------------------
 *  Exercises the three routes against a real (miniflare) R2 binding: seed a manifest +
 *  build object directly via env.RELEASES, then hit the worker over SELF.fetch so
 *  routing + R2 reads are covered end-to-end, not just the handler functions.
 *--------------------------------------------------------------------------------------*/

const typedEnv = env as unknown as Env;

const BASE = 'https://v3update.test';
const PLATFORM = 'darwin-arm64';
const QUALITY = 'stable';
const OLD_COMMIT = 'aaaa000';
const NEW_COMMIT = 'bbbb111';
const UNKNOWN_OR_NEWER_COMMIT = 'cccc222';

const MANIFEST: ReleaseManifest = {
	version: NEW_COMMIT,
	productVersion: '1.5.0',
	timestamp: 1_770_000_000_000,
	url: `https://v3update.kevinbakon463.workers.dev/download/${QUALITY}/${PLATFORM}/V3Code-1.5.0.zip`,
	sha256hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
	name: '1.5.0',
	supersedes: [OLD_COMMIT],
};

async function seedManifest(manifest: ReleaseManifest = MANIFEST): Promise<void> {
	await typedEnv.RELEASES.put(`manifests/${QUALITY}/${PLATFORM}/latest.json`, JSON.stringify(manifest));
}

async function seedBuild(bytes: Uint8Array): Promise<void> {
	await typedEnv.RELEASES.put(`builds/${QUALITY}/${PLATFORM}/V3Code-1.5.0.zip`, bytes, {
		httpMetadata: { contentType: 'application/zip' },
	});
}

async function createProductVotesTable(): Promise<void> {
	await typedEnv.ANALYTICS!.prepare(`
		CREATE TABLE IF NOT EXISTS product_votes (
			survey_id TEXT NOT NULL,
			voter_hash TEXT NOT NULL,
			choice TEXT NOT NULL CHECK (choice IN ('yes', 'no')),
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (survey_id, voter_hash)
		)
	`).run();
}

async function createRuntimeStateTable(): Promise<void> {
	await typedEnv.ANALYTICS!.prepare(`
		CREATE TABLE IF NOT EXISTS runtime_install_state (
			installation_hash TEXT NOT NULL,
			commit_id TEXT NOT NULL,
			product_version TEXT NOT NULL,
			platform TEXT NOT NULL,
			quality TEXT NOT NULL,
			first_seen INTEGER NOT NULL,
			last_seen INTEGER NOT NULL,
			launched_at INTEGER,
			runtime_ready_at INTEGER,
			ai_first_attempt_at INTEGER,
			ai_first_success_at INTEGER,
			ai_last_failure_at INTEGER,
			last_failure_code TEXT,
			event_count INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (installation_hash, commit_id)
		)
	`).run();
}

async function createStatsTables(): Promise<void> {
	await typedEnv.ANALYTICS!.prepare(`
		CREATE TABLE IF NOT EXISTS downloads (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			ip TEXT,
			country TEXT,
			city TEXT,
			platform TEXT,
			quality TEXT,
			filename TEXT,
			src TEXT,
			referer TEXT,
			ua TEXT,
			is_range INTEGER NOT NULL DEFAULT 0
		)
	`).run();
	await typedEnv.ANALYTICS!.prepare(`
		CREATE TABLE IF NOT EXISTS install_pings (
			ip TEXT NOT NULL,
			platform TEXT NOT NULL,
			quality TEXT,
			commit_id TEXT NOT NULL,
			country TEXT,
			first_seen INTEGER NOT NULL,
			last_seen INTEGER NOT NULL,
			hits INTEGER NOT NULL DEFAULT 1,
			PRIMARY KEY (ip, platform, commit_id)
		)
	`).run();
	await createProductVotesTable();
	await createRuntimeStateTable();
}

async function postRuntimeEvent(
	installationId: string,
	event: string,
	extra: Record<string, unknown> = {},
): Promise<Response> {
	return SELF.fetch(`${BASE}/api/runtime-events`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			schemaVersion: 1,
			installationId,
			event,
			commit: 'abcdef0123456789abcdef0123456789abcdef01',
			productVersion: '1.4.9-0096',
			platform: PLATFORM,
			quality: QUALITY,
			...extra,
		}),
	});
}

describe('GET /api/update/:platform/:quality/:commit', () => {
	it('204s when there is no manifest at all', async () => {
		const res = await SELF.fetch(`${BASE}/api/update/${PLATFORM}/${QUALITY}/${OLD_COMMIT}`);
		expect(res.status).toBe(204);
	});

	it('204s when the running commit already matches the manifest version', async () => {
		await seedManifest();
		const res = await SELF.fetch(`${BASE}/api/update/${PLATFORM}/${QUALITY}/${NEW_COMMIT}`);
		expect(res.status).toBe(204);
	});

	it('200s with an IUpdate-shaped body when the client is behind', async () => {
		await seedManifest();
		const res = await SELF.fetch(`${BASE}/api/update/${PLATFORM}/${QUALITY}/${OLD_COMMIT}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=60');

		const body = await res.json<any>();
		// Fields the electron-main update services require to be present (or they
		// silently treat the response as "no update" — see updateService.win32.ts
		// doCheckForUpdates / updateService.darwin.ts checkForUpdateNoDownload).
		expect(body.url).toBe(MANIFEST.url);
		expect(body.version).toBe(MANIFEST.version);
		expect(body.productVersion).toBe(MANIFEST.productVersion);
		expect(body.sha256hash).toBe(MANIFEST.sha256hash);
		expect(body.timestamp).toBe(MANIFEST.timestamp);
		expect(body.name).toBe(MANIFEST.name);
		// Fields Squirrel.Mac reads from the same feed URL: the darwin service maps
		// update-downloaded's (releaseNotes, releaseName) to (version, productVersion),
		// so notes must carry the commit or post-download update.version is undefined.
		expect(body.notes).toBe(MANIFEST.version);
		expect(body.pub_date).toBe(new Date(MANIFEST.timestamp).toISOString());
	});

	it('204s for an unknown or newer commit instead of serving a downgrade', async () => {
		await seedManifest();
		const res = await SELF.fetch(`${BASE}/api/update/${PLATFORM}/${QUALITY}/${UNKNOWN_OR_NEWER_COMMIT}`);
		expect(res.status).toBe(204);
	});

	it('204s for a legacy manifest that cannot prove commit ordering', async () => {
		const { supersedes: _supersedes, ...legacyManifest } = MANIFEST;
		await seedManifest(legacyManifest);
		const res = await SELF.fetch(`${BASE}/api/update/${PLATFORM}/${QUALITY}/${OLD_COMMIT}`);
		expect(res.status).toBe(204);
	});

	it('allows a deliberate rollback only when the client commit is explicitly superseded', async () => {
		const rollbackManifest: ReleaseManifest = {
			...MANIFEST,
			version: OLD_COMMIT,
			productVersion: '1.4.9',
			name: '1.4.9',
			supersedes: [NEW_COMMIT],
		};
		await seedManifest(rollbackManifest);
		const res = await SELF.fetch(`${BASE}/api/update/${PLATFORM}/${QUALITY}/${NEW_COMMIT}`);
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.version).toBe(OLD_COMMIT);
	});

	it('204s (not 500) when the stored manifest is corrupt JSON', async () => {
		await typedEnv.RELEASES.put(`manifests/${QUALITY}/${PLATFORM}/latest.json`, '{not json');
		const res = await SELF.fetch(`${BASE}/api/update/${PLATFORM}/${QUALITY}/${OLD_COMMIT}`);
		expect(res.status).toBe(204);
	});
});

describe('GET /api/latest/:platform/:quality', () => {
	it('returns the manifest as-is for the website download buttons', async () => {
		await seedManifest();
		const res = await SELF.fetch(`${BASE}/api/latest/${PLATFORM}/${QUALITY}`);
		expect(res.status).toBe(200);
		const body = await res.json<ReleaseManifest>();
		expect(body).toEqual(MANIFEST);
	});

	it('404s when there is no manifest', async () => {
		const res = await SELF.fetch(`${BASE}/api/latest/${PLATFORM}/insiders`);
		expect(res.status).toBe(404);
	});

	it('404s (not 500) when the stored manifest is corrupt JSON', async () => {
		await typedEnv.RELEASES.put(`manifests/${QUALITY}/${PLATFORM}/latest.json`, '{not json');
		const res = await SELF.fetch(`${BASE}/api/latest/${PLATFORM}/${QUALITY}`);
		expect(res.status).toBe(404);
	});
});

describe('GET /download/:quality/:platform/:filename', () => {
	it('streams the object with content-type/length and a long-lived cache header', async () => {
		const payload = new TextEncoder().encode('fake-zip-bytes-for-testing');
		await seedBuild(payload);

		const res = await SELF.fetch(`${BASE}/download/${QUALITY}/${PLATFORM}/V3Code-1.5.0.zip`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/zip');
		expect(res.headers.get('content-length')).toBe(String(payload.byteLength));
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes).toEqual(payload);
	});

	it('serves a 206 partial response honoring a Range header', async () => {
		const payload = new TextEncoder().encode('0123456789abcdefghij');
		await seedBuild(payload);

		const res = await SELF.fetch(`${BASE}/download/${QUALITY}/${PLATFORM}/V3Code-1.5.0.zip`, {
			headers: { range: 'bytes=2-5' },
		});
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 2-5/${payload.byteLength}`);
		expect(res.headers.get('content-length')).toBe('4');

		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(new TextDecoder().decode(bytes)).toBe('2345');
	});

	it('404s (JSON) when the build object is missing', async () => {
		const res = await SELF.fetch(`${BASE}/download/${QUALITY}/${PLATFORM}/does-not-exist.zip`);
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toBe('application/json');
		const body = await res.json<any>();
		expect(body.error).toBe('not found');
	});

	it('answers HEAD from object metadata with an empty body', async () => {
		const payload = new TextEncoder().encode('fake-zip-bytes-for-testing');
		await seedBuild(payload);

		const res = await SELF.fetch(`${BASE}/download/${QUALITY}/${PLATFORM}/V3Code-1.5.0.zip`, { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(payload.byteLength));
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect((await res.arrayBuffer()).byteLength).toBe(0);
	});

	it('416s (not 500) on an unsatisfiable range — resume of a completed download', async () => {
		const payload = new TextEncoder().encode('0123456789abcdefghij');
		await seedBuild(payload);

		const res = await SELF.fetch(`${BASE}/download/${QUALITY}/${PLATFORM}/V3Code-1.5.0.zip`, {
			headers: { range: `bytes=${payload.byteLength}-` },
		});
		expect(res.status).toBe(416);
		expect(res.headers.get('content-range')).toBe(`bytes */${payload.byteLength}`);
	});

	it('degrades an unparseable suffix range to a plain 200 full object', async () => {
		const payload = new TextEncoder().encode('0123456789abcdefghij');
		await seedBuild(payload);

		const res = await SELF.fetch(`${BASE}/download/${QUALITY}/${PLATFORM}/V3Code-1.5.0.zip`, {
			headers: { range: 'bytes=-5' },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(payload.byteLength));
		// Drain the body — an unconsumed R2 stream holds miniflare's isolated-storage
		// frame open and fails the pop after the test.
		expect((await res.arrayBuffer()).byteLength).toBe(payload.byteLength);
	});

	it('serves a percent-encoded filename by decoding it to the same R2 key', async () => {
		const payload = new TextEncoder().encode('fake-zip-bytes-for-testing');
		await seedBuild(payload);

		const res = await SELF.fetch(`${BASE}/download/${QUALITY}/${PLATFORM}/V3Code%2D1.5.0.zip`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(payload.byteLength));
		// Drain the body (see suffix-range test).
		expect((await res.arrayBuffer()).byteLength).toBe(payload.byteLength);
	});
});

describe('broadcast notifications (/api/notifications)', () => {
	it('GETs an empty feed when nothing has been published', async () => {
		const res = await SELF.fetch(`${BASE}/api/notifications`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(await res.json<any>()).toEqual({ notifications: [] });
	});

	it('allows the editor to preflight the public read endpoint', async () => {
		const res = await SELF.fetch(`${BASE}/api/notifications`, {
			method: 'OPTIONS',
			headers: {
				origin: 'vscode-file://vscode-app',
				'access-control-request-method': 'GET',
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
	});

	it('GETs the published feed verbatim', async () => {
		const feed = { notifications: [{ id: '2026-08-25-test', body: 'hello installs', severity: 'info' }] };
		await typedEnv.RELEASES.put('broadcasts/broadcasts.json', JSON.stringify(feed), {
			httpMetadata: { contentType: 'application/json' },
		});
		const res = await SELF.fetch(`${BASE}/api/notifications`);
		expect(res.status).toBe(200);
		expect(await res.json<any>()).toEqual(feed);
	});

	it('rejects a PUT without a valid admin token', async () => {
		const res = await SELF.fetch(`${BASE}/api/notifications?token=wrong`, {
			method: 'PUT',
			body: JSON.stringify({ notifications: [] }),
		});
		expect(res.status).toBe(401);
	});

	it('does not accept an admin token in the URL', async () => {
		const res = await SELF.fetch(`${BASE}/api/notifications?token=test-admin-token`, {
			method: 'PUT',
			body: JSON.stringify({ notifications: [] }),
		});
		expect(res.status).toBe(401);
	});

	it('accepts a bounded feed with the admin token in a header', async () => {
		const feed = {
			notifications: [{
				id: '2026-08-25-provider-outage',
				sender: 'Daniel — V3Code',
				display: 'banner',
				title: 'Provider notice',
				body: 'Use another model while this provider recovers.',
				actions: [{ label: 'V3Code status', href: 'https://status.v3code.dev/providers' }],
			}],
		};
		const res = await SELF.fetch(`${BASE}/api/notifications`, {
			method: 'PUT',
			headers: { 'x-admin-token': 'test-admin-token', 'content-type': 'application/json' },
			body: JSON.stringify(feed),
		});
		expect(res.status).toBe(200);
		expect(await res.json<any>()).toEqual({ ok: true, count: 1 });
	});

	it('rejects invalid sender and display fields', async () => {
		for (const notification of [
			{ id: 'empty-sender', sender: '   ', body: 'No.' },
			{ id: 'unknown-display', display: 'modal', body: 'No.' },
		]) {
			const res = await SELF.fetch(`${BASE}/api/notifications`, {
				method: 'PUT',
				headers: { 'x-admin-token': 'test-admin-token', 'content-type': 'application/json' },
				body: JSON.stringify({ notifications: [notification] }),
			});
			expect(res.status).toBe(400);
		}
	});

	it('rejects remote commands, foreign hosts, and arbitrary image URLs', async () => {
		for (const notification of [
			{ id: 'command', body: 'No.', actions: [{ label: 'Open', href: 'command:workbench.action.openSettings' }] },
			{ id: 'foreign-host', body: 'No.', actions: [{ label: 'Open', href: 'https://example.com' }] },
			{ id: 'foreign-image', body: 'No.', imageUrl: 'https://example.com/image.png' },
		]) {
			const res = await SELF.fetch(`${BASE}/api/notifications`, {
				method: 'PUT',
				headers: { 'x-admin-token': 'test-admin-token', 'content-type': 'application/json' },
				body: JSON.stringify({ notifications: [notification] }),
			});
			expect(res.status).toBe(400);
		}
	});

	it('rejects an oversized feed before storing it', async () => {
		const res = await SELF.fetch(`${BASE}/api/notifications`, {
			method: 'PUT',
			headers: { 'x-admin-token': 'test-admin-token', 'content-type': 'application/json' },
			body: JSON.stringify({ notifications: [{ id: 'oversized', body: 'x'.repeat(129 * 1024) }] }),
		});
		expect(res.status).toBe(413);
	});

	it('rejects a broadcast asset name with path separators', async () => {
		const res = await SELF.fetch(`${BASE}/api/notifications/asset/..%2Fmanifests`, {
			method: 'GET',
		});
		expect(res.status).toBe(400);
	});

	it('serves an uploaded asset with its content type', async () => {
		const bytes = new TextEncoder().encode('fake-png');
		await typedEnv.RELEASES.put('broadcasts/assets/hero.png', bytes, {
			httpMetadata: { contentType: 'image/png' },
		});
		const res = await SELF.fetch(`${BASE}/api/notifications/asset/hero.png`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect((await res.arrayBuffer()).byteLength).toBe(bytes.byteLength);
	});

	it('accepts only bounded image uploads authorized by a header', async () => {
		const accepted = await SELF.fetch(`${BASE}/api/notifications/asset/hero.png`, {
			method: 'PUT',
			headers: { 'x-admin-token': 'test-admin-token', 'content-type': 'image/png' },
			body: new TextEncoder().encode('fake-png'),
		});
		expect(accepted.status).toBe(200);

		const rejected = await SELF.fetch(`${BASE}/api/notifications/asset/hero.svg`, {
			method: 'PUT',
			headers: { 'x-admin-token': 'test-admin-token', 'content-type': 'image/svg+xml' },
			body: '<svg/>',
		});
		expect(rejected.status).toBe(415);
	});
});

describe('anonymous Agents beta vote (/api/votes/agents-beta)', () => {
	it('allows the editor to preflight a JSON POST', async () => {
		const res = await SELF.fetch(`${BASE}/api/votes/agents-beta`, {
			method: 'OPTIONS',
			headers: {
				origin: 'vscode-file://vscode-app',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
		expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
	});

	it('rejects malformed, oversized, and extra-field votes before touching D1', async () => {
		for (const body of [
			{ choice: 'maybe', voterId: '87ab7b3d-2df0-4c35-a1d2-44184ef984d2' },
			{ choice: 'yes', voterId: 'not-a-uuid' },
			{ choice: 'yes', voterId: '87ab7b3d-2df0-4c35-a1d2-44184ef984d2', email: 'no@example.com' },
		]) {
			const res = await SELF.fetch(`${BASE}/api/votes/agents-beta`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(400);
		}

		const oversized = await SELF.fetch(`${BASE}/api/votes/agents-beta`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ choice: 'yes', voterId: '87ab7b3d-2df0-4c35-a1d2-44184ef984d2', padding: 'x'.repeat(600) }),
		});
		expect(oversized.status).toBe(413);
	});

	it('stores only a hash and replaces the same installation vote', async () => {
		await createProductVotesTable();
		const voterId = '87ab7b3d-2df0-4c35-a1d2-44184ef984d2';
		for (const choice of ['yes', 'no']) {
			const res = await SELF.fetch(`${BASE}/api/votes/agents-beta`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ choice, voterId }),
			});
			expect(res.status).toBe(200);
			expect(await res.json<any>()).toEqual({ ok: true });
		}

		const rows = await typedEnv.ANALYTICS!.prepare(
			'SELECT voter_hash, choice FROM product_votes WHERE survey_id = ?'
		).bind('agents-beta-return').all<{ voter_hash: string; choice: string }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results[0].choice).toBe('no');
		expect(rows.results[0].voter_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(rows.results[0].voter_hash).not.toContain(voterId);
	});
});

describe('privacy-safe runtime adoption (/api/runtime-events)', () => {
	it('allows the editor to preflight a bounded JSON POST', async () => {
		const res = await SELF.fetch(`${BASE}/api/runtime-events`, {
			method: 'OPTIONS',
			headers: {
				origin: 'vscode-file://vscode-app',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
	});

	it('rejects arbitrary content, invalid IDs, and unclassified failures', async () => {
		const installationId = '87ab7b3d-2df0-4c35-a1d2-44184ef984d2';
		for (const body of [
			{ schemaVersion: 1, installationId, event: 'runtime_ready', commit: 'not-a-commit', productVersion: '1.4.9-0096', platform: PLATFORM, quality: QUALITY },
			{ schemaVersion: 1, installationId, event: 'runtime_ready', commit: 'abcdef0123456789abcdef0123456789abcdef01', productVersion: '1.4.9-0096', platform: PLATFORM, quality: QUALITY, prompt: 'never accept this' },
			{ schemaVersion: 1, installationId, event: 'ai_request_failed', commit: 'abcdef0123456789abcdef0123456789abcdef01', productVersion: '1.4.9-0096', platform: PLATFORM, quality: QUALITY, failureCode: 'raw provider message' },
		]) {
			const res = await SELF.fetch(`${BASE}/api/runtime-events`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(400);
		}
	});

	it('stores only a hash and rolls milestones into one bounded build row', async () => {
		await createRuntimeStateTable();
		const installationId = '87ab7b3d-2df0-4c35-a1d2-44184ef984d2';
		for (const event of ['app_launched', 'runtime_ready', 'ai_request_started', 'ai_response_succeeded']) {
			const res = await postRuntimeEvent(installationId, event);
			expect(res.status).toBe(202);
			expect(await res.json<any>()).toEqual({ ok: true });
		}

		const row = await typedEnv.ANALYTICS!.prepare(
			`SELECT installation_hash, commit_id, launched_at, runtime_ready_at,
			        ai_first_attempt_at, ai_first_success_at, event_count
			 FROM runtime_install_state`
		).first<Record<string, unknown>>();
		expect(row?.installation_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.installation_hash).not.toBe(installationId);
		expect(row?.commit_id).toBe('abcdef0123456789abcdef0123456789abcdef01');
		expect(row?.launched_at).toBeTypeOf('number');
		expect(row?.runtime_ready_at).toBeTypeOf('number');
		expect(row?.ai_first_attempt_at).toBeTypeOf('number');
		expect(row?.ai_first_success_at).toBeTypeOf('number');
		expect(row?.event_count).toBe(4);
		expect(JSON.stringify(row)).not.toContain(installationId);
	});

	it('returns aggregate build health without installation hashes', async () => {
		await createStatsTables();
		const successId = '87ab7b3d-2df0-4c35-a1d2-44184ef984d2';
		const quietId = '7fc49d70-6f06-4db7-8f6d-38cbc5ed98c2';
		const failedId = '038c0ca8-1903-4b42-9281-779a29d6ec98';
		for (const event of ['app_launched', 'runtime_ready', 'ai_request_started', 'ai_response_succeeded']) {
			expect((await postRuntimeEvent(successId, event)).status).toBe(202);
		}
		for (const event of ['app_launched', 'runtime_ready']) {
			expect((await postRuntimeEvent(quietId, event)).status).toBe(202);
		}
		expect((await postRuntimeEvent(failedId, 'ai_request_failed', { failureCode: 'network' })).status).toBe(202);

		const res = await SELF.fetch(`${BASE}/api/stats?days=30`, {
			headers: { 'x-admin-token': 'test-admin-token' },
		});
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.runtime_adoption).toMatchObject({
			available: true,
			installs_seen: 3,
			launched: 3,
			runtime_ready: 3,
			ai_attempted: 2,
			ai_succeeded: 1,
			never_attempted: 1,
			attempted_without_success: 1,
			failed_without_success: 1,
		});
		expect(body.runtime_adoption.builds).toHaveLength(1);
		expect(JSON.stringify(body.runtime_adoption)).not.toContain(successId);
		expect(JSON.stringify(body.runtime_adoption)).not.toMatch(/[0-9a-f]{64}/);
	});
});

describe('protected admin stats product-vote tally (/api/stats)', () => {
	it('rejects an unauthenticated tally read', async () => {
		const res = await SELF.fetch(`${BASE}/api/stats`);
		expect(res.status).toBe(401);
	});

	it('returns only aggregate yes/no counts and the latest vote time', async () => {
		await createStatsTables();
		await typedEnv.ANALYTICS!.prepare(
			`INSERT INTO product_votes (survey_id, voter_hash, choice, updated_at)
			 VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`
		).bind(
			'agents-beta-return', 'hash-a', 'yes', 1_000,
			'agents-beta-return', 'hash-b', 'yes', 3_000,
			'agents-beta-return', 'hash-c', 'no', 2_000,
		).run();

		const res = await SELF.fetch(`${BASE}/api/stats?token=test-admin-token&days=30`);
		expect(res.status).toBe(200);
		const body = await res.json<any>();
		expect(body.product_votes.agents_beta).toEqual({
			available: true,
			total: 3,
			yes: 2,
			no: 1,
			last_vote_at: 3_000,
		});
		expect(JSON.stringify(body.product_votes)).not.toContain('hash-a');
	});
});
