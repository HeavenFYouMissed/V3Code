/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TurnOutcomeTracker, CLEAN_TURN } from '../../common/router/turnOutcomes.js';

const TROUBLED = { failures: 3, spiraled: false, testsFailed: false, selfEscalated: false };
const SELF_ESCALATED = { failures: 0, spiraled: false, testsFailed: false, selfEscalated: true };

suite('void adaptive router turn outcomes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('quiet session stays at base', () => {
		const t = new TurnOutcomeTracker();
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'V3Fast');
		t.recordTurnOutcome('s', CLEAN_TURN);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'V3Fast');
	});

	test('one troubled turn escalates the next turn one rung', () => {
		const t = new TurnOutcomeTracker();
		t.startingRungFor('s', 'V3Fast', 'FullOpus');
		t.recordTurnOutcome('s', TROUBLED);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'V3Pro');
	});

	test('two troubled turns jump to OpusEasy (advisor on)', () => {
		const t = new TurnOutcomeTracker();
		t.startingRungFor('s', 'V3Fast', 'FullOpus');
		t.recordTurnOutcome('s', TROUBLED);
		t.startingRungFor('s', 'V3Fast', 'FullOpus'); // V3Pro
		t.recordTurnOutcome('s', TROUBLED);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'OpusEasy');
	});

	test('self-escalation via the escalate_model tool counts as troubled', () => {
		const t = new TurnOutcomeTracker();
		t.startingRungFor('s', 'V3Fast', 'FullOpus');
		t.recordTurnOutcome('s', SELF_ESCALATED);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'V3Pro');
	});

	test('escalation clamps to the ceiling', () => {
		const t = new TurnOutcomeTracker();
		t.startingRungFor('s', 'V3Fast', 'V3Pro');
		t.recordTurnOutcome('s', TROUBLED);
		t.recordTurnOutcome('s', TROUBLED);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'V3Pro'), 'V3Pro'); // OpusEasy jump capped
	});

	test('clean turns decay back toward base one rung per two clean turns', () => {
		const t = new TurnOutcomeTracker();
		t.startingRungFor('s', 'V3Fast', 'FullOpus');
		t.recordTurnOutcome('s', TROUBLED);
		t.recordTurnOutcome('s', TROUBLED);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'OpusEasy');
		t.recordTurnOutcome('s', CLEAN_TURN);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'OpusEasy'); // 1 clean — hold
		t.recordTurnOutcome('s', CLEAN_TURN);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'V3Pro');    // 2 clean — decay
		t.recordTurnOutcome('s', CLEAN_TURN);
		t.recordTurnOutcome('s', CLEAN_TURN);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'V3Fast');   // back at base
		t.recordTurnOutcome('s', CLEAN_TURN);
		t.recordTurnOutcome('s', CLEAN_TURN);
		assert.strictEqual(t.startingRungFor('s', 'V3Fast', 'FullOpus'), 'V3Fast');   // never below base
	});

	test('sessions are independent and resettable', () => {
		const t = new TurnOutcomeTracker();
		t.startingRungFor('a', 'V3Fast', 'FullOpus');
		t.recordTurnOutcome('a', TROUBLED);
		assert.strictEqual(t.startingRungFor('a', 'V3Fast', 'FullOpus'), 'V3Pro');
		assert.strictEqual(t.startingRungFor('b', 'V3Fast', 'FullOpus'), 'V3Fast');
		t.resetSession('a');
		assert.strictEqual(t.startingRungFor('a', 'V3Fast', 'FullOpus'), 'V3Fast');
	});
});
