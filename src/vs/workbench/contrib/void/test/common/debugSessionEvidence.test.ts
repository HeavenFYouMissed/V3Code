/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	formatEvidenceData,
	isUsableDebugSessionId,
	parseEvidenceLine,
	parseEvidenceLog,
	V3_DEBUG_SESSION_ID_PATTERN,
} from '../../common/debugSessionTypes.js';
import { buildDebugEvidenceBlock, buildDebugFetchTemplate } from '../../common/prompt/debugEvidencePrompt.js';
import { debugLiveStatusIsActive, debugLiveStatusText, v3DebugIdleWorkingText } from '../../common/v3DebugTranscript.js';

const ENDPOINT = 'http://127.0.0.1:7642/ingest/510c3311-6856-4d61-875c-4a82eebfe4d7';
const LOG_PATH = '/Users/dev/project/.v3code/debug-abc123def456.log';
const SESSION = 'abc123def456';
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

suite('V3Code Debug evidence sink — contract and prompt', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a session id never reaches the filesystem unless it is a plain token', () => {
		assert.strictEqual(isUsableDebugSessionId('abc123def456'), true);
		assert.strictEqual(isUsableDebugSessionId('a'.repeat(32)), true);
		assert.strictEqual(isUsableDebugSessionId('abc'), false, 'too short');
		assert.strictEqual(isUsableDebugSessionId('a'.repeat(33)), false, 'too long');
		assert.strictEqual(isUsableDebugSessionId('../etc/passwd'), false);
		assert.strictEqual(isUsableDebugSessionId('abc/def'), false);
		assert.strictEqual(isUsableDebugSessionId('abc def'), false);
		assert.strictEqual(isUsableDebugSessionId('ABC123DEF456'), false, 'uppercase is not in the pattern');
		assert.strictEqual(isUsableDebugSessionId(undefined), false);
		assert.strictEqual(isUsableDebugSessionId(42), false);
		assert.strictEqual(V3_DEBUG_SESSION_ID_PATTERN.test('abc123def456'), true);
	});

	test('well-formed evidence lines become structured entries', () => {
		const line = parseEvidenceLine(JSON.stringify({
			sessionId: SESSION,
			location: 'src/app.ts:42',
			message: 'token is null here',
			data: { userId: 7 },
			hypothesisId: 'H2',
			runId: 'run1',
			timestamp: 1700000000000,
		}), 0, 0);
		assert.strictEqual(line.message, 'token is null here');
		assert.strictEqual(line.location, 'src/app.ts:42');
		assert.strictEqual(line.hypothesisId, 'H2');
		assert.strictEqual(line.runId, 'run1');
		assert.strictEqual(line.timestamp, 1700000000000);
		assert.deepStrictEqual(line.data, { userId: 7 });
		assert.strictEqual(line.beforeRunMark, false);
	});

	test('a malformed line is KEPT as text, never dropped', () => {
		// The file is an ordinary file a user can open and edit. Evidence silently vanishing is
		// the exact failure this feature exists to prevent, so a bad line must still render.
		const line = parseEvidenceLine('{this is not json', 3, 0);
		assert.strictEqual(line.message, '{this is not json');
		assert.strictEqual(line.index, 3);

		const notAnObject = parseEvidenceLine('[1,2,3]', 4, 0);
		assert.strictEqual(notAnObject.message, '[1,2,3]');

		const bare = parseEvidenceLine('"just a string"', 5, 0);
		assert.strictEqual(bare.message, '"just a string"');
	});

	test('a line with no message field falls back through the known aliases', () => {
		assert.strictEqual(parseEvidenceLine(JSON.stringify({ msg: 'via msg' }), 0).message, 'via msg');
		assert.strictEqual(parseEvidenceLine(JSON.stringify({ event: 'via event' }), 0).message, 'via event');
		assert.strictEqual(parseEvidenceLine(JSON.stringify({ raw: 'via raw' }), 0).message, 'via raw');
	});

	test('the run boundary separates this run from the previous one', () => {
		const text = ['a', 'b', 'c', 'd'].map(m => JSON.stringify({ message: m })).join('\n');
		const lines = parseEvidenceLog(text, 2);
		assert.strictEqual(lines.length, 4);
		assert.deepStrictEqual(lines.map(l => l.beforeRunMark), [true, true, false, false]);
		assert.deepStrictEqual(lines.map(l => l.message), ['a', 'b', 'c', 'd']);
		// Blank lines are separators, not evidence.
		assert.strictEqual(parseEvidenceLog('a\n\n\nb', 0).length, 2);
	});

	test('evidence payloads render compactly and never throw', () => {
		assert.strictEqual(formatEvidenceData({ a: 1 }), '{"a":1}');
		assert.strictEqual(formatEvidenceData('plain'), 'plain');
		assert.strictEqual(formatEvidenceData(undefined), undefined);
		assert.strictEqual(formatEvidenceData(null), undefined);
		assert.strictEqual(formatEvidenceData({}), undefined, 'an empty object carries nothing');
		const long = formatEvidenceData({ blob: 'x'.repeat(1000) })!;
		assert.ok(long.length <= 400);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		assert.doesNotThrow(() => formatEvidenceData(circular));
	});

	test('the fetch template carries the live endpoint and the session header', () => {
		const template = buildDebugFetchTemplate(ENDPOINT, SESSION);
		assert.ok(template.includes(ENDPOINT), 'the endpoint must be the one we were given');
		assert.ok(template.includes(`'X-Debug-Session-Id': '${SESSION}'`));
		assert.ok(template.includes('POST'));
		assert.ok(template.includes('JSON.stringify'));
		assert.ok(/\.catch\(/.test(template), 'an instrumentation failure must never break the app being debugged');
	});

	test('WITHOUT a sink the model is told there is none, and given no endpoint to invent from', () => {
		const block = buildDebugEvidenceBlock({
			runMark: 0, lineCount: 0, isFirstTurn: true,
			unavailableReason: 'workspace is not trusted',
		});
		assert.ok(block.includes('<DEBUG_RUNTIME_EVIDENCE_UNAVAILABLE>'));
		assert.ok(block.includes('workspace is not trusted'));
		assert.ok(/do not claim to have collected runtime logs/i.test(block));
		assert.ok(!block.includes('fetch('), 'no instrumentation template when there is no sink');
		assert.ok(!block.includes('http://'), 'no endpoint for the model to guess against');
	});

	test('the first turn carries the endpoint, the file, the session and the rules', () => {
		const block = buildDebugEvidenceBlock({
			endpoint: ENDPOINT, logPath: LOG_PATH, sessionId: SESSION,
			runMark: 12, lineCount: 12, isFirstTurn: true,
		});
		assert.ok(block.includes('<DEBUG_RUNTIME_EVIDENCE>'));
		assert.ok(block.includes(ENDPOINT));
		assert.ok(block.includes(LOG_PATH));
		assert.ok(block.includes(SESSION));
		assert.ok(block.includes('begins at line 12'), 'the run boundary is stated');
		assert.ok(block.includes(`'X-Debug-Session-Id': '${SESSION}'`), 'the template itself is included');
		assert.ok(block.includes('Never hardcode a URL'));
		assert.ok(/1 line is the minimum/i.test(block), 'the log budget is stated');
		assert.ok(/do not exceed 10/i.test(block));
		// The user watches the same stream in the transcript, so the model is told not to read
		// the log aloud. That is a speed property as much as a style one.
		assert.ok(/rendered live in the transcript/i.test(block), 'the model knows the user sees the evidence');
		// Exactly the endpoint we handed it — never a second one, never a guessed port.
		const hosts = block.match(/http:\/\/127\.0\.0\.1:\d+/g) ?? [];
		assert.ok(hosts.length > 0);
		assert.deepStrictEqual([...new Set(hosts)], [ENDPOINT.split('/ingest/')[0]]);
		assert.strictEqual(block.match(new RegExp(escapeRegex(ENDPOINT), 'g'))?.length, 2, 'template + bullet');
	});

	test('every later turn re-asserts the constraint in a much smaller block', () => {
		const full = buildDebugEvidenceBlock({
			endpoint: ENDPOINT, logPath: LOG_PATH, sessionId: SESSION,
			runMark: 0, lineCount: 0, isFirstTurn: true,
		});
		const reminder = buildDebugEvidenceBlock({
			endpoint: ENDPOINT, logPath: LOG_PATH, sessionId: SESSION,
			runMark: 5, lineCount: 8, isFirstTurn: false,
		});
		assert.ok(reminder.includes('<DEBUG_RUNTIME_EVIDENCE_REMINDER>'));
		assert.ok(reminder.includes(ENDPOINT));
		assert.ok(reminder.includes('begins at line 5'));
		assert.ok(reminder.includes('3 lines recorded in it so far'));
		assert.ok(reminder.length < full.length / 2, 'the re-assertion must stay cheap');
		assert.ok(!reminder.includes('fetch('), 'the template is not re-sent every turn');
	});

	test('the reminder counts a single new line in the singular', () => {
		const reminder = buildDebugEvidenceBlock({
			endpoint: ENDPOINT, logPath: LOG_PATH, sessionId: SESSION,
			runMark: 4, lineCount: 5, isFirstTurn: false,
		});
		assert.ok(reminder.includes('1 line recorded in it so far'));
	});

	test('a half-configured sink is treated as no sink at all', () => {
		// A missing logPath must NOT produce a block that promises a file which does not exist.
		const block = buildDebugEvidenceBlock({
			endpoint: ENDPOINT, sessionId: SESSION, runMark: 0, lineCount: 0, isFirstTurn: true,
		});
		assert.ok(block.includes('<DEBUG_RUNTIME_EVIDENCE_UNAVAILABLE>'));
	});

	test('the live status only claims activity when activity is real', () => {
		assert.strictEqual(debugLiveStatusText([]), '', 'nothing observed renders nothing');
		assert.strictEqual(debugLiveStatusIsActive([]), false);

		assert.strictEqual(debugLiveStatusIsActive([{ lifecycle: 'running' }]), true);
		assert.strictEqual(debugLiveStatusIsActive([{ lifecycle: 'preparing' }]), true);

		// Waiting on the user is NOT work happening. The sheen keys off this.
		assert.strictEqual(debugLiveStatusIsActive([{ lifecycle: 'awaiting-approval' }]), false);
		assert.strictEqual(debugLiveStatusIsActive([{ lifecycle: 'awaiting-approval', isQuestion: true }]), false);
		assert.strictEqual(debugLiveStatusIsActive([{ lifecycle: 'succeeded' }, { lifecycle: 'failed' }]), false);

		// Mixed: one real operation is enough to animate.
		assert.strictEqual(debugLiveStatusIsActive([{ lifecycle: 'awaiting-approval' }, { lifecycle: 'running' }]), true);

		assert.ok(debugLiveStatusText([{ lifecycle: 'running' }]).length > 0);
		assert.strictEqual(v3DebugIdleWorkingText(), 'Working');
	});
});
