/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/*
 * Adapted from Continue (https://github.com/continuedev/continue), Apache-2.0.
 * Copyright 2023-2026 Continue Dev, Inc. Modifications Copyright 2026 Glass Devtools, Inc.
 */

/*
 * Ported from Continue's core/autocomplete/postprocessing/index.test.ts (the
 * removeBackticks suite; `llm: { model }` became `modelName`), plus tests for the
 * rejection rules and per-model fixups the module ports (Continue has no upstream
 * tests for those).
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { postprocessCompletion } from '../../common/autocomplete/autocompletePostprocessing.js';

suite('autocomplete postprocessing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const modelName = 'test-model';

	suite('removeBackticks (Continue postprocessing/index.test.ts)', () => {
		test('should remove first line starting with ``` and last line that is ```', () => {
			const completion = '```typescript\nfunction hello() {\n  return \'world\';\n}\n```';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, 'function hello() {\n  return \'world\';\n}');
		});

		test('should remove only first line if it starts with ```', () => {
			const completion = '```javascript\nconst x = 5;\nconsole.log(x);';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, 'const x = 5;\nconsole.log(x);');
		});

		test('should remove only last line if it is ```', () => {
			const completion = 'const y = 10;\nconsole.log(y);\n```';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, 'const y = 10;\nconsole.log(y);');
		});

		test('should not modify completion without backticks', () => {
			const completion = 'function test() {\n  return true;\n}';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, 'function test() {\n  return true;\n}');
		});

		test('should handle completion with backticks in the middle', () => {
			const completion = 'const str = `template ${literal}`;\nconsole.log(str);';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, 'const str = `template ${literal}`;\nconsole.log(str);');
		});

		test('should handle first line with leading whitespace before ```', () => {
			const completion = '  ```python\ndef hello():\n  pass\n```';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, 'def hello():\n  pass');
		});

		test('should handle last line with whitespace around ```', () => {
			const completion = '```\ncode here\n  ```  ';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, 'code here');
		});

		test('should handle single line completion', () => {
			const completion = 'const x = 5;';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, 'const x = 5;');
		});

		test('should handle empty completion', () => {
			const completion = '';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, undefined);
		});

		test('should not remove ``` if it\'s not on its own line at the end', () => {
			const completion = '```typescript\nconst x = 5; // end```';
			const result = postprocessCompletion({ completion, modelName, prefix: '', suffix: '' });
			assert.strictEqual(result, 'const x = 5; // end```');
		});
	});

	suite('rejection rules', () => {
		test('should reject whitespace-only completions', () => {
			assert.strictEqual(postprocessCompletion({ completion: '   \n\t\n  ', modelName, prefix: '', suffix: '' }), undefined);
		});

		test('should reject a completion that just repeats the line above', () => {
			const result = postprocessCompletion({
				completion: 'const value = 42;',
				modelName,
				prefix: 'function f() {\n\tconst value = 42;\n',
				suffix: '',
			});
			assert.strictEqual(result, undefined);
		});

		test('should not reject a completion that differs from the line above', () => {
			const result = postprocessCompletion({
				completion: 'return value + offset;',
				modelName,
				prefix: 'function f() {\n\tconst value = 42;\n',
				suffix: '',
			});
			assert.strictEqual(result, 'return value + offset;');
		});

		test('should reject extreme line repetition', () => {
			const completion = Array(12).fill('console.log("again");').join('\n');
			assert.strictEqual(postprocessCompletion({ completion, modelName, prefix: '', suffix: '' }), undefined);
		});

		test('should keep short non-repetitive multi-line completions', () => {
			const completion = 'if (a) {\n\treturn 1;\n}';
			assert.strictEqual(postprocessCompletion({ completion, modelName, prefix: '', suffix: '' }), completion);
		});
	});

	suite('model-specific fixups', () => {
		test('codestral: strips the duplicated leading space at end-of-line cursor', () => {
			const result = postprocessCompletion({
				completion: ' return 1;',
				modelName: 'codestral-latest',
				prefix: 'const f = () => ',
				suffix: '\nconsole.log(f());',
			});
			assert.strictEqual(result, 'return 1;');
		});

		test('codestral: drops one leading newline when there is no suffix after a blank line', () => {
			const result = postprocessCompletion({
				completion: '\nconst x = 5;',
				modelName: 'codestral-latest',
				prefix: '// header\n\n',
				suffix: '',
			});
			assert.strictEqual(result, 'const x = 5;');
		});

		test('qwen3: removes think markers and surrounding newlines', () => {
			const result = postprocessCompletion({
				completion: '<think>\nplanning...\n</think>\nconst x = 5;',
				modelName: 'qwen3-8b',
				prefix: '',
				suffix: '',
			});
			assert.strictEqual(result, 'const x = 5;');
		});

		test('qwen3: removes a stray closing think marker', () => {
			const result = postprocessCompletion({
				completion: '</think>\nconst x = 5;',
				modelName: 'qwen3-8b',
				prefix: '',
				suffix: '',
			});
			assert.strictEqual(result, 'const x = 5;');
		});

		test('granite: strips a repeated trimmed prefix from the completion start', () => {
			const result = postprocessCompletion({
				completion: 'const x = 5;',
				modelName: 'granite-code-8b',
				prefix: '\tconst x',
				suffix: '',
			});
			assert.strictEqual(result, ' = 5;');
		});

		test('mercury: moves an indented completion after an end-of-line cursor to a new line', () => {
			const result = postprocessCompletion({
				completion: '  return 1;',
				modelName: 'mercury-coder',
				prefix: 'def f():',
				suffix: '',
			});
			assert.strictEqual(result, '\n  return 1;');
		});

		test('gemini/gemma: strips a trailing <|file_separator|>', () => {
			const result = postprocessCompletion({
				completion: 'const x = 5;<|file_separator|>',
				modelName: 'gemini-2.0-flash',
				prefix: '',
				suffix: '',
			});
			assert.strictEqual(result, 'const x = 5;');
		});

		test('any model: dedupes the space when both prefix and completion have one', () => {
			const result = postprocessCompletion({
				completion: ' 5;',
				modelName,
				prefix: 'const x = ',
				suffix: '',
			});
			assert.strictEqual(result, '5;');
		});
	});
});
