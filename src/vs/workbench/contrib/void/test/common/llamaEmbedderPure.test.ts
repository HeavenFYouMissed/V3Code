/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { formatForQwen3Embedding, l2Normalize, QWEN3_EMBED_MODEL } from '../../common/semanticIndex/llamaEmbedder.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('llamaEmbedder pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('documents embed raw, queries get the Qwen3 instruct prefix', () => {
		assert.strictEqual(formatForQwen3Embedding('const x = 1', 'doc'), 'const x = 1');
		const q = formatForQwen3Embedding('where is auth handled', 'query');
		assert.ok(q.startsWith('Instruct: '));
		assert.ok(q.includes('\nQuery: where is auth handled'));
	});

	test('over-long inputs are truncated below the context ceiling', () => {
		const long = 'x'.repeat(50_000);
		assert.ok(formatForQwen3Embedding(long, 'doc').length <= 11_000);
		// queries run on a smaller dedicated context (1536 tokens) so their
		// char guard is tighter: 4000 chars + the instruct prefix.
		assert.ok(formatForQwen3Embedding(long, 'query').length <= 4_100);
	});

	test('l2Normalize produces unit vectors (quantizer contract)', () => {
		const v = l2Normalize(Float32Array.from([3, 4]));
		assert.ok(Math.abs(v[0] - 0.6) < 1e-6);
		assert.ok(Math.abs(v[1] - 0.8) < 1e-6);
		let norm = 0;
		for (const x of v) { norm += x * x; }
		assert.ok(Math.abs(norm - 1) < 1e-6);
	});

	test('l2Normalize leaves zero vectors zero (neutral no-match, not NaN)', () => {
		const v = l2Normalize(new Float32Array(4));
		for (const x of v) { assert.strictEqual(x, 0); }
	});

	test('model identity is stable — changing it invalidates every stored vector', () => {
		// CAS entries and the manifest key vectors on this exact string + dim.
		// If you change the GGUF/quant, change the id WITH it, never silently.
		assert.strictEqual(QWEN3_EMBED_MODEL.id, 'Qwen/Qwen3-Embedding-0.6B-GGUF@Q8_0');
		assert.strictEqual(QWEN3_EMBED_MODEL.dim, 1024);
	});
});
