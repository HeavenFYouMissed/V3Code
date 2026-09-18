/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	assessWorkerOutcome,
	emptySubagentActivity,
	emptySubagentEvidence,
	isTerminalSubagentStatus,
	MAX_BACKGROUND_SUBAGENTS_PER_PARENT,
	MAX_BACKGROUND_SUBAGENTS_TOTAL,
	MAX_QUEUED_SUBAGENTS_PER_PARENT,
	MAX_RECENT_TOOLS_PER_WORKER,
	QueueEntry,
	recomputeQueuePositions,
	recordSubagentToolCall,
	selectDrainableSubagents,
	SubagentActivity,
	SubagentEvidence,
	SubagentStatus,
	subagentAdmission,
} from '../../common/subagentLifecycle.js';
import {
	ALL_BROWSER_TOOL_NAMES,
	applyMultitaskBrowserPolicy,
	isSubagentToolAllowed,
	MULTITASK_BROWSER_INSPECTION_TOOLS,
} from '../../common/toolsServiceTypes.js';

/**
 * These tests drive the REAL exported implementations (recordSubagentToolCall,
 * assessWorkerOutcome, selectDrainableSubagents, applyMultitaskBrowserPolicy) rather than
 * asserting the shape of hand-built objects. Each one corresponds to a lane blocker.
 */

// ---- §2 evidence attribution ----

suite('subagent evidence attribution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const fresh = () => ({ activity: emptySubagentActivity(), evidence: emptySubagentEvidence() });

	test('a successful edit_file records the file, the tool, and the activity snapshot', () => {
		const next = recordSubagentToolCall(fresh(), { tool: 'edit_file', file: 'src/foo.ts', succeeded: true, at: 1000 });
		assert.deepStrictEqual(next.evidence.filesTouched, ['src/foo.ts']);
		assert.strictEqual(next.evidence.toolsRun, 1);
		assert.strictEqual(next.evidence.fileTouchDetail[0].tool, 'edit_file');
		assert.strictEqual(next.activity.lastToolName, 'edit_file');
		assert.strictEqual(next.activity.lastToolTimestamp, 1000);
		assert.strictEqual(next.activity.currentFile, 'src/foo.ts');
	});

	test('a FAILED edit updates activity but contributes no evidence', () => {
		const next = recordSubagentToolCall(fresh(), { tool: 'edit_file', file: 'src/foo.ts', succeeded: false, at: 1000 });
		assert.deepStrictEqual(next.evidence.filesTouched, [], 'a failed edit must not count as a file change');
		assert.strictEqual(next.evidence.toolsRun, 0);
		assert.strictEqual(next.activity.lastToolName, 'edit_file', 'activity still shows what it attempted');
	});

	test('a read-only tool never lands in filesTouched', () => {
		const next = recordSubagentToolCall(fresh(), { tool: 'read_file', file: 'src/foo.ts', succeeded: true, at: 1 });
		assert.deepStrictEqual(next.evidence.filesTouched, []);
		assert.strictEqual(next.evidence.toolsRun, 1, 'it still counts as a tool call');
		assert.strictEqual(next.activity.currentFile, 'src/foo.ts');
	});

	test('the same file edited twice is recorded once in filesTouched but twice in detail', () => {
		let s = fresh();
		s = recordSubagentToolCall(s, { tool: 'edit_file', file: 'src/a.ts', succeeded: true, at: 1 });
		s = recordSubagentToolCall(s, { tool: 'edit_file', file: 'src/a.ts', succeeded: true, at: 2 });
		assert.deepStrictEqual(s.evidence.filesTouched, ['src/a.ts']);
		assert.strictEqual(s.evidence.fileTouchDetail.length, 2);
		assert.strictEqual(s.evidence.toolsRun, 2);
	});

	test('commands are recorded with their real pass/fail outcome', () => {
		let s = fresh();
		s = recordSubagentToolCall(s, { tool: 'run_command', command: 'npm test', commandStatus: 'pass', succeeded: true, at: 1 });
		s = recordSubagentToolCall(s, { tool: 'run_command', command: 'npm run lint', commandStatus: 'fail', succeeded: true, at: 2 });
		assert.strictEqual(s.evidence.commandsRun.length, 2);
		assert.strictEqual(s.evidence.commandsRun[0].status, 'pass');
		assert.strictEqual(s.evidence.commandsRun[1].status, 'fail');
	});

	test('the recent-tool log is bounded', () => {
		let s = fresh();
		for (let i = 0; i < MAX_RECENT_TOOLS_PER_WORKER + 10; i++) {
			s = recordSubagentToolCall(s, { tool: `tool_${i}`, succeeded: true, at: i });
		}
		assert.strictEqual(s.activity.recentTools.length, MAX_RECENT_TOOLS_PER_WORKER);
		assert.strictEqual(s.activity.recentTools[s.activity.recentTools.length - 1].tool, `tool_${MAX_RECENT_TOOLS_PER_WORKER + 9}`, 'keeps the newest');
	});

	test('evidence is per-worker: two workers folded independently never share files', () => {
		let a = fresh();
		let b = fresh();
		a = recordSubagentToolCall(a, { tool: 'edit_file', file: 'src/a.ts', succeeded: true, at: 1 });
		b = recordSubagentToolCall(b, { tool: 'edit_file', file: 'src/b.ts', succeeded: true, at: 2 });
		assert.deepStrictEqual(a.evidence.filesTouched, ['src/a.ts']);
		assert.deepStrictEqual(b.evidence.filesTouched, ['src/b.ts'], 'a global diff would have credited both files to both workers');
	});
});

