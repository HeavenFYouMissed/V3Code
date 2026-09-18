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

/** Inlined from Continue's core/util/lcs.ts. */
function longestCommonSubsequence(a: string, b: string): string {
	const lengths: number[][] = [];
	for (let i = 0; i <= a.length; i++) {
		lengths[i] = [];
		for (let j = 0; j <= b.length; j++) {
			if (i === 0 || j === 0) {
				lengths[i][j] = 0;
			} else if (a[i - 1] === b[j - 1]) {
				lengths[i][j] = lengths[i - 1][j - 1] + 1;
			} else {
				lengths[i][j] = Math.max(lengths[i - 1][j], lengths[i][j - 1]);
			}
		}
	}
	let result = '';
	let x = a.length;
	let y = b.length;
	while (x !== 0 && y !== 0) {
		if (lengths[x][y] === lengths[x - 1][y]) {
			x--;
		} else if (lengths[x][y] === lengths[x][y - 1]) {
			y--;
		} else {
			result = a[x - 1] + result;
			x--;
			y--;
		}
	}
	return result;
}

/**
 * Levenshtein edit distance — inlined replacement for Continue's
 * `fastest-levenshtein` dependency (standard two-row DP).
 */
function levenshteinDistance(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (a.length === 0) {
		return b.length;
	}
	if (b.length === 0) {
		return a.length;
	}
	let prevRow: number[] = new Array(b.length + 1);
	let currRow: number[] = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) {
		prevRow[j] = j;
	}
	for (let i = 1; i <= a.length; i++) {
		currRow[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
			currRow[j] = Math.min(
				prevRow[j] + 1, // deletion
				currRow[j - 1] + 1, // insertion
				prevRow[j - 1] + substitutionCost, // substitution
			);
		}
		const tmp = prevRow;
		prevRow = currRow;
		currRow = tmp;
	}
	return prevRow[b.length];
}

/**
 * Determines if two lines of text are considered repeated or very similar.
 *
 * This function checks if the Levenshtein distance between them is less than 10% of the
 * length of the second line. Lines shorter than 5 characters are never considered repeated.
 * (Inlined from Continue's lineStream.ts.)
 */
function lineIsRepeated(a: string, b: string): boolean {
	if (a.length <= 4 || b.length <= 4) {
		return false;
	}

	const aTrim = a.trim();
	const bTrim = b.trim();
	return levenshteinDistance(aTrim, bTrim) / bTrim.length < 0.1;
}

function rewritesLineAbove(completion: string, prefix: string): boolean {
	const lineAbove = prefix
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.slice(-1)[0];
	if (!lineAbove) {
		return false;
	}

	const firstLineOfCompletion = completion
		.split('\n')
		.find((line) => line.trim().length > 0);
	if (!firstLineOfCompletion) {
		return false;
	}
	return lineIsRepeated(lineAbove, firstLineOfCompletion);
}

const MAX_REPETITION_FREQ_TO_CHECK = 3;
function isExtremeRepetition(completion: string): boolean {
	const lines = completion.split('\n');
	if (lines.length < 6) {
		return false;
	}
	for (let freq = 1; freq < MAX_REPETITION_FREQ_TO_CHECK; freq++) {
		const lcs = longestCommonSubsequence(lines[0], lines[freq]);
		if (lcs.length > 5 || lcs.length > lines[0].length * 0.5) {
			let matchCount = 0;
			for (let i = 0; i < lines.length; i += freq) {
				if (lines[i].includes(lcs)) {
					matchCount++;
				}
			}
			if (matchCount * freq > 8 || (matchCount * freq) / lines.length > 0.8) {
				return true;
			}
		}
	}
	return false;
}

function isOnlyWhitespace(completion: string): boolean {
	const whitespaceRegex = /^[\s]+$/;
	return whitespaceRegex.test(completion);
}

function isBlank(completion: string): boolean {
	return completion.trim().length === 0;
}

/**
 * Removes markdown code block delimiters from completion.
 * Removes the first line if it starts with backticks (with optional language name).
 * Removes the last line if it contains only backticks.
 */
