/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	appendStageHistory,
	canTransitionTurboDraftPhase,
	isTurboDraftBusyPhase,
	isTurboDraftTerminalPhase,
} from '../../common/turboDraftRunState.js';

suite('turboDraftRunState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('legal monotonic progress transitions', () => {
		assert.strictEqual(canTransitionTurboDraftPhase('idle', 'reading'), true);
		assert.strictEqual(canTransitionTurboDraftPhase('reading', 'recognizing'), true);
		assert.strictEqual(canTransitionTurboDraftPhase('restructuring', 'validating'), true);
		assert.strictEqual(canTransitionTurboDraftPhase('validating', 'repairing'), true);
		assert.strictEqual(canTransitionTurboDraftPhase('repairing', 'validating'), true);
		assert.strictEqual(canTransitionTurboDraftPhase('creatingTabs', 'ready'), true);
		assert.strictEqual(canTransitionTurboDraftPhase('ready', 'completed'), true);
	});

	test('cannot regress progress stages', () => {
		assert.strictEqual(canTransitionTurboDraftPhase('restructuring', 'reading'), false);
		assert.strictEqual(canTransitionTurboDraftPhase('validating', 'organizing'), false);
	});

	test('terminal states are sticky except ready exits', () => {
		assert.strictEqual(isTurboDraftTerminalPhase('error'), true);
		assert.strictEqual(isTurboDraftTerminalPhase('noChanges'), true);
		assert.strictEqual(canTransitionTurboDraftPhase('error', 'reading'), false);
		assert.strictEqual(canTransitionTurboDraftPhase('noChanges', 'ready'), false);
		assert.strictEqual(canTransitionTurboDraftPhase('ready', 'cancelled'), true);
		assert.strictEqual(canTransitionTurboDraftPhase('ready', 'error'), true);
	});

	test('busy vs terminal helpers', () => {
		assert.strictEqual(isTurboDraftBusyPhase('restructuring'), true);
		assert.strictEqual(isTurboDraftBusyPhase('ready'), false);
		assert.strictEqual(isTurboDraftBusyPhase('error'), false);
	});

	test('appendStageHistory merges same phase and appends new', () => {
		const h1 = appendStageHistory([], 'reading', 1, 'a');
		const h2 = appendStageHistory(h1, 'reading', 2, 'b');
		assert.strictEqual(h2.length, 1);
		assert.strictEqual(h2[0]!.detail, 'b');
		const h3 = appendStageHistory(h2, 'recognizing', 3);
		assert.strictEqual(h3.length, 2);
		assert.strictEqual(h3[1]!.phase, 'recognizing');
	});
});