// ---- §3 false success ----

suite('subagent false-success guard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const withFiles = (files: string[]): SubagentEvidence => ({
		...emptySubagentEvidence(),
		filesTouched: files,
		toolsRun: files.length,
	});

	test('a work worker that CLAIMS edits but touched no file is blocked', () => {
		const r = assessWorkerOutcome({
			profile: 'work',
			task: 'Fix the parser bug in src/parser.ts',
			report: 'I updated src/parser.ts and the bug is fixed.',
			evidence: emptySubagentEvidence(),
		});
		assert.strictEqual(r.status, 'blocked');
		assert.ok(r.status === 'blocked' && r.reason.length > 0, 'a blocked worker must carry a reason');
	});

	test('a work worker that actually touched a file completes', () => {
		const r = assessWorkerOutcome({
			profile: 'work',
			task: 'Fix the parser bug in src/parser.ts',
			report: 'I updated src/parser.ts and the bug is fixed.',
			evidence: withFiles(['src/parser.ts']),
		});
		assert.strictEqual(r.status, 'completed');
	});

	test('a research worker that changed nothing is NOT blocked', () => {
		const r = assessWorkerOutcome({
			profile: 'research',
			task: 'Investigate how auth refresh works',
			report: 'I reviewed the auth flow and found the refresh in tokenService.',
			evidence: emptySubagentEvidence(),
		});
		assert.strictEqual(r.status, 'completed', 'research workers are supposed to change nothing');
	});

	test('a work worker asked to edit that ran no tools at all is blocked', () => {
		const r = assessWorkerOutcome({
			profile: 'work',
			task: 'Update the config to add a retry',
			report: 'Nothing to report.',
			evidence: emptySubagentEvidence(),
		});
		assert.strictEqual(r.status, 'blocked');
	});

	test('a work worker that investigated, did real tool work, and claims nothing is fine', () => {
		const r = assessWorkerOutcome({
			profile: 'work',
			task: 'Look into the flaky test and report what you find',
			report: 'The flake comes from a timing assumption in the retry helper.',
			evidence: { ...emptySubagentEvidence(), toolsRun: 6 },
		});
		assert.strictEqual(r.status, 'completed');
	});
});

// ---- §5 queue correctness ----

