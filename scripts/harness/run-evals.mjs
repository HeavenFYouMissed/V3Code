/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// V3Code agent eval harness — fire saved prompt-sets at the REAL open chat over
// MCP (send_chat), capture each turn's transcript, run objective checks, and
// save a timestamped result so runs are comparable across tuning changes / models.
//
//   node scripts/harness/run-evals.mjs                 # run every set in sets/
//   node scripts/harness/run-evals.mjs tool-accuracy   # run one set by id
//   node scripts/harness/run-evals.mjs a b c           # run several by id
//
// Flags:
//   --label <name>     tag this run (e.g. the model under test) in the saved result
//   --judge-cmd <cmd>  external grader for "judge" checks: receives a JSON
//                      {rubric, transcript} on stdin, must print a line
//                      "SCORE: <0-10>" (+ optional reasoning). Use a DIFFERENT
//                      model than the one under test to avoid self-preference bias.
//   --keep-thread      do NOT force a fresh thread at each set's start
//
// A prompt-set is sets/<id>.json:
//   {
//     "id": "long-memory",
//     "description": "…",
//     "newThreadAtStart": true,        // start clean (default true)
//     "autoApprove": true,             // auto-approve tool prompts (default true)
//     "timeoutMs": 180000,             // per-turn cap (default 180000)
//     "turns": [
//       { "send": "…", "checks": [ {type, …} ] },
//       …
//     ]
//   }
//
// Check types (evaluated against THAT turn's transcript text):
//   { "type": "status", "equals": "completed" }
//   { "type": "contains_all", "values": ["a","b"], "ci": true }
//   { "type": "contains_any", "values": ["a","b"], "ci": true }
//   { "type": "not_contains", "values": ["a"], "ci": true }
//   { "type": "regex", "pattern": "…", "flags": "i" }
//   { "type": "tool_used", "tool": "find_text" }
//   { "type": "tool_first", "tool": "find_text" }          // first tool call must be this
//   { "type": "no_tools" }                                  // no tool calls this turn
//   { "type": "judge", "rubric": "…", "min": 7 }            // needs --judge-cmd

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETS_DIR = join(HERE, 'sets');
const RESULTS_DIR = join(HERE, 'results');
const REPO_ROOT = join(HERE, '..', '..');

// ---- args ----
const argv = process.argv.slice(2);
const valFlag = (name, def) => {
	const i = argv.indexOf(name);
	if (i === -1) { return def; }
	const v = argv[i + 1];
	argv.splice(i, v !== undefined ? 2 : 1);
	return v !== undefined ? v : def;
};
const boolFlag = (name) => {
	const i = argv.indexOf(name);
	if (i === -1) { return false; }
	argv.splice(i, 1);
	return true;
};
const label = valFlag('--label', '');
const judgeCmd = valFlag('--judge-cmd', '');
const keepThread = boolFlag('--keep-thread');
const onlyIds = argv.filter(a => !a.startsWith('--'));

// ---- endpoint ----
let url = 'http://127.0.0.1:7333/mcp';
let token = '';
let workspaces = [];
try {
	const lock = JSON.parse(readFileSync(join(homedir(), '.v3code', 'endpoint.json'), 'utf8'));
	if (lock.url) { url = lock.url; }
	try { token = readFileSync(join(homedir(), '.v3code', 'mcp-token'), 'utf8').trim(); }
	catch { if (lock.token) { token = lock.token; } } // compatibility with pre-0093 descriptors
	workspaces = lock.workspaces ?? [];
} catch { /* default */ }

function expandHarnessTemplate(str) {
	if (!str || !str.includes('{{')) {
		return str;
	}
	const workspace = workspaces[0] ?? '';
	const fixtureFileUrl = `file://${REPO_ROOT}/scripts/harness/fixtures/browser/index.html`;
	return str
		.replace(/\{\{workspace\}\}/g, workspace)
		.replace(/\{\{fixture_file_url\}\}/g, fixtureFileUrl);
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
	const init = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'run-evals', version: '0' } });
	if (init.json?.result?.protocolVersion) { protocolVersion = init.json.result.protocolVersion; }
	await rpc('notifications/initialized', undefined, true);
	const list = await rpc('tools/list', {});
	const names = list.json?.result?.tools?.map(t => t.name) ?? [];
	if (!names.includes('send_chat')) {
		throw new Error(`This V3Code build does not expose send_chat. Tools: ${names.join(', ') || 'none'}`);
	}
}

