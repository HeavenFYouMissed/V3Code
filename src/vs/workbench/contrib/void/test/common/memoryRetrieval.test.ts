/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { cosineSim, normalizeScores } from '../../common/memory/vectorMath.js';
import { hybridMerge } from '../../common/memory/hybridMerge.js';
import { decayFactor, applyDecay, isEvergreen, DECAY_HALFLIVES } from '../../common/memory/temporalDecay.js';
import { mmrSelect } from '../../common/memory/mmr.js';

suite('memory retrieval math (catalog C4)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('cosineSim: identical = 1, orthogonal = 0, empty = 0', () => {
		assert.ok(Math.abs(cosineSim([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
		assert.strictEqual(cosineSim([1, 0], [0, 1]), 0);
		assert.strictEqual(cosineSim([], [1, 2]), 0);
		assert.strictEqual(cosineSim([0, 0], [1, 1]), 0); // zero-magnitude -> 0, not NaN
	});

	test('normalizeScores: maps to [0,1]; all-equal -> all 1', () => {
		const n = normalizeScores(new Map([['a', 2], ['b', 4], ['c', 6]]));
		assert.strictEqual(n.get('a'), 0);
		assert.strictEqual(n.get('c'), 1);
		assert.strictEqual(n.get('b'), 0.5);
		const eq = normalizeScores(new Map([['a', 5], ['b', 5]]));
		assert.strictEqual(eq.get('a'), 1);
		assert.strictEqual(eq.get('b'), 1);
	});

	test('hybridMerge: 0.7*vec + 0.3*bm25 ordering + exact weights', () => {
		// A: best vector, worst BM25. B: worst vector, best BM25. At 0.7/0.3, A wins.
		const vec = new Map([['A', 1.0], ['B', 0.0]]);
		const bm25 = new Map([['A', 0.0], ['B', 1.0]]);
		const m = hybridMerge(vec, bm25);
		assert.ok(m.get('A')! > m.get('B')!, 'vector-strong A outranks BM25-strong B');
		assert.ok(Math.abs(m.get('A')! - 0.7) < 1e-9);
		assert.ok(Math.abs(m.get('B')! - 0.3) < 1e-9);
	});

	test('hybridMerge: union of ids; missing side counts as 0', () => {
		const m = hybridMerge(new Map([['A', 1]]), new Map([['B', 1]]));
		assert.ok(m.has('A') && m.has('B'));
		assert.ok(Math.abs(m.get('A')! - 0.7) < 1e-9); // A only in vec -> 0.7*1 + 0.3*0
		assert.ok(Math.abs(m.get('B')! - 0.3) < 1e-9); // B only in bm25 -> 0.7*0 + 0.3*1
	});

	test('temporalDecay: half-life halves; older ranks lower; age 0 = 1', () => {
		const hl = DECAY_HALFLIVES.workspace;
		assert.ok(Math.abs(decayFactor(hl, hl) - 0.5) < 1e-9);
		assert.ok(decayFactor(2 * hl, hl) < decayFactor(hl, hl));
		assert.strictEqual(decayFactor(0, hl), 1);
		assert.strictEqual(decayFactor(hl, Infinity), 1); // evergreen layer never decays
	});

	test('temporalDecay: evergreen (human / verified) is exempt', () => {
		assert.ok(isEvergreen({ source: 'human' }));
		assert.ok(isEvergreen({ verifiedByTest: true }));
		assert.ok(!isEvergreen({ source: 'ai_inferred' }));
		const old = 100 * DECAY_HALFLIVES.workspace;
		assert.strictEqual(applyDecay(1, old, DECAY_HALFLIVES.workspace, true), 1); // kept
		assert.ok(applyDecay(1, old, DECAY_HALFLIVES.workspace, false) < 0.01);      // decayed away
	});

	test('mmr: drops a near-duplicate in favour of a diverse item', () => {
		const items = [
			{ id: 'A', relevance: 1.0, vec: [1, 0, 0] },
			{ id: 'B', relevance: 0.95, vec: [0.99, 0.01, 0] }, // near-duplicate of A
			{ id: 'C', relevance: 0.9, vec: [0, 1, 0] },         // distinct
		];
		const top2 = mmrSelect(items, 2, 0.7);
		assert.strictEqual(top2[0], 'A', 'A picked first (highest relevance)');
		assert.strictEqual(top2[1], 'C', 'C (diverse) beats the near-duplicate B at lambda 0.7');
	});

	test('mmr: pure relevance (lambda=1) ignores diversity', () => {
		const items = [
			{ id: 'A', relevance: 1.0, vec: [1, 0] },
			{ id: 'B', relevance: 0.9, vec: [1, 0] }, // identical vec but lambda=1 -> relevance wins
			{ id: 'C', relevance: 0.5, vec: [0, 1] },
		];
		assert.deepStrictEqual(mmrSelect(items, 2, 1.0), ['A', 'B']);
	});
});
