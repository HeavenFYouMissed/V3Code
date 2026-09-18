/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Never reads user endpoint descriptors, connects to a real editor, opens the
// Electron GUI, or changes MCP configuration. Only a temporary local fixture.
export async function smokeMcpBridge(runtime, bridge) {
	const probeHome = mkdtempSync(join(tmpdir(), 'v3code-mcp-package-probe-'));
	let requests = 0;
	const server = createServer((request, response) => {
		let body = '';
		request.on('data', chunk => { body += chunk; });
		request.on('end', () => {
			try {
				const message = JSON.parse(body);
				assert.equal(message.id, 97);
				assert.equal(message.method, 'initialize');
				requests++;
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { packageBridgeProbe: true } }));
			} catch (error) {
				response.writeHead(400);
				response.end(String(error));
			}
		});
	});
	try {
		await new Promise((accept, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', accept);
		});
		const descriptors = join(probeHome, '.v3code', 'endpoints');
		mkdirSync(descriptors, { recursive: true });
		writeFileSync(join(descriptors, 'probe.json'), JSON.stringify({
			pid: process.pid, instanceId: 'release-probe', workspaces: [probeHome],
			url: `http://127.0.0.1:${server.address().port}/mcp`, updatedAt: new Date().toISOString(),
		}));
		const reply = await new Promise((accept, reject) => {
			const child = spawn(runtime, [bridge], {
				cwd: probeHome,
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', V3CODE_MCP_HOME: probeHome,
					V3CODE_MCP_WORKSPACE: probeHome, V3CODE_MCP_INSTANCE: 'release-probe', V3CODE_MCP_PREFERRED_APP_ROOT: '' },
				stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
			});
			let stdout = '', stderr = '';
			const timer = setTimeout(() => { child.kill(); reject(new Error('packaged MCP bridge timed out')); }, 15000);
			child.stdout.on('data', chunk => { stdout += chunk; });
			child.stderr.on('data', chunk => { stderr += chunk; });
			child.stdin.on('error', () => { /* exit/error handler reports failed startup */ });
			child.once('error', error => { clearTimeout(timer); reject(error); });
			child.once('close', code => {
				clearTimeout(timer);
				if (code !== 0) { reject(new Error(`packaged MCP bridge exited ${code}: ${stderr}`)); }
				else { accept(stdout); }
			});
			child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 97, method: 'initialize', params: {} }) + '\n');
		});
		assert.equal(requests, 1, 'bridge must reach the isolated endpoint exactly once');
		assert.deepEqual(JSON.parse(reply.trim()), { jsonrpc: '2.0', id: 97, result: { packageBridgeProbe: true } });
	} finally {
		server.closeAllConnections();
		await new Promise(accept => server.close(accept));
		rmSync(probeHome, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	assert.ok(['darwin', 'win32'].includes(process.platform), 'packaged runtime smoke supports macOS and Windows');
	const rootIndex = process.argv.indexOf('--root');
	assert.ok(rootIndex > 0 && process.argv[rootIndex + 1], 'usage: mcp-bridge-smoke.mjs --root <packaged app>');
	const root = resolve(process.argv[rootIndex + 1]);
	const mac = process.platform === 'darwin';
	const appRoot = join(root, mac ? 'Contents/Resources/app' : 'resources/app');
	const product = JSON.parse(readFileSync(join(appRoot, 'product.json'), 'utf8'));
	const runtime = join(root, mac ? `Contents/MacOS/${product.nameShort}` : `${product.nameShort}.exe`);
	await smokeMcpBridge(runtime, join(appRoot, '.v3code/mcp/v3code-mcp-bridge.mjs'));
	console.log('PASS packaged MCP bridge: Electron-as-Node -> stdio -> isolated HTTP fixture; no GUI or user configuration touched');
}