async function sendChat(message, { newThread, autoApprove, timeoutMs }) {
	const args = { message, timeout_ms: String(timeoutMs ?? 180000), auto_approve: autoApprove ? 'true' : 'false' };
	if (newThread) { args.new_thread = 'true'; }
	const call = await rpc('tools/call', { name: 'send_chat', arguments: args });
	const text = call.json?.result?.content?.[0]?.text ?? JSON.stringify(call.json);
	const isError = !!call.json?.result?.isError;
	return { text, isError };
}

// ---- transcript parsing ----
function turnStatus(text) {
	const m = text.match(/·\s*status\s+([a-z_]+)\)/);
	return m ? m[1] : 'unknown';
}
function toolCalls(text) {
	const out = [];
	const re = /\[tool:([a-zA-Z0-9_]+)\]/g;
	let m;
	while ((m = re.exec(text)) !== null) { out.push(m[1]); }
	return out;
}

function runJudge(rubric, transcript) {
	if (!judgeCmd) { return { score: null, detail: 'no --judge-cmd configured' }; }
	const r = spawnSync(judgeCmd, { input: JSON.stringify({ rubric, transcript }), shell: true, encoding: 'utf8', timeout: 120000 });
	const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
	const m = out.match(/SCORE:\s*([0-9]+(?:\.[0-9]+)?)/i);
	return { score: m ? Number(m[1]) : null, detail: out.trim().slice(0, 400) };
}

function evalCheck(check, text) {
	const ci = check.ci !== false; // default case-insensitive
	const hay = ci ? text.toLowerCase() : text;
	const norm = (s) => ci ? String(s).toLowerCase() : String(s);
	switch (check.type) {
		case 'status': {
			const st = turnStatus(text);
			return { pass: st === check.equals, detail: `status=${st} expected=${check.equals}` };
		}
		case 'contains_all': {
			const missing = (check.values || []).filter(v => !hay.includes(norm(v)));
			return { pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : 'all present' };
		}
		case 'contains_any': {
			const hit = (check.values || []).find(v => hay.includes(norm(v)));
			return { pass: !!hit, detail: hit ? `matched: ${hit}` : `none of: ${(check.values || []).join(', ')}` };
		}
		case 'not_contains': {
			const present = (check.values || []).filter(v => hay.includes(norm(v)));
			return { pass: present.length === 0, detail: present.length ? `unexpectedly present: ${present.join(', ')}` : 'clean' };
		}
		case 'regex': {
			const re = new RegExp(check.pattern, check.flags ?? '');
			return { pass: re.test(text), detail: `re=/${check.pattern}/${check.flags ?? ''}` };
		}
		case 'tool_used': {
			const used = toolCalls(text);
			return { pass: used.includes(check.tool), detail: `tools=[${used.join(', ')}]` };
		}
		case 'tool_first': {
			const used = toolCalls(text);
			return { pass: used[0] === check.tool, detail: `first=${used[0] ?? '(none)'} expected=${check.tool}` };
		}
		case 'no_tools': {
			const used = toolCalls(text);
			return { pass: used.length === 0, detail: `tools=[${used.join(', ')}]` };
		}
		case 'judge': {
			const { score, detail } = runJudge(check.rubric, text);
			if (score === null) { return { pass: null, detail: `judge unavailable (${detail})` }; }
			return { pass: score >= (check.min ?? 7), detail: `score=${score} min=${check.min ?? 7}` };
		}
		default:
			return { pass: null, detail: `unknown check type: ${check.type}` };
	}
}

