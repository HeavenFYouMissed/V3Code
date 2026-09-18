/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ORIGINAL, DIVIDER, FINAL } from '../../common/prompt/prompts.js';
import { scoreTurboDraftBlocks, serializeTurboDraftBlocks } from '../../common/turboDraftHunkQuality.js';

const block = (orig: string, final: string) =>
	`${ORIGINAL}\n${orig}\n${DIVIDER}\n${final}\n${FINAL}`;

suite('turboDraftHunkQuality', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts unique exact match and apply yields draft', () => {
		const file = 'function hello() {\n  return 1\n}\n';
		const blocksStr = block('  return 1', '  return 2');
		const report = scoreTurboDraftBlocks(file, blocksStr);
		assert.strictEqual(report.ok, true);
		assert.strictEqual(report.acceptedBlocks.length, 1);
		assert.ok(report.finalText?.includes('return 2'));
		assert.ok(!report.finalText?.includes('return 1'));
		assert.ok(serializeTurboDraftBlocks(report.acceptedBlocks).includes(ORIGINAL));
	});

	test('rejects not-unique ORIGINAL', () => {
		const file = 'x = 1\nx = 1\n';
		const report = scoreTurboDraftBlocks(file, block('x = 1', 'x = 2'));
		assert.strictEqual(report.ok, false);
		assert.strictEqual(report.scores[0]?.reason, 'not-unique');
		assert.strictEqual(report.acceptedBlocks.length, 0);
	});

	test('rejects not-found', () => {
		const report = scoreTurboDraftBlocks('a\n', block('missing', 'y'));
		assert.strictEqual(report.ok, false);
		assert.strictEqual(report.scores[0]?.reason, 'not-found');
	});

	test('rejects unchanged', () => {
		const report = scoreTurboDraftBlocks('a\n', block('a', 'a'));
		assert.strictEqual(report.ok, false);
		assert.strictEqual(report.scores[0]?.reason, 'unchanged');
	});

	test('rejects empty ORIGINAL as unanchored insertion', () => {
		const report = scoreTurboDraftBlocks('a\n', block('', 'inserted'));
		assert.strictEqual(report.ok, false);
		assert.strictEqual(report.scores[0]?.reason, 'unanchored-insertion');
	});

	test('all-or-nothing: mixed valid+invalid rejects entire response', () => {
		const file = 'alpha\nbeta\n';
		const blocksStr = [
			block('alpha', 'ALPHA'),
			block('missing', 'x'),
		].join('\n\n');
		const report = scoreTurboDraftBlocks(file, blocksStr);
		assert.strictEqual(report.ok, false);
		assert.ok((report.rejectSummary['partial-reject'] ?? 0) >= 1);
		assert.strictEqual(report.acceptedBlocks.length, 0);
		// The good block is kept aside: if the repair pass also fails it beats shipping nothing.
		assert.strictEqual(report.salvageableBlocks.length, 1);
		assert.strictEqual(report.salvageableBlocks[0]?.orig, 'alpha');
	});

	test('salvage is only offered for partial rejects', () => {
		const allBad = scoreTurboDraftBlocks('alpha\n', block('missing', 'x'));
		assert.strictEqual(allBad.ok, false);
		assert.strictEqual(allBad.salvageableBlocks.length, 0, 'nothing was valid, nothing to salvage');

		const good = scoreTurboDraftBlocks('alpha\n', block('alpha', 'ALPHA'));
		assert.strictEqual(good.ok, true);
		assert.strictEqual(good.salvageableBlocks.length, 0, 'the normal path applies acceptedBlocks');
	});

	test('salvaged blocks are individually applicable', () => {
		const file = 'alpha\nbeta\ngamma\n';
		const report = scoreTurboDraftBlocks(file, [
			block('alpha', 'ALPHA'),
			block('gamma', 'GAMMA'),
			block('nowhere', 'x'),
		].join('\n\n'));
		assert.strictEqual(report.salvageableBlocks.length, 2);
		// Re-scoring just the salvage must pass cleanly, otherwise applying it would be unsafe.
		const rescored = scoreTurboDraftBlocks(file, report.salvageableBlocks.map(b => block(b.orig, b.final)).join('\n\n'));
		assert.strictEqual(rescored.ok, true, JSON.stringify(rescored.rejectSummary));
	});

	test('normalizes CRLF for matching', () => {
		const file = 'line1\r\nline2\r\n';
		const report = scoreTurboDraftBlocks(file, block('line1\nline2', 'line1\nLINE2'));
		assert.strictEqual(report.ok, true);
		assert.ok(report.finalText?.includes('LINE2'));
	});

	test('rejects ambiguous marker counts', () => {
		const file = 'hello\n';
		const bad = `${ORIGINAL}\nhello\n${DIVIDER}\n${DIVIDER}\nworld\n${FINAL}`;
		const report = scoreTurboDraftBlocks(file, bad);
		assert.strictEqual(report.ok, false);
		assert.ok((report.rejectSummary['ambiguous-markers'] ?? 0) >= 1);
	});
});
