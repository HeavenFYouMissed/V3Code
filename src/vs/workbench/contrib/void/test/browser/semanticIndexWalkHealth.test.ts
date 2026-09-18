/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { coveredByFailedWalk, failedWalkPrefix, walkHealthRetryDelay } from '../../browser/semanticIndex/walkHealth.js';

suite('semanticIndex / walk health', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves only files below an unreadable directory', () => {
		const prefix = failedWalkPrefix('/repo', '/repo/packages/app', false);
		assert.strictEqual(prefix, 'packages/app');
		assert.strictEqual(coveredByFailedWalk('packages/app/src/index.ts', [prefix!]), true);
		assert.strictEqual(coveredByFailedWalk('packages/api/src/index.ts', [prefix!]), false);
	});

	test('handles Windows paths and drive-letter case', () => {
		const prefix = failedWalkPrefix('C:\\Repo', 'c:\\repo\\src\\feature', true);
		assert.strictEqual(prefix, 'src/feature');
		assert.strictEqual(coveredByFailedWalk('src/feature/index.ts', [prefix!]), true);
	});

	test('a failed workspace root conservatively preserves every old file', () => {
		assert.strictEqual(failedWalkPrefix('/repo', '/repo', false), '');
		assert.strictEqual(coveredByFailedWalk('any/path.ts', ['']), true);
	});

	test('retry backoff is bounded', () => {
		assert.deepStrictEqual([0, 1, 2, 8].map(walkHealthRetryDelay), [15_000, 30_000, 60_000, 300_000]);
	});
});
