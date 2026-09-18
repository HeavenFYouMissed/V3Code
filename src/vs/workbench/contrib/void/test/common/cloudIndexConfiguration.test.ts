/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IWorkspace } from '../../../../../platform/workspace/common/workspace.js';
import { deriveCloudIndexWorkspaceIdForWorkspace } from '../../common/cloudIndex/cloudIndexConfiguration.js';

function workspace(id: string, name = 'VSElite'): IWorkspace {
	return { id, name, folders: [] };
}

suite('cloud index / workspace identity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses an authenticated configured repository id verbatim', () => {
		assert.strictEqual(deriveCloudIndexWorkspaceIdForWorkspace(workspace('local-id'), 'team/repository-id'), 'team/repository-id');
	});

	test('same-named checkouts do not collide', () => {
		const first = deriveCloudIndexWorkspaceIdForWorkspace(workspace('aaaaaaaa11111111'), '');
		const second = deriveCloudIndexWorkspaceIdForWorkspace(workspace('bbbbbbbb22222222'), '');
		assert.notStrictEqual(first, second);
		assert.ok(first.startsWith('vselite-'));
		assert.ok(second.startsWith('vselite-'));
	});

	test('fallback id is bounded and contains no absolute path', () => {
		const id = deriveCloudIndexWorkspaceIdForWorkspace(workspace('ABC-123', '/Users/daniel/private/repository'), '');
		assert.ok(id.length <= 64);
		assert.ok(!id.includes('/'));
		assert.ok(id.endsWith('-abc123'));
	});
});
