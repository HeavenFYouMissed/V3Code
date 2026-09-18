/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { hybridSearch } from '../../browser/semanticIndex/hybridRetriever.js';
import { internTokens } from '../../browser/semanticIndex/tokenDict.js';
import { DependencyGraph } from '../../browser/semanticIndex/dependencyGraph.js';
import { IndexedChunk } from '../../browser/semanticIndex/browserIndexTypes.js';

function chunk(id: string, file: string, tokens: string[], lines?: { start: number; end: number; parentId?: string }): IndexedChunk {
	return {
		id, file, startLine: lines?.start ?? 1, endLine: lines?.end ?? 10, kind: 'function', name: id,
		language: 'typescript', contentHash: `h-${id}`,
		content: `function ${id}() {}`,
		tokens: internTokens(tokens),
		scored: true,
		parentId: lines?.parentId,
	};
}

function ctxOf(chunks: IndexedChunk[]) {
	return {
		chunks: new Map(chunks.map(c => [c.id, c])),
		graph: new DependencyGraph(),
		embeddingsAvailable: false,
	};
}

suite('semanticIndex / hybridRetriever beast channel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a beast-only hit surfaces a chunk with zero lexical/vector signal', () => {
		const chunks = [
			chunk('alpha', 'a.ts', ['parse', 'config']),
			chunk('exact', 'exact.ts', ['unrelated', 'tokens']),
		];
		// beast lines are 1-based; chunk 'exact' covers 0-based lines 1..10 → 1-based 2..11.
		const hits = hybridSearch(
			ctxOf(chunks),
			{ queryTokens: ['parse', 'config'], queryEmbedding: null, beastHits: [{ file: 'exact.ts', line: 5 }] },
			{ topK: 5, fileFilter: null },
		);
		assert.deepStrictEqual(hits.map(h => h.chunk.file).sort(), ['a.ts', 'exact.ts']);
		const beastHit = hits.find(h => h.chunk.file === 'exact.ts')!;
		assert.strictEqual(beastHit.signals.beast, 1);
	});

	test('hit resolves to the SMALLEST containing chunk, not the enclosing parent', () => {
		const parent = chunk('parent', 'f.ts', ['token'], { start: 0, end: 100 });
		const child = chunk('child', 'f.ts', ['token'], { start: 40, end: 50, parentId: 'parent' });
		const hits = hybridSearch(
			ctxOf([parent, child]),
			{ queryTokens: ['nomatch'], queryEmbedding: null, beastHits: [{ file: 'f.ts', line: 45 }] },
			{ topK: 5, fileFilter: null },
		);
		// Child resolves + collapses to its display parent — but exactly ONE fused
		// entry (no parent+child double count), carrying the beast signal.
		assert.strictEqual(hits.filter(h => !h.signals.neighbor).length, 1);
		assert.strictEqual(hits[0].signals.beast, 1);
	});

	test('hits in unchunked files are dropped; empty beast channel changes nothing', () => {
		const chunks = [chunk('alpha', 'a.ts', ['parse', 'config'])];
		const withGhost = hybridSearch(
			ctxOf(chunks),
			{ queryTokens: ['parse'], queryEmbedding: null, beastHits: [{ file: 'never-chunked.ts', line: 3 }] },
			{ topK: 5, fileFilter: null },
		);
		const without = hybridSearch(
			ctxOf(chunks),
			{ queryTokens: ['parse'], queryEmbedding: null },
			{ topK: 5, fileFilter: null },
		);
		assert.deepStrictEqual(withGhost.map(h => h.chunk.file), without.map(h => h.chunk.file));
	});

	test('beast rank order is preserved through fusion for beast-only candidates', () => {
		const chunks = [
			chunk('first', 'first.ts', ['x'], { start: 0, end: 5 }),
			chunk('second', 'second.ts', ['x'], { start: 0, end: 5 }),
		];
		const hits = hybridSearch(
			ctxOf(chunks),
			{
				queryTokens: ['nomatch'], queryEmbedding: null,
				beastHits: [{ file: 'second.ts', line: 2 }, { file: 'first.ts', line: 2 }],
			},
			{ topK: 5, fileFilter: null },
		);
		assert.deepStrictEqual(hits.filter(h => !h.signals.neighbor).map(h => h.chunk.file), ['second.ts', 'first.ts']);
		assert.strictEqual(hits[0].signals.beast, 1);
		assert.strictEqual(hits[1].signals.beast, 2);
	});
});
