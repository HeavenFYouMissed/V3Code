/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildContextLedger, estimateTokens, formatContextLedger } from '../../common/memory/contextLedger.js';

suite('memory context-budget ledger (catalog C5.2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('estimateTokens = ceil(chars / 4)', () => {
		assert.strictEqual(estimateTokens(''), 0);
		assert.strictEqual(estimateTokens('abcd'), 1);
		assert.strictEqual(estimateTokens('abcde'), 2);
	});

	test('buildContextLedger: totals, shares sum to ~1, largest first, empties dropped', () => {
		const led = buildContextLedger([
			{ name: 'memory', text: 'x'.repeat(400), why: 'salience-ranked memory' },
			{ name: 'system', text: 'y'.repeat(200) },
			{ name: 'empty', text: '' },           // dropped
			{ name: 'grounding', text: 'z'.repeat(800) },
		]);
		assert.strictEqual(led.entries.length, 3, 'empty source dropped');
		assert.strictEqual(led.entries[0].name, 'grounding', 'largest source first');
		assert.strictEqual(led.totalChars, 1400);
		assert.strictEqual(led.totalTokens, 100 + 50 + 200); // 200+800 chars -> tokens; memory 100, system 50, grounding 200
		const shareSum = led.entries.reduce((a, e) => a + e.share, 0);
		assert.ok(Math.abs(shareSum - 1) < 1e-9, 'shares sum to 1');
		assert.ok(led.entries[0].share > led.entries[2].share, 'grounding occupies the most');
	});

	test('buildContextLedger: all-empty -> zero totals, no divide-by-zero', () => {
		const led = buildContextLedger([{ name: 'a', text: '' }, { name: 'b', text: '' }]);
		assert.strictEqual(led.entries.length, 0);
		assert.strictEqual(led.totalTokens, 0);
	});

	test('formatContextLedger: ASCII one-liner with per-source share', () => {
		const s = formatContextLedger(buildContextLedger([{ name: 'memory', text: 'x'.repeat(40) }]));
		assert.ok(s.startsWith('[context-ledger]'));
		assert.ok(s.includes('memory=10t'));
		assert.ok(/[^\x00-\x7F]/.test(s) === false, 'stays ASCII (hygiene)');
	});
});
