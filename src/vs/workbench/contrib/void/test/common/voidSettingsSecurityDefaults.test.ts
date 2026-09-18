/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { defaultGlobalSettings } from '../../common/voidSettingsTypes.js';

suite('void settings security defaults', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('dangerous tool auto-approval is deny-by-default', () => {
		assert.deepStrictEqual(defaultGlobalSettings.autoApprove, {});
		assert.strictEqual(defaultGlobalSettings.autoApprove.edits, undefined);
		assert.strictEqual(defaultGlobalSettings.autoApprove.terminal, undefined);
		assert.strictEqual(defaultGlobalSettings.autoApprove['MCP tools'], undefined);
		assert.strictEqual(defaultGlobalSettings.autoApprove.projects, undefined);
		assert.strictEqual(defaultGlobalSettings.didMigrateAutoApproveDefaults, true);
	});

	test('local autocomplete is opt-in', () => {
		assert.strictEqual(defaultGlobalSettings.enableAutocomplete, false);
	});
});
