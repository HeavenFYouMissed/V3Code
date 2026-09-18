/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpLocalStore } from '../../electron-main/mcpLocalStore.js';

suite('MCP local collaboration durable store', () => {
	let dir: string;
	let store: McpLocalStore;
	let a: string;
	let b: string;
	let bId: string;
	let time: number;
	const request = () => randomUUID();
	const save = (token: string, extra: Record<string, unknown> = {}) => store.execute('agent_memory', {
		action: 'save', session_token: token, request_id: request(), title: 'Terminal cleanup', body: 'Persistent terminals survive command completion.', category: 'discovery', ...extra,
	});
	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'v3code-mcp-store-'));
		time = 1000000;
		store = new McpLocalStore(join(dir, 'memory.sqlite'), () => time);
		a = (await store.createSession('project-a', 'First agent')).session_token;
		const second = await store.createSession('project-a', 'Second agent');
		b = second.session_token; bId = second.actor;
	});
	teardown(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });

	test('inbox cursor does not skip messages when the previous page is acknowledged', async () => {
		for (let i = 0; i < 12; i++) { await store.execute('agent_message', { action: 'send', session_token: a, request_id: request(), to: bId, body: `Message ${i}` }); }
		const page = await store.execute('agent_message', { action: 'inbox', session_token: b });
		for (const message of page.messages as { id: string }[]) { await store.execute('agent_message', { action: 'ack', session_token: b, request_id: request(), id: message.id }); }
		const next = await store.execute('agent_message', { action: 'inbox', session_token: b, cursor: page.next_cursor });
		assert.strictEqual((next.messages as unknown[]).length, 2);
	});
	test('search previews are bounded while full and historical reads retain evidence', async () => {
		const note = await save(a, { body: 'terminal '.repeat(800) });
		const matches = (await store.execute('agent_memory', { action: 'search', session_token: a, query: 'terminal' })).matches as { payload: { body: string; truncated: boolean } }[];
		assert.strictEqual(matches[0].payload.body.length, 500);
		assert.strictEqual(matches[0].payload.truncated, true);
		await save(a, { id: note.saved, expected_revision: 1, visibility: 'project', body: 'Corrected public terminal note' });
		const historical = await store.execute('agent_memory', { action: 'read', session_token: a, id: note.saved, revision: 1 });
		assert.strictEqual(historical.historical, true);
		await assert.rejects(store.execute('agent_memory', { action: 'read', session_token: b, id: note.saved, revision: 1 }), /Revision not found/);
	});
	test('workspace switch receipt survives reopen and refuses duplicate changes', async () => {
		const operation = await store.beginSwitch(a, 'switch-1', '/fixture/project', 'replace');
		assert.strictEqual(operation.fresh, true);
		await store.close(); store = new McpLocalStore(join(dir, 'memory.sqlite'));
		assert.strictEqual((await store.beginSwitch(a, 'switch-1', '/fixture/project', 'replace')).fresh, false);
		assert.strictEqual((await store.readSwitch(a, 'switch-1')).state, 'pending');
		await assert.rejects(store.beginSwitch(a, 'switch-1', '/different', 'replace'), /different workspace/);
		await store.finishSwitch(a, 'switch-1', { state: 'unconfirmed' });
		assert.strictEqual((await store.readSwitch(a, 'switch-1')).state, 'unconfirmed');
		await assert.rejects(store.readSwitch(b, 'switch-1'), /not found/);
	});
	test('private memory stays private; explicit shared memory is visible to another agent and editor', async () => {
		const privateNote = await save(a);
		await assert.rejects(store.execute('agent_memory', { action: 'read', session_token: b, id: privateNote.saved }), /not found/);
		assert.strictEqual((await store.shared('project-a')).memories.length, 0);
		await save(a, { visibility: 'project' });
		assert.strictEqual((await store.shared('project-a')).memories.length, 1);
		const matches = await store.execute('agent_memory', { action: 'search', session_token: b, query: 'persistent terminals' });
		assert.strictEqual((matches.matches as unknown[]).length, 1);
	});
	test('another project cannot read even a shared note by guessed ID', async () => {
		const note = await save(a, { visibility: 'project' });
		const outsider = await store.createSession('other-project', 'Other');
		await assert.rejects(store.execute('agent_memory', { action: 'read', session_token: outsider.session_token, id: note.saved }), /not found/);
	});
	test('committed save and identity survive closing and reopening the real database', async () => {
		const note = await save(a);
		await store.close(); store = new McpLocalStore(join(dir, 'memory.sqlite'), () => time);
		const read = await store.execute('agent_memory', { action: 'read', session_token: a, id: note.saved });
		assert.strictEqual((read.record as { revision: number }).revision, 1);
	});
	test('same request retries without duplicating memory; mismatched request reuse is rejected', async () => {
		const request_id = request();
		const first = await save(a, { request_id });
		assert.deepStrictEqual(await save(a, { request_id }), first);
		await assert.rejects(save(a, { request_id, body: 'different' }), /different operation/);
	});
	test('revision checked correction replaces old search text', async () => {
		const note = await save(a, { body: 'Old conclusion: zebracleanup.' });
		await save(a, { id: note.saved, expected_revision: 1, body: 'Corrected: violetcleanup.' });
		await assert.rejects(save(a, { id: note.saved, expected_revision: 1 }), /revision conflict/);
		const old = await store.execute('agent_memory', { action: 'search', session_token: a, query: 'zebracleanup' });
		assert.deepStrictEqual(old.matches, []);
		const updated = await store.execute('agent_memory', { action: 'search', session_token: a, query: 'violetcleanup' });
		assert.strictEqual((updated.matches as unknown[]).length, 1);
	});
	test('non-owner cannot update or delete project-visible notes', async () => {
		const note = await save(a, { visibility: 'project' });
		await assert.rejects(save(b, { id: note.saved, expected_revision: 1 }), /ownership/);
		await assert.rejects(store.execute('agent_memory', { action: 'delete', session_token: b, request_id: request(), id: note.saved, expected_revision: 1 }), /ownership/);
	});
	test('deletion removes source and searchable text', async () => {
		const note = await save(a);
		await store.execute('agent_memory', { action: 'delete', session_token: a, request_id: request(), id: note.saved, expected_revision: 1 });
		await assert.rejects(store.execute('agent_memory', { action: 'read', session_token: a, id: note.saved }), /not found/);
		assert.deepStrictEqual((await store.execute('agent_memory', { action: 'search', session_token: a, query: 'terminal' })).matches, []);
	});
	test('nonsense and generic stopword queries abstain', async () => {
		await save(a);
		for (const query of ['zqxv9217nonesuch', 'zebra quartz nonexistent calibration decision', 'what is it']) {
			assert.deepStrictEqual((await store.execute('agent_memory', { action: 'search', session_token: a, query })).matches, []);
		}
	});
	test('matching words deep in a saved note are searchable', async () => {
		await save(a, { body: Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ') + ' durablemarker' });
		assert.strictEqual(((await store.execute('agent_memory', { action: 'search', session_token: a, query: 'durablemarker' })).matches as unknown[]).length, 1);
	});
	test('two clients racing a claim get exactly one owner', async () => {
		const claims = await Promise.allSettled([a, b].map(token => store.execute('agent_board', { action: 'claim', session_token: token, request_id: request(), task_id: 'terminal', doing: 'investigating' })));
		assert.strictEqual(claims.filter(c => c.status === 'fulfilled').length, 1);
		assert.strictEqual(claims.filter(c => c.status === 'rejected').length, 1);
	});
	test('cross-connection SQLite claims are atomic', async () => {
		const other = new McpLocalStore(join(dir, 'memory.sqlite'), () => time);
		try {
			const claims = await Promise.allSettled([store, other].map((db, i) => db.execute('agent_board', { action: 'claim', session_token: i ? b : a, request_id: request(), task_id: 'same-task', doing: 'testing' })));
			assert.strictEqual(claims.filter(c => c.status === 'fulfilled').length, 1);
		} finally { await other.close(); }
	});
	test('expired lease is reclaimable and fences the late writer', async () => {
		await store.execute('agent_board', { action: 'claim', session_token: a, request_id: request(), task_id: 'terminal', doing: 'working' });
		time += 300001;
		await store.execute('agent_board', { action: 'claim', session_token: b, request_id: request(), task_id: 'terminal', doing: 'taking over' });
		await assert.rejects(store.execute('agent_board', { action: 'update', session_token: a, request_id: request(), task_id: 'terminal', expected_revision: 1, status: 'done', doing: 'late writer' }), /conflict/);
	});
	test('completed task stays on the board with evidence', async () => {
		await store.execute('agent_board', { action: 'claim', session_token: a, request_id: request(), task_id: 'terminal', doing: 'working' });
		await store.execute('agent_board', { action: 'update', session_token: a, request_id: request(), task_id: 'terminal', expected_revision: 1, status: 'done', doing: 'finished', evidence: 'test result 12 passing' });
		const board = await store.shared('project-a');
		assert.strictEqual(board.tasks[0].payload.status, 'done');
		assert.strictEqual(board.tasks[0].payload.evidence, 'test result 12 passing');
	});
	test('addressed messages are durable, private and explicitly acknowledged', async () => {
		const sent = await store.execute('agent_message', { action: 'send', session_token: a, request_id: request(), to: bId, body: 'Check terminal cleanup before changing this function.' });
		const ownInbox = await store.execute('agent_message', { action: 'inbox', session_token: a });
		assert.deepStrictEqual(ownInbox.messages, []);
		await store.close(); store = new McpLocalStore(join(dir, 'memory.sqlite'), () => time);
		const inbox = await store.execute('agent_message', { action: 'inbox', session_token: b });
		assert.strictEqual((inbox.messages as unknown[]).length, 1);
		await assert.rejects(store.execute('agent_message', { action: 'ack', session_token: a, request_id: request(), id: sent.sent }), /recipient/);
		await store.execute('agent_message', { action: 'ack', session_token: b, request_id: request(), id: sent.sent });
		assert.deepStrictEqual((await store.execute('agent_message', { action: 'inbox', session_token: b })).messages, []);
	});
	test('revoked credentials cannot read or write; display name is not authentication', async () => {
		await store.execute('agent_session', { action: 'revoke', session_token: a });
		await assert.rejects(save(a), /revoked/);
		await assert.rejects(store.resolve('First agent'), /revoked/);
	});
	test('failed transactions do not poison subsequent writes', async () => {
		await assert.rejects(save(a, { category: 'made-up' }), /category/);
		assert.strictEqual((await save(a)).durable, true);
	});
});
