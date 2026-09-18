/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EMPTY_TOKENS, hasTokenId, internTokens, tokenIdOf, tokenStringsOf } from '../../browser/semanticIndex/tokenDict.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('semanticIndex tokenDict', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('intern round-trips through tokenStringsOf as a sorted unique set', () => {
		const ids = internTokens(['beta', 'alpha', 'beta', 'gamma']);
		assert.strictEqual(ids.length, 3); // deduped
		// sorted ascending ids
		assert.deepStrictEqual([...ids], [...ids].sort((a, b) => a - b));
		assert.deepStrictEqual(tokenStringsOf(ids), ['alpha', 'beta', 'gamma']);
		// re-interning the persisted form yields the identical array
		assert.deepStrictEqual([...internTokens(tokenStringsOf(ids))], [...ids]);
	});

	test('membership matches Set semantics including unseen tokens', () => {
		const ids = internTokens(['foo', 'bar']);
		assert.strictEqual(hasTokenId(ids, tokenIdOf('foo')), true);
		assert.strictEqual(hasTokenId(ids, tokenIdOf('bar')), true);
		// a token interned by ANOTHER chunk is a real id but not a member here
		const other = internTokens(['baz']);
		assert.strictEqual(hasTokenId(ids, other[0]), false);
		// never-seen token -> -1 -> false (old Set.has(unknown) === false)
		assert.strictEqual(tokenIdOf('never-seen-token-xyz'), -1);
		assert.strictEqual(hasTokenId(ids, -1), false);
		// empty array edge
		assert.strictEqual(hasTokenId(EMPTY_TOKENS, tokenIdOf('foo')), false);
	});

	test('non-string input is skipped (corrupt persisted record guard)', () => {
		const dirty = ['ok', null, 42, undefined, 'also'] as unknown as string[];
		assert.deepStrictEqual(tokenStringsOf(internTokens(dirty)), ['also', 'ok']);
	});

	test('empty input returns the shared EMPTY_TOKENS constant', () => {
		assert.strictEqual(internTokens([]), EMPTY_TOKENS);
	});
});
