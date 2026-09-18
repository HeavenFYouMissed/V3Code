/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedProxy, selectEndpoint } from '../.v3code/mcp/v3code-mcp-bridge.mjs';

function fixture(options = {}) {
	const calls = [];
	let projects = [{ window_id: 'one', roots: ['/workspace'] }];
	const request = async message => {
		calls.push(message);
		let result = {};
		if (message.method === 'initialize') { result = { instructions: 'old ritual' }; }
		if (message.method === 'tools/list') { result = { tools: ['read_file', 'remember', 'open_browser_page', 'select_project'].map(name => ({ name, inputSchema: { properties: { session_token: {}, path: {} } } })) }; }
		if (message.params?.name === 'list_projects') { result = { structuredContent: { projects } }; }
		if (message.params?.name === 'agent_session') { result = { structuredContent: { session_token: 'fixture-private' } }; }
		return JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
	};
	return { calls, proxy: createManagedProxy({ workspace: '/workspace', memoryIndex: true, browserAccess: false, ...options }, request), setProjects: value => { projects = value; } };
}
const call = name => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

test('managed instance never falls back to another editor', () => {
	assert.equal(selectEndpoint([{ pid: 1, url: 'http://127.0.0.1:1234' }], { parentPid: '2' }), undefined);
});
test('memory tools only, with no exposed notebook token', async () => {
	const f = fixture();
	const result = JSON.parse(await f.proxy({ method: 'tools/list' })).result;
	assert.deepEqual(result.tools.map(t => t.name), ['read_file', 'remember']);
	assert.equal(result.tools[0].inputSchema.properties.session_token, undefined);
});
test('browser can be enabled without memory', async () => {
	const f = fixture({ memoryIndex: false, browserAccess: true });
	assert.deepEqual(JSON.parse(await f.proxy({ method: 'tools/list' })).result.tools.map(t => t.name), ['open_browser_page']);
});
test('disabled browser calls fail before contacting editor', async () => {
	const f = fixture();
	await assert.rejects(f.proxy(call('open_browser_page')), /not enabled/);
	assert.equal(f.calls.length, 0);
});
test('workspace changes are never silently followed', async () => {
	const f = fixture();
	await f.proxy(call('read_file'));
	f.setProjects([{ window_id: 'two', roots: ['/workspace'] }]);
	await assert.rejects(f.proxy(call('read_file')), /workspace changed/);
});
test('ambiguous windows fail closed', async () => {
	const f = fixture();
	f.setProjects([{ window_id: 'one', roots: ['/workspace'] }, { window_id: 'two', roots: ['/workspace'] }]);
	await assert.rejects(f.proxy(call('read_file')), /No unique window/);
});
test('concurrent calls share only their connection notebook', async () => {
	const f = fixture();
	await Promise.all([f.proxy(call('read_file')), f.proxy(call('remember'))]);
	assert.equal(f.calls.filter(c => c.params?.name === 'agent_session').length, 1);
	assert.equal(f.calls.at(-1).params.arguments.session_token, 'fixture-private');
});
test('managed instructions remove setup ritual', async () => {
	assert.ok(JSON.parse(await fixture().proxy({ method: 'initialize' })).result.instructions.includes('Notebook routing is automatic'));
});

test('browser consent request uses managed connection identity, not tool arguments', async () => {
	const f = fixture({ browserAccess: true, agentId: 'fixture-agent' });
	const message = call('read_page');
	message.params.arguments.browser_agent_id = 'spoofed-agent';
	await f.proxy(message);
	const setup = f.calls.find(c => c.params?.name === 'agent_session');
	assert.equal(setup.params.arguments.browser_agent_id, 'fixture-agent');
});

test('browser disabled never requests a browser grant', async () => {
	const f = fixture({ browserAccess: false, agentId: 'fixture-agent' });
	await f.proxy(call('read_file'));
	assert.equal(f.calls.find(c => c.params?.name === 'agent_session').params.arguments.browser_agent_id, undefined);
});
