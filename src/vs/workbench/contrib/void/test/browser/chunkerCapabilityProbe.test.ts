/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChunkerHost, TreeSitterChunker } from '../../browser/semanticIndex/treeSitterChunker.js';
import { chunkerGrammarNames, shouldRechunkForCapability } from '../../common/semanticIndex/chunkerCapability.js';

/** Host that only answers the capability probe — nothing here parses. */
function probeHost(answer: (grammarName: string) => boolean): ChunkerHost {
	return {
		loadRuntime: async () => null,
		readGrammarBytes: async () => null,
		grammarExists: async (grammarName: string) => answer(grammarName),
		log: () => { },
	};
}

suite('Chunker capability probe', () => {
	test('reports exactly the grammar assets present, and probes each name once', async () => {
		const asked: string[] = [];
		const chunker = new TreeSitterChunker(probeHost(name => {
			asked.push(name);
			return name !== 'tree-sitter-c'; // never shipped by @vscode/tree-sitter-wasm
		}));
		const first = await chunker.capability();
		const second = await chunker.capability();
		assert.deepStrictEqual(
			[first, first === second, asked.length],
			[
				{ algo: first!.algo, grammars: chunkerGrammarNames().filter(g => g !== 'tree-sitter-c') },
				true,                        // cached — one probe per session
				chunkerGrammarNames().length,
			],
		);
	});

	test('a shipped grammar the index was built without forces a re-chunk', async () => {
		const before = await new TreeSitterChunker(probeHost(n => n === 'tree-sitter-typescript')).capability();
		const after = await new TreeSitterChunker(probeHost(() => true)).capability();
		assert.deepStrictEqual(
			[shouldRechunkForCapability(before, after!), shouldRechunkForCapability(after, after!)],
			[true, false],
		);
	});

	test('an unanswerable probe is indeterminate, never a capability change', async () => {
		// Both degenerate answers must read as "unknown": returning a shrunken set
		// would make an I/O failure impersonate a grammar change and re-chunk the
		// whole workspace — every session, for as long as the failure lasts.
		const threw = await new TreeSitterChunker(probeHost(() => { throw new Error('file service down'); })).capability();
		const empty = await new TreeSitterChunker(probeHost(() => false)).capability();
		assert.deepStrictEqual([threw, empty], [undefined, undefined]);
	});
});
