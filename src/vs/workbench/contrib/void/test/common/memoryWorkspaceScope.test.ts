/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isGreenfieldWorkspace } from '../../common/memory/workspaceScope.js';

suite('memory workspace scope (greenfield gate)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('greenfield detection across workspace states', () => {
		const noWorkspace = '(NO WORKSPACE OPEN)';
		const empty = '';
		const onlyV3code = 'Directory of /x/test1:\n- .v3code/';
		const dotOnly = 'Directory of /x/test1:\n- .v3code/\n- .git/\n- .DS_Store';
		const oneRealFile = 'Directory of /x/test1:\n- .v3code/\n- notes.txt';     // 1 real entry -> still greenfield
		const tinyRealProject = 'Directory of /x/proj:\n- .v3code/\n- package.json\n- README.md\n- src/'; // 3 real -> NOT greenfield
		const realProject = 'Directory of /x/proj:\n' + Array.from({ length: 20 }, (_, i) => `  - file${i}.ts`).join('\n');

		assert.deepStrictEqual(
			[noWorkspace, empty, onlyV3code, dotOnly, oneRealFile, tinyRealProject, realProject].map(isGreenfieldWorkspace),
			[true, true, true, true, true, false, false]
		);
	});

	test('coffee-site repro: blank folder is greenfield, so cross-project memory must not auto-push', () => {
		// What Daniel's test1 folder looked like at turn 1 (only .v3code) - the agent must NOT be fed
		// GLOBAL V3Code-dev facts here. After a real scaffold lands many files, it is no longer greenfield.
		assert.strictEqual(isGreenfieldWorkspace('Directory of /Users/daniel/dev/v3codetests/test1:\n- .v3code/'), true);
		const scaffolded = 'Directory of /x/test1:\n' + ['- .v3code/', '- package.json', '- next.config.js', '- app/', '- public/'].join('\n');
		assert.strictEqual(isGreenfieldWorkspace(scaffolded), false);
	});
});
