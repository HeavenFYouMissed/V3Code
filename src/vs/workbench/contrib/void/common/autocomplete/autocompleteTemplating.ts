/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/*
 * Adapted from Continue (https://github.com/continuedev/continue), Apache-2.0.
 * Copyright 2023-2026 Continue Dev, Inc. Modifications Copyright 2026 Glass Devtools, Inc.
 */
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/*
 * Per-model FIM (fill-in-the-middle) prompt templating, ported from Continue's
 * core/autocomplete/templating/AutocompleteTemplate.ts, getStopTokens.ts and
 * formatting.ts.
 *
 * Differences from the Continue source (interface adaptations only — the prompt
 * shapes and dispatch heuristics are preserved):
 * - Paths are workspace-relative strings (our snippets already carry relative
 *   paths), so the URI helpers (getLastNUriRelativePathParts,
 *   getShortestUniqueRelativeUriPaths) are inlined in simplified string form.
 * - Handlebars custom-template support is dropped; the built-in string templates
 *   only use triple-stache variables, so a single-pass literal interpolation is
 *   equivalent.
 * - Unknown and chat-style models (gpt/claude/gemini/...) return undefined instead
 *   of Continue's stableCode/hole-filler fallbacks — the caller falls back to the
 *   provider's native prefix/suffix FIM endpoint.
 * - Continue's token-counted prompt pruning (renderPromptWithTokenLimit) and
 *   token-budget snippet selection are not ported; snippets arrive pre-selected
 *   and the host budgets by characters. Nothing in this file counts tokens — if a
 *   budget is ever needed here, assume ~4 characters per token.
 */

import {
	AutocompleteClipboardSnippet,
	AutocompleteCodeSnippet,
	AutocompleteDiffSnippet,
	AutocompleteSnippet,
	AutocompleteSnippetType,
	FimTemplateContext,
	RenderedFimPrompt,
} from './autocompleteTypes.js';

// ---------------------------------------------------------------------------------
// Path helpers (inlined + simplified from Continue's core/util/uri.ts; they operate
// on workspace-relative string paths instead of URIs)
// ---------------------------------------------------------------------------------

/** Last `n` path parts of a relative path, joined with '/'. */
function getLastNPathParts(filepath: string, n: number): string {
	if (n <= 0) {
		return '';
	}
	return filepath.split(/[\\/]/).slice(-n).join('/');
}

/**
 * For each path, the shortest trailing-segment suffix that is unique among all the
 * given paths (falls back to the full path when no unique suffix exists).
 */
function getShortestUniqueRelativePaths(paths: string[]): { path: string; uniquePath: string }[] {
	// Split all paths into segments and count occurrences of each suffix combination
	const segmentCombinationsMap = new Map<string, number>();
	const segmentsInfo = paths.map((path) => {
		const segments = path.split('/');
		const suffixes: string[] = [];

		// Generate all possible suffix combinations, starting from the shortest (basename)
		for (let i = segments.length - 1; i >= 0; i--) {
			const suffix = segments.slice(i).join('/');
			suffixes.push(suffix); // Now pushing in order from shortest to longest
			// Count occurrences of each suffix
			segmentCombinationsMap.set(suffix, (segmentCombinationsMap.get(suffix) || 0) + 1);
		}

		return { path, suffixes };
	});
	// Find shortest unique path for each path
	return segmentsInfo.map(({ path, suffixes }) => {
		// Since suffixes are now ordered from shortest to longest,
		// the first unique one we find will be the shortest
		const uniquePath = suffixes.find((suffix) => segmentCombinationsMap.get(suffix) === 1)
			?? path; // fallback to full path if no unique suffix found
		return { path, uniquePath };
	});
}

/**
 * Continue's templates label non-file:// snippets with the full URI; our snippet
 * paths are always workspace-relative strings, so the unique path is always the label.
 */
function getFileName(entry: { path: string; uniquePath: string }): string {
	return entry.uniquePath;
}

/** The relative path a snippet is labeled with ('Untitled.txt' for clipboard/diff snippets). */
function snippetPathOrUntitled(snippet: AutocompleteSnippet): string {
	return 'filepath' in snippet ? snippet.filepath : 'Untitled.txt';
}

// ---------------------------------------------------------------------------------
// Template shape (adapted from Continue's AutocompleteTemplate; workspaceUris
// parameters are dropped since paths are already workspace-relative)
// ---------------------------------------------------------------------------------

/** Subset of Continue's CompletionOptions that the FIM templates use. */
export interface FimCompletionOptions {
	stop?: string[];
}

