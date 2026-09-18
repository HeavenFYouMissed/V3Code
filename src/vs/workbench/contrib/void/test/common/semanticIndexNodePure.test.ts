/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	capEmbedText, isValidNodeChunkInput, mapNodeHits, toBatches,
	NodeIndexChunkInput, NodeIndexHit, NODE_EMBED_MAX_CHARS,
} from '../../common/semanticIndex/semanticIndexNodeIpc.js';
import type { Chunk } from '../../common/semanticIndex/semanticIndexTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function mkChunkInput(overrides: Partial<NodeIndexChunkInput> = {}): NodeIndexChunkInput {
	return {
		id: 'abc123', file: 'src/a.ts', name: 'foo',
		startLine: 1, endLine: 10, text: 'function foo() {}',
		...overrides,
	};
}

function mkNodeHit(id: string, file: string, content: string, score = 0.5): NodeIndexHit {
	const chunk: Chunk = {
		id, file, startLine: 1, endLine: 5, kind: 'block',
		name: file.split('/').pop() ?? '', language: 'typescript', contentHash: 'h',
	};
	return { chunk, content, score, signals: { fts: 1 } };
}

suite('semanticIndexNode pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('toBatches: splits into consecutive batches of at most size', () => {
		const batches = toBatches([1, 2, 3, 4, 5], 2);
		assert.deepStrictEqual(batches, [[1, 2], [3, 4], [5]]);
	});

	test('toBatches: empty input, oversized batch, and degenerate size', () => {
		assert.deepStrictEqual(toBatches([], 4), []);
		assert.deepStrictEqual(toBatches([1, 2], 100), [[1, 2]]);
		// size < 1 is clamped to 1 rather than looping forever
		assert.deepStrictEqual(toBatches([1, 2], 0), [[1], [2]]);
		assert.deepStrictEqual(toBatches([1, 2], -3), [[1], [2]]);
	});

	test('capEmbedText: prefix-truncates past the embed cap, no-ops below it', () => {
		assert.strictEqual(capEmbedText('short'), 'short');
		const long = 'x'.repeat(NODE_EMBED_MAX_CHARS + 500);
		const capped = capEmbedText(long);
		assert.strictEqual(capped.length, NODE_EMBED_MAX_CHARS);
		assert.ok(long.startsWith(capped));
		assert.strictEqual(capEmbedText('abcdef', 3), 'abc');
	});

	test('isValidNodeChunkInput: accepts the wire shape', () => {
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput()), true);
		// empty name is fine (window chunks have no symbol), empty text is fine
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput({ name: '', text: '' })), true);
		// single-line chunk
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput({ startLine: 7, endLine: 7 })), true);
	});

	test('isValidNodeChunkInput: rejects malformed rows', () => {
		assert.strictEqual(isValidNodeChunkInput(null), false);
		assert.strictEqual(isValidNodeChunkInput(undefined), false);
		assert.strictEqual(isValidNodeChunkInput({}), false);
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput({ id: '' })), false);
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput({ file: '' })), false);
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput({ startLine: 0 })), false);
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput({ startLine: 9, endLine: 3 })), false);
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput({ startLine: 1.5 as any })), false);
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput({ text: 42 as any })), false);
		assert.strictEqual(isValidNodeChunkInput(mkChunkInput({ name: undefined as any })), false);
	});

	test('mapNodeHits: known ids resolve to the renderer chunk (richer metadata wins)', () => {
		const rendererChunk: Chunk & { content?: string } = {
			id: 'k1', file: 'src/a.ts', startLine: 1, endLine: 5, kind: 'function',
			name: 'fooRenamed', language: 'typescript', contentHash: 'h2', content: 'renderer content',
		};
		const out = mapNodeHits([mkNodeHit('k1', 'src/a.ts', 'node content')], id => id === 'k1' ? rendererChunk : undefined);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].chunk, rendererChunk); // identity: renderer metadata
		assert.strictEqual(out[0].content, 'node content'); // wire content still preferred
		assert.strictEqual(out[0].signals.fts, 1);
	});

	test('mapNodeHits: unknown ids keep the engine chunk as a minimal synthetic', () => {
		const hit = mkNodeHit('unknown', 'src/b.ts', 'engine content', 0.25);
		const out = mapNodeHits([hit], () => undefined);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].chunk.id, 'unknown');
		assert.strictEqual(out[0].chunk.file, 'src/b.ts');
		assert.strictEqual(out[0].content, 'engine content');
		assert.strictEqual(out[0].score, 0.25);
	});

	test('mapNodeHits: empty wire content falls back to the resolved chunk content', () => {
		const rendererChunk: Chunk & { content?: string } = {
			id: 'k1', file: 'src/a.ts', startLine: 1, endLine: 5, kind: 'function',
			name: 'foo', language: 'typescript', contentHash: 'h', content: 'renderer content',
		};
		const out = mapNodeHits([mkNodeHit('k1', 'src/a.ts', '')], () => rendererChunk);
		assert.strictEqual(out[0].content, 'renderer content');
	});

	test('mapNodeHits: drops malformed rows and tolerates non-array input', () => {
		const bad: any[] = [null, {}, { chunk: {} }, { chunk: { id: '' } }, mkNodeHit('ok', 'src/c.ts', 'c')];
		const out = mapNodeHits(bad as NodeIndexHit[], () => undefined);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].chunk.id, 'ok');
		assert.deepStrictEqual(mapNodeHits(undefined as any, () => undefined), []);
	});

	test('mapNodeHits: normalizes missing score/signals', () => {
		const h: any = { chunk: mkNodeHit('x', 'src/d.ts', 'd').chunk, content: 'd' };
		const out = mapNodeHits([h], () => undefined);
		assert.strictEqual(out[0].score, 0);
		assert.deepStrictEqual(out[0].signals, {});
	});
});
