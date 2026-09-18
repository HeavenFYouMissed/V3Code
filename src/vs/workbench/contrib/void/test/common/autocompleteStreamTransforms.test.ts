/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/*
 * Adapted from Continue (https://github.com/continuedev/continue), Apache-2.0.
 * Copyright 2023-2026 Continue Dev, Inc. Modifications Copyright 2026 Glass Devtools, Inc.
 */

/*
 * Ported from Continue's
 * core/autocomplete/filtering/streamTransforms/charStream.vitest.ts and
 * core/autocomplete/filtering/streamTransforms/lineStream.vitest.ts.
 *
 * Cases not ported (the functions they exercise were not ported):
 * noTopLevelKeywordsMidline (a todo upstream), skipLines, filterEnglishLinesAtStart/AtEnd,
 * fixCodeLlamaFirstLineIndentation, filterLeadingAndTrailingNewLineInsertion, and the
 * direct MarkdownBlockStateTracker / shouldStopAtMarkdownBlock / collectAllLines unit
 * tests (those helpers are private here — their behavior is covered through the
 * filterCodeBlockLines cases below).
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	avoidEmptyComments,
	avoidPathLine,
	filterCodeBlockLines,
	hasNestedMarkdownBlocks,
	lineIsRepeated,
	LINES_TO_STOP_AT,
	noDoubleNewLine,
	noFirstCharNewline,
	PREFIXES_TO_SKIP,
	shouldChangeLineAndStop,
	showWhateverWeHaveAtXMs,
	skipPrefixes,
	stopAtLines,
	stopAtLinesExact,
	stopAtRepeatingLines,
	stopAtSimilarLine,
	stopAtStartOf,
	stopAtStopTokens,
	streamLines,
	streamWithNewLines,
	validatePatternInLine,
} from '../../common/autocomplete/autocompleteStreamTransforms.js';

async function* toAsyncGenerator(chunks: string[]): AsyncGenerator<string> {
	for (const chunk of chunks) {
		yield chunk;
	}
}

async function streamToString(stream: AsyncGenerator<string>): Promise<string> {
	let result = '';
	for await (const chunk of stream) {
		result += chunk;
	}
	return result;
}

async function collectLines(stream: AsyncGenerator<string>): Promise<string[]> {
	const output: string[] = [];
	for await (const line of stream) {
		output.push(line);
	}
	return output;
}

suite('autocomplete stream transforms', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// -----------------------------------------------------------------------------------
	// Char-level transforms (Continue charStream.vitest.ts)
	// -----------------------------------------------------------------------------------

	suite('stopAtStopTokens', () => {
		test('should yield characters until a stop token is encountered', async () => {
			const mockStream = toAsyncGenerator(['Hello', ' world', '! Stop', 'here']);
			const result = stopAtStopTokens(mockStream, ['Stop']);
			assert.strictEqual(await streamToString(result), 'Hello world! ');
		});

		test('should handle multiple stop tokens', async () => {
			const mockStream = toAsyncGenerator(['This', ' is a ', 'test. END', ' of stream']);
			const result = stopAtStopTokens(mockStream, ['END', 'STOP', 'HALT']);
			assert.strictEqual(await streamToString(result), 'This is a test. ');
		});

		test('should handle stop tokens split across chunks', async () => {
			const mockStream = toAsyncGenerator(['Hello', ' wo', 'r', 'ld! ST', 'OP now']);
			const result = stopAtStopTokens(mockStream, ['STOP']);
			assert.strictEqual(await streamToString(result), 'Hello world! ');
		});

		test('should yield all characters if no stop token is encountered', async () => {
			const mockStream = toAsyncGenerator(['This', ' is ', 'a complete', ' stream']);
			const result = stopAtStopTokens(mockStream, ['END']);
			assert.strictEqual(await streamToString(result), 'This is a complete stream');
		});

		test('should handle empty chunks', async () => {
			const mockStream = toAsyncGenerator(['Hello', '', ' world', '', '! STOP']);
			const result = stopAtStopTokens(mockStream, ['STOP']);
			assert.strictEqual(await streamToString(result), 'Hello world! ');
		});

		test('should handle stop token at the beginning of the stream', async () => {
			const mockStream = toAsyncGenerator(['STOP', 'Hello world']);
			const result = stopAtStopTokens(mockStream, ['STOP']);
			assert.strictEqual(await streamToString(result), '');
		});

		test('should handle stop token at the end of the stream', async () => {
			const mockStream = toAsyncGenerator(['Hello world', 'STOP']);
			const result = stopAtStopTokens(mockStream, ['STOP']);
			assert.strictEqual(await streamToString(result), 'Hello world');
		});

		test('should handle multiple stop tokens of different lengths', async () => {
			const mockStream = toAsyncGenerator(['This is a ', 'test with ', 'multiple STOP', ' tokens END']);
			const result = stopAtStopTokens(mockStream, ['STOP', 'END', 'HALT']);
			assert.strictEqual(await streamToString(result), 'This is a test with multiple ');
		});

		test('should handle an empty stream', async () => {
			const mockStream = toAsyncGenerator([]);
			const result = stopAtStopTokens(mockStream, ['STOP']);
			assert.strictEqual(await streamToString(result), '');
		});

		test('should handle an empty stop tokens array', async () => {
			const mockStream = toAsyncGenerator(['Hello', ' world!']);
			const result = stopAtStopTokens(mockStream, []);
			assert.strictEqual(await streamToString(result), 'Hello world!');
		});

		test('should handle stop token when remaining buffer is smaller than maximum stop token length', async () => {
			const mockStream = toAsyncGenerator(['Hello world!STOP']);
			const result = stopAtStopTokens(mockStream, ['STOP', 'STOP_TOKEN_THAT_IS_LARGER_THAN_BUFFER']);
			assert.strictEqual(await streamToString(result), 'Hello world!');
		});
	});

	suite('stopAtStartOf', () => {
		const sampleCode = `      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: \`Bearer \${this.workOsAccessToken}\`,
        },
      },
    );
    const data = await response.json();
    return data.items;
  }

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    const response = await extras.fetch(
      new URL(
        \`/proxy/context/\${this.options.id}/retrieve\`,
        controlPlaneEnv.CONTROL_PLANE_URL,
      ),
`;

		/* Some LLMs, such as Codestral, repeat the suffix of the query. To test our filtering, we cut the sample code at random positions, remove a part of the input
	and construct a response, containing the removed part and the suffix. The goal of the stopAtStartOf() method is to detect the start of the suffix in the response */
		test('should stop if the start of the suffix is reached', async () => {
			const suffix = `
  const data = await response.json();
  return data.items;
}`;
			const mockStream = toAsyncGenerator(sampleCode.split(/(?! )/g));
			const result = stopAtStartOf(mockStream, suffix);

			assert.strictEqual(await streamToString(result), `      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: \`Bearer \${this.workOsAccessToken}\`,
        },
      },
    );
    `);
		});

		test('should stop if the start of the suffix is reached, even if the suffix has a prefix', async () => {
			const suffix = `
  xxxconst data = await response.json();
  return data.items;
}`;
			const mockStream = toAsyncGenerator(sampleCode.split(/(?! )/g));
			const result = stopAtStartOf(mockStream, suffix);

			assert.strictEqual(await streamToString(result), `      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: \`Bearer \${this.workOsAccessToken}\`,
        },
      },
    );
    `);
		});

		test('should pass everything through when the suffix is shorter than the sequence length', async () => {
			const mockStream = toAsyncGenerator(['const a = 1;\n', 'const b = 2;\n']);
			const result = stopAtStartOf(mockStream, '\n}');
			assert.strictEqual(await streamToString(result), 'const a = 1;\nconst b = 2;\n');
		});
	});

	suite('noFirstCharNewline', () => {
		test('should stop the stream when the first character is a newline', async () => {
			const result = noFirstCharNewline(toAsyncGenerator(['\nconst x = 5;', 'more']));
			assert.strictEqual(await streamToString(result), '');
		});

		test('should pass through streams that do not start with a newline', async () => {
			const result = noFirstCharNewline(toAsyncGenerator(['const x = 5;', '\nlet y = 10;']));
			assert.strictEqual(await streamToString(result), 'const x = 5;\nlet y = 10;');
		});
	});

	suite('streamLines', () => {
		test('should split chunks into lines', async () => {
			const result = streamLines(toAsyncGenerator(['line1\nli', 'ne2\nline3']));
			assert.deepStrictEqual(await collectLines(result), ['line1', 'line2', 'line3']);
		});

		test('should not emit an empty trailing line for a trailing newline', async () => {
			const result = streamLines(toAsyncGenerator(['line1\n']));
			assert.deepStrictEqual(await collectLines(result), ['line1']);
		});
	});

	// -----------------------------------------------------------------------------------
	// Line-level transforms (Continue lineStream.vitest.ts)
	// -----------------------------------------------------------------------------------

	suite('avoidPathLine', () => {
		test('should filter out path lines', async () => {
			const linesGenerator = toAsyncGenerator([
				'// Path: src/index.ts',
				'const x = 5;',
				'//',
				'console.log(x);',
			]);
			const result = avoidPathLine(linesGenerator, '//');
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;', '//', 'console.log(x);']);
		});
	});

	suite('avoidEmptyComments', () => {
		test('should filter out empty comments', async () => {
			const linesGenerator = toAsyncGenerator([
				'// Path: src/index.ts',
				'const x = 5;',
				'//',
				'console.log(x);',
			]);
			const result = avoidEmptyComments(linesGenerator, '//');
			assert.deepStrictEqual(await collectLines(result), [
				'// Path: src/index.ts',
				'const x = 5;',
				'console.log(x);',
			]);
		});
	});

	suite('streamWithNewLines', () => {
		test('should add newlines between lines', async () => {
			const linesGenerator = toAsyncGenerator(['line1', 'line2', 'line3']);
			const result = streamWithNewLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), ['line1', '\n', 'line2', '\n', 'line3']);
		});
	});

	suite('lineIsRepeated', () => {
		test('should return true for similar lines', () => {
			assert.strictEqual(lineIsRepeated('const x = 5;', 'const x = 6;'), true);
		});

		test('should return false for different lines', () => {
			assert.strictEqual(lineIsRepeated('const x = 5;', 'let y = 10;'), false);
		});

		test('should return false for short lines', () => {
			assert.strictEqual(lineIsRepeated('x=5', 'x=6'), false);
		});
	});

	suite('stopAtSimilarLine', () => {
		test('should stop at the exact same line', async () => {
			let fullStopCount = 0;
			const lineToTest = 'const x = 6';
			const linesGenerator = toAsyncGenerator([
				'console.log();',
				'const y = () => {};',
				lineToTest,
			]);

			const result = stopAtSimilarLine(linesGenerator, lineToTest, () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), ['console.log();', 'const y = () => {};']);
			assert.strictEqual(fullStopCount, 1);
		});

		test('should stop at a similar line', async () => {
			let fullStopCount = 0;
			const lineToTest = 'const x = 6;';
			const linesGenerator = toAsyncGenerator([
				'console.log();',
				'const y = () => {};',
				lineToTest,
			]);

			const result = stopAtSimilarLine(linesGenerator, 'a' + lineToTest, () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), ['console.log();', 'const y = () => {};']);
			assert.strictEqual(fullStopCount, 1);
		});

		test('should continue on bracket ending lines', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator([
				' if (x > 0) {',
				'   console.log(x);',
				' }',
			]);

			const result = stopAtSimilarLine(linesGenerator, '}', () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), [
				' if (x > 0) {',
				'   console.log(x);',
				' }',
			]);
			assert.strictEqual(fullStopCount, 0);
		});
	});

	suite('stopAtLines', () => {
		test('should stop at specified lines', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'let y = 10;',
				LINES_TO_STOP_AT[0],
				'const z = 15;',
			]);

			const result = stopAtLines(linesGenerator, () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;', 'let y = 10;']);
			assert.strictEqual(fullStopCount, 1);
		});

		test('should stop at lines with leading whitespace', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'let y = 10;',
				`    ${LINES_TO_STOP_AT[0]}`,
				'const z = 15;',
			]);

			const result = stopAtLines(linesGenerator, () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;', 'let y = 10;']);
			assert.strictEqual(fullStopCount, 1);
		});

		test('should NOT stop when stop phrase is inside quotes', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'console.log("# End of file. not really");',
				'let y = 10;',
				'const z = 15;',
			]);

			const result = stopAtLines(linesGenerator, () => fullStopCount++);
			// Should not stop, should yield all lines
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'console.log("# End of file. not really");',
				'let y = 10;',
				'const z = 15;',
			]);
			assert.strictEqual(fullStopCount, 0);
		});

		test('should NOT stop when stop phrase is inside single quotes', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'const message = \'# End of file. not really\';',
				'let y = 10;',
			]);

			const result = stopAtLines(linesGenerator, () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'const message = \'# End of file. not really\';',
				'let y = 10;',
			]);
			assert.strictEqual(fullStopCount, 0);
		});

		test('should NOT stop when stop phrase is part of larger text', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'// This function stops<STOP EDITING HERE>after processing',
				'let y = 10;',
			]);

			const result = stopAtLines(linesGenerator, () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'// This function stops<STOP EDITING HERE>after processing',
				'let y = 10;',
			]);
			assert.strictEqual(fullStopCount, 0);
		});

		test('should stop when stop phrase appears properly at start of content', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'let y = 10;',
				'# End of file. Done here',
				'const z = 15;',
			]);

			const result = stopAtLines(linesGenerator, () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;', 'let y = 10;']);
			assert.strictEqual(fullStopCount, 1);
		});
	});

	suite('stopAtLinesExact', () => {
		test('should stop at an exactly matching line', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator(['const a = 1;', 'const y = 2;', 'const b = 3;']);
			const result = stopAtLinesExact(linesGenerator, () => fullStopCount++, ['const y = 2;']);
			assert.deepStrictEqual(await collectLines(result), ['const a = 1;']);
			assert.strictEqual(fullStopCount, 1);
		});

		test('should not stop at near-matching lines', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator(['const a = 1;', '  const y = 2;', 'const b = 3;']);
			const result = stopAtLinesExact(linesGenerator, () => fullStopCount++, ['const y = 2;']);
			assert.deepStrictEqual(await collectLines(result), ['const a = 1;', '  const y = 2;', 'const b = 3;']);
			assert.strictEqual(fullStopCount, 0);
		});
	});

	suite('skipPrefixes', () => {
		test('should skip specified prefixes', async () => {
			const linesGenerator = toAsyncGenerator([
				`${PREFIXES_TO_SKIP[0]}const x = 5;`,
				'let y = 10;',
			]);

			const result = skipPrefixes(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;', 'let y = 10;']);
		});
	});

	suite('noDoubleNewLine', () => {
		test('should stop at the first empty line after content', async () => {
			const linesGenerator = toAsyncGenerator(['const x = 5;', 'let y = 10;', '', 'const z = 15;']);
			const result = noDoubleNewLine(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;', 'let y = 10;']);
		});

		test('should allow an empty first line', async () => {
			const linesGenerator = toAsyncGenerator(['', 'const x = 5;']);
			const result = noDoubleNewLine(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), ['', 'const x = 5;']);
		});
	});

	suite('showWhateverWeHaveAtXMs', () => {
		test('should yield the full stream when the deadline is far away', async () => {
			const linesGenerator = toAsyncGenerator(['line1', 'line2', 'line3']);
			const result = showWhateverWeHaveAtXMs(linesGenerator, 60_000);
			assert.deepStrictEqual(await collectLines(result), ['line1', 'line2', 'line3']);
		});

		test('should stop after the first non-whitespace line once the deadline has passed', async () => {
			const linesGenerator = toAsyncGenerator(['', 'line1', 'line2']);
			// A deadline in the past: cuts as soon as a non-whitespace line has been yielded.
			const result = showWhateverWeHaveAtXMs(linesGenerator, -1);
			assert.deepStrictEqual(await collectLines(result), ['', 'line1']);
		});
	});

	suite('filterCodeBlockLines', () => {
		test('should handle unfenced code', async () => {
			const linesGenerator = toAsyncGenerator(['const x = 5;']);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;']);
		});

		test('should handle unfenced code with a code block', async () => {
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
			]);
		});

		test('should handle unfenced code with two code blocks', async () => {
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
				'```bash',
				'ls -al',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
				'```bash',
				'ls -al',
				'```',
			]);
		});

		test('should remove lines before the first valid line', async () => {
			const linesGenerator = toAsyncGenerator(['```ts', 'const x = 5;']);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;']);
		});

		test('should remove outer blocks', async () => {
			const linesGenerator = toAsyncGenerator(['```ts', 'const x = 5;', '```']);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;']);
		});

		test('should leave inner blocks intact', async () => {
			const linesGenerator = toAsyncGenerator([
				'```md',
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
			]);
		});

		test('should ignore ticks inside of code blocks such as tests', async () => {
			const linesGenerator = toAsyncGenerator([
				'```typescript',
				'it("should handle included inner ticks", async () => {',
				' const linesGenerator = await getLineGenerator([`',
				' "```md"',
				' "const x = 5;"',
				' "```bash"',
				' "echo ```test```"',
				' "```"',
				' "```"',
				']);',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), [
				'it("should handle included inner ticks", async () => {',
				' const linesGenerator = await getLineGenerator([`',
				' "```md"',
				' "const x = 5;"',
				' "```bash"',
				' "echo ```test```"',
				' "```"',
				' "```"',
				']);',
			]);
		});

		test('should handle included inner ticks', async () => {
			const linesGenerator = toAsyncGenerator([
				'```md',
				'const x = 5;',
				'```bash',
				'echo ```test```',
				'```',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'```bash',
				'echo ```test```',
				'```',
			]);
		});

		test('should leave single inner blocks intact but not return trailing text', async () => {
			const linesGenerator = toAsyncGenerator([
				'```md',
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
				'```',
				'trailing text',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
			]);
		});

		test('should leave double inner blocks intact but not return trailing text', async () => {
			const linesGenerator = toAsyncGenerator([
				'```md',
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
				'const y = 10;',
				'```sh',
				'echo `hello world`',
				'```',
				'```',
				'trailing text',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
				'const y = 10;',
				'```sh',
				'echo `hello world`',
				'```',
			]);
		});

		test('should leave inner blocks intact but not return trailing or leading text', async () => {
			const linesGenerator = toAsyncGenerator([
				'[CODE]',
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
				'[/CODE]',
				'trailing text',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'```bash',
				'ls -al',
				'```',
			]);
		});

		test('should handle markdown files with nested code blocks and a filename is included', async () => {
			const linesGenerator = toAsyncGenerator([
				'```markdown README.md',
				'# Project Structure',
				'',
				'```',
				'debug-test-folder/',
				'├── AdvancedPage.tsx',
				'├── Calculator.java',
				'└── test.ts',
				'```',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator, 'README.md');
			// Should include all content up to the final closing ```
			assert.deepStrictEqual(await collectLines(result), [
				'# Project Structure',
				'',
				'```',
				'debug-test-folder/',
				'├── AdvancedPage.tsx',
				'├── Calculator.java',
				'└── test.ts',
				'```',
			]);
		});

		test('should handle markdown files with nested code blocks and a filename is excluded', async () => {
			const linesGenerator = toAsyncGenerator([
				'```markdown README.md',
				'# Project Structure',
				'',
				'```',
				'debug-test-folder/',
				'├── AdvancedPage.tsx',
				'├── Calculator.java',
				'└── test.ts',
				'```',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			// Should include all content up to the final closing ```
			assert.deepStrictEqual(await collectLines(result), [
				'# Project Structure',
				'',
				'```',
				'debug-test-folder/',
				'├── AdvancedPage.tsx',
				'├── Calculator.java',
				'└── test.ts',
				'```',
			]);
		});

		test('should handle non-markdown files normally with filepath parameter', async () => {
			const linesGenerator = toAsyncGenerator([
				'```',
				'function test() {',
				'  return \'hello\';',
				'}',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator, 'test.js');
			assert.deepStrictEqual(await collectLines(result), [
				'function test() {',
				'  return \'hello\';',
				'}',
			]);
		});

		test('should handle simple markdown code blocks', async () => {
			const linesGenerator = toAsyncGenerator([
				'```',
				'Here\'s some code:',
				'```',
				'function example() {',
				'  console.log(\'test\');',
				'}',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator, 'README.md');
			// Should remove the outer markdown wrapper, and return just the inner content.
			// The lack of an end tag should cause it to return all remaining lines.
			assert.deepStrictEqual(await collectLines(result), [
				'Here\'s some code:',
				'```',
				'function example() {',
				'  console.log(\'test\');',
				'}',
				'```',
			]);
		});

		test('should use optimized state tracker for markdown files', async () => {
			const linesGenerator = toAsyncGenerator([
				'```markdown',
				'# Documentation',
				'```typescript',
				'const config = { name: \'test\' };',
				'```',
				'Final notes',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator, 'README.md');
			assert.deepStrictEqual(await collectLines(result), [
				'# Documentation',
				'```typescript',
				'const config = { name: \'test\' };',
				'```',
				'Final notes',
			]);
		});

		test('should fall back to legacy behavior when no markdown nesting detected', async () => {
			const linesGenerator = toAsyncGenerator([
				'```typescript',
				'const x = 5;',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator, 'script.ts');
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;']);
		});

		test('should handle mixed markdown and code scenarios with optimization', async () => {
			const linesGenerator = toAsyncGenerator([
				'```md',
				'## API Reference',
				'',
				'```javascript',
				'async function fetchData() {',
				'  return await fetch(\'/api/data\');',
				'}',
				'```',
				'',
				'Usage notes and more documentation.',
				'```',
			]);
			const result = filterCodeBlockLines(linesGenerator);
			assert.deepStrictEqual(await collectLines(result), [
				'## API Reference',
				'',
				'```javascript',
				'async function fetchData() {',
				'  return await fetch(\'/api/data\');',
				'}',
				'```',
				'',
				'Usage notes and more documentation.',
			]);
		});
	});

	suite('stopAtRepeatingLines', () => {
		test('should handle non-repeating lines correctly', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'let y = 10;',
				'const z = 15;',
			]);

			const result = stopAtRepeatingLines(linesGenerator, () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), [
				'const x = 5;',
				'let y = 10;',
				'const z = 15;',
			]);
			assert.strictEqual(fullStopCount, 0);
		});

		test('should stop at repeating lines', async () => {
			let fullStopCount = 0;
			const linesGenerator = toAsyncGenerator([
				'const x = 5;',
				'let y = 10;',
				'let y = 10;',
				'let y = 10;',
				'const z = 15;',
			]);

			const result = stopAtRepeatingLines(linesGenerator, () => fullStopCount++);
			assert.deepStrictEqual(await collectLines(result), ['const x = 5;', 'let y = 10;']);
			assert.strictEqual(fullStopCount, 1);
		});
	});

	suite('hasNestedMarkdownBlocks', () => {
		test('should detect nested markdown blocks from first line', () => {
			assert.strictEqual(hasNestedMarkdownBlocks('```markdown', undefined), true);
			assert.strictEqual(hasNestedMarkdownBlocks('```md', undefined), true);
			assert.strictEqual(hasNestedMarkdownBlocks('```gfm', undefined), true);
		});

		test('should detect nested markdown blocks from filepath', () => {
			assert.strictEqual(hasNestedMarkdownBlocks('```typescript', 'README.md'), true);
			assert.strictEqual(hasNestedMarkdownBlocks('```javascript', 'docs.markdown'), true);
		});

		test('should return false for non-markdown scenarios', () => {
			assert.strictEqual(hasNestedMarkdownBlocks('```typescript', 'script.js'), false);
			assert.strictEqual(hasNestedMarkdownBlocks('```python', undefined), false);
			assert.strictEqual(hasNestedMarkdownBlocks('const x = 5;', undefined), false);
		});

		test('should handle complex first line scenarios', () => {
			assert.strictEqual(hasNestedMarkdownBlocks('```markdown README.md', undefined), true);
			assert.strictEqual(hasNestedMarkdownBlocks('```md with extra text', undefined), true);
		});
	});

	suite('shouldChangeLineAndStop', () => {
		test('should handle [/CODE] at start of line', () => {
			assert.strictEqual(shouldChangeLineAndStop('[/CODE]'), '[/CODE]');
		});

		test('should handle [/CODE] with leading whitespace', () => {
			assert.strictEqual(shouldChangeLineAndStop('    [/CODE]'), '    [/CODE]');
		});

		test('should return partial line before [/CODE] when at start/after whitespace', () => {
			assert.strictEqual(shouldChangeLineAndStop('some code [/CODE] more text'), 'some code');
		});

		test('should NOT trigger on [/CODE] within quotes or non-whitespace preceded', () => {
			assert.strictEqual(shouldChangeLineAndStop('console.log("test [/CODE] end");'), undefined);
		});

		test('should NOT trigger on [/CODE] in middle of identifier', () => {
			assert.strictEqual(shouldChangeLineAndStop('const var[/CODE]Name = "test";'), undefined);
		});

		test('should handle ``` with trimStart correctly', () => {
			assert.strictEqual(shouldChangeLineAndStop('    ```'), '    ```');
		});

		test('should NOT handle ``` in middle of line', () => {
			assert.strictEqual(shouldChangeLineAndStop('console.log("test ``` end");'), undefined);
		});
	});

	suite('validatePatternInLine', () => {
		test('should return false when pattern is not found', () => {
			const result = validatePatternInLine('const x = 5;', '[/CODE]');
			assert.strictEqual(result.isValid, false);
			assert.strictEqual(result.patternIndex, -1);
			assert.strictEqual(result.beforePattern, '');
		});

		test('should return false when pattern is preceded by non-whitespace', () => {
			const result = validatePatternInLine('const var[/CODE]Name = "test";', '[/CODE]');
			assert.strictEqual(result.isValid, false);
			assert.strictEqual(result.patternIndex, 9);
		});

		test('should return false when pattern is inside double quotes', () => {
			const result = validatePatternInLine('console.log("test [/CODE] end");', '[/CODE]');
			assert.strictEqual(result.isValid, false);
			assert.strictEqual(result.patternIndex, 18);
		});

		test('should return false when pattern is inside single quotes', () => {
			const result = validatePatternInLine('const message = \'test [/CODE] end\';', '[/CODE]');
			assert.strictEqual(result.isValid, false);
			assert.strictEqual(result.patternIndex, 22);
		});

		test('should return true when pattern is properly separated by whitespace', () => {
			const result = validatePatternInLine('some code [/CODE] more text', '[/CODE]');
			assert.strictEqual(result.isValid, true);
			assert.strictEqual(result.patternIndex, 10);
			assert.strictEqual(result.beforePattern, 'some code ');
		});

		test('should return true when pattern is at start of line', () => {
			const result = validatePatternInLine('[/CODE]', '[/CODE]');
			assert.strictEqual(result.isValid, true);
			assert.strictEqual(result.patternIndex, 0);
			assert.strictEqual(result.beforePattern, '');
		});

		test('should return true when pattern has only whitespace before it', () => {
			const result = validatePatternInLine('    [/CODE]', '[/CODE]');
			assert.strictEqual(result.isValid, true);
			assert.strictEqual(result.patternIndex, 4);
			assert.strictEqual(result.beforePattern, '    ');
		});

		test('should handle complex quote scenarios correctly', () => {
			// Unmatched quote should make it invalid
			const result1 = validatePatternInLine('const x = "unclosed quote [/CODE]', '[/CODE]');
			assert.strictEqual(result1.isValid, false);

			// Matched quotes should make it valid
			const result2 = validatePatternInLine('const x = "closed"; [/CODE]', '[/CODE]');
			assert.strictEqual(result2.isValid, true);
		});

		test('should work with different patterns', () => {
			const result1 = validatePatternInLine('# End of file. Done', '# End of file.');
			assert.strictEqual(result1.isValid, true);

			const result2 = validatePatternInLine('    ```', '```');
			assert.strictEqual(result2.isValid, true);
		});
	});
});
