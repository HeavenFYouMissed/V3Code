/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { initialV3AgentModePreference } from '../../common/v3AgentModeState.js';

suite('V3 agent mode state', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('fresh profiles start in V3 chat', () => {
		assert.strictEqual(initialV3AgentModePreference(undefined, undefined), true);
	});

	test('an explicit profile choice wins across projects', () => {
		assert.strictEqual(initialV3AgentModePreference(false, true), false);
		assert.strictEqual(initialV3AgentModePreference(true, false), true);
	});

	test('legacy workspace choice migrates when no profile choice exists', () => {
		assert.strictEqual(initialV3AgentModePreference(undefined, false), false);
		assert.strictEqual(initialV3AgentModePreference(undefined, true), true);
	});
});
