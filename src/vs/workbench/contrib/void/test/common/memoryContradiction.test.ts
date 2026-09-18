/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveContradiction, isAuthoritative } from '../../common/memory/contradiction.js';

suite('memory contradiction (catalog C6)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const human = { source: 'human' };
	const verified = { source: 'ai_inferred', verifiedByTest: true };
	const ai = { source: 'ai_inferred' };

	test('isAuthoritative: human + verified yes; plain AI no', () => {
		assert.ok(isAuthoritative(human));
		assert.ok(isAuthoritative(verified));
		assert.ok(!isAuthoritative(ai));
	});

	test('human supersedes an AI fact -> incoming wins, resolved', () => {
		const d = resolveContradiction(ai, human);
		assert.deepStrictEqual(d, { winner: 'incoming', resolved: true });
	});

	test('verified supersedes an AI fact -> incoming wins, resolved', () => {
		const d = resolveContradiction(ai, verified);
		assert.deepStrictEqual(d, { winner: 'incoming', resolved: true });
	});

	test('AI cannot demote a human fact -> existing wins, FLAGGED', () => {
		const d = resolveContradiction(human, ai);
		assert.deepStrictEqual(d, { winner: 'existing', resolved: false });
	});

	test('AI cannot demote a verified fact -> existing wins, FLAGGED', () => {
		const d = resolveContradiction(verified, ai);
		assert.deepStrictEqual(d, { winner: 'existing', resolved: false });
	});

	test('AI vs AI -> newer (incoming) wins, FLAGGED for review', () => {
		const d = resolveContradiction(ai, ai);
		assert.deepStrictEqual(d, { winner: 'incoming', resolved: false });
	});

	test('human vs human -> newer (incoming) wins, FLAGGED for review', () => {
		const d = resolveContradiction(human, { source: 'human' });
		assert.deepStrictEqual(d, { winner: 'incoming', resolved: false });
	});
});