export interface FimAutocompleteTemplate {
	compilePrefixSuffix?: (
		prefix: string,
		suffix: string,
		filepath: string,
		reponame: string,
		snippets: AutocompleteSnippet[],
	) => [string, string];
	template:
	| string
	| ((
		prefix: string,
		suffix: string,
		filepath: string,
		reponame: string,
		language: string,
		snippets: AutocompleteSnippet[],
	) => string);
	completionOptions?: FimCompletionOptions;
}

// ---------------------------------------------------------------------------------
// Model templates (ported verbatim from Continue where possible)
// ---------------------------------------------------------------------------------

// https://huggingface.co/stabilityai/stable-code-3b
export const stableCodeFimTemplate: FimAutocompleteTemplate = {
	template: '<fim_prefix>{{{prefix}}}<fim_suffix>{{{suffix}}}<fim_middle>',
	completionOptions: {
		stop: [
			'<fim_prefix>',
			'<fim_suffix>',
			'<fim_middle>',
			'<file_sep>',
			'<|endoftext|>',
			'</fim_middle>',
			'</code>',
		],
	},
};

// https://github.com/QwenLM/Qwen2.5-Coder?tab=readme-ov-file#3-file-level-code-completion-fill-in-the-middle
// This issue asks about the use of <|repo_name|> and <|file_sep|> together with <|fim_prefix|>, <|fim_suffix|> and <|fim_middle|>
// https://github.com/QwenLM/Qwen2.5-Coder/issues/343
// (Defined in Continue but never dispatched — getTemplateForModel routes qwen-coder
// to the multifile variant below. Kept exported for tests.)
export const qwenCoderFimTemplate: FimAutocompleteTemplate = {
	template: '<|fim_prefix|>{{{prefix}}}<|fim_suffix|>{{{suffix}}}<|fim_middle|>',
	completionOptions: {
		stop: [
			'<|endoftext|>',
			'<|fim_prefix|>',
			'<|fim_middle|>',
			'<|fim_suffix|>',
			'<|fim_pad|>',
			'<|repo_name|>',
			'<|file_sep|>',
			'<|im_start|>',
			'<|im_end|>',
		],
	},
};

// Qwen multi-file FIM template for repository-level autocompletion
// https://github.com/continuedev/continue/issues/3589
export const qwenMultifileFimTemplate: FimAutocompleteTemplate = {
	compilePrefixSuffix: (prefix, suffix, filepath, reponame, snippets): [string, string] => {
		if (snippets.length === 0) {
			return [prefix, suffix];
		}

		const relativePaths = getShortestUniqueRelativePaths([
			...snippets.map(snippetPathOrUntitled),
			filepath,
		]);

		// (Continue formatted diff snippets identically to all other snippets here.)
		const fileContents = snippets
			.map((snippet, i) => `<|file_sep|>${getFileName(relativePaths[i])}\n${snippet.content}`)
			.join('\n');

		// Note: 'istruction' typo preserved from Continue — this is only an internal
		// marker matched by the template function below, never seen by the model.
		const fullPrefix = `<|repo_name|>${reponame}\n${fileContents}\n<|file_sep|>${getFileName(
			relativePaths[relativePaths.length - 1],
		)}<|system_separator_istruction_repository_level|>${prefix}`;

		return [fullPrefix, suffix];
	},
	template: (prefix: string, suffix: string): string => {
		if (prefix.includes('<|system_separator_istruction_repository_level|>')) {
			const [beforeSeparator, ...afterSeparator] = prefix.split(
				'<|system_separator_istruction_repository_level|>',
			);
			const combinedAfterSeparator = afterSeparator.join('');
			return `${beforeSeparator}\n<|fim_prefix|>${combinedAfterSeparator}<|fim_suffix|>${suffix}<|fim_middle|>`;
		}
		return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
	},
	completionOptions: {
		stop: [
			'<|endoftext|>',
			'<|fim_prefix|>',
			'<|fim_middle|>',
			'<|fim_suffix|>',
			'<|fim_pad|>',
			'<|repo_name|>',
			'<|file_sep|>',
			'<|im_start|>',
			'<|im_end|>',
		],
	},
};

// https://www.ibm.com/granite/docs/models/granite#fim
export const granite4FimTemplate: FimAutocompleteTemplate = {
	template: '<|fim_prefix|>{{{prefix}}}<|fim_suffix|>{{{suffix}}}<|fim_middle|>',
	completionOptions: {
		stop: [
			'<|end_of_text|>',
			'<|fim_prefix|>',
			'<|fim_middle|>',
			'<|fim_suffix|>',
			'<|fim_pad|>',
		],
	},
};

