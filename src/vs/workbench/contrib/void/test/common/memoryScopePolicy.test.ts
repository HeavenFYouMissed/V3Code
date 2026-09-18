/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { automaticMemoryTarget, memorySearchTargets, workspaceMemoryIdentity } from '../../common/memory/memoryScopePolicy.js';

suite('workspace memory isolation policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an open project never silently reads the global store', () => {
		assert.deepStrictEqual(memorySearchTargets(undefined, true), { workspace: true, global: false });
		assert.deepStrictEqual(memorySearchTargets('workspace', true), { workspace: true, global: false });
		assert.deepStrictEqual(memorySearchTargets('session', true), { workspace: true, global: false });
		assert.strictEqual(automaticMemoryTarget(true), 'workspace');
	});

	test('global recall is an explicit action', () => {
		assert.deepStrictEqual(memorySearchTargets('global', true), { workspace: false, global: true });
		assert.deepStrictEqual(memorySearchTargets(undefined, false), { workspace: false, global: false });
		assert.deepStrictEqual(memorySearchTargets('global', false), { workspace: false, global: true });
		assert.strictEqual(automaticMemoryTarget(false), 'global');
	});

	test('workspace caches are isolated across swaps and stable across folder order', () => {
		assert.notStrictEqual(workspaceMemoryIdentity(['file:///project-a']), workspaceMemoryIdentity(['file:///project-b']));
		assert.strictEqual(
			workspaceMemoryIdentity(['file:///project-b', 'file:///project-a']),
			workspaceMemoryIdentity(['file:///project-a', 'file:///project-b']),
		);
		assert.strictEqual(workspaceMemoryIdentity([]), '<no-workspace>');
	});
});
