/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { rrfMerge, RankedItem } from '../../common/semanticIndex/rrf.js';

interface Doc extends RankedItem {
	id: string;
	label: string;
}

const d = (id: string): Doc => ({ id, label: id });

suite('semanticIndex / rrfMerge', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty input returns empty output', () => {
		assert.deepStrictEqual(rrfMerge<Doc>([]), []);
		assert.deepStrictEqual(rrfMerge<Doc>([[], [], []]), []);
	});

	test('single list preserves ranking order', () => {
		const result = rrfMerge<Doc>([[d('a'), d('b'), d('c')]]);
		assert.deepStrictEqual(result.map(r => r.item.id), ['a', 'b', 'c']);
	});

	test('exact RRF arithmetic with k=60 across two channels', () => {
		// 'a' is rank 1 in channel 0 only.            score = 1/(60+1) = 1/61
		// 'b' is rank 2 in channel 0 and rank 1 in 1. score = 1/62 + 1/61
		// 'c' is rank 3 in channel 0 only.            score = 1/63
		const result = rrfMerge<Doc>([
			[d('a'), d('b'), d('c')],
			[d('b')],
		]);

		const byId = new Map(result.map(r => [r.item.id, r.score]));
		const eps = 1e-12;

		assert.ok(Math.abs(byId.get('a')! - (1 / 61)) < eps, `a score: ${byId.get('a')}`);
		assert.ok(Math.abs(byId.get('b')! - (1 / 62 + 1 / 61)) < eps, `b score: ${byId.get('b')}`);
		assert.ok(Math.abs(byId.get('c')! - (1 / 63)) < eps, `c score: ${byId.get('c')}`);

		// b should rank first because it appears in both lists.
		assert.strictEqual(result[0].item.id, 'b');
	});

	test('doc present in multiple lists wins over doc that tops only one', () => {
		// 'top' is rank 1 in channel 0 but absent elsewhere.
		// 'spread' is rank 3 in all four channels.
		// RRF defends the spread doc against the spike doc — that is the whole point.
		const top = d('top');
		const spread = d('spread');
		const filler = (i: number) => d(`f${i}`);

		const result = rrfMerge<Doc>([
			[top, filler(0), spread],
			[filler(1), filler(2), spread],
			[filler(3), filler(4), spread],
			[filler(5), filler(6), spread],
		]);

		const idx = (id: string) => result.findIndex(r => r.item.id === id);
		assert.ok(idx('spread') < idx('top'), `spread (#${idx('spread')}) should rank above top (#${idx('top')})`);
	});

	test('ranks array preserves per-channel position with 0 for absent', () => {
		const result = rrfMerge<Doc>([
			[d('x'), d('y')],
			[d('y'), d('z')],
			[d('x')],
		]);

		const byId = new Map(result.map(r => [r.item.id, r.ranks]));
		assert.deepStrictEqual(byId.get('x'), [1, 0, 1]);
		assert.deepStrictEqual(byId.get('y'), [2, 1, 0]);
		assert.deepStrictEqual(byId.get('z'), [0, 2, 0]);
	});

	test('invalid k throws', () => {
		assert.throws(() => rrfMerge<Doc>([[d('a')]], 0), /k must be positive/);
		assert.throws(() => rrfMerge<Doc>([[d('a')]], -1), /k must be positive/);
	});

	test('duplicate id within the same list accumulates correctly', () => {
		// Defensive — callers shouldn't pass duplicates, but if they do the
		// second occurrence overwrites the first's rank for that channel.
		// We document the behavior here so a future change doesn't silently
		// drift.
		const result = rrfMerge<Doc>([[d('a'), d('a')]]);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].ranks[0], 2); // last write wins
	});
});
