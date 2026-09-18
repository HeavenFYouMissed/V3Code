/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../chat/common/chatService/chatService.js';
import { parseEvidenceLine, V3DebugEvidenceLine } from '../../common/debugSessionTypes.js';
import {
	categorizeDebugTool, debugGroupTitle, debugLiveStatusText, describeToolLifecycle, formatStreamedToolInput, observeToolInvocation,
	parseTranscriptDensity, planDebugToolGroups, planEvidencePanel, V3_TRANSCRIPT_DENSITY_DEFAULT, V3DebugGroupExpansionStore, V3ToolLifecycle, V3ToolObservation, V3TranscriptItem,
} from '../../common/v3DebugTranscript.js';

const live = (stateKind: IChatToolInvocation.StateKind, extra: Partial<V3ToolObservation> = {}): V3ToolObservation => ({
	isSerialized: false, stateKind, confirmed: undefined, isComplete: false, isError: false, ...extra,
});
const saved = (extra: Partial<V3ToolObservation> = {}): V3ToolObservation => ({
	isSerialized: true, stateKind: undefined, confirmed: 'confirmed', isComplete: true, isError: false, ...extra,
});
const tool = (id: string, lifecycle: V3ToolLifecycle, category: 'read' | 'edit' | 'command' = 'read'): V3TranscriptItem => ({ kind: 'tool', id, lifecycle, category });
const narration: V3TranscriptItem = { kind: 'boundary' };
const hidden: V3TranscriptItem = { kind: 'transparent' };

suite('debug transcript — lifecycle labels', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preparing arguments is not executing a command', () => {
		const d = describeToolLifecycle(live(IChatToolInvocation.StateKind.Streaming));
		assert.strictEqual(d.lifecycle, 'preparing');
		assert.strictEqual(d.label, 'Preparing');
		assert.strictEqual(d.isActive, true);
		assert.strictEqual(describeToolLifecycle(live(IChatToolInvocation.StateKind.Executing)).lifecycle, 'running');
	});

	test('approval and post-approval waits are visible as approvals, not as running', () => {
		const waiting = describeToolLifecycle(live(IChatToolInvocation.StateKind.WaitingForConfirmation));
		assert.strictEqual(waiting.lifecycle, 'awaiting-approval');
		assert.strictEqual(waiting.isActive, false, 'no sheen while blocked on the user');
		assert.strictEqual(describeToolLifecycle(live(IChatToolInvocation.StateKind.WaitingForPostApproval, { isComplete: true })).lifecycle, 'awaiting-approval');
	});

	test('a failed operation never gets a success receipt', () => {
		const failed = describeToolLifecycle(live(IChatToolInvocation.StateKind.Completed, { confirmed: 'confirmed', isComplete: true, isError: true }));
		assert.strictEqual(failed.lifecycle, 'failed');
		assert.strictEqual(failed.label, 'Failed');
		assert.strictEqual(describeToolLifecycle(saved({ isError: true })).lifecycle, 'failed', 'serialized failures stay failures after reopening');
		assert.strictEqual(describeToolLifecycle(saved()).lifecycle, 'succeeded');
	});

	test('denied is cancelled, skipped is skipped — live and serialized alike', () => {
		assert.strictEqual(describeToolLifecycle(live(IChatToolInvocation.StateKind.Cancelled, { confirmed: 'denied', isComplete: true })).lifecycle, 'cancelled');
		assert.strictEqual(describeToolLifecycle(live(IChatToolInvocation.StateKind.Cancelled, { confirmed: 'skipped', isComplete: true })).lifecycle, 'skipped');
		assert.strictEqual(describeToolLifecycle(saved({ confirmed: 'denied' })).lifecycle, 'cancelled');
		assert.strictEqual(describeToolLifecycle(saved({ confirmed: 'skipped' })).lifecycle, 'skipped');
	});

	test('a reopened chat never animates: serialized parts are never active', () => {
		for (const obs of [saved(), saved({ isError: true }), saved({ confirmed: 'denied' }), saved({ confirmed: undefined, isComplete: false })]) {
			assert.strictEqual(describeToolLifecycle(obs).isActive, false);
		}
	});

	test('observeToolInvocation reads the serialized shape', () => {
		const serialized = {
			kind: 'toolInvocationSerialized', isComplete: true, isConfirmed: { type: ToolConfirmKind.UserAction },
			resultDetails: { input: '{}', output: [{ type: 'embed', isText: true, value: 'Tool error: boom' }], isError: true },
		} as unknown as IChatToolInvocationSerialized;
		const obs = observeToolInvocation(serialized);
		assert.deepStrictEqual(obs, { isSerialized: true, stateKind: undefined, confirmed: 'confirmed', isComplete: true, isError: true });
		assert.strictEqual(describeToolLifecycle(obs).lifecycle, 'failed');
		const skipped = { kind: 'toolInvocationSerialized', isComplete: true, isConfirmed: { type: ToolConfirmKind.Skipped } } as unknown as IChatToolInvocationSerialized;
		assert.strictEqual(describeToolLifecycle(observeToolInvocation(skipped)).lifecycle, 'skipped');
	});
});