suite('subagent global queue drain', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const allQueued = () => true;

	test('a slot freed under parent A starts a worker queued under parent B', () => {
		const queue: QueueEntry[] = [{ subagentThreadId: 'b1', parentThreadId: 'B' }];
		const started = selectDrainableSubagents({
			queue,
			runningByParent: { A: 0 },
			runningTotal: 0,
			isStillQueued: allQueued,
		});
		assert.deepStrictEqual(started, ['b1'], 'a cross-parent queued worker must not stay stuck');
	});

	test('a saturated parent is SKIPPED, not allowed to block the queue behind it', () => {
		const queue: QueueEntry[] = [
			{ subagentThreadId: 'a4', parentThreadId: 'A' },
			{ subagentThreadId: 'b1', parentThreadId: 'B' },
		];
		const started = selectDrainableSubagents({
			queue,
			runningByParent: { A: MAX_BACKGROUND_SUBAGENTS_PER_PARENT },
			runningTotal: MAX_BACKGROUND_SUBAGENTS_PER_PARENT,
			isStillQueued: allQueued,
		});
		assert.deepStrictEqual(started, ['b1'], "parent A is full, but B's worker is eligible");
	});

	test('FIFO order is preserved among eligible workers', () => {
		const queue: QueueEntry[] = [
			{ subagentThreadId: 'first', parentThreadId: 'A' },
			{ subagentThreadId: 'second', parentThreadId: 'A' },
			{ subagentThreadId: 'third', parentThreadId: 'A' },
		];
		const started = selectDrainableSubagents({
			queue,
			runningByParent: {},
			runningTotal: 0,
			isStillQueued: allQueued,
		});
		assert.deepStrictEqual(started, ['first', 'second', 'third']);
	});

	test('the per-parent running cap is still honoured while draining', () => {
		const queue: QueueEntry[] = Array.from({ length: 6 }, (_, i) => ({ subagentThreadId: `a${i}`, parentThreadId: 'A' }));
		const started = selectDrainableSubagents({
			queue,
			runningByParent: {},
			runningTotal: 0,
			isStillQueued: allQueued,
		});
		assert.strictEqual(started.length, MAX_BACKGROUND_SUBAGENTS_PER_PARENT);
	});

	test('the global cap stops the drain even across different parents', () => {
		const queue: QueueEntry[] = [];
		for (const p of ['A', 'B', 'C', 'D']) {
			for (let i = 0; i < 3; i++) { queue.push({ subagentThreadId: `${p}${i}`, parentThreadId: p }); }
		}
		const started = selectDrainableSubagents({
			queue,
			runningByParent: {},
			runningTotal: 0,
			isStillQueued: allQueued,
		});
		assert.strictEqual(started.length, MAX_BACKGROUND_SUBAGENTS_TOTAL);
	});

	test('a cancelled queued worker is skipped and never revived', () => {
		const queue: QueueEntry[] = [
			{ subagentThreadId: 'cancelled', parentThreadId: 'A' },
			{ subagentThreadId: 'alive', parentThreadId: 'A' },
		];
		const started = selectDrainableSubagents({
			queue,
			runningByParent: {},
			runningTotal: 0,
			isStillQueued: id => id !== 'cancelled',
		});
		assert.deepStrictEqual(started, ['alive']);
	});

	test('queue positions are restated per parent after a cancellation', () => {
		const queue: QueueEntry[] = [
			{ subagentThreadId: 'a1', parentThreadId: 'A' },
			{ subagentThreadId: 'gone', parentThreadId: 'A' },
			{ subagentThreadId: 'a3', parentThreadId: 'A' },
			{ subagentThreadId: 'b1', parentThreadId: 'B' },
		];
		const positions = recomputeQueuePositions(queue, id => id !== 'gone');
		assert.strictEqual(positions.get('a1'), 1);
		assert.strictEqual(positions.get('a3'), 2, 'the worker behind the cancelled one moves up');
		assert.strictEqual(positions.get('b1'), 1, 'positions are per parent');
		assert.strictEqual(positions.has('gone'), false);
	});

	test('admission queues the 4th worker rather than refusing it', () => {
		const admission = subagentAdmission({
			depth: 1,
			runningForParent: MAX_BACKGROUND_SUBAGENTS_PER_PARENT,
			runningTotal: MAX_BACKGROUND_SUBAGENTS_PER_PARENT,
			queuedForParent: 0,
			activeTotal: MAX_BACKGROUND_SUBAGENTS_PER_PARENT,
		});
		assert.strictEqual(admission.ok, true);
		assert.ok(admission.ok && admission.queued === true);
	});

	test('admission refuses once the per-parent queue is full', () => {
		const admission = subagentAdmission({
			depth: 1,
			runningForParent: MAX_BACKGROUND_SUBAGENTS_PER_PARENT,
			runningTotal: MAX_BACKGROUND_SUBAGENTS_PER_PARENT,
			queuedForParent: MAX_QUEUED_SUBAGENTS_PER_PARENT,
			activeTotal: MAX_BACKGROUND_SUBAGENTS_PER_PARENT + MAX_QUEUED_SUBAGENTS_PER_PARENT,
		});
		assert.strictEqual(admission.ok, false);
	});
});