export const seedCoderFimTemplate: FimAutocompleteTemplate = {
	template: '<[fim-prefix]>{{{prefix}}}<[fim-suffix]>{{{suffix}}}<[fim-middle]>',
	completionOptions: {
		stop: [
			// allow-any-unicode-next-line
			'<[end▁of▁sentence]>',
			'<[fim-prefix]>',
			'<[fim-middle]>',
			'<[fim-suffix]>',
			// allow-any-unicode-next-line
			'<[PAD▁TOKEN]>',
			// allow-any-unicode-next-line
			'<[SEP▁TOKEN]>',
			// allow-any-unicode-next-line
			'<[begin▁of▁sentence]>',
		],
	},
};

// (Defined in Continue but never dispatched — getTemplateForModel routes codestral
// to the multifile variant below. Kept exported for tests.)
export const codestralFimTemplate: FimAutocompleteTemplate = {
	template: '[SUFFIX]{{{suffix}}}[PREFIX]{{{prefix}}}',
	completionOptions: {
		stop: ['[PREFIX]', '[SUFFIX]'],
	},
};

export const codestralMultifileFimTemplate: FimAutocompleteTemplate = {
	compilePrefixSuffix: (prefix, suffix, filepath, reponame, snippets): [string, string] => {
		if (snippets.length === 0) {
			if (suffix.trim().length === 0 && prefix.trim().length === 0) {
				return [`+++++ ${getLastNPathParts(filepath, 2)}\n${prefix}`, suffix];
			}
			return [prefix, suffix];
		}

		const relativePaths = getShortestUniqueRelativePaths([
			...snippets.map(snippetPathOrUntitled),
			filepath,
		]);

		const otherFiles = snippets
			.map((snippet, i) => {
				if (snippet.type === AutocompleteSnippetType.Diff) {
					return snippet.content;
				}

				return `+++++ ${getFileName(relativePaths[i])} \n${snippet.content}`;
			})
			.join('\n\n');

		return [
			`${otherFiles}\n\n+++++ ${getFileName(relativePaths[relativePaths.length - 1])}\n${prefix}`,
			suffix,
		];
	},
	template: (prefix: string, suffix: string): string => {
		return `[SUFFIX]${suffix}[PREFIX]${prefix}`;
	},
	completionOptions: {
		stop: ['[PREFIX]', '[SUFFIX]', '\n+++++ '],
	},
};

