/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/*
 * Adapted from Continue (https://github.com/continuedev/continue), Apache-2.0.
 * Copyright 2023-2026 Continue Dev, Inc. Modifications Copyright 2026 Glass Devtools, Inc.
 */

/*
 * Tests for the port of Continue's
 * core/autocomplete/classification/shouldCompleteMultiline.ts (Continue has no upstream
 * test suite for it; these cases are derived from its documented behavior — the
 * multilineCompletions setting, the single-line-comment check, and Markdown's
 * useMultiline heuristic, the only per-language hook in Continue's language table).
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { shouldCompleteMultiline } from '../../common/autocomplete/autocompleteMultiline.js';

function args(overrides: Partial<Parameters<typeof shouldCompleteMultiline>[0]> = {}) {
	return {
		prefix: 'function add(a, b) {\n\t',
		suffix: '\n}',
		language: 'typescript',
		multilineSetting: 'auto' as const,
		...overrides,
	};
}

suite('autocomplete multiline classification', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('multiline setting', () => {
		test('always wins over every heuristic', () => {
			assert.strictEqual(shouldCompleteMultiline(args({ multilineSetting: 'always', prefix: '// comment' })), true);
			assert.strictEqual(shouldCompleteMultiline(args({ multilineSetting: 'always', language: 'markdown', prefix: '- item' })), true);
		});

		test('never wins over every heuristic', () => {
			assert.strictEqual(shouldCompleteMultiline(args({ multilineSetting: 'never' })), false);
		});
	});

	suite('auto: single-line comment heuristic', () => {
		test('plain code completes multiline', () => {
			assert.strictEqual(shouldCompleteMultiline(args()), true);
		});

		test('cursor on a // comment line does not complete multiline', () => {
			assert.strictEqual(shouldCompleteMultiline(args({ prefix: 'const a = 1;\n// write a function that ' })), false);
		});

		test('comment check applies to the last prefix line only, ignoring indentation', () => {
			assert.strictEqual(shouldCompleteMultiline(args({ prefix: '// header comment\nconst a = ' })), true);
			assert.strictEqual(shouldCompleteMultiline(args({ prefix: 'const a = 1;\n\t\t// indented comment' })), false);
		});

		test('uses the per-language comment mark', () => {
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'python', prefix: 'x = 1\n# comment' })), false);
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'python', prefix: 'x = 1\n// not a python comment' })), true);
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'haskell', prefix: '-- note' })), false);
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'clojure', prefix: '; note' })), false);
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'lua', prefix: '-- note' })), false);
		});

		test('unknown language skips the comment heuristic and completes multiline', () => {
			assert.strictEqual(shouldCompleteMultiline(args({ language: '', prefix: '// looks like a comment' })), true);
		});
	});

	suite('auto: markdown useMultiline heuristic', () => {
		test('regular paragraph text completes multiline', () => {
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'markdown', prefix: 'Some paragraph text about ' })), true);
		});

		test('single-line starters do not complete multiline', () => {
			for (const prefix of ['- list item', '* list item', '3. numbered item', '> quoted text', '```', '## Heading text']) {
				assert.strictEqual(
					shouldCompleteMultiline(args({ language: 'markdown', prefix: `intro line\n${prefix}` })),
					false,
					`expected single-line for prefix line: ${JSON.stringify(prefix)}`,
				);
			}
		});

		test('starters require their trailing space / digit-dot shape', () => {
			// '*bold' is not a list item ('* ' requires the space), '#hashtag' is not a
			// heading, '1.x' is not a numbered item.
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'markdown', prefix: '*bold text' })), true);
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'markdown', prefix: '#hashtag' })), true);
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'markdown', prefix: '1.x release notes are ' })), true);
		});

		test('quirk preserved: a prefix ending in a newline completes multiline (heuristic only looks at the current line)', () => {
			assert.strictEqual(shouldCompleteMultiline(args({ language: 'markdown', prefix: '- item\n' })), true);
		});
	});
});
