/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	applyTurnToDurableTask, createDurableTaskFile, DurableTaskFile, extractConstraintsAndGates,
	applyPlanLifecycleToDurableTask, durableTaskLanguageSignals, isGenuineTaskMessage, parseDurableTaskFile, renderDurableTaskBlock, serializeDurableTaskFile, shouldRejectPlanReplace,
	DURABLE_TASK_SIDE_QUEUE_MAX, DURABLE_TASK_VERBATIM_MAX_CHARS,
} from '../../common/memory/durableTask.js';

const T0 = 1_700_000_000_000;

function turn(message: string, over: Partial<Parameters<typeof applyTurnToDurableTask>[1]> = {}) {
	return {
		threadId: 'thread-1',
		message,
		isContinuation: false,
		hasTaskCommand: false,
		hasSwitchIntent: false,
		hasPriorAssistantTurn: true,
		liveTaskInFlight: false,
		now: T0,
		...over,
	};
}

function applied(existing: DurableTaskFile | null, input: ReturnType<typeof turn>) {
	const result = applyTurnToDurableTask(existing, input);
	assert.ok(result.file, `expected task file for action ${result.action}`);
	return { file: result.file, action: result.action };
}

suite('durableTask', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('first genuine task creates the task verbatim (origin first_user_message)', () => {
		const { file, action } = applied(null, turn('Implement the auth repair in /some/path', { hasTaskCommand: true }));
		assert.strictEqual(action, 'created');
		assert.strictEqual(file.task.verbatimGoal, 'Implement the auth repair in /some/path');
		assert.strictEqual(file.task.createdFrom, 'first_user_message');
		assert.strictEqual(file.task.revision, 1);
		assert.strictEqual(file.task.status, 'active');
		assert.ok(file.task.taskId.startsWith('dt_'));
	});

	test('T7: side request never replaces the primary task; "ok keep going" resumes it', () => {
		// The incident script: primary task -> cosmetic side request -> "ok keep going".
		const created = applied(null, turn('Execute the Bot/Agent capability swap per the handoff', { hasTaskCommand: true }));
		const sided = applied(created.file, turn('i want it big and chunky like the second image', { liveTaskInFlight: true }));
		assert.strictEqual(sided.action, 'side-queued');
		assert.strictEqual(sided.file.lastTurnKind, 'side');
		// Primary goal untouched, side request queued:
		assert.strictEqual(sided.file.task.verbatimGoal, 'Execute the Bot/Agent capability swap per the handoff');
		assert.strictEqual(sided.file.task.sideQueue.length, 1);
		assert.strictEqual(sided.file.task.sideQueue[0].status, 'pending');
		assert.ok(sided.file.task.sideQueue[0].text.includes('big and chunky'));
		// Continuation resumes the SAME primary task:
		const resumed = applied(sided.file, turn('ok keep going', { isContinuation: true }));
		assert.strictEqual(resumed.action, 'resumed');
		assert.strictEqual(resumed.file.lastTurnKind, 'work');
		assert.strictEqual(resumed.file.task.taskId, created.file.task.taskId);
		assert.strictEqual(resumed.file.task.verbatimGoal, created.file.task.verbatimGoal);
	});

	test('explicit user task switch still works (old task preserved under superseded)', () => {
		const created = applied(null, turn('Build the auth flow', { hasTaskCommand: true }));
		const switched = applied(created.file, turn('forget that — switch to the onboarding redesign', { hasSwitchIntent: true }));
		assert.strictEqual(switched.action, 'switched');
		assert.strictEqual(switched.file.lastTurnKind, 'switch');
		assert.notStrictEqual(switched.file.task.taskId, created.file.task.taskId);
		assert.strictEqual(switched.file.task.verbatimGoal, 'forget that — switch to the onboarding redesign');
		assert.strictEqual(switched.file.task.createdFrom, 'task_switch');
		assert.strictEqual(switched.file.superseded.length, 1);
		assert.strictEqual(switched.file.superseded[0].verbatimGoal, 'Build the auth flow');
		assert.strictEqual(switched.file.superseded[0].status, 'superseded');
	});

	test('switch vocabulary inside a continuation ("yes, continue") does NOT switch', () => {
		const created = applied(null, turn('Build the auth flow', { hasTaskCommand: true }));
		const cont = applied(created.file, turn('yes continue', { isContinuation: true, hasSwitchIntent: true }));
		assert.strictEqual(cont.action, 'resumed');
		assert.strictEqual(cont.file.task.taskId, created.file.task.taskId);
	});

	test('work-intent follow-ups refine the same task (no new identity, no side queue)', () => {
		const created = applied(null, turn('Implement the settings pane', { hasTaskCommand: true }));
		const refined = applied(created.file, turn('now fix the layout padding', { hasTaskCommand: true }));
		assert.strictEqual(refined.action, 'none');
		assert.strictEqual(refined.file.task.taskId, created.file.task.taskId);
		assert.strictEqual(refined.file.task.sideQueue.length, 0);
		assert.strictEqual(refined.file.lastTurnKind, 'work');
	});

	test('T15: shouldRejectPlanReplace blocks a full replace only from a side turn', () => {
		const created = applied(null, turn('Build the auth flow', { hasTaskCommand: true }));
		assert.strictEqual(shouldRejectPlanReplace(created.file, false), false, 'work turn replace allowed');
		const sided = applied(created.file, turn('quick wordmark tweak', { liveTaskInFlight: true }));
		assert.strictEqual(shouldRejectPlanReplace(sided.file, false), true, 'side turn full replace blocked');
		assert.strictEqual(shouldRejectPlanReplace(sided.file, true), false, 'merge always allowed');
		assert.strictEqual(shouldRejectPlanReplace(null, false), false, 'no record = unguarded (legacy surfaces)');
	});

	test('constraints and approval gates are extracted from the user\'s own words', () => {
		const { constraints, approvalGates } = extractConstraintsAndGates(
			'Ship the panel fix. Never touch the release feed. Stop and report before the Agent side.'
		);
		assert.ok(constraints.some(c => /never touch the release feed/i.test(c)), JSON.stringify(constraints));
		assert.ok(approvalGates.some(g => /stop and report/i.test(g)), JSON.stringify(approvalGates));
	});

	test('round trip: serialize -> parse preserves the record; garbage parses null', () => {
		const created = applied(null, turn('Build the auth flow', { hasTaskCommand: true }));
		const sided = applied(created.file, turn('aside', { liveTaskInFlight: true }));
		const parsed = parseDurableTaskFile(serializeDurableTaskFile(sided.file));
		assert.deepStrictEqual(parsed, sided.file);
		assert.strictEqual(parseDurableTaskFile('not json'), null);
		assert.strictEqual(parseDurableTaskFile('{"threadId": 5}'), null);
	});

	test('rendered block carries goal, revision, gates and the side queue — bounded', () => {
		const created = applied(null, turn('Fix compaction. Never drop unsaved history. Stop and report before shipping.', { hasTaskCommand: true }));
		const sided = applied(created.file, turn('meanwhile the font', { liveTaskInFlight: true }));
		const block = renderDurableTaskBlock(sided.file);
		assert.ok(block.includes('<durable_task>') && block.includes('</durable_task>'));
		assert.ok(block.includes('Fix compaction'), 'goal on the wire');
		assert.ok(block.includes('rev 2'), 'side-queue revision bump visible');
		assert.ok(block.includes('Never drop unsaved history'), 'constraint visible');
		assert.ok(block.includes('meanwhile the font'), 'side request visible but labeled');
		assert.ok(block.length <= 2_000, 'bounded');
	});

	test('side queue is capped (oldest dropped) and verbatim goal is capped', () => {
		let file: DurableTaskFile = createDurableTaskFile('thread-1', 'x'.repeat(DURABLE_TASK_VERBATIM_MAX_CHARS + 500), 'first_user_message', T0);
		assert.ok(file.task.verbatimGoal.length <= DURABLE_TASK_VERBATIM_MAX_CHARS);
		for (let i = 0; i < DURABLE_TASK_SIDE_QUEUE_MAX + 4; i++) {
			file = applied(file, turn(`side request number ${i} here`, { liveTaskInFlight: true, now: T0 + i })).file;
		}
		assert.strictEqual(file.task.sideQueue.length, DURABLE_TASK_SIDE_QUEUE_MAX);
		assert.ok(file.task.sideQueue[0].text.includes(`number 4`), 'oldest entries dropped');
	});

	test('greeting and orientation do not become primary; the next genuine ask does', () => {
		for (const message of ['hello', 'what can you do?', 'open this folder']) {
			const result = applyTurnToDurableTask(null, turn(message, { hasGenuineTaskIntent: isGenuineTaskMessage(message, false) }));
			assert.strictEqual(result.action, 'ignored');
			assert.strictEqual(result.file, null);
		}
		const real = applied(null, turn('Fix the request-size failure', { hasTaskCommand: true }));
		assert.strictEqual(real.file.task.verbatimGoal, 'Fix the request-size failure');
	});

	test('completed task releases authority so an ordinary new task becomes primary', () => {
		const created = applied(null, turn('Fix compaction', { hasTaskCommand: true }));
		const completed = applyPlanLifecycleToDurableTask(created.file, [{ content: 'Fix compaction', status: 'completed' }], T0 + 1);
		assert.strictEqual(completed.task.status, 'completed');
		assert.strictEqual(renderDurableTaskBlock(completed), '');
		const next = applied(completed, turn('Review the provider UI', { hasGenuineTaskIntent: true, now: T0 + 2 }));
		assert.notStrictEqual(next.file.task.taskId, created.file.task.taskId);
		assert.strictEqual(next.file.task.verbatimGoal, 'Review the provider UI');
	});

	test('completed side work stops rendering and explicit promotion makes pending side work primary', () => {
		const created = applied(null, turn('Fix compaction', { hasTaskCommand: true }));
		const sided = applied(created.file, turn('also update the provider label', { liveTaskInFlight: true }));
		const promoteText = 'make that the main task';
		const promoted = applied(sided.file, turn(promoteText, { ...durableTaskLanguageSignals(promoteText) }));
		assert.strictEqual(promoted.action, 'promoted');
		assert.strictEqual(promoted.file.task.verbatimGoal, 'also update the provider label');
		assert.ok(!renderDurableTaskBlock(promoted.file).includes('Side queue'));
	});

	test('switch-back restores the prior task identity', () => {
		const first = applied(null, turn('Fix compaction', { hasTaskCommand: true }));
		const second = applied(first.file, turn('switch to provider auth', { hasSwitchIntent: true }));
		const text = 'switch back';
		const restored = applied(second.file, turn(text, { hasSwitchIntent: true, ...durableTaskLanguageSignals(text) }));
		assert.strictEqual(restored.action, 'restored');
		assert.strictEqual(restored.file.task.taskId, first.file.task.taskId);
	});

	test('long goals cannot truncate approval and forbidden-action gates', () => {
		const goal = `Never publish or sign anything. Stop and ask before deployment. Work only in /safe/worktree. ${'descriptive prose '.repeat(400)}`;
		const file = createDurableTaskFile('thread-1', goal, 'first_user_message', T0);
		const block = renderDurableTaskBlock(file, 700);
		assert.ok(block.includes('Never publish or sign anything'));
		assert.ok(block.includes('Stop and ask before deployment'));
		assert.ok(block.includes('/safe/worktree'));
		assert.ok(block.length <= 700);
	});
});