export const mercuryMultifileFimTemplate: FimAutocompleteTemplate = {
	compilePrefixSuffix: (prefix, suffix, filepath, reponame, snippets): [string, string] => {
		// Our current snippet format doesn't work well with mercury. We need to clean this up
		snippets = [];

		if (snippets.length === 0) {
			if (suffix.trim().length === 0 && prefix.trim().length === 0) {
				return [
					`<|file_sep|>${getLastNPathParts(filepath, 2)}\n<|fim_prefix|>${prefix}`,
					suffix,
				];
			}
			return [`${prefix}`, suffix];
		}

		// (Unreachable while the snippets override above is in place — kept from
		// Continue so the intended multi-file format survives.)
		const relativePaths = getShortestUniqueRelativePaths([
			...snippets.map(snippetPathOrUntitled),
			filepath,
		]);

		const otherFiles = snippets
			.map((snippet, i) => {
				if (snippet.type === AutocompleteSnippetType.Diff) {
					return snippet.content;
				}

				return `<|file_sep|>${getFileName(relativePaths[i])} \n${snippet.content}`;
			})
			.join('\n\n');

		return [
			`${otherFiles}${otherFiles ? '\n\n' : ''}<|file_sep|>${getFileName(relativePaths[relativePaths.length - 1])}\n<|fim_prefix|>${prefix}`,
			suffix,
		];
	},
	template: (prefix: string, suffix: string): string => {
		return `${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
	},
	// (No completionOptions in Continue — mercury relies on the common stops only.)
};

export const codegemmaFimTemplate: FimAutocompleteTemplate = {
	template: '<|fim_prefix|>{{{prefix}}}<|fim_suffix|>{{{suffix}}}<|fim_middle|>',
	completionOptions: {
		stop: [
			'<|fim_prefix|>',
			'<|fim_suffix|>',
			'<|fim_middle|>',
			'<|file_separator|>',
			'<end_of_turn>',
			'<eos>',
		],
	},
};

// https://arxiv.org/pdf/2402.19173.pdf section 5.1
// (Dispatch to this template is commented out in Continue — starcoder2 falls through
// to the stableCode family, which shares its FIM tokens. Kept exported for tests.)
export const starcoder2FimTemplate: FimAutocompleteTemplate = {
	template: (prefix, suffix, filename, reponame, language, snippets): string => {
		const otherFiles =
			snippets.length === 0
				? ''
				: `<file_sep>${snippets
					.map((snippet) => {
						return snippet.content;
					})
					.join('<file_sep>')}<file_sep>`;

		const prompt = `${otherFiles}<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`;
		return prompt;
	},
	completionOptions: {
		stop: [
			'<fim_prefix>',
			'<fim_suffix>',
			'<fim_middle>',
			'<file_sep>',
			'<|endoftext|>',
		],
	},
};

export const codeLlamaFimTemplate: FimAutocompleteTemplate = {
	template: '<PRE> {{{prefix}}} <SUF>{{{suffix}}} <MID>',
	completionOptions: { stop: ['<PRE>', '<SUF>', '<MID>', '<EOT>'] },
};

// https://huggingface.co/deepseek-ai/deepseek-coder-1.3b-base
export const deepseekFimTemplate: FimAutocompleteTemplate = {
	// allow-any-unicode-next-line
	template: '<｜fim▁begin｜>{{{prefix}}}<｜fim▁hole｜>{{{suffix}}}<｜fim▁end｜>',
	completionOptions: {
		stop: [
			// allow-any-unicode-next-line
			'<｜fim▁begin｜>',
			// allow-any-unicode-next-line
			'<｜fim▁hole｜>',
			// allow-any-unicode-next-line
			'<｜fim▁end｜>',
			'//',
			// allow-any-unicode-next-line
			'<｜end▁of▁sentence｜>',
		],
	},
};

// https://github.com/THUDM/CodeGeeX4/blob/main/guides/Infilling_guideline.md
export const codegeexFimTemplate: FimAutocompleteTemplate = {
	template: (prefix, suffix, filepath, reponame, language, allSnippets): string => {
		const snippets = allSnippets.filter(
			(snippet) => snippet.type === AutocompleteSnippetType.Code,
		) as AutocompleteCodeSnippet[];

		const relativePaths = getShortestUniqueRelativePaths([
			...snippets.map((snippet) => snippet.filepath),
			filepath,
		]);
		// (Continue interpolates the {uri, uniquePath} object here, yielding
		// '[object Object]' — we label with the unique path, which is the clear intent.)
		const baseTemplate = `###PATH:${getFileName(
			relativePaths[relativePaths.length - 1],
		)}\n###LANGUAGE:${language}\n###MODE:BLOCK\n<|code_suffix|>${suffix}<|code_prefix|>${prefix}<|code_middle|>`;
		if (snippets.length === 0) {
			return `<|user|>\n${baseTemplate}<|assistant|>\n`;
		}
		const references = `###REFERENCE:\n${snippets
			.map((snippet, i) => `###PATH:${getFileName(relativePaths[i])}\n${snippet.content}\n`)
			.join('###REFERENCE:\n')}`;
		const prompt = `<|user|>\n${references}\n${baseTemplate}<|assistant|>\n`;
		return prompt;
	},
	completionOptions: {
		stop: [
			'<|user|>',
			'<|code_suffix|>',
			'<|code_prefix|>',
			'<|code_middle|>',
			'<|assistant|>',
			'<|endoftext|>',
		],
	},
};

// ---------------------------------------------------------------------------------
// Model-name dispatch (mirrors Continue's getTemplateForModel, including its
// ordering quirks — e.g. plain 'qwen' without 'coder' lands on stableCode, and the
// starcoder2 branch stays commented out)
// ---------------------------------------------------------------------------------

/** A matched template family: the name we log plus the template itself. */
export interface NamedFimTemplate {
	name: string;
	template: FimAutocompleteTemplate;
}

export function getFimTemplateForModel(modelName: string): NamedFimTemplate | undefined {
	const lowerCaseModel = modelName.toLowerCase();

	// if (lowerCaseModel.includes('starcoder2')) {
	//   return starcoder2FimTemplate;
	// }
	if (lowerCaseModel.includes('mercury')) {
		return { name: 'mercury', template: mercuryMultifileFimTemplate };
	}

	if (lowerCaseModel.includes('qwen') && lowerCaseModel.includes('coder')) {
		return { name: 'qwen', template: qwenMultifileFimTemplate };
	}

	if (lowerCaseModel.includes('granite') && lowerCaseModel.includes('4')) {
		return { name: 'granite4', template: granite4FimTemplate };
	}

	if (lowerCaseModel.includes('seed') && lowerCaseModel.includes('coder')) {
		return { name: 'seed-coder', template: seedCoderFimTemplate };
	}

	if (
		lowerCaseModel.includes('starcoder') ||
		lowerCaseModel.includes('star-coder') ||
		lowerCaseModel.includes('starchat') ||
		lowerCaseModel.includes('octocoder') ||
		lowerCaseModel.includes('stable') ||
		lowerCaseModel.includes('codeqwen') ||
		lowerCaseModel.includes('qwen')
	) {
		return { name: 'stableCode', template: stableCodeFimTemplate };
	}

	if (lowerCaseModel.includes('codestral')) {
		return { name: 'codestral', template: codestralMultifileFimTemplate };
	}

	if (lowerCaseModel.includes('codegemma')) {
		return { name: 'codegemma', template: codegemmaFimTemplate };
	}

	if (lowerCaseModel.includes('codellama')) {
		return { name: 'codellama', template: codeLlamaFimTemplate };
	}

	if (lowerCaseModel.includes('deepseek')) {
		return { name: 'deepseek', template: deepseekFimTemplate };
	}

	if (lowerCaseModel.includes('codegeex')) {
		return { name: 'codegeex', template: codegeexFimTemplate };
	}

	// Chat-style models: Continue falls back to a hole-filler chat prompt here; our
	// host instead falls back to the provider's native prefix/suffix FIM endpoint.
	if (
		lowerCaseModel.includes('gpt') ||
		lowerCaseModel.includes('davinci-002') ||
		lowerCaseModel.includes('claude') ||
		lowerCaseModel.includes('gemini') ||
		lowerCaseModel.includes('granite3') ||
		lowerCaseModel.includes('granite-3')
	) {
		return undefined;
	}

	// Unknown models: Continue defaults to stableCodeFimTemplate; we return undefined
	// so the caller uses the provider's native FIM instead of guessing FIM tokens.
	return undefined;
}

/**
 * Template family for a model, via model-name substring match ('codestral', 'qwen',
 * ...). undefined for chat models and unknown models — the caller should fall back
 * to provider-native prefix/suffix FIM.
 */
export function getFimTemplateNameForModel(modelName: string): string | undefined {
	return getFimTemplateForModel(modelName)?.name;
}

// ---------------------------------------------------------------------------------
// Stop tokens (ported from Continue's getStopTokens.ts)
// ---------------------------------------------------------------------------------

// Continue also defines double-newline stops here, but keeps them commented out of
// commonStops (multilineStops below) — we drop the dead constants entirely.
// TODO: Do we want to stop completions when reaching a `/src/` string?
const SRC_DIRECTORY = '/src/';
// Starcoder2 tends to output artifacts starting with the letter "t"
const STARCODER2_T_ARTIFACTS = ['t.', '\nt', '<file_sep>'];
const PYTHON_ENCODING = '#- coding: utf-8';
const CODE_BLOCK_END = '```';

