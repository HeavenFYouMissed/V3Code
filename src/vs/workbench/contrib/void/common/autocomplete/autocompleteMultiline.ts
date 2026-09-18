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

export type AutocompleteMultilineSetting = 'auto' | 'always' | 'never';

/**
 * Single-line comment prefix per language id (lowercase VS Code language ids).
 * Adapted from Continue's AutocompleteLanguageInfo table (which is keyed by file
 * extension); languages not listed here simply skip the comment heuristic.
 */
const SINGLE_LINE_COMMENT_BY_LANGUAGE: { [languageId: string]: string } = {
	typescript: '//',
	typescriptreact: '//',
	javascript: '//',
	javascriptreact: '//',
	json: '//',
	jsonc: '//',
	python: '#',
	java: '//',
	c: '//',
	cpp: '//',
	csharp: '//',
	scala: '//',
	go: '//',
	rust: '//',
	haskell: '--',
	php: '//',
	ruby: '#',
	erb: '#',
	swift: '//',
	kotlin: '//',
	clojure: ';',
	julia: '#',
	fsharp: '//',
	r: '#',
	dart: '//',
	solidity: '//',
	lua: '--',
	yaml: '#',
	// markdown deliberately has no single-line comment (Continue uses '')
};

// function isMidlineCompletion(prefix: string, suffix: string): boolean {
// 	return !suffix.startsWith('\n');
// }

/**
 * Continue's Markdown language info is the only one that defines a custom
 * `useMultiline` heuristic; every other language defaults to multiline.
 */
function markdownUseMultiline(prefix: string): boolean {
	const singleLineStarters: (string | RegExp)[] = ['- ', '* ', /^\d+\. /, '> ', '```', /^#{1,6} /];
	let currentLine = prefix.split('\n').pop();
	if (!currentLine) {
		return true;
	}
	currentLine = currentLine.trim();
	for (const starter of singleLineStarters) {
		if (
			typeof starter === 'string'
				? currentLine.startsWith(starter)
				: starter.test(currentLine)
		) {
			return false;
		}
	}
	return true;
}

function shouldCompleteMultilineBasedOnLanguage(
	language: string,
	prefix: string,
	_suffix: string,
): boolean {
	// language.useMultiline?.({ prefix, suffix }) ?? true — only Markdown defines one
	if (language === 'markdown') {
		return markdownUseMultiline(prefix);
	}
	return true;
}

/** Single-line comment prefix for a language id ('' when unknown) — used by the stream filters. */
export function getSingleLineCommentPrefix(languageId: string): string {
	return SINGLE_LINE_COMMENT_BY_LANGUAGE[languageId] ?? '';
}

export function shouldCompleteMultiline(args: {
	prefix: string;
	suffix: string;
	/** Language id, lowercase (e.g. 'typescript'); '' when unknown. */
	language: string;
	multilineSetting: AutocompleteMultilineSetting;
}): boolean {
	const { prefix, suffix, language, multilineSetting } = args;

	switch (multilineSetting) {
		case 'always':
			return true;
		case 'never':
			return false;
		default:
			break;
	}

	// NOTE: dropped from the Continue original here:
	// - the early `return true` when an IntelliSense item is selected
	//   (helper.input.selectedCompletionInfo) — that signal isn't shipped through this layer;
	// - the tree-sitter AST refinement (classifying the node under the cursor) that older
	//   Continue versions applied — we keep only the string/heuristic logic.

	// // Don't complete multi-line if you are mid-line
	// if (isMidlineCompletion(prefix, suffix)) {
	// 	return false;
	// }

	// Don't complete multi-line for single-line comments
	const singleLineComment = SINGLE_LINE_COMMENT_BY_LANGUAGE[language];
	if (
		singleLineComment &&
		prefix
			.split('\n')
			.slice(-1)[0]
			?.trimStart()
			.startsWith(singleLineComment)
	) {
		return false;
	}

	return shouldCompleteMultilineBasedOnLanguage(language, prefix, suffix);
}
