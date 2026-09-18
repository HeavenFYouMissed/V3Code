/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_REPO_ROOT, loadArtifactManifest, resolvePlatformConfig } from './runtime-asset-contract.mjs';
import { smokeMcpBridge } from './mcp-bridge-smoke.mjs';

test('MCP package assertions require the current stable-bridge UI on both platforms', () => {
	const source = readFileSync(join(DEFAULT_REPO_ROOT, 'src/vs/workbench/contrib/void/browser/react/src/void-settings-tsx/tabs/McpTab.tsx'), 'utf8');
	const manifest = loadArtifactManifest();
	const currentCopy = ['Universal stable config', 'Copy the stable stdio definition'];
	let firstPatterns;
	for (const platform of ['darwin-arm64', 'win32-x64']) {
		const config = resolvePlatformConfig(manifest, platform);
		const entry = config.content.find(check => check.id === 'renderer-mcp-current-ui-and-tools');
		assert.ok(entry, `${platform}: MCP renderer gate must exist`);
		for (const pattern of currentCopy) {
			assert.ok(source.includes(pattern), `current MCP source no longer contains: ${pattern}`);
			assert.ok(entry.requiredPatterns.includes(pattern), `${platform}: missing current MCP UI assertion: ${pattern}`);
		}
		assert.ok(!entry.requiredPatterns.includes('URL-only config below'), 'retired fixed-endpoint copy must not gate a stable-bridge package');
		for (const tool of ['get_memory_checkpoint', 'deep_recall', 'impact_trace']) {
			assert.ok(entry.requiredPatterns.includes(tool), `${platform}: exposed-tool assertion must remain: ${tool}`);
		}
		if (firstPatterns) {
			assert.deepEqual(entry.requiredPatterns, firstPatterns, 'platform MCP package assertions must match');
		} else {
			firstPatterns = entry.requiredPatterns;
		}
	}
});

test('all package cleanup allowlists preserve the bridge and the manifest requires it', () => {
	const manifest = loadArtifactManifest();
	for (const platform of Object.keys(manifest.platforms)) {
		const config = resolvePlatformConfig(manifest, platform);
		const bridge = config.artifacts.find(artifact => artifact.id === 'mcp-stdio-bridge');
		assert.ok(bridge?.shared, `${platform}: bridge must be a required shared artifact`);
		assert.ok(bridge.path.endsWith('/app/.v3code/mcp/v3code-mcp-bridge.mjs'));
		assert.ok(bridge.minBytes >= 3000, 'empty bridge placeholders must fail');
	}
	for (const platform of ['mac', 'win32', 'linux']) {
		const script = readFileSync(join(DEFAULT_REPO_ROOT, `scripts/v3-package-${platform}.sh`), 'utf8');
		const cleanup = script.split('\n').filter(line => line.includes('find "$V3CODE_BUNDLED"') && line.includes('-exec rm'));
		assert.equal(cleanup.length, 1);
		for (const directory of ['skills', 'rules', 'mcp']) {
			assert.ok(cleanup[0].includes(`! -name ${directory} `), `${platform}: cleanup deletes ${directory}`);
		}
		const fixture = mkdtempSync(join(tmpdir(), 'v3code-content-retention-'));
		try {
			for (const directory of ['skills', 'rules', 'mcp', 'browser-sessions']) {
				mkdirSync(join(fixture, '.v3code', directory), { recursive: true });
			}
			writeFileSync(join(fixture, '.v3code/mcp/v3code-mcp-bridge.mjs'), 'bridge fixture');
			writeFileSync(join(fixture, '.v3code/active-plan.json'), '{}');
			// Run the actual cleanup command with a relative path inside this new fixture,
			// so it is portable to Git Bash and cannot touch a workspace or user profile.
			execFileSync('bash', ['-c', cleanup[0]], { cwd: fixture, env: { ...process.env, V3CODE_BUNDLED: '.v3code' } });
			for (const directory of ['skills', 'rules', 'mcp']) {
				assert.ok(existsSync(join(fixture, '.v3code', directory)));
			}
			assert.ok(existsSync(join(fixture, '.v3code/mcp/v3code-mcp-bridge.mjs')));
			assert.equal(existsSync(join(fixture, '.v3code/browser-sessions')), false);
			assert.equal(existsSync(join(fixture, '.v3code/active-plan.json')), false);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	}
});

test('source MCP bridge completes an isolated stdio to HTTP round trip', async () => {
	await smokeMcpBridge(process.execPath, join(DEFAULT_REPO_ROOT, '.v3code/mcp/v3code-mcp-bridge.mjs'));
});

test('MCP bridge starts when the client launches it through a directory alias', async () => {
	const fixture = mkdtempSync(join(tmpdir(), 'v3code-bridge-alias-'));
	try {
		// Directory junctions do not need developer-mode privileges on Windows.
		symlinkSync(join(DEFAULT_REPO_ROOT, '.v3code/mcp'), join(fixture, 'alias'), 'junction');
		await smokeMcpBridge(process.execPath, join(fixture, 'alias/v3code-mcp-bridge.mjs'));
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