async function runSet(set) {
	const newAtStart = !keepThread && (set.newThreadAtStart !== false);
	const autoApprove = set.autoApprove !== false;
	const timeoutMs = set.timeoutMs ?? 180000;
	const turnResults = [];
	console.log(`\n${'='.repeat(70)}\n> SET: ${set.id} -- ${set.description ?? ''}`);

	for (let i = 0; i < set.turns.length; i++) {
		const turn = set.turns[i];
		const t0 = Date.now();
		// A turn starts a fresh thread if it asks to (independent probes), or if
		// it's the set's first turn and the set wants a clean start.
		const newThread = turn.newThread === true || (newAtStart && i === 0);
		const sendMsg = expandHarnessTemplate(turn.send);
		const { text, isError } = await sendChat(sendMsg, { newThread, autoApprove, timeoutMs });
		const durationMs = Date.now() - t0;
		const status = turnStatus(text);
		const checks = (turn.checks || []).map(c => ({ ...c, ...evalCheck(c, text) }));
		const failed = checks.filter(c => c.pass === false);
		const unknown = checks.filter(c => c.pass === null);
		const turnPass = !isError && failed.length === 0;
		turnResults.push({ index: i, send: sendMsg, status, isError, durationMs, checks, transcript: text });

		const mark = turnPass ? '[PASS]' : '[FAIL]';
		console.log(`\n  ${mark} turn ${i + 1}/${set.turns.length}  (status=${status}, ${(durationMs / 1000).toFixed(1)}s)`);
		console.log(`     > ${sendMsg.slice(0, 90)}${sendMsg.length > 90 ? '...' : ''}`);
		for (const c of checks) {
			const cm = c.pass === true ? 'pass' : c.pass === false ? 'FAIL' : 'skip';
			console.log(`     [${cm}] ${c.type}: ${c.detail}`);
		}
		void unknown;
	}

	const allChecks = turnResults.flatMap(t => t.checks);
	const scored = allChecks.filter(c => c.pass !== null);
	const passed = scored.filter(c => c.pass === true).length;
	const anyErr = turnResults.some(t => t.isError);
	const setPass = !anyErr && scored.every(c => c.pass === true);
	return {
		setId: set.id,
		description: set.description ?? '',
		pass: setPass,
		checksPassed: passed,
		checksTotal: scored.length,
		turns: turnResults,
	};
}

function loadSets() {
	let files;
	try { files = readdirSync(SETS_DIR).filter(f => f.endsWith('.json')); }
	catch { throw new Error(`No sets dir at ${SETS_DIR}. Create prompt-set JSON files there.`); }
	const sets = files.map(f => JSON.parse(readFileSync(join(SETS_DIR, f), 'utf8')));
	if (onlyIds.length) { return sets.filter(s => onlyIds.includes(s.id)); }
	return sets;
}

(async () => {
	try {
		mkdirSync(RESULTS_DIR, { recursive: true });
		const sets = loadSets();
		if (!sets.length) { console.error(`No matching sets (ids: ${onlyIds.join(', ') || 'all'}).`); process.exit(1); }
		console.log(`endpoint: ${url}  workspace: ${workspaces.join(', ') || 'unknown'}`);
		console.log(`running ${sets.length} set(s)${label ? `  label=${label}` : ''}${judgeCmd ? '  judge=on' : ''}`);
		await handshake();

		const results = [];
		for (const set of sets) { results.push(await runSet(set)); }

		const ts = new Date().toISOString().replace(/[:.]/g, '-');
		const outPath = join(RESULTS_DIR, `evalrun-${ts}.json`);
		const summary = {
			ranAt: new Date().toISOString(),
			label,
			endpoint: url,
			workspace: workspaces,
			sets: results.map(r => ({ setId: r.setId, pass: r.pass, checksPassed: r.checksPassed, checksTotal: r.checksTotal })),
			full: results,
		};
		writeFileSync(outPath, JSON.stringify(summary, null, 2));

		console.log(`\n${'='.repeat(70)}\nSUMMARY${label ? ` (label: ${label})` : ''}`);
		let totP = 0, totC = 0, setsPass = 0;
		for (const r of results) {
			totP += r.checksPassed; totC += r.checksTotal; if (r.pass) { setsPass++; }
			console.log(`  ${r.pass ? '[PASS]' : '[FAIL]'} ${r.setId.padEnd(22)} ${r.checksPassed}/${r.checksTotal} checks`);
		}
		console.log(`\n  Sets passed: ${setsPass}/${results.length}   Checks: ${totP}/${totC}`);
		console.log(`  Saved: ${outPath}`);
		process.exit(setsPass === results.length ? 0 : 1);
	} catch (e) {
		console.error('\nEVAL RUN FAILED:', e.message);
		console.error('Is V3Code running with this build, and a workspace open?');
		process.exit(1);
	}
})();