suite('debug transcript — categories and streamed arguments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('categories come from the terminal payload kind or the native tool id', () => {
		assert.strictEqual(categorizeDebugTool('v3code_run_command', 'terminal'), 'command');
		assert.strictEqual(categorizeDebugTool('v3code_run_tests', undefined), 'command');
		assert.strictEqual(categorizeDebugTool('v3code_edit_file', undefined), 'edit');
		assert.strictEqual(categorizeDebugTool('v3code_create_file_or_folder', undefined), 'edit');
		assert.strictEqual(categorizeDebugTool('v3code_read_file', undefined), 'read');
		assert.strictEqual(categorizeDebugTool('v3code_semantic_search', 'input'), 'read');
	});

	test('streamed arguments are shown as plain text and truncated', () => {
		assert.strictEqual(formatStreamedToolInput(undefined), '');
		assert.strictEqual(formatStreamedToolInput('  {"uri": "src/a.ts"'), '{"uri": "src/a.ts"');
		assert.strictEqual(formatStreamedToolInput({ command: 'npm test', cwd: '/repo' }), 'command: npm test\ncwd: /repo');
		const long = formatStreamedToolInput('x'.repeat(500), 100);
		assert.strictEqual(long.length, 101);
		assert.ok(long.endsWith('…'));
	});
});

suite('debug transcript — grouping and density', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('setting parses to a known density with standard as the default', () => {
		assert.strictEqual(V3_TRANSCRIPT_DENSITY_DEFAULT, 'standard');
		assert.strictEqual(parseTranscriptDensity(undefined), 'standard');
		assert.strictEqual(parseTranscriptDensity('bogus'), 'standard');
		assert.strictEqual(parseTranscriptDensity('minimal'), 'minimal');
	});

	test('verbose never groups', () => {
		assert.deepStrictEqual(planDebugToolGroups([tool('a', 'succeeded'), tool('b', 'succeeded'), tool('c', 'succeeded')], 'verbose'), []);
	});

	test('standard groups adjacent successes of the same category, minimum two', () => {
		const items = [tool('r1', 'succeeded', 'read'), tool('r2', 'succeeded', 'read'), tool('e1', 'succeeded', 'edit'), tool('c1', 'succeeded', 'command'), tool('c2', 'succeeded', 'command')];
		assert.deepStrictEqual(planDebugToolGroups(items, 'standard'), [
			{ start: 0, end: 2, memberIds: ['r1', 'r2'], single: false },
			{ start: 3, end: 5, memberIds: ['c1', 'c2'], single: false },
		]);
	});

	test('compact groups across categories; minimal also wraps single completed cards', () => {
		const items = [tool('r1', 'succeeded', 'read'), tool('e1', 'succeeded', 'edit'), tool('x', 'running'), tool('c1', 'succeeded', 'command')];
		assert.deepStrictEqual(planDebugToolGroups(items, 'compact'), [{ start: 0, end: 2, memberIds: ['r1', 'e1'], single: false }]);
		assert.deepStrictEqual(planDebugToolGroups(items, 'minimal'), [
			{ start: 0, end: 2, memberIds: ['r1', 'e1'], single: false },
			{ start: 3, end: 4, memberIds: ['c1'], single: true },
		]);
	});

	test('active, awaiting, failed, cancelled and skipped operations stay individually visible and break the run', () => {
		for (const blocker of ['preparing', 'awaiting-approval', 'running', 'failed', 'cancelled', 'skipped'] as const) {
			const items = [tool('a', 'succeeded'), tool('b', 'succeeded'), tool('z', blocker), tool('c', 'succeeded'), tool('d', 'succeeded')];
			const groups = planDebugToolGroups(items, 'compact');
			assert.deepStrictEqual(groups.map(g => g.memberIds), [['a', 'b'], ['c', 'd']], blocker);
			assert.ok(groups.every(g => !g.memberIds.includes('z')), `${blocker} must never be grouped`);
		}
	});

	test('narration and any other visible part is a boundary; hidden parts are transparent', () => {
		const items = [tool('a', 'succeeded'), narration, tool('b', 'succeeded'), tool('c', 'succeeded'), hidden, tool('d', 'succeeded')];
		assert.deepStrictEqual(planDebugToolGroups(items, 'compact').map(g => g.memberIds), [['b', 'c', 'd']]);
		assert.deepStrictEqual(planDebugToolGroups([tool('a', 'succeeded'), narration, tool('b', 'succeeded')], 'compact'), []);
	});

	test('titles count operations', () => {
		assert.strictEqual(debugGroupTitle(1), '1 operation');
		assert.strictEqual(debugGroupTitle(3), '3 operations');
	});

	test('expansion survives a rerender and an earlier tool joining the front of the group', () => {
		const store = new V3DebugGroupExpansionStore();
		assert.strictEqual(store.get('resp-1', ['b', 'c']), undefined);
		store.set('resp-1', ['b', 'c'], true);
		assert.strictEqual(store.get('resp-1', ['b', 'c']), true);
		assert.strictEqual(store.get('resp-1', ['a', 'b', 'c']), true, 'late-completing "a" joined the front');
		assert.strictEqual(store.get('resp-2', ['b', 'c']), undefined, 'keyed by response identity too');
		assert.strictEqual(V3DebugGroupExpansionStore.key('resp-1', 'b'), 'resp-1::b');
	});
});

