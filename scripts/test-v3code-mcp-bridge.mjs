/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { proxyMessage, selectEndpoint, workspaceMatchLength } from '../.v3code/mcp/v3code-mcp-bridge.mjs';

const now = new Date().toISOString();
const base = { pid: process.pid, channel: 'dev', startedAt: now, updatedAt: now };

test('selects the endpoint serving the client workspace', () => {
	const endpoints = [
		{ ...base, instanceId: 'dev-1', name: 'one', url: 'http://127.0.0.1:7333/mcp', appRoot: '/app/one', workspaces: ['/repo/one'] },
		{ ...base, instanceId: 'dev-2', name: 'two', url: 'http://127.0.0.1:7334/mcp', appRoot: '/app/two', workspaces: ['/repo/two'] },
	];
	assert.equal(workspaceMatchLength('/repo/two', '/repo/two/src'), path.resolve('/repo/two').length);
	assert.equal(selectEndpoint(endpoints, { workspace: '/repo/two/src' })?.instanceId, 'dev-2');
	assert.equal(selectEndpoint(endpoints, { instance: 'dev-1', workspace: '/repo/two/src' })?.instanceId, 'dev-1');
	assert.equal(selectEndpoint(endpoints, { instance: 'missing', workspace: '/repo/two/src' }), undefined);
});

test('proxies JSON-RPC through the registry without a fixed port', async () => {
	let authorization;
	const server = http.createServer((request, response) => {
		authorization = request.headers.authorization;
		let raw = '';
		request.setEncoding('utf8');
		request.on('data', chunk => { raw += chunk; });
		request.on('end', () => {
			const message = JSON.parse(raw);
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'v3code' } } }));
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('test server did not bind'); }

	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v3code-mcp-bridge-'));
	const endpoints = path.join(home, '.v3code', 'endpoints');
	fs.mkdirSync(endpoints, { recursive: true });
	fs.writeFileSync(path.join(home, '.v3code', 'mcp-token'), 'a'.repeat(48), { mode: 0o600 });
	fs.writeFileSync(path.join(endpoints, `dev-${process.pid}.json`), JSON.stringify({
		...base,
		instanceId: `dev-${process.pid}`,
		name: 'test editor',
		url: `http://127.0.0.1:${address.port}/mcp`,
		port: address.port,
		appRoot: '/test/app',
		workspaces: ['/test/workspace'],
	}));

	try {
		const body = await proxyMessage({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }, { home, workspace: '/test/workspace/src' });
		assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', id: 7, result: { serverInfo: { name: 'v3code' } } });
		assert.equal(authorization, `Bearer ${'a'.repeat(48)}`);
	} finally {
		await new Promise(resolve => server.close(resolve));
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test('a failed tool call is never repeated in another editor', async () => {
	let calls = 0;
	const server = http.createServer((_request, response) => { calls++; response.writeHead(500).end(); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v3code-mcp-retry-'));
	const endpoints = path.join(home, '.v3code', 'endpoints');
	fs.mkdirSync(endpoints, { recursive: true });
	for (const id of ['first', 'second']) {
		fs.writeFileSync(path.join(endpoints, `${id}.json`), JSON.stringify({ ...base, instanceId: id, url: `http://127.0.0.1:${server.address().port}/mcp/${id}`, workspaces: ['/fixture'] }));
	}
	try {
		await assert.rejects(proxyMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_memory' } }, { home, workspace: '/fixture' }), /HTTP 500/);
		assert.equal(calls, 1);
	} finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); }
});

test('the copied extension stdio process accepts a fast request while a slow tool is pending', { timeout: 10000 }, async () => {
	let slowResponse;
	let fastFinished = false;
	const finishSlow = () => {
		if (slowResponse && fastFinished) {
			const response = slowResponse; slowResponse = undefined;
			setTimeout(() => response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })), 20);
		}
	};
	const server = http.createServer((request, response) => {
		let raw = '';
		request.on('data', chunk => { raw += chunk; });
		request.on('end', () => {
			const message = JSON.parse(raw);
			if (message.id === 1) { slowResponse = response; finishSlow(); return; }
			response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
			fastFinished = true; finishSlow();
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v3code-mcp-parallel-'));
	fs.mkdirSync(path.join(home, '.v3code', 'endpoints'), { recursive: true });
	fs.writeFileSync(path.join(home, '.v3code', 'endpoints', 'fixture.json'), JSON.stringify({ ...base, instanceId: 'fixture', url: `http://127.0.0.1:${server.address().port}/mcp`, workspaces: ['/fixture'] }));
	const extensionServer = path.join(home, 'extension', 'server', 'v3code-mcp-bridge.mjs');
	fs.mkdirSync(path.dirname(extensionServer), { recursive: true });
	fs.copyFileSync(fileURLToPath(new URL('../.v3code/mcp/v3code-mcp-bridge.mjs', import.meta.url)), extensionServer);
	const child = spawn(process.execPath, [extensionServer], { env: { ...process.env, V3CODE_MCP_HOME: home, V3CODE_MCP_INSTANCE: 'fixture' } });
	let stdout = ''; let stderr = '';
	child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
	const exit = new Promise(resolve => child.on('close', resolve));
	const timer = setTimeout(() => child.kill(), 7000);
	try {
		child.stdin.end([1, 2].map(id => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fixture' } })).join('\n') + '\n');
		assert.equal(await exit, 0, stderr);
		assert.deepEqual(stdout.trim().split('\n').map(line => JSON.parse(line).id), [2, 1]);
	} finally {
		clearTimeout(timer); child.kill(); server.closeAllConnections();
		await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true });
	}
});
