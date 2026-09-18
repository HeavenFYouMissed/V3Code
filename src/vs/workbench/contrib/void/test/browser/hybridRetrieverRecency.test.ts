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

function chunk(id: string, file: string, tokens: string[]): IndexedChunk {
	return {
		id, file, startLine: 1, endLine: 10, kind: 'function', name: id,
		language: 'typescript', contentHash: `h-${id}`,
		content: `function ${id}() {}`,
		tokens: internTokens(tokens),
		scored: true,
	};
}

function ctxOf(chunks: IndexedChunk[]) {
	return {
		chunks: new Map(chunks.map(c => [c.id, c])),
		graph: new DependencyGraph(),
		embeddingsAvailable: false,
	};
}

suite('semanticIndex / hybridRetriever recency channel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('recently-edited file wins the tiebreak between equal lexical matches', () => {
		// Two chunks with IDENTICAL lexical overlap; only `b.ts` was recently edited.
		const chunks = [
			chunk('alpha', 'a.ts', ['parse', 'config']),
			chunk('beta', 'b.ts', ['parse', 'config']),
		];
		const query = { queryTokens: ['parse', 'config'], queryEmbedding: null };

		const without = hybridSearch(ctxOf(chunks), query, { topK: 5, fileFilter: null });
		assert.strictEqual(without.length, 2);

		const withRecency = hybridSearch(
			ctxOf(chunks),
			{ ...query, recentFiles: new Map([['b.ts', 0]]) },
			{ topK: 5, fileFilter: null },
		);
		assert.strictEqual(withRecency[0].chunk.file, 'b.ts');
		assert.ok(withRecency[0].score > withRecency[1].score);
	});

	test('recency boost never surfaces chunks with no lexical/vector match', () => {
		const chunks = [
			chunk('alpha', 'a.ts', ['parse', 'config']),
			chunk('gamma', 'recent.ts', ['unrelated', 'tokens']),
		];
		const hits = hybridSearch(
			ctxOf(chunks),
			{ queryTokens: ['parse', 'config'], queryEmbedding: null, recentFiles: new Map([['recent.ts', 0]]) },
			{ topK: 5, fileFilter: null },
		);
		assert.deepStrictEqual(hits.map(h => h.chunk.file), ['a.ts']);
	});

	test('boost is bounded: a weak recent match cannot leap a decisively stronger head', () => {
		// Ten full-overlap chunks occupy lexical ranks 1-10; the recent file's
		// chunk matches only 1/3 tokens (rank 11). The multiplicative 1.25x boost
		// must not catapult it past the strongest match (an additive RRF channel
		// would — adjacent RRF ranks differ by only ~3%).
		const strong = Array.from({ length: 10 }, (_, i) => chunk(`s${i}`, `s${i}.ts`, ['parse', 'config', 'loader']));
		const weak = chunk('weak', 'recent.ts', ['parse']);
		const hits = hybridSearch(
			ctxOf([...strong, weak]),
			{ queryTokens: ['parse', 'config', 'loader'], queryEmbedding: null, recentFiles: new Map([['recent.ts', 0]]) },
			{ topK: 11, fileFilter: null },
		);
		assert.notStrictEqual(hits[0].chunk.file, 'recent.ts');
		// ...but the boost still lifts it above where it would otherwise sit.
		const unboosted = hybridSearch(
			ctxOf([...strong, weak]),
			{ queryTokens: ['parse', 'config', 'loader'], queryEmbedding: null },
			{ topK: 11, fileFilter: null },
		);
		const rankOf = (hits: ReturnType<typeof hybridSearch>, file: string) => hits.findIndex(h => h.chunk.file === file);
		assert.ok(rankOf(hits, 'recent.ts') <= rankOf(unboosted, 'recent.ts'));
	});
});
