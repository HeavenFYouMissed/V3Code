/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canInjectSemanticAutoContext, canServeSemanticWorkspace, shouldResetSemanticCorpus } from '../../common/semanticIndex/semanticWorkspacePolicy.js';

suite('semantic workspace isolation policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an index can answer only for the workspace that produced it', () => {
		assert.strictEqual(canServeSemanticWorkspace('workspace:a', 'workspace:a'), true);
		assert.strictEqual(canServeSemanticWorkspace('workspace:a', 'workspace:b'), false);
		assert.strictEqual(canServeSemanticWorkspace(null, 'workspace:a'), false);
	});

	test('automatic context waits for a complete ready index', () => {
		assert.strictEqual(canInjectSemanticAutoContext('ready', 3), true);
		assert.strictEqual(canInjectSemanticAutoContext('walking', 3), false);
		assert.strictEqual(canInjectSemanticAutoContext('chunking', 3), false);
		assert.strictEqual(canInjectSemanticAutoContext('embedding', 3), false);
		assert.strictEqual(canInjectSemanticAutoContext('ready', 0), false);
	});

	test('an incomplete live workspace swap never preserves the prior corpus', () => {
		assert.strictEqual(shouldResetSemanticCorpus(true, true, false), true);
		assert.strictEqual(shouldResetSemanticCorpus(true, true, true), false, 'same-workspace health reconcile may preserve verified files');
		assert.strictEqual(shouldResetSemanticCorpus(true, false, true), true);
		assert.strictEqual(shouldResetSemanticCorpus(false, false, false), false);
	});
});
