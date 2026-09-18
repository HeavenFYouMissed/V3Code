/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createServer, Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpLocalStore } from '../../electron-main/mcpLocalStore.js';
import { createMcpToolProtocol } from '../../electron-main/mcpToolProtocol.js';
import { boundMcpText } from '../../common/mcpExpose/localCollaboration.js';

suite('MCP local collaboration HTTP protocol', () => {
	let dir: string;
	let store: McpLocalStore;
	let http: Server;
	let url: URL;
	const clients: Client[] = [];
	async function client(authenticated = true): Promise<Client> {
		const client = new Client({ name: 'test-local-agent', version: '1' });
		await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: authenticated ? { Authorization: 'Bearer fixture' } : {} } }));
		clients.push(client); return client;
	}
	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'v3code-mcp-http-'));
		store = new McpLocalStore(join(dir, 'memory.sqlite'));
		http = createServer(async (req, res) => {
			if (req.method !== 'POST') { res.writeHead(405).end(); return; }
			const chunks: Buffer[] = [];
			for await (const chunk of req) { chunks.push(Buffer.from(chunk)); }
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
			const protocol = createMcpToolProtocol({
				listCodeTools: async () => [{ name: 'find_text', description: 'Fixture code tool', inputSchema: { type: 'object', properties: {} } }],
				localCall: async (name, args) => name === 'agent_session' && args.action === 'open'
					? { ...await store.createSession('fixture-project', String(args.label)) } : store.execute(name, args),
				codeCall: async () => ({ text: 'Fixture: exact file match' }),
			}, req.headers.authorization === 'Bearer fixture', 'fixture', 'Local collaboration test');
			res.on('close', () => { void protocol.close(); void transport.close(); });
			await protocol.connect(transport);
			await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')));
		});
		await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
		const address = http.address();
		assert.ok(address && typeof address !== 'string');
		url = new URL(`http://127.0.0.1:${address.port}/mcp`);
	});
	teardown(async () => {
		await Promise.all(clients.splice(0).map(client => client.close()));
		http.closeAllConnections();
		await new Promise<void>((resolve, reject) => http.close(err => err ? reject(err) : resolve()));
		await store.close(); await fs.rm(dir, { recursive: true, force: true });
	});

	test('advertises collaboration schemas and a session-aware code schema', async () => {
		const c = await client(); const result = await c.listTools();
		assert.ok(result.tools.some(t => t.name === 'agent_message'));
		assert.ok(result.tools.some(t => t.name === 'project_operation'));
		assert.ok(result.tools.find(t => t.name === 'find_text')?.inputSchema.properties?.session_token);
	});
	test('unauthenticated client can use legacy code tools but cannot create a notebook', async () => {
		const c = await client(false);
		assert.strictEqual((await c.callTool({ name: 'find_text', arguments: {} })).isError, false);
		assert.strictEqual((await c.callTool({ name: 'agent_session', arguments: { action: 'open', label: 'unpaired' } })).isError, true);
	});
	test('browser tools require both authentication and a workspace token', async () => {
		const unpaired = await client(false);
		assert.strictEqual((await unpaired.callTool({ name: 'open_browser_page', arguments: { session_token: 'fixture' } })).isError, true);
		const paired = await client();
		assert.strictEqual((await paired.callTool({ name: 'open_browser_page', arguments: {} })).isError, true);
	});
	test('two real HTTP clients coordinate and read shared evidence through MCP', async () => {
		const a = await client(); const b = await client();
		const aSession = (await a.callTool({ name: 'agent_session', arguments: { action: 'open', label: 'Agent A' } })).structuredContent as { actor: string; session_token: string };
		const bSession = (await b.callTool({ name: 'agent_session', arguments: { action: 'open', label: 'Agent B' } })).structuredContent as { actor: string; session_token: string };
		const call = (c: Client, session_token: string, name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: { session_token, request_id: randomUUID(), ...args } });
		const claimed = await call(a, aSession.session_token, 'agent_board', { action: 'claim', task_id: 'terminal', doing: 'Inspecting terminal cleanup' });
		assert.strictEqual(claimed.isError, false);
		assert.strictEqual((await call(b, bSession.session_token, 'agent_board', { action: 'claim', task_id: 'terminal', doing: 'Conflicting claim' })).isError, true);
		const saved = await call(a, aSession.session_token, 'agent_memory', { action: 'save', title: 'Terminal evidence', body: 'Preserve reusable terminal ownership.', category: 'discovery', visibility: 'project' });
		assert.strictEqual(saved.isError, false);
		await call(a, aSession.session_token, 'agent_message', { action: 'send', to: bSession.actor, body: 'The terminal ownership note is ready to review.' });
		const inbox = (await call(b, bSession.session_token, 'agent_message', { action: 'inbox' })).structuredContent as { messages: { id: string }[] };
		assert.strictEqual(inbox.messages.length, 1);
		const memory = (await call(b, bSession.session_token, 'agent_memory', { action: 'search', query: 'terminal ownership' })).structuredContent as { matches: unknown[] };
		assert.strictEqual(memory.matches.length, 1);
		assert.strictEqual((await call(b, bSession.session_token, 'agent_message', { action: 'ack', id: inbox.messages[0].id })).isError, false);
		const fresh = await client();
		const resumed = await call(fresh, aSession.session_token, 'agent_session', { action: 'resume' });
		assert.strictEqual(resumed.isError, false);
		assert.strictEqual((resumed.structuredContent as { tasks: unknown[] }).tasks.length, 1);
	});
	test('response budget is explicit and never exceeded', () => {
		const bounded = boundMcpText('line\n'.repeat(5000), 2000);
		assert.ok(bounded.length <= 2000);
		assert.ok(bounded.includes('TRUNCATED'));
		assert.strictEqual(boundMcpText('small', 2000), 'small');
	});
});