suite('debug transcript — live status', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders nothing when idle or finished', () => {
		assert.strictEqual(debugLiveStatusText([]), '');
		assert.strictEqual(debugLiveStatusText([{ lifecycle: 'succeeded' }, { lifecycle: 'failed' }, { lifecycle: 'cancelled' }, { lifecycle: 'skipped' }]), '');
	});

	test('counts concurrent operations and approval waits from observed activity', () => {
		assert.strictEqual(debugLiveStatusText([{ lifecycle: 'running' }]), 'Running 1 operation');
		assert.strictEqual(debugLiveStatusText([{ lifecycle: 'running' }, { lifecycle: 'running' }, { lifecycle: 'succeeded' }]), 'Running 2 operations');
		assert.strictEqual(debugLiveStatusText([{ lifecycle: 'preparing' }]), 'Preparing 1 operation');
		assert.strictEqual(debugLiveStatusText([{ lifecycle: 'running' }, { lifecycle: 'awaiting-approval' }]), 'Running 1 operation · 1 operation awaiting your approval');
		assert.strictEqual(debugLiveStatusText([{ lifecycle: 'awaiting-approval', isQuestion: true }]), 'Waiting for your answer');
	});

	test('never infers "wrapping up" from every known tool being finished', () => {
		const text = debugLiveStatusText([{ lifecycle: 'succeeded' }, { lifecycle: 'succeeded' }]);
		assert.strictEqual(text, '');
		assert.ok(!/wrapping/i.test(text));
	});
});