// ---- §4 status vocabulary ----

suite('subagent lifecycle status', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('terminal states are exactly the finished ones', () => {
		const terminal: SubagentStatus[] = ['completed', 'blocked', 'failed', 'cancelled'];
		const live: SubagentStatus[] = ['queued', 'running', 'waiting-approval'];
		for (const s of terminal) { assert.strictEqual(isTerminalSubagentStatus(s), true, s); }
		for (const s of live) { assert.strictEqual(isTerminalSubagentStatus(s), false, s); }
	});

	test('a fresh worker starts with empty, non-undefined evidence and activity', () => {
		const e: SubagentEvidence = emptySubagentEvidence();
		const a: SubagentActivity = emptySubagentActivity();
		assert.deepStrictEqual(e.filesTouched, []);
		assert.strictEqual(e.toolsRun, 0);
		assert.deepStrictEqual(a.milestones, []);
		assert.deepStrictEqual(a.recentTools, []);
	});
});

// ---- §8 Multitask browser policy ----

suite('multitask coordinator browser policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('grants exactly the four read-only inspection tools', () => {
		const granted = applyMultitaskBrowserPolicy(['read_file', 'semantic_search']);
		const browserGranted = granted.filter(t => ALL_BROWSER_TOOL_NAMES.has(t));
		assert.deepStrictEqual(browserGranted.sort(), [...MULTITASK_BROWSER_INSPECTION_TOOLS].sort());
	});

	test('strips every mutating browser tool even if it was in the input list', () => {
		const granted = applyMultitaskBrowserPolicy([
			'read_file', 'click_element', 'type_in_page', 'navigate_page', 'run_playwright_code',
			'fill_form', 'drag_element', 'hover_element', 'handle_dialog',
		]);
		for (const denied of ['click_element', 'type_in_page', 'navigate_page', 'run_playwright_code', 'fill_form', 'drag_element', 'hover_element', 'handle_dialog']) {
			assert.strictEqual(granted.includes(denied), false, `${denied} must never be granted to the coordinator`);
		}
	});

	test('non-browser tools pass through untouched', () => {
		const granted = applyMultitaskBrowserPolicy(['read_file', 'semantic_search', 'launch_subagent']);
		for (const kept of ['read_file', 'semantic_search', 'launch_subagent']) {
			assert.strictEqual(granted.includes(kept), true, kept);
		}
	});

	test('an ungated but non-inspection browser tool is still stripped', () => {
		// extract_page_data / watch_page carry no approval type, so a plain read-only filter
		// would hand them to the foreman. The explicit policy must drop them.
		const granted = applyMultitaskBrowserPolicy(['extract_page_data', 'watch_page', 'open_browser']);
		assert.strictEqual(granted.includes('extract_page_data'), false);
		assert.strictEqual(granted.includes('watch_page'), false);
		assert.strictEqual(granted.includes('open_browser'), false);
	});
});

// ---- §6 coordination tools are real ----

suite('worker coordination tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('message_subagent is available to a work worker? no — it is the parent\'s tool', () => {
		assert.strictEqual(isSubagentToolAllowed('work', 'message_subagent', true, { canDelegate: true }), false,
			'a worker must not message its siblings around the parent that owns the batch');
	});

	test('report_progress IS available to both worker profiles', () => {
		assert.strictEqual(isSubagentToolAllowed('work', 'report_progress', true, { canDelegate: false }), true);
		assert.strictEqual(isSubagentToolAllowed('research', 'report_progress', true, { canDelegate: false }), true);
	});
});
