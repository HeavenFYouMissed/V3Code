/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyTurn, classifyContinuation, isContinuationPhrase, TurnKind } from '../../common/memory/turnIntent.js';

suite('memory turn-intent (contract §5)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('turn classification table', () => {
		// [liveMessage, hasPriorAssistantTurn, expectedTurnKind]
		const cases: Array<[string, boolean, TurnKind]> = [
			// new task — carries its own goal
			['build a coffee website', false, 'new_task'],
			['fix the login bug', false, 'new_task'],
			['fix the login bug', true, 'new_task'],          // a task command is a new task even mid-thread
			['research the best charting libs', true, 'new_task'],
			// continuation — affirmation AFTER the agent has engaged
			['go for it', true, 'continuation'],
			['ok do it', true, 'continuation'],
			['Ok do it', true, 'continuation'],
			['go', true, 'continuation'],
			['keep going', true, 'continuation'],
			['yes', true, 'continuation'],
			['ok', true, 'continuation'],
			['sure', true, 'continuation'],
			['yes please', true, 'continuation'],
			// switch / resume — explicit
			['continue', true, 'switch'],                      // "continue" is an explicit resume word
			['where were we', true, 'switch'],
			['go back to the auth task', true, 'switch'],
			// chitchat / meta — and the safety boundary
			['go for it', false, 'chitchat'],                  // approval with NO prior agent turn is meaningless
			['thanks', true, 'chitchat'],                      // pure acknowledgment is NOT "keep working"
			['cool', true, 'chitchat'],
			['nice', true, 'chitchat'],
			['no', true, 'chitchat'],
			['what model are you', true, 'chitchat'],
			['', true, 'chitchat'],
		];
		const actual = cases.map(([m, p]) => classifyTurn(m, p));
		const expected = cases.map(c => c[2]);
		assert.deepStrictEqual(actual, expected);
	});

	test('coffee-site repro: an approval after the agent engaged resumes, it does not restart', () => {
		// turn 1 — user asks; no assistant turn exists yet
		assert.strictEqual(classifyTurn('build a coffee website', false), 'new_task');
		// agent engages... turn 2 — user approves; the assistant has now produced turns
		assert.strictEqual(classifyTurn('go for it', true), 'continuation');
		assert.strictEqual(classifyTurn('ok do it', true), 'continuation');
		// the SAME approval with no prior agent turn must stay harmless (no loop trigger)
		assert.strictEqual(classifyTurn('go for it', false), 'chitchat');
	});

	test('continuation requires a prior agent turn, and ignores long / task-bearing messages', () => {
		assert.strictEqual(classifyContinuation('go for it', false), false); // no prior turn
		assert.strictEqual(classifyContinuation('go for it', true), true);
		assert.strictEqual(classifyContinuation('do it '.repeat(20), true), false); // >60 chars: suspicious, not a bare approval
		assert.strictEqual(classifyContinuation('build it the way you think', true), false); // carries a task verb
	});

	test('isContinuationPhrase: proceed-verbs and bare affirmatives yes; acknowledgments no', () => {
		const yes = ['go', 'go for it', 'ok do it', 'keep going', 'proceed', 'yes', 'ok', 'sure', 'yep'];
		const no = ['thanks', 'cool', 'nice', 'great', 'perfect', 'no', 'stop', 'wait'];
		assert.deepStrictEqual(
			{ yes: yes.map(isContinuationPhrase), no: no.map(isContinuationPhrase) },
			{ yes: yes.map(() => true), no: no.map(() => false) }
		);
	});

	// Fix 1 (the "ok bro" drop): an affirmation followed by trailing filler, a vocative, or a
	// light status/progress question — "ok now", "ok bro", "ok now what happens", "ok so",
	// "alright keep going" — must classify as continuation. Without this, the task_kernel
	// branded the in-progress task "already answered" and the agent restarted.
	test('isContinuationPhrase: affirmation-led with trailing filler / vocative / status-question is continuation', () => {
		const yes = [
			'ok now',
			'ok bro',
			'ok now what happens',
			'ok now whats different',
			'ok so',
			'ok so is it working',
			'alright keep going',
			'ok dude',
			'yeah man',
			'ok buddy',
			"ok now what's next",
			'ok did it work',
			'ok any luck',
			'ok all good',
			'ok we good',
			'sure now',
			'yes bro',
		];
		assert.deepStrictEqual(
			yes.map(m => [m, isContinuationPhrase(m)]),
			yes.map(m => [m, true]),
		);
	});

	// Negative side of Fix 1: pure acknowledgments / closure / non-affirmation messages must
	// stay non-continuation so the agent doesn't keep grinding when the user is just thanking
	// it. Note: "yea resume" / "k continue" are NOT tested here because they contain a switch
	// verb and TASK_SWITCH_INTENT_RE precedence (correctly) routes them to 'switch' — see the
	// classifyTurn precedence test below.
	test('isContinuationPhrase: pure acknowledgments and closures stay non-continuation', () => {
		const no = [
			'thanks',
			"perfect, that's done",
			'cool now',
			'nice work',
			'great job',
			"that's good",
			'lgtm',
			'right',
			'no',
			'stop',
			'wait',
		];
		assert.deepStrictEqual(
			no.map(m => [m, isContinuationPhrase(m)]),
			no.map(m => [m, false]),
		);
	});

	// classifyTurn precedence: a real new-task command after an affirmation must be 'new_task',
	// an affirmation + switch verb ("yea resume", "k continue", "alright go back to ...") must
	// be 'switch' (which still gets work/mayResumeMemoryTask=true), and a clean affirmation-led
	// message must be 'continuation'. The shared safety property the harness depends on: NONE
	// of these may fall through to 'chitchat' — that was the bug.
	test('classifyTurn: precedence — task command, switch verb, and affirmation-led continuation', () => {
		assert.strictEqual(classifyTurn('ok now fix the picker', true), 'new_task');
		assert.strictEqual(classifyTurn('ok now build the chart', true), 'new_task');
		assert.strictEqual(classifyTurn('alright go back to the auth task', true), 'switch');
		assert.strictEqual(classifyTurn('yea resume', true), 'switch');
		assert.strictEqual(classifyTurn('k continue', true), 'switch');
		assert.strictEqual(classifyTurn('ok bro', true), 'continuation');
		assert.strictEqual(classifyTurn('ok now', true), 'continuation');
		assert.strictEqual(classifyTurn('ok now what happens', true), 'continuation');
		assert.strictEqual(classifyTurn('alright keep going', true), 'continuation');
		// SAFETY: none of the live-continuation messages may land in 'chitchat'.
		const safetyMessages = ['ok now', 'ok bro', 'ok now what happens', 'ok so', 'yea resume', 'alright keep going', 'k continue'];
		for (const m of safetyMessages) {
			assert.notStrictEqual(classifyTurn(m, true), 'chitchat', `"${m}" must not classify as chitchat`);
		}
		// Pure acknowledgment STAYS chitchat — the user is reacting, not asking for more work.
		assert.strictEqual(classifyTurn('cool now', true), 'chitchat');
		assert.strictEqual(classifyTurn('thanks', true), 'chitchat');
	});
});