suite('debug transcript — runtime evidence panel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const line = (index: number, message: string, extra: Partial<V3DebugEvidenceLine> = {}): V3DebugEvidenceLine => ({ index, message, ...extra });
	// `phase` rather than a boolean: 'starting' is a state the panel has to state honestly, and
	// a boolean has nowhere to carry it.
	const running = { phase: 'running' as const, endpoint: 'http://127.0.0.1:7642/ingest/abc123', sessionId: 'abc123', logPath: '/w/.v3code/debug-abc123.log' };

	test('no sink is stated plainly, and never hands out an endpoint that does not exist', () => {
		const view = planEvidencePanel({ phase: 'unavailable', reason: 'Workspace is not trusted.', lines: [], lineCount: 0, runMark: 0 });
		assert.strictEqual(view.tone, 'off');
		assert.strictEqual(view.summary, 'Workspace is not trusted.');
		assert.deepStrictEqual(view.lines, []);
		assert.strictEqual(view.instrumentLine, undefined);
	});

	test('a running sink with nothing recorded says Waiting, not Working', () => {
		const view = planEvidencePanel({ ...running, lines: [], lineCount: 0, runMark: 0 });
		assert.strictEqual(view.tone, 'waiting');
		assert.strictEqual(view.badge, 'Waiting');
		assert.ok(view.summary.includes('http://127.0.0.1:7642/ingest/abc123'), view.summary);
		assert.ok(view.summary.includes('none in this run yet'), view.summary);
	});

	test('the offered instrumentation line is one pasteable line carrying the real endpoint', () => {
		const view = planEvidencePanel({ ...running, lines: [], lineCount: 0, runMark: 0 });
		assert.ok(view.instrumentLine);
		assert.ok(view.instrumentLine!.startsWith('fetch('), view.instrumentLine);
		assert.ok(view.instrumentLine!.includes('/ingest/abc123'), 'points at the live sink');
		assert.ok(view.instrumentLine!.includes('abc123'), 'carries the session id');
		assert.strictEqual(view.instrumentLine!.includes('\n'), false, 'a multi-line snippet is the one that gets truncated on paste');
		assert.strictEqual(view.lines.length, 0, 'nothing is invented to fill the panel');
	});

	test('evidence is counted honestly: what is recorded, and what belongs to this run', () => {
		const view = planEvidencePanel({
			...running,
			lines: [line(0, 'previous run line', { beforeRunMark: true }), line(1, 'this run line')],
			lineCount: 2,
			runMark: 1,
		});
		assert.strictEqual(view.tone, 'live');
		assert.strictEqual(view.badge, 'Live');
		assert.ok(view.summary.includes('2 lines'), view.summary);
		assert.ok(view.summary.includes('1 in this run'), view.summary);
		assert.strictEqual(view.lines[0].isThisRun, false);
		assert.strictEqual(view.lines[1].isThisRun, true);
		assert.strictEqual(view.hasEarlier, true, 'the previous run stays visible and marked, never hidden');
	});

	test('a single line is never rendered as "1 lines"', () => {
		const view = planEvidencePanel({ ...running, lines: [line(0, 'only')], lineCount: 1, runMark: 0 });
		assert.ok(view.summary.includes('1 line · 1 in this run'), view.summary);
		assert.strictEqual(view.summary.includes('1 lines'), false, 'a lone line is singular');
		assert.strictEqual(view.footer, undefined, 'no truncation note when everything fits');
	});

	test('the panel shows the newest lines and says how many it is hiding', () => {
		const view = planEvidencePanel({
			...running,
			lines: Array.from({ length: 30 }, (_, i) => line(i, `line ${i}`)),
			lineCount: 30,
			runMark: 0,
			maxLines: 5,
		});
		assert.deepStrictEqual(view.lines.map(l => l.message), ['line 25', 'line 26', 'line 27', 'line 28', 'line 29']);
		assert.strictEqual(view.lines[0].index, 26, 'the index is the 1-based file line number a verdict cites');
		assert.strictEqual(view.footer, 'Showing the last 5 of 30 lines.');
	});

	test('unparseable evidence is preserved as text rather than dropped', () => {
		const view = planEvidencePanel({
			...running,
			lines: [
				parseEvidenceLine('not json at all', 0),
				parseEvidenceLine('{"message":"ok","location":"a.ts:3","hypothesisId":"H2","data":{"v":1}}', 1),
			],
			lineCount: 2,
			runMark: 0,
		});
		assert.strictEqual(view.lines[0].index, 1);
		assert.strictEqual(view.lines[0].message, 'not json at all');
		assert.strictEqual(view.lines[1].index, 2);
		assert.strictEqual(view.lines[1].location, 'a.ts:3');
		assert.strictEqual(view.lines[1].hypothesisId, 'H2');
		assert.strictEqual(view.lines[1].data, '{"v":1}');
	});

	test('a line with no endpoint still reports counts instead of inventing one', () => {
		const view = planEvidencePanel({ phase: 'running', sessionId: 'abc123', lines: [line(0, 'x')], lineCount: 1, runMark: 0 });
		assert.strictEqual(view.summary, '1 line · 1 in this run');
	});

	test('a sink that is still coming up is never reported as absent', () => {
		const view = planEvidencePanel({ phase: 'starting', lines: [], lineCount: 0, runMark: 0 });
		assert.strictEqual(view.tone, 'starting');
		assert.strictEqual(view.badge, 'Starting');
		// The spawn plus a handshake can take seconds, and "no runtime-evidence sink is running"
		// is false for that whole window — on the one panel whose job is to state it truthfully.
		assert.strictEqual(view.summary.includes('No runtime-evidence sink is running'), false);
		assert.strictEqual(view.summary.includes('Off'), false);
		assert.deepStrictEqual(view.lines, []);
		assert.strictEqual(view.instrumentLine, undefined, 'no endpoint is offered before there is one');
		assert.strictEqual(view.logPath, undefined, 'nor a file that does not exist yet');
	});
});
