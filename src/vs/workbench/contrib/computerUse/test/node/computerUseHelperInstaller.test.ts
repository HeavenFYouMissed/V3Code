/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { findEnclosingDarwinAppBundle } from '../../electron-main/computerUseHelperInstaller.js';

suite('Computer Use Helper Installer', () => {
	test('assesses the enclosing app instead of the loose helper executable', () => {
		assert.strictEqual(
			findEnclosingDarwinAppBundle('/Applications/V3Code.app/Contents/Resources/computerUse/darwin/v3code-computer-use-helper'),
			'/Applications/V3Code.app',
		);
	});

	test('refuses a helper with no assessable application container', () => {
		assert.strictEqual(findEnclosingDarwinAppBundle('/tmp/v3code-computer-use-helper'), undefined);
	});
});
