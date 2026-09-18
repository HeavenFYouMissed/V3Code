/*---------------------------------------------------------------------------------------------
 *  Copyright (c) V3Code. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadOrCreateV3codeMcpToken, matchesV3codeMcpAuthorization } from '../../electron-main/v3codeMcpAuth.js';
import {
	buildV3codeCodexConfig,
	buildV3codeMcpClientConfig,
	buildV3codeMcpStdioClientConfig,
	buildV3codeMcpbManifest,
	getV3codeCodexConfigStatus,
	upsertV3codeCodexConfig,
	V3codeMcpBridgeLaunch,
} from '../../common/mcpExpose/mcpExposeTypes.js';

suite('V3Code MCP persistent authentication', () => {
	const bridge: V3codeMcpBridgeLaunch = {
		command: '/Applications/V3Code.app/Contents/MacOS/Electron',
		args: ['/Applications/V3Code.app/Contents/Resources/app/.v3code/mcp/v3code-mcp-bridge.mjs'],
		env: { ELECTRON_RUN_AS_NODE: '1', V3CODE_MCP_PREFERRED_APP_ROOT: '/Applications/V3Code.app/Contents/Resources/app' },
	};

	test('accepts the exact optional bearer credential and rejects wrong credentials', () => {
		const token = 'a'.repeat(48);
		assert.strictEqual(matchesV3codeMcpAuthorization(`Bearer ${token}`, token), true);
		assert.strictEqual(matchesV3codeMcpAuthorization(`Bearer ${token.slice(1)}`, token), false);
		assert.strictEqual(matchesV3codeMcpAuthorization(undefined, token), false);
	});

	test('Settings defaults to URL-only config and can build an authenticated variant', () => {
		const token = 'b'.repeat(48);
		const url = 'http://127.0.0.1:7333/mcp';
		const defaultConfig = JSON.parse(buildV3codeMcpClientConfig(url));
		assert.deepStrictEqual(defaultConfig, { mcpServers: { v3code: { url } } });
		const authenticatedConfig = JSON.parse(buildV3codeMcpClientConfig(url, token));
		const authorization = authenticatedConfig.mcpServers.v3code.headers.Authorization;
		assert.strictEqual(authorization, `Bearer ${token}`);
		assert.strictEqual(matchesV3codeMcpAuthorization(authorization, token), true);
		assert.throws(() => buildV3codeMcpClientConfig(url, 'undefined'));
	});

	test('builds a portable stdio config instead of pinning one HTTP port', () => {
		const parsed = JSON.parse(buildV3codeMcpStdioClientConfig(bridge));
		assert.deepStrictEqual(parsed.mcpServers.v3code, bridge);
		assert.ok(!JSON.stringify(parsed).includes('7333'));
	});

	test('repairs only the V3Code Codex table and is idempotent', () => {
		const old = [
			'model = "gpt-5.6-sol"',
			'',
			'[mcp_servers.github]',
			'url = "https://example.test/mcp"',
			'',
			'[mcp_servers.v3code]',
			'url = "http://127.0.0.1:7333/mcp"',
			'',
			'[mcp_servers.v3code.headers]',
			'Authorization = "Bearer old"',
			'',
			'[features]',
			'multi_agent = true',
		].join('\n');
		assert.strictEqual(getV3codeCodexConfigStatus(old, bridge), 'stale');
		const updated = upsertV3codeCodexConfig(old, bridge);
		assert.ok(updated.includes('[mcp_servers.github]'));
		assert.ok(updated.includes('[features]'));
		assert.ok(updated.includes(buildV3codeCodexConfig(bridge).trim()));
		assert.ok(!updated.includes('7333'));
		assert.ok(!updated.includes('Bearer old'));
		assert.strictEqual(upsertV3codeCodexConfig(updated, bridge), updated);
		assert.strictEqual(getV3codeCodexConfigStatus(updated, bridge), 'current');
	});

	test('builds a Claude Desktop MCPB v0.3 manifest', () => {
		const manifest = JSON.parse(buildV3codeMcpbManifest('1.4.9'));
		assert.strictEqual(manifest.manifest_version, '0.3');
		assert.strictEqual(manifest.server.type, 'node');
		assert.strictEqual(manifest.server.entry_point, 'server/v3code-mcp-bridge.mjs');
		assert.ok(manifest.server.mcp_config.args[0].includes('${__dirname}'));
	});

	test('creates one stable owner-only token', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3code-mcp-auth-'));
		const file = path.join(dir, 'nested', 'mcp-token');
		try {
			const first = loadOrCreateV3codeMcpToken(file);
			assert.match(first, /^[a-f0-9]{48}$/);
			assert.strictEqual(loadOrCreateV3codeMcpToken(file), first);
			if (process.platform !== 'win32') { assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600); }
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('repairs malformed generated token state', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3code-mcp-auth-repair-'));
		const file = path.join(dir, 'mcp-token');
		try {
			fs.writeFileSync(file, '');
			const repaired = loadOrCreateV3codeMcpToken(file);
			assert.match(repaired, /^[a-f0-9]{48}$/);
			assert.strictEqual(loadOrCreateV3codeMcpToken(file), repaired);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
