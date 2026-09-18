/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	addedGrammars, ChunkerCapability, chunkerCapabilityKey, chunkerCapabilityOf, chunkerGrammarNames,
	CHUNKER_ALGO_VERSION, mergeChunkerCapability, readChunkerCapability, shouldRechunkForCapability,
} from '../../common/semanticIndex/chunkerCapability.js';

const ALGO = CHUNKER_ALGO_VERSION;
const cap = (grammars: string[], algo = ALGO): ChunkerCapability => ({ algo, grammars });

suite('Chunker capability', () => {
	test('capability is order- and duplicate-independent', () => {
		assert.deepStrictEqual(
			chunkerCapabilityOf(['tree-sitter-python', 'tree-sitter-go', 'tree-sitter-python']),
			{ algo: ALGO, grammars: ['tree-sitter-go', 'tree-sitter-python'] },
		);
		assert.strictEqual(
			chunkerCapabilityKey(chunkerCapabilityOf(['tree-sitter-go', 'tree-sitter-python'])),
			chunkerCapabilityKey(chunkerCapabilityOf(['tree-sitter-python', 'tree-sitter-go'])),
		);
		assert.strictEqual(chunkerCapabilityKey(undefined), '');
	});

	test('probe list covers every grammar the language profiles can ask for', () => {
		const names = chunkerGrammarNames();
		assert.deepStrictEqual(
			[names.includes('tree-sitter-typescript'), names.includes('tree-sitter-python'), names.includes('tree-sitter-ruby'), names.length === new Set(names).size],
			[true, true, true, true],
		);
	});

	test('re-chunks when grammars are gained, but never when they are only lost', () => {
		const before = cap(['tree-sitter-typescript']);
		const after = cap(['tree-sitter-python', 'tree-sitter-typescript']);
		assert.deepStrictEqual(
			[
				shouldRechunkForCapability(before, after),           // grammar shipped -> heal
				shouldRechunkForCapability(after, after),            // unchanged -> no-op
				shouldRechunkForCapability(after, before),           // grammar lost -> keep better chunks
				shouldRechunkForCapability(undefined, after),        // index predates tracking -> heal
				shouldRechunkForCapability(cap([], 0), after),       // algorithm moved -> heal
			],
			[true, false, false, true, true],
		);
		assert.deepStrictEqual(addedGrammars(before, after), ['tree-sitter-python']);
	});

	test('promoting after a heal makes it happen exactly once, and a lost grammar cannot re-trigger it', () => {
		const before = cap(['tree-sitter-typescript']);
		const full = cap(['tree-sitter-python', 'tree-sitter-typescript']);
		const promoted = mergeChunkerCapability(before, full);
		const shrunk = cap(['tree-sitter-typescript']);
		assert.deepStrictEqual(
			[
				promoted,
				shouldRechunkForCapability(promoted, full),                                     // next session: settled
				shouldRechunkForCapability(promoted, shrunk),                                   // asset vanished: no flap
				mergeChunkerCapability(promoted, shrunk),                                       // ...and the record is not narrowed
				shouldRechunkForCapability(mergeChunkerCapability(promoted, shrunk), full),      // asset returns: still settled
			],
			[full, false, false, full, false],
		);
	});

	test('an algorithm bump replaces the recorded grammar set instead of unioning it', () => {
		const old = cap(['tree-sitter-python', 'tree-sitter-typescript'], ALGO - 1);
		const live = cap(['tree-sitter-typescript']);
		assert.deepStrictEqual(
			[shouldRechunkForCapability(old, live), mergeChunkerCapability(old, live)],
			[true, live],
		);
	});

	test('persisted records are read defensively', () => {
		assert.deepStrictEqual(
			[
				readChunkerCapability(undefined),
				readChunkerCapability({ grammars: ['tree-sitter-go'] }),
				readChunkerCapability({ algo: ALGO, grammars: 'tree-sitter-go' }),
				readChunkerCapability({ algo: ALGO, grammars: ['tree-sitter-go', 7, '', 'tree-sitter-c', 'tree-sitter-go'] }),
			],
			[undefined, undefined, undefined, { algo: ALGO, grammars: ['tree-sitter-c', 'tree-sitter-go'] }],
		);
	});
});