function removeBackticks(completion: string): string {
	const lines = completion.split('\n');

	if (lines.length === 0) {
		return completion;
	}

	let startIdx = 0;
	let endIdx = lines.length;

	// Remove first line if it starts with backticks (``` or ```language)
	const firstLineTrimmed = lines[0].trim();
	if (firstLineTrimmed.startsWith('```')) {
		startIdx = 1;
	}

	// Remove last line if it contains only backticks (one or more)
	if (lines.length > startIdx) {
		const lastLineTrimmed = lines[lines.length - 1].trim();
		if (lastLineTrimmed.length > 0 && /^`+$/.test(lastLineTrimmed)) {
			endIdx = lines.length - 1;
		}
	}

	// If we removed lines, return the modified completion
	if (startIdx > 0 || endIdx < lines.length) {
		return lines.slice(startIdx, endIdx).join('\n');
	}

	return completion;
}

/** Returns the cleaned-up completion, or undefined to reject it entirely. */
export function postprocessCompletion(args: {
	completion: string;
	prefix: string;
	suffix: string;
	/** The model name/id, matched by substring (Continue uses llm.model). */
	modelName: string;
}): string | undefined {
	const { prefix, suffix, modelName } = args;
	let completion = args.completion;

	// Don't return empty
	if (isBlank(completion)) {
		return undefined;
	}

	// Don't return whitespace
	if (isOnlyWhitespace(completion)) {
		return undefined;
	}

	// Dont return if it's just a repeat of the line above
	if (rewritesLineAbove(completion, prefix)) {
		return undefined;
	}

	// Filter out repetitions of many lines in a row
	if (isExtremeRepetition(completion)) {
		return undefined;
	}

	if (modelName.includes('codestral')) {
		// Codestral sometimes starts with an extra space
		if (completion[0] === ' ' && completion[1] !== ' ') {
			if (prefix.endsWith(' ') && suffix.startsWith('\n')) {
				completion = completion.slice(1);
			}
		}

		// When there is no suffix, Codestral tends to begin with a new line
		// We do this to avoid double new lines
		if (
			suffix.length === 0 &&
			prefix.endsWith('\n\n') &&
			completion.startsWith('\n')
		) {
			// Remove a single leading \n from the completion
			completion = completion.slice(1);
		}
	}

	if (modelName.includes('qwen3')) {
		// Qwen3 always starts from special thinking markers, and we don't want them to output these contents
		completion = completion.replace(/<think>.*?<\/think>/s, '');
		completion = completion.replace(/<\/think>/, '');

		// Remove any number of newline characters at the beginning and end
		completion = completion.replace(/^\n+|\n+$/g, '');
	}

	if (modelName.includes('granite')) {
		// Granite tends to repeat the start of the line in the completion output
		const prefixEnd = prefix.split('\n').pop();
		if (prefixEnd) {
			if (completion.startsWith(prefixEnd)) {
				completion = completion.slice(prefixEnd.length);
			} else {
				const trimmedPrefix = prefixEnd.trim();
				const lastWord = trimmedPrefix.split(/\s+/).pop();
				if (lastWord && completion.startsWith(lastWord)) {
					completion = completion.slice(lastWord.length);
				} else if (completion.startsWith(trimmedPrefix)) {
					completion = completion.slice(trimmedPrefix.length);
				}
			}
		}
	}

	// // If completion starts with multiple whitespaces, but the cursor is at the end of the line
	// // then it should probably be on a new line
	if (
		modelName.includes('mercury') &&
		(completion.startsWith('  ') || completion.startsWith('\t')) &&
		!prefix.endsWith('\n') &&
		(suffix.startsWith('\n') || suffix.trim().length === 0)
	) {
		completion = '\n' + completion;
	}

	if (
		(modelName.includes('gemini') || modelName.includes('gemma')) &&
		completion.endsWith('<|file_separator|>')
	) {
		// "<|file_separator|>" is 18 characters long
		completion = completion.slice(0, -18);
	}

	// If prefix ends with space and so does completion, then remove the space from completion
	if (prefix.endsWith(' ') && completion.startsWith(' ')) {
		completion = completion.slice(1);
	}

	// Remove markdown code block delimiters
	completion = removeBackticks(completion);

	return completion;
}

/**
 * URI schemes where inline suggestions (FIM autocomplete and next-edit prediction) may fire.
 *
 * Real editable files only. Every other Monaco model — chat composers, output channels, the debug
 * console, search editors, previews, custom input widgets — is somewhere the user is not writing
 * code, and suggesting there is the "it pops up everywhere" complaint.
 *
 * Deliberately an ALLOW-list. The previous checks denied a single scheme each, so any new non-file
 * surface was wrong by default and nobody found out until it misbehaved.
 */
export const INLINE_SUGGESTION_ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
	'file',
	'vscode-remote',
	'untitled',
	'vscode-notebook-cell',
	'vscode-userdata',
]);
