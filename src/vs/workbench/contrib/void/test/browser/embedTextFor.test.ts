/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { embedTextFor, EmbedTextChunk } from '../../browser/semanticIndex/embedText.js';
import { effectiveEmbedIdentity, EMBED_TEXT_SCHEME } from '../../common/semanticIndex/embedIdentity.js';

function chunk(overrides: Partial<EmbedTextChunk>): EmbedTextChunk {
	return {
		file: 'src/parser.ts',
		name: 'parseConfig',
		content: 'function parseConfig() {\n\treturn cfg;\n}',
		...overrides,
	};
}

suite('semanticIndex / contextual embed text + embedder identity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('header shape: one comment line "// file basename :: parent :: name", then the raw body', () => {
		const parent = chunk({ name: 'ConfigLoader', content: 'class ConfigLoader { }' });
		const child = chunk({
			name: 'ConfigLoader › if_statement',
			content: 'if (raw) { return parse(raw); }',
			parentId: 'p1',
		});
		const map = new Map<string, EmbedTextChunk>([['p1', parent]]);

		const text = embedTextFor(child, map);
		const [header, ...bodyLines] = text.split('\n');
		assert.strictEqual(header, '// parser.ts :: ConfigLoader :: ConfigLoader › if_statement');
		assert.strictEqual(bodyLines.join('\n'), child.content);
	});

	test('file segment is the BASENAME — the shared path prefix dilutes mean-pooled vectors (hdr2)', () => {
		const deep = chunk({ file: 'src/vs/workbench/contrib/void/browser/semanticIndex/embedText.ts' });
		assert.ok(embedTextFor(deep, new Map()).startsWith('// embedText.ts :: parseConfig\n'));
		// A path-less file name is already its own basename.
		const flat = chunk({ file: 'gulpfile.js' });
		assert.ok(embedTextFor(flat, new Map()).startsWith('// gulpfile.js :: parseConfig\n'));
	});

	test('parent is resolved one hop via chunksMap.get(parentId)', () => {
		const parent = chunk({ name: 'walkWorkspace' });
		const child = chunk({ name: 'walkWorkspace › for_statement', parentId: 'parent-id' });
		const map = new Map<string, EmbedTextChunk>([['parent-id', parent]]);
		assert.ok(embedTextFor(child, map).startsWith('// parser.ts :: walkWorkspace :: '));
		// Missing parent (stale id) → parent segment cleanly elided, no crash.
		const orphan = embedTextFor(child, new Map());
		assert.ok(orphan.startsWith('// parser.ts :: walkWorkspace › for_statement\n'));
	});

	test('empty segments are elided — no dangling separators, no bare "//" line', () => {
		const noParent = chunk({});
		assert.ok(embedTextFor(noParent, new Map()).startsWith('// parser.ts :: parseConfig\n'));

		const anonymous = chunk({ name: '' });
		assert.ok(embedTextFor(anonymous, new Map()).startsWith('// parser.ts\n'));

		const whitespaceName = chunk({ name: '  ' });
		const wsText = embedTextFor(whitespaceName, new Map());
		assert.ok(wsText.startsWith('// parser.ts\n'));
		assert.ok(!wsText.includes('::'));

		// Everything empty → body returned unchanged (never a bare comment line).
		const bare = embedTextFor({ file: '', name: '', content: 'x = 1' }, new Map());
		assert.strictEqual(bare, 'x = 1');
	});

	test('body falls back to name when content is empty (mirrors the old "content || name")', () => {
		const empty = chunk({ content: '' });
		assert.strictEqual(embedTextFor(empty, new Map()), '// parser.ts :: parseConfig\nparseConfig');
	});

	test('scheme is hdr2 — changing embedTextFor output MUST bump EMBED_TEXT_SCHEME', () => {
		// Deliberate friction: if this assert fails you changed the embed-text
		// scheme; bump the constant so persisted vectors re-embed (embedIdentity.ts).
		assert.strictEqual(EMBED_TEXT_SCHEME, 'hdr2');
	});

	test('stored/displayed content is untouched — pure, no mutation', () => {
		const parent = chunk({ name: 'ConfigLoader' });
		const c = chunk({ name: 'load', parentId: 'p', content: 'load() { }' });
		const before = JSON.stringify(c);
		const beforeParent = JSON.stringify(parent);
		embedTextFor(c, new Map([['p', parent]]));
		assert.strictEqual(JSON.stringify(c), before);
		assert.strictEqual(JSON.stringify(parent), beforeParent);
	});

	test('effectiveEmbedIdentity salts exactly once and is idempotent', () => {
		const salted = effectiveEmbedIdentity('minishlab/potion-code-16M');
		assert.strictEqual(salted, `minishlab/potion-code-16M+${EMBED_TEXT_SCHEME}`);
		// Idempotent: re-salting a salted id (round-tripped through a manifest) is a no-op.
		assert.strictEqual(effectiveEmbedIdentity(salted), salted);
		assert.strictEqual(effectiveEmbedIdentity(effectiveEmbedIdentity(salted)), salted);
	});

	test('effectiveEmbedIdentity is stable and injective over distinct models', () => {
		assert.strictEqual(effectiveEmbedIdentity('m1'), effectiveEmbedIdentity('m1'));
		assert.notStrictEqual(effectiveEmbedIdentity('m1'), effectiveEmbedIdentity('m2'));
		// A salted identity never equals any raw model id — that mismatch is what
		// invalidates pre-header vectors.
		assert.notStrictEqual(effectiveEmbedIdentity('m1'), 'm1');
	});

	test('effectiveEmbedIdentity keeps the empty id empty (unresolved embedder stays falsy)', () => {
		assert.strictEqual(effectiveEmbedIdentity(''), '');
	});
});
