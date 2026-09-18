/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { applyRerankOrder, buildRerankDoc, RERANK_DOC_CHARS } from '../../common/semanticIndex/llamaRerankerPure.js';
import type { Hit } from '../../common/semanticIndex/semanticIndexTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function mkHit(file: string, content: string, neighbor?: number): Hit {
	return {
		chunk: { file, name: file.split('/').pop() } as any,
		content,
		score: 1,
		signals: neighbor ? { neighbor } : {},
	};
}

suite('llamaReranker pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildRerankDoc: path :: name header + whitespace-flattened body, capped', () => {
		const doc = buildRerankDoc(mkHit('src/a.ts', 'line1\n\t line2   line3'));
		assert.ok(doc.startsWith('src/a.ts :: a.ts\n'));
		assert.ok(doc.includes('line1 line2 line3'));
		const long = buildRerankDoc(mkHit('src/a.ts', 'x'.repeat(10_000)));
		assert.ok(long.length <= RERANK_DOC_CHARS + 'src/a.ts :: a.ts\n'.length);
	});

	test('applyRerankOrder: head reordered by score desc, tail untouched behind it', () => {
		const hits = [mkHit('a', ''), mkHit('b', ''), mkHit('c', ''), mkHit('n1', '', 1)];
		const out = applyRerankOrder(hits, [0.1, 0.9, 0.5]); // head = a,b,c; tail = n1
		assert.deepStrictEqual(out.map(h => h.chunk.file), ['b', 'c', 'a', 'n1']);
	});

	test('applyRerankOrder: stable on tied scores (compressed-range bug safety)', () => {
		// 3.18.1 compresses scores toward [0.5, 0.731]; exact ties must keep fused order.
		const hits = [mkHit('a', ''), mkHit('b', ''), mkHit('c', '')];
		const out = applyRerankOrder(hits, [0.6, 0.6, 0.6]);
		assert.deepStrictEqual(out.map(h => h.chunk.file), ['a', 'b', 'c']);
	});

	test('applyRerankOrder: writes signals.xenc on scored hits only', () => {
		const hits = [mkHit('a', ''), mkHit('b', ''), mkHit('n1', '', 1)];
		const out = applyRerankOrder(hits, [0.7, 0.2]);
		assert.strictEqual(typeof out[0].signals.xenc, 'number');
		assert.strictEqual(typeof out[1].signals.xenc, 'number');
		assert.strictEqual(out[2].signals.xenc, undefined);
		assert.strictEqual(out[2].signals.neighbor, 1);
	});

	test('applyRerankOrder: empty scores is a no-op', () => {
		const hits = [mkHit('a', ''), mkHit('b', '')];
		const out = applyRerankOrder(hits, []);
		assert.deepStrictEqual(out.map(h => h.chunk.file), ['a', 'b']);
	});

	test('applyRerankOrder: protectHead 0 matches omitting the option', () => {
		const hits = [mkHit('a', ''), mkHit('b', ''), mkHit('c', '')];
		const scores = [0.1, 0.9, 0.5];
		assert.deepStrictEqual(
			applyRerankOrder([mkHit('a', ''), mkHit('b', ''), mkHit('c', '')], scores, { protectHead: 0 }).map(h => h.chunk.file),
			applyRerankOrder(hits, scores).map(h => h.chunk.file),
		);
	});

	test('applyRerankOrder: protectHead 1 pins the fused top-1 and still reranks the rest', () => {
		const hits = [mkHit('a', ''), mkHit('b', ''), mkHit('c', '')];
		// Without the guard this head becomes b,c,a (see the reorder test above).
		const out = applyRerankOrder(hits, [0.1, 0.9, 0.5], { protectHead: 1 });
		assert.deepStrictEqual(out.map(h => h.chunk.file), ['a', 'b', 'c']);
	});

	test('applyRerankOrder: protectHead 2 pins two, reranks the remainder, tail intact', () => {
		const hits = [mkHit('a', ''), mkHit('b', ''), mkHit('c', ''), mkHit('d', ''), mkHit('n1', '', 1)];
		const out = applyRerankOrder(hits, [0.2, 0.1, 0.9, 0.5], { protectHead: 2 });
		assert.deepStrictEqual(out.map(h => h.chunk.file), ['a', 'b', 'c', 'd', 'n1']);
	});

	test('applyRerankOrder: protectHead clamps to the scored head length', () => {
		const hits = [mkHit('a', ''), mkHit('b', ''), mkHit('c', '')];
		const out = applyRerankOrder(hits, [0.1, 0.9, 0.5], { protectHead: 10 });
		assert.deepStrictEqual(out.map(h => h.chunk.file), ['a', 'b', 'c']);
	});

	test('applyRerankOrder: negative protectHead falls back to pure rerank', () => {
		const hits = [mkHit('a', ''), mkHit('b', ''), mkHit('c', '')];
		const out = applyRerankOrder(hits, [0.1, 0.9, 0.5], { protectHead: -4 });
		assert.deepStrictEqual(out.map(h => h.chunk.file), ['b', 'c', 'a']);
	});

	test('applyRerankOrder: pinned hits still carry signals.xenc', () => {
		const hits = [mkHit('a', ''), mkHit('b', ''), mkHit('c', '')];
		const out = applyRerankOrder(hits, [0.1, 0.9, 0.5], { protectHead: 1 });
		assert.strictEqual(out[0].signals.xenc, 0.1); // pinned a keeps its own score
		assert.strictEqual(out[1].signals.xenc, 0.9);
		assert.strictEqual(out[2].signals.xenc, 0.5);
	});
});
