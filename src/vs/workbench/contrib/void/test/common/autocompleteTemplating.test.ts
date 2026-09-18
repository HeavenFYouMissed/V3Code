/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/*
 * Adapted from Continue (https://github.com/continuedev/continue), Apache-2.0.
 * Copyright 2023-2026 Continue Dev, Inc. Modifications Copyright 2026 Glass Devtools, Inc.
 */

/*
 * Adapted from Continue's core/autocomplete/templating/__tests__/renderPrompt.vitest.ts.
 * The upstream suite mocks every collaborator (Handlebars, token counting, snippet
 * selection, template dispatch); our port has none of those seams, so the same concerns
 * are tested here against the real templates through renderFimPrompt: template dispatch
 * (getTemplateForModel), compilePrefixSuffix vs snippet-comment formatting, function vs
 * string templates, the empty-suffix substitution, and stop-token merging.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	codegeexFimTemplate,
	codeLlamaFimTemplate,
	codestralMultifileFimTemplate,
	deepseekFimTemplate,
	getFimTemplateForModel,
	getFimTemplateNameForModel,
	getStopTokens,
	granite4FimTemplate,
	mercuryMultifileFimTemplate,
	qwenMultifileFimTemplate,
	renderFimPrompt,
	seedCoderFimTemplate,
	stableCodeFimTemplate,
} from '../../common/autocomplete/autocompleteTemplating.js';
import {
	AutocompleteSnippet,
	AutocompleteSnippetType,
	FimTemplateContext,
} from '../../common/autocomplete/autocompleteTypes.js';

const COMMON_STOPS = ['/src/', '#- coding: utf-8', '```'];

function makeCtx(overrides: Partial<FimTemplateContext> = {}): FimTemplateContext {
	return {
		prefix: 'const x = ',
		suffix: ';\n',
		filepath: 'src/index.ts',
		reponame: 'myrepo',
		language: 'typescript',
		snippets: [],
		...overrides,
	};
}

suite('autocomplete templating', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('getFimTemplateForModel dispatch', () => {
		test('maps model names to template families (Continue getTemplateForModel ordering)', () => {
			assert.strictEqual(getFimTemplateNameForModel('mercury-coder-small'), 'mercury');
			assert.strictEqual(getFimTemplateNameForModel('Qwen2.5-Coder-7B-Instruct'), 'qwen');
			assert.strictEqual(getFimTemplateNameForModel('granite-4.0-h-small'), 'granite4');
			assert.strictEqual(getFimTemplateNameForModel('seed-coder-8b'), 'seed-coder');
			assert.strictEqual(getFimTemplateNameForModel('starcoder-3b'), 'stableCode');
			assert.strictEqual(getFimTemplateNameForModel('star-coder'), 'stableCode');
			assert.strictEqual(getFimTemplateNameForModel('starchat-beta'), 'stableCode');
			assert.strictEqual(getFimTemplateNameForModel('octocoder'), 'stableCode');
			assert.strictEqual(getFimTemplateNameForModel('stable-code-3b'), 'stableCode');
			assert.strictEqual(getFimTemplateNameForModel('CodeQwen1.5-7B'), 'stableCode');
			assert.strictEqual(getFimTemplateNameForModel('codestral-latest'), 'codestral');
			assert.strictEqual(getFimTemplateNameForModel('codegemma-7b'), 'codegemma');
			assert.strictEqual(getFimTemplateNameForModel('codellama-13b'), 'codellama');
			assert.strictEqual(getFimTemplateNameForModel('deepseek-coder-6.7b-base'), 'deepseek');
			assert.strictEqual(getFimTemplateNameForModel('codegeex4-all-9b'), 'codegeex');
		});

		test('quirk preserved: plain qwen without coder lands on the stableCode family', () => {
			assert.strictEqual(getFimTemplateNameForModel('qwen2.5-7b'), 'stableCode');
		});

		test('quirk preserved: starcoder2 dispatch stays commented out (falls to stableCode)', () => {
			assert.strictEqual(getFimTemplateNameForModel('starcoder2-15b'), 'stableCode');
			assert.strictEqual(getFimTemplateForModel('starcoder2-15b')?.template, stableCodeFimTemplate);
		});

		test('quirk preserved: granite-4 matches any model containing granite and a 4', () => {
			assert.strictEqual(getFimTemplateNameForModel('granite-34b-code'), 'granite4');
		});

		test('returns the exported template constants', () => {
			assert.strictEqual(getFimTemplateForModel('codestral-latest')?.template, codestralMultifileFimTemplate);
			assert.strictEqual(getFimTemplateForModel('qwen2.5-coder')?.template, qwenMultifileFimTemplate);
			assert.strictEqual(getFimTemplateForModel('mercury-coder')?.template, mercuryMultifileFimTemplate);
			assert.strictEqual(getFimTemplateForModel('granite-4.0')?.template, granite4FimTemplate);
			assert.strictEqual(getFimTemplateForModel('seed-coder')?.template, seedCoderFimTemplate);
			assert.strictEqual(getFimTemplateForModel('codellama-13b')?.template, codeLlamaFimTemplate);
			assert.strictEqual(getFimTemplateForModel('deepseek-coder')?.template, deepseekFimTemplate);
			assert.strictEqual(getFimTemplateForModel('codegeex4')?.template, codegeexFimTemplate);
		});

		test('chat models return undefined (host falls back to native prefix/suffix FIM)', () => {
			assert.strictEqual(getFimTemplateNameForModel('gpt-4o-mini'), undefined);
			assert.strictEqual(getFimTemplateNameForModel('davinci-002'), undefined);
			assert.strictEqual(getFimTemplateNameForModel('claude-3-5-haiku'), undefined);
			assert.strictEqual(getFimTemplateNameForModel('gemini-2.0-flash'), undefined);
			assert.strictEqual(getFimTemplateNameForModel('granite3-dense-8b'), undefined);
			assert.strictEqual(getFimTemplateNameForModel('granite-3.1-8b'), undefined);
		});

		test('unknown models return undefined instead of the Continue stableCode fallback', () => {
			assert.strictEqual(getFimTemplateNameForModel('some-unknown-model'), undefined);
			assert.strictEqual(renderFimPrompt('some-unknown-model', makeCtx()), undefined);
			assert.strictEqual(renderFimPrompt('gpt-4o', makeCtx()), undefined);
		});
	});

	suite('codestral rendering', () => {
		test('renders [SUFFIX]/[PREFIX] with no snippets', () => {
			const result = renderFimPrompt('codestral-latest', makeCtx());
			assert.ok(result);
			assert.strictEqual(result.templateName, 'codestral');
			assert.strictEqual(result.prompt, '[SUFFIX];\n[PREFIX]const x = ');
		});

		test('labels an empty file with the last two path parts', () => {
			const result = renderFimPrompt('codestral-latest', makeCtx({
				prefix: '',
				suffix: '',
				filepath: 'a/b/notes.ts',
			}));
			assert.ok(result);
			// Empty suffix is replaced by '\n' before compilePrefixSuffix runs.
			assert.strictEqual(result.prompt, '[SUFFIX]\n[PREFIX]+++++ b/notes.ts\n');
		});

		test('renders multi-file snippets with +++++ headers, unique paths, and raw diffs', () => {
			const snippets: AutocompleteSnippet[] = [
				{ type: AutocompleteSnippetType.Code, filepath: 'src/a/utils.ts', content: 'export const A = 1;' },
				{ type: AutocompleteSnippetType.Code, filepath: 'src/b/utils.ts', content: 'export const B = 2;' },
				{ type: AutocompleteSnippetType.Diff, content: 'diff --git a/x b/x\n+added line' },
			];
			const result = renderFimPrompt('codestral-latest', makeCtx({ filepath: 'src/main.ts', snippets }));
			assert.ok(result);
			// Colliding basenames are disambiguated ('a/utils.ts' vs 'b/utils.ts'); the
			// trailing space in '+++++ <name> \n' is a preserved Continue quirk; diff
			// snippets are inlined raw.
			assert.strictEqual(result.prompt,
				'[SUFFIX];\n[PREFIX]' +
				'+++++ a/utils.ts \nexport const A = 1;\n\n' +
				'+++++ b/utils.ts \nexport const B = 2;\n\n' +
				'diff --git a/x b/x\n+added line\n\n' +
				'+++++ main.ts\nconst x = ');
		});

		test('labels clipboard snippets Untitled.txt', () => {
			const snippets: AutocompleteSnippet[] = [
				{ type: AutocompleteSnippetType.Clipboard, content: 'copied text', copiedAt: 1 },
			];
			const result = renderFimPrompt('codestral-latest', makeCtx({ snippets }));
			assert.ok(result);
			assert.ok(result.prompt.includes('+++++ Untitled.txt \ncopied text'));
		});

		test('merges template stops with the common stops', () => {
			const result = renderFimPrompt('codestral-latest', makeCtx());
			assert.deepStrictEqual(result?.stopTokens, ['[PREFIX]', '[SUFFIX]', '\n+++++ ', ...COMMON_STOPS]);
		});
	});

	suite('qwen rendering', () => {
		test('renders plain FIM tokens with no snippets', () => {
			const result = renderFimPrompt('qwen2.5-coder-7b', makeCtx());
			assert.ok(result);
			assert.strictEqual(result.templateName, 'qwen');
			assert.strictEqual(result.prompt, '<|fim_prefix|>const x = <|fim_suffix|>;\n<|fim_middle|>');
		});

		test('substitutes a newline for an empty suffix', () => {
			const result = renderFimPrompt('qwen2.5-coder-7b', makeCtx({ suffix: '' }));
			assert.strictEqual(result?.prompt, '<|fim_prefix|>const x = <|fim_suffix|>\n<|fim_middle|>');
		});

		test('renders repo-level tokens for multi-file snippets', () => {
			const snippets: AutocompleteSnippet[] = [
				{ type: AutocompleteSnippetType.Code, filepath: 'src/utils/math.ts', content: 'export function add(a, b) { return a + b; }' },
				{ type: AutocompleteSnippetType.Clipboard, content: 'copied snippet', copiedAt: 1 },
			];
			const result = renderFimPrompt('qwen2.5-coder-7b', makeCtx({ prefix: 'const sum = ', snippets }));
			assert.ok(result);
			assert.strictEqual(result.prompt,
				'<|repo_name|>myrepo\n' +
				'<|file_sep|>math.ts\nexport function add(a, b) { return a + b; }\n' +
				'<|file_sep|>Untitled.txt\ncopied snippet\n' +
				'<|file_sep|>index.ts\n' +
				'<|fim_prefix|>const sum = <|fim_suffix|>;\n<|fim_middle|>');
			// The internal repo-level separator marker must never leak into the prompt.
			assert.ok(!result.prompt.includes('istruction'));
		});

		test('merges template stops with the common stops', () => {
			const result = renderFimPrompt('qwen2.5-coder-7b', makeCtx());
			assert.deepStrictEqual(result?.stopTokens, [
				'<|endoftext|>',
				'<|fim_prefix|>',
				'<|fim_middle|>',
				'<|fim_suffix|>',
				'<|fim_pad|>',
				'<|repo_name|>',
				'<|file_sep|>',
				'<|im_start|>',
				'<|im_end|>',
				...COMMON_STOPS,
			]);
		});
	});

	suite('starcoder (stableCode family) rendering', () => {
		test('folds the filepath comment into the prefix even with zero snippets', () => {
			const result = renderFimPrompt('starcoder-3b', makeCtx({
				prefix: 'function add(a, b) {\n\treturn ',
				suffix: '\n}',
				filepath: 'src/math.ts',
			}));
			assert.ok(result);
			assert.strictEqual(result.templateName, 'stableCode');
			assert.strictEqual(result.prompt,
				'<fim_prefix>\n// src/math.ts\nfunction add(a, b) {\n\treturn <fim_suffix>\n}<fim_middle>');
		});

		test('folds snippets into the prefix as a comment block (no compilePrefixSuffix)', () => {
			const snippets: AutocompleteSnippet[] = [
				{ type: AutocompleteSnippetType.Code, filepath: 'src/utils/helpers.ts', content: 'export function clamp(x: number) {}' },
			];
			const result = renderFimPrompt('starcoder-3b', makeCtx({
				prefix: 'const y = ',
				suffix: ';',
				filepath: 'src/math.ts',
				snippets,
			}));
			assert.ok(result);
			assert.strictEqual(result.prompt,
				'<fim_prefix>' +
				'// Path: utils/helpers.ts\n' +
				'// export function clamp(x: number) {}\n' +
				'// src/math.ts\n' +
				'const y = <fim_suffix>;<fim_middle>');
		});

		test('uses the language comment mark when folding snippets', () => {
			const snippets: AutocompleteSnippet[] = [
				{ type: AutocompleteSnippetType.Code, filepath: 'src/util.py', content: 'def helper(): pass' },
			];
			const result = renderFimPrompt('stable-code-3b', makeCtx({
				prefix: 'def main():\n\t',
				suffix: '\n',
				filepath: 'src/app.py',
				language: 'python',
				snippets,
			}));
			assert.ok(result);
			assert.ok(result.prompt.includes('# Path: src/util.py\n# def helper(): pass\n# src/app.py'));
		});

		test('stableCode stops are used, with starcoder2 t-artifacts only for starcoder2', () => {
			const stableStops = [
				'<fim_prefix>',
				'<fim_suffix>',
				'<fim_middle>',
				'<file_sep>',
				'<|endoftext|>',
				'</fim_middle>',
				'</code>',
			];
			const starcoder = renderFimPrompt('starcoder-3b', makeCtx());
			assert.deepStrictEqual(starcoder?.stopTokens, [...stableStops, ...COMMON_STOPS]);

			const starcoder2 = renderFimPrompt('starcoder2-15b', makeCtx());
			assert.deepStrictEqual(starcoder2?.stopTokens, [...stableStops, ...COMMON_STOPS, 't.', '\nt', '<file_sep>']);
		});
	});

	suite('mercury rendering', () => {
		test('labels an empty file and renders the prefix-anchored template', () => {
			const result = renderFimPrompt('mercury-coder', makeCtx({
				prefix: '',
				suffix: '',
				filepath: 'a/b/notes.ts',
			}));
			assert.ok(result);
			assert.strictEqual(result.templateName, 'mercury');
			assert.strictEqual(result.prompt, '<|file_sep|>b/notes.ts\n<|fim_prefix|><|fim_suffix|>\n<|fim_middle|>');
		});

		test('quirk preserved: snippets are discarded (hardcoded snippets = [])', () => {
			const snippets: AutocompleteSnippet[] = [
				{ type: AutocompleteSnippetType.Code, filepath: 'src/other.ts', content: 'export const other = 1;' },
			];
			const result = renderFimPrompt('mercury-coder', makeCtx({ snippets }));
			assert.strictEqual(result?.prompt, 'const x = <|fim_suffix|>;\n<|fim_middle|>');
		});

		test('has no template stops — only the common stops', () => {
			const result = renderFimPrompt('mercury-coder', makeCtx());
			assert.deepStrictEqual(result?.stopTokens, COMMON_STOPS);
		});
	});

	suite('codellama rendering (string template interpolation)', () => {
		test('interpolates the <PRE>/<SUF>/<MID> template', () => {
			const result = renderFimPrompt('codellama-13b', makeCtx({
				prefix: 'int main() {',
				suffix: '}',
				filepath: 'src/main.c',
				language: 'c',
			}));
			assert.ok(result);
			assert.strictEqual(result.prompt, '<PRE> \n// src/main.c\nint main() { <SUF>} <MID>');
			assert.deepStrictEqual(result.stopTokens, ['<PRE>', '<SUF>', '<MID>', '<EOT>', ...COMMON_STOPS]);
		});
	});

	suite('getStopTokens', () => {
		test('returns only the common stops when there are no template stops', () => {
			assert.deepStrictEqual(getStopTokens(undefined, 'some-model'), COMMON_STOPS);
		});

		test('prepends template stops and appends starcoder2 artifacts', () => {
			assert.deepStrictEqual(
				getStopTokens({ stop: ['<A>'] }, 'starcoder2-7b'),
				['<A>', ...COMMON_STOPS, 't.', '\nt', '<file_sep>'],
			);
		});
	});
});
