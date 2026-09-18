/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// V3Code MCP chat loop — drive the editor's REAL open chat from the terminal.
//
//   node scripts/chat-loop.mjs "your prompt here"      # one shot
//   node scripts/chat-loop.mjs                          # interactive REPL
//
// Flags:
//   --auto-approve        auto-approve tool-approval prompts (unattended loop)
//   --timeout <ms>        max wait per turn (default 180000)
//   --thread <id>         target a specific chat thread (default: the open one)
//   --new                 start a FRESH chat thread for the first message (clean
//                         context). In the REPL, type /new before a prompt to do
//                         the same mid-session.
//
// Reads ~/.v3code/endpoint.json (written by the editor when the MCP server
// starts) for the url + token, falls back to http://127.0.0.1:7333/mcp.
// Requires V3Code running with a workspace open.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
// Boolean flags take NO value — presence alone is true. Removing them must not
// consume the following token (that token is the prompt). Value flags consume
// exactly the next token.
const boolFlag = (name) => {
	const i = argv.indexOf(name);
	if (i === -1) { return false; }
	argv.splice(i, 1);
	return true;
};
const valFlag = (name, def) => {
	const i = argv.indexOf(name);
	if (i === -1) { return def; }
	const v = argv[i + 1];
	argv.splice(i, v !== undefined ? 2 : 1);
	return v !== undefined ? v : def;
};
const autoApprove = boolFlag('--auto-approve');
const newThreadFlag = boolFlag('--new');
const timeoutMs = String(valFlag('--timeout', '180000'));
const threadId = valFlag('--thread', undefined);
const oneShotPrompt = argv.join(' ').trim();

let url = 'http://127.0.0.1:7333/mcp';
let token = '';
try {
	const lock = JSON.parse(readFileSync(join(homedir(), '.v3code', 'endpoint.json'), 'utf8'));
	if (lock.url) { url = lock.url; }
	try { token = readFileSync(join(homedir(), '.v3code', 'mcp-token'), 'utf8').trim(); }
	catch { if (lock.token) { token = lock.token; } } // compatibility with pre-0093 descriptors
	console.log(`endpoint: ${url}  (workspaces: ${(lock.workspaces ?? []).join(', ') || 'none'})`);
} catch {
	console.log(`endpoint: ${url}  (no lockfile — using default)`);
}

let protocolVersion = '2025-06-18';
async function rpc(method, params, isNotification = false) {
	const body = { jsonrpc: '2.0', method, ...(isNotification ? {} : { id: Math.floor(Math.random() * 1e6) }), ...(params ? { params } : {}) };
	const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion };
	if (token) { headers['Authorization'] = `Bearer ${token}`; }
	const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
	if (isNotification) { return { status: res.status }; }
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); }
	catch { json = JSON.parse(text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')); }
	return { status: res.status, json };
}

async function handshake() {
	const init = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'chat-loop', version: '0' } });
	if (init.json?.result?.protocolVersion) { protocolVersion = init.json.result.protocolVersion; }
	await rpc('notifications/initialized', undefined, true);
	const list = await rpc('tools/list', {});
	const names = list.json?.result?.tools?.map(t => t.name) ?? [];
	if (!names.includes('send_chat')) {
		console.error(`\nThis V3Code build does not expose send_chat. Tools: ${names.join(', ') || 'none'}`);
		console.error('Rebuild + relaunch V3Code with the send_chat/get_chat tools.');
		process.exit(1);
	}
}

async function sendChat(message, newThread = false) {
	const args = { message, timeout_ms: timeoutMs, auto_approve: autoApprove ? 'true' : 'false' };
	if (threadId) { args.thread_id = threadId; }
	if (newThread) { args.new_thread = 'true'; }
	const t0 = Date.now();
	const call = await rpc('tools/call', { name: 'send_chat', arguments: args });
	const txt = call.json?.result?.content?.[0]?.text ?? JSON.stringify(call.json);
	const isErr = call.json?.result?.isError;
	console.log(`\n${'='.repeat(60)}\n${txt}\n${'='.repeat(60)}\n(${isErr ? 'isError ' : ''}${((Date.now() - t0) / 1000).toFixed(1)}s)`);
	return !isErr;
}

try {
	await handshake();
	if (oneShotPrompt) {
		const ok = await sendChat(oneShotPrompt, newThreadFlag);
		process.exit(ok ? 0 : 1);
	}
	console.log('\nInteractive chat loop. Type a prompt and press enter (Ctrl+C to quit).');
	console.log('Prefix a line with /new to start a fresh thread for that message.');
	const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\nyou> ' });
	rl.prompt();
	rl.on('line', async (line) => {
		let msg = line.trim();
		if (!msg) { rl.prompt(); return; }
		let fresh = false;
		if (msg.startsWith('/new')) { fresh = true; msg = msg.slice(4).trim(); }
		if (!msg) { rl.prompt(); return; }
		rl.pause();
		try { await sendChat(msg, fresh); } catch (e) { console.error('send_chat failed:', e.message); }
		rl.resume();
		rl.prompt();
	});
} catch (e) {
	console.error('\nCHAT LOOP FAILED:', e.message);
	console.error('Is V3Code running with this build, and has a workspace open?');
	process.exit(1);
}