// const multilineStops: string[] = [DOUBLE_NEWLINE, WINDOWS_DOUBLE_NEWLINE];
const commonStops = [SRC_DIRECTORY, PYTHON_ENCODING, CODE_BLOCK_END];

export function getStopTokens(
	completionOptions: FimCompletionOptions | undefined,
	modelName: string,
): string[] {
	const stopTokens = [
		...(completionOptions?.stop || []),
		// ...multilineStops,
		...commonStops,
		...(modelName.toLowerCase().includes('starcoder2')
			? STARCODER2_T_ARTIFACTS
			: []),
	];

	return stopTokens;
}

// ---------------------------------------------------------------------------------
// Snippet formatting for templates without compilePrefixSuffix (ported from
// Continue's formatting.ts — snippets are folded into the prefix as a comment block)
// ---------------------------------------------------------------------------------

/**
 * Single-line comment prefix by lowercase language id, mirroring Continue's
 * AutocompleteLanguageInfo table. Continue falls back to TypeScript ('//') for
 * unknown languages; we do the same (including for '' / unknown language ids).
 */
const SINGLE_LINE_COMMENT_BY_LANGUAGE: { [languageId: string]: string } = {
	python: '#',
	ruby: '#',
	julia: '#',
	r: '#',
	yaml: '#',
	haskell: '--',
	lua: '--',
	clojure: ';',
	markdown: '',
	// everything else (typescript, javascript, java, c, cpp, csharp, go, rust, php,
	// swift, kotlin, scala, dart, solidity, fsharp, json, ...) uses '//'
};

