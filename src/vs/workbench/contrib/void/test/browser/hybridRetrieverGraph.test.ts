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

function chunk(
	id: string, file: string, tokens: string[],
	opts?: { defines?: string[]; refs?: string[]; lspDefines?: string[]; lspRefs?: string[] },
): IndexedChunk {
	return {
		id, file, startLine: 1, endLine: 10, kind: 'function', name: id,
		language: 'typescript', contentHash: `h-${id}`,
		content: `function ${id}() {}`,
		tokens: internTokens(tokens),
		scored: true,
		defines: opts?.defines,
		refs: opts?.refs,
		lspDefines: opts?.lspDefines,
		lspRefs: opts?.lspRefs,
	};
}

function ctxOf(chunks: IndexedChunk[]) {
	const graph = new DependencyGraph();
	graph.ensure(chunks);
	return {
		chunks: new Map(chunks.map(c => [c.id, c])),
		graph,
		embeddingsAvailable: false,
	};
}

suite('semanticIndex / hybridRetriever graph propagation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('graph propagation lifts the shared dependency hub above a lexical fluke', () => {
		// Two memory-related seeds both reference MemoryStore; memoryDb defines it.
		// Notebook matches "persistent" lexically but has no graph tie to memory.
		const chunks = [
			chunk('rememberTool', 'tools/remember.ts', ['memory', 'persistent', 'notes'], { refs: ['MemoryStore'] }),
			chunk('listNotes', 'tools/listNotes.ts', ['memory', 'notes', 'list'], { refs: ['MemoryStore'] }),
			chunk('memoryDb', 'memory/memoryDatabase.ts', ['store', 'sqlite'], { defines: ['MemoryStore'], lspDefines: ['MemoryStore'] }),
			chunk('notebook', 'notebook/persist.ts', ['persistent', 'options', 'transient'], { defines: ['TransientOptions'] }),
		];
		const hits = hybridSearch(
			ctxOf(chunks),
			{ queryTokens: ['persistent', 'memory', 'store', 'notes'], queryEmbedding: null },
			{ topK: 5, fileFilter: null },
		);
		const primaries = hits.filter(h => !h.signals.neighbor);
		const files = primaries.map(h => h.chunk.file);
		const dbRank = files.indexOf('memory/memoryDatabase.ts');
		const nbRank = files.indexOf('notebook/persist.ts');
		assert.ok(dbRank !== -1, 'memory hub should appear in results');
		assert.ok(nbRank === -1 || dbRank < nbRank, 'memory hub should outrank notebook lexical match');
		const dbHit = primaries.find(h => h.chunk.file === 'memory/memoryDatabase.ts');
		assert.ok(dbHit?.signals.graphBoost !== undefined && dbHit.signals.graphBoost > 0);
	});

	test('knee cut marks weak tail matches without dropping them', () => {
		const chunks = Array.from({ length: 12 }, (_, i) =>
			chunk(`fn${i}`, `f${i}.ts`, i < 5 ? ['alpha', 'beta', 'gamma'] : ['alpha']),
		);
		const hits = hybridSearch(
			ctxOf(chunks),
			{ queryTokens: ['alpha', 'beta', 'gamma'], queryEmbedding: null },
			{ topK: 10, fileFilter: null },
		);
		const primaries = hits.filter(h => !h.signals.neighbor);
		assert.ok(primaries.length >= 5);
		const weak = primaries.filter(h => h.signals.weak);
		const strong = primaries.filter(h => !h.signals.weak);
		if (weak.length > 0) {
			assert.ok(strong.length >= 5, 'never cut before position 5');
			assert.ok(strong.every(s => s.score >= weak[0].score), 'weak hits follow strong ones in score order');
		}
	});
});
