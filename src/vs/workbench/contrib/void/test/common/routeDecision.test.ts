/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideAction, applyAction, pickStartingTier } from '../../common/router/routeDecision.js';

suite('void adaptive router decision', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('needsStrongerExecutor swaps one rung up, clamped to ceiling', () => {
		assert.deepStrictEqual(decideAction({ kind: 'needsStrongerExecutor', rule: 't' }, 'V3Fast', 'FullOpus'), { type: 'swapExecutor', toRung: 'V3Pro' });
		assert.deepStrictEqual(decideAction({ kind: 'needsStrongerExecutor', rule: 't' }, 'V3Pro', 'FullOpus'), { type: 'swapExecutor', toRung: 'OpusEasy' });
	});

	test('needsBetterJudgment on OpusEasy bumps the advisor (options-only), not a swap', () => {
		assert.deepStrictEqual(decideAction({ kind: 'needsBetterJudgment', rule: 'j' }, 'OpusEasy', 'FullOpus'), { type: 'bumpAdvisor', from: 'easy', to: 'hard' });
		// ceiling only OpusEasy -> no room for the bump -> hold
		assert.deepStrictEqual(decideAction({ kind: 'needsBetterJudgment', rule: 'j' }, 'OpusEasy', 'OpusEasy'), { type: 'hold' });
	});

	test('reaching the top swaps to a real Opus executor (advisor dropped)', () => {
		assert.deepStrictEqual(decideAction({ kind: 'needsStrongerExecutor', rule: 't' }, 'OpusHard', 'FullOpus'), { type: 'toFullOpus' });
	});

	test('danger short-circuits to at least OpusEasy, clamped, upward-only', () => {
		assert.deepStrictEqual(decideAction({ kind: 'danger', rule: 'd' }, 'V3Fast', 'FullOpus'), { type: 'swapExecutor', toRung: 'OpusEasy' });
		// already above OpusEasy -> danger doesn't move down; normal escalation applies
		assert.deepStrictEqual(decideAction({ kind: 'danger', rule: 'd' }, 'OpusHard', 'FullOpus'), { type: 'toFullOpus' });
	});

	test('hold at the ceiling', () => {
		assert.deepStrictEqual(decideAction({ kind: 'needsStrongerExecutor', rule: 't' }, 'FullOpus', 'FullOpus'), { type: 'hold' });
	});

	test('applyAction resolves the new rung + advisor override', () => {
		assert.deepStrictEqual(applyAction({ type: 'bumpAdvisor', from: 'easy', to: 'hard' }, 'OpusEasy'), { rung: 'OpusEasy', advisorEffortOverride: 'hard' });
		assert.deepStrictEqual(applyAction({ type: 'swapExecutor', toRung: 'V3Pro' }, 'V3Fast'), { rung: 'V3Pro' });
		assert.deepStrictEqual(applyAction({ type: 'toFullOpus' }, 'OpusHard'), { rung: 'FullOpus' });
		assert.deepStrictEqual(applyAction({ type: 'hold' }, 'V3Pro'), { rung: 'V3Pro' });
	});

	test('pickStartingTier scales with difficulty, clamps to ceiling, falls back off absent Local', () => {
		assert.strictEqual(pickStartingTier(0.1, 'FullOpus', true), 'Local');
		assert.strictEqual(pickStartingTier(0.1, 'FullOpus', false), 'V3Fast'); // local not ready yet
		assert.strictEqual(pickStartingTier(0.5, 'FullOpus', true), 'V3Fast');
		assert.strictEqual(pickStartingTier(0.9, 'FullOpus', true), 'V3Pro');
		assert.strictEqual(pickStartingTier(0.9, 'V3Fast', true), 'V3Fast');     // clamped to ceiling
	});
});