function getCommentMark(language: string): string {
	const mark = SINGLE_LINE_COMMENT_BY_LANGUAGE[language];
	return mark !== undefined ? mark : '//';
}

function addCommentMarks(text: string, commentMark: string): string {
	return text
		.trim()
		.split('\n')
		.map((line) => `${commentMark} ${line}`)
		.join('\n');
}

function formatCodeSnippet(snippet: AutocompleteCodeSnippet): AutocompleteCodeSnippet {
	return {
		...snippet,
		content: `Path: ${getLastNPathParts(snippet.filepath, 2)}\n${snippet.content}`,
	};
}

function formatClipboardSnippet(snippet: AutocompleteClipboardSnippet): AutocompleteCodeSnippet {
	return formatCodeSnippet({
		filepath: 'Untitled.txt',
		content: snippet.content,
		type: AutocompleteSnippetType.Code,
	});
}

function formatDiffSnippet(snippet: AutocompleteDiffSnippet): AutocompleteDiffSnippet {
	return snippet;
}

function formatSnippets(
	filepath: string,
	language: string,
	snippets: AutocompleteSnippet[],
): string {
	const commentMark = getCommentMark(language);
	const currentFilepathComment = addCommentMarks(getLastNPathParts(filepath, 2), commentMark);

	return (
		snippets
			.map((snippet) => {
				switch (snippet.type) {
					case AutocompleteSnippetType.Code:
						return formatCodeSnippet(snippet);
					case AutocompleteSnippetType.Diff:
						return formatDiffSnippet(snippet);
					case AutocompleteSnippetType.Clipboard:
						return formatClipboardSnippet(snippet);
				}
			})
			.map((item) => {
				return addCommentMarks(item.content, commentMark);
			})
			.join('\n') + `\n${currentFilepathComment}`
	);
}

// ---------------------------------------------------------------------------------
// Prompt rendering (ported from Continue's templating/index.ts renderPrompt)
// ---------------------------------------------------------------------------------

/**
 * Continue renders string templates with Handlebars; the built-in templates only
 * use triple-stache ({{{...}}}) variables, so a single-pass literal interpolation
 * is equivalent. Unknown placeholders are left untouched.
 */
function renderStringTemplate(template: string, vars: { [key: string]: string }): string {
	return template.replace(/\{\{\{(\w+)\}\}\}/g, (match, name: string) => {
		const value = vars[name];
		return value !== undefined ? value : match;
	});
}

/**
 * Renders the full FIM prompt for the given model. Runs the family's
 * compilePrefixSuffix when it has one (codestral/qwen/mercury multi-file formats),
 * otherwise folds the snippets into the prefix as a comment block, then
 * interpolates the FIM tokens. Returns undefined when no template family matches
 * the model name (the caller should fall back to provider-native FIM).
 */
export function renderFimPrompt(
	modelName: string,
	ctx: FimTemplateContext,
): RenderedFimPrompt | undefined {
	const matched = getFimTemplateForModel(modelName);
	if (!matched) {
		return undefined;
	}
	const { template, compilePrefixSuffix, completionOptions } = matched.template;

	let prefix = ctx.prefix;
	let suffix = ctx.suffix;
	// Continue never sends an empty suffix — some FIM models degenerate without one.
	if (suffix === '') {
		suffix = '\n';
	}

	if (compilePrefixSuffix) {
		[prefix, suffix] = compilePrefixSuffix(prefix, suffix, ctx.filepath, ctx.reponame, ctx.snippets);
	} else {
		const formatted = formatSnippets(ctx.filepath, ctx.language, ctx.snippets);
		prefix = [formatted, prefix].join('\n');
	}

	const prompt =
		typeof template === 'string'
			? renderStringTemplate(template, {
				prefix,
				suffix,
				filename: getLastNPathParts(ctx.filepath, 1),
				reponame: ctx.reponame,
				language: ctx.language,
			})
			: template(prefix, suffix, ctx.filepath, ctx.reponame, ctx.language, ctx.snippets);

	const stopTokens = getStopTokens(completionOptions, modelName);

	return {
		prompt,
		stopTokens,
		templateName: matched.name,
	};
}
