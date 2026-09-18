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

function chunk(id: string, file: string, tokens: string[], name?: string, content?: string): IndexedChunk {
	return {
		id, file, startLine: 1, endLine: 10, kind: 'function', name: name ?? id,
		language: 'typescript', contentHash: `h-${id}`,
		content: content ?? `function ${id}() {}`,
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

suite('semanticIndex / hybridRetriever lexical IDF', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a rare-token match outranks an equal-overlap common-token match', () => {
		// 'reranker' appears in 1 chunk; 'index' appears in all of them. Both
		// targets match exactly ONE query token — binary overlap would tie them
		// (and scan order would decide); IDF must rank the rare match first.
		const common = Array.from({ length: 8 }, (_, i) => chunk(`c${i}`, `common${i}.ts`, ['index', 'noise']));
		const rare = chunk('rare', 'rare.ts', ['reranker', 'noise']);
		const hits = hybridSearch(
			ctxOf([...common, rare]),
			{ queryTokens: ['index', 'reranker'], queryEmbedding: null },
			{ topK: 9, fileFilter: null },
		);
		assert.strictEqual(hits[0].chunk.file, 'rare.ts');
	});

	test('name-match bonus breaks a tie toward the chunk NAMED like the query', () => {
		const body = chunk('bodyOnly', 'a.ts', ['rerank', 'filler'], 'unrelatedName');
		const named = chunk('rerankScores', 'b.ts', ['rerank', 'filler'], 'rerankScores');
		const hits = hybridSearch(
			ctxOf([body, named]),
			{ queryTokens: ['rerank'], queryEmbedding: null },
			{ topK: 5, fileFilter: null },
		);
		assert.strictEqual(hits[0].chunk.file, 'b.ts');
	});

	test('equal matches tie-break toward the SMALLER token set (precision beats bulk)', () => {
		const kitchen = chunk('kitchen', 'big.ts', ['parse', 'config', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
		const precise = chunk('precise', 'small.ts', ['parse', 'config']);
		const hits = hybridSearch(
			ctxOf([kitchen, precise]),
			{ queryTokens: ['parse', 'config'], queryEmbedding: null },
			{ topK: 5, fileFilter: null },
		);
		assert.strictEqual(hits[0].chunk.file, 'small.ts');
	});

	test('exact phrase restores word order lost by token overlap', () => {
		const reversed = chunk('reversed', 'a.ts', ['quality', 'upgrade'], undefined, 'upgrade then quality');
		const exact = chunk('exact', 'b.ts', ['quality', 'upgrade'], undefined, 'search is live; quality upgrade continues');
		const hits = hybridSearch(
			ctxOf([reversed, exact]),
			{ queryTokens: ['quality', 'upgrade'], queryText: 'quality upgrade', queryEmbedding: null },
			{ topK: 5, fileFilter: null },
		);
		assert.strictEqual(hits[0].chunk.file, 'b.ts');
		assert.strictEqual(hits[0].signals.exact, 2);
	});

	test('exact symbol name outranks a body reference', () => {
		const reference = chunk('reference', 'a.ts', ['semantic', 'index'], 'wrapper', 'const service: ISemanticIndexService = value;');
		const definition = chunk('definition', 'b.ts', ['semantic', 'index'], 'ISemanticIndexService', 'export interface ISemanticIndexService {}');
		const hits = hybridSearch(
			ctxOf([reference, definition]),
			{ queryTokens: ['semantic', 'index'], queryText: 'ISemanticIndexService', queryEmbedding: null },
			{ topK: 5, fileFilter: null },
		);
		assert.strictEqual(hits[0].chunk.file, 'b.ts');
		assert.strictEqual(hits[0].signals.exact, 4);
	});
});
