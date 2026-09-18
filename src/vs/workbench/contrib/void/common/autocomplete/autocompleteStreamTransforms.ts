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

/**
 * Mid-stream filtering transforms for FIM autocomplete output.
 *
 * Char-level generators are ported from Continue's
 * core/autocomplete/filtering/streamTransforms/charStream.ts, line-level generators from
 * core/autocomplete/filtering/streamTransforms/lineStream.ts and filterCodeBlock.ts, with
 * the small helpers they import (streamLines from core/diff/util.ts, the markdown fence
 * utilities from core/utils/markdownUtils.ts and streamMarkdownUtils.ts, and the
 * Levenshtein distance from the 'fastest-levenshtein' package) inlined below.
 */

/** A stream of complete lines (no trailing '\n'). Continue's `LineStream`. */
export type LineStream = AsyncGenerator<string>;

// ---------------------------------------------------------------------------------------
// Inlined helpers
// ---------------------------------------------------------------------------------------

/**
 * Plain two-row Levenshtein edit distance. Inlined stand-in for the
 * 'fastest-levenshtein' `distance` function Continue depends on — identical results
 * (only less optimized, which is fine for single-line inputs).
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
		const charA = a.charCodeAt(i - 1);
		for (let j = 1; j <= b.length; j++) {
			const cost = charA === b.charCodeAt(j - 1) ? 0 : 1;
			currRow[j] = Math.min(
				prevRow[j] + 1, // deletion
				currRow[j - 1] + 1, // insertion
				prevRow[j - 1] + cost, // substitution
			);
		}
		const tmp = prevRow;
		prevRow = currRow;
		currRow = tmp;
	}

	return prevRow[b.length];
}

// ---------------------------------------------------------------------------------------
// Char-level transforms (Continue charStream.ts)
// ---------------------------------------------------------------------------------------

/**
 * Yields characters from the stream, stopping if the first character is a newline.
 */
export async function* noFirstCharNewline(stream: AsyncGenerator<string>): AsyncGenerator<string> {
	let first = true;
	for await (const char of stream) {
		if (first) {
			first = false;
			if (char.startsWith('\n') || char.startsWith('\r')) {
				return;
			}
		}
		yield char;
	}
}

/**
 * Asynchronously yields characters from the input stream, stopping if a stop token is encountered.
 *
 * 1. If no stop tokens are provided, yields all characters from the stream.
 * 2. Otherwise, buffers incoming chunks and checks for stop tokens.
 * 3. Yields characters one by one if no stop token is found at the start of the buffer.
 * 4. Stops yielding and returns if a stop token is encountered.
 * 5. After the stream ends, filters encountered stop tokens in remaining buffer.
 * 6. Yields any remaining buffered characters.
 */
export async function* stopAtStopTokens(
	stream: AsyncGenerator<string>,
	stopTokens: string[],
): AsyncGenerator<string> {
	if (stopTokens.length === 0) {
		for await (const char of stream) {
			yield char;
		}
		return;
	}

	const maxStopTokenLength = Math.max(...stopTokens.map((token) => token.length));
	let buffer = '';

	for await (const chunk of stream) {
		buffer += chunk;

		while (buffer.length >= maxStopTokenLength) {
			let found = false;
			for (const stopToken of stopTokens) {
				if (buffer.startsWith(stopToken)) {
					found = true;
					return;
				}
			}

			if (!found) {
				yield buffer[0];
				buffer = buffer.slice(1);
			}
		}
	}
	// Filter out the possible stop tokens from remaining buffer
	stopTokens.forEach((token) => {
		buffer = buffer.replace(token, '');
	});

	// Yield any remaining characters in the buffer
	for (const char of buffer) {
		yield char;
	}
}

/**
 * Asynchronously yields characters from the input stream.
 * Stops if the beginning of the suffix is detected in the stream.
 */
export async function* stopAtStartOf(
	stream: AsyncGenerator<string>,
	suffix: string,
	sequenceLength: number = 20,
): AsyncGenerator<string> {
	if (suffix.length < sequenceLength) {
		for await (const chunk of stream) {
			yield chunk;
		}
		return;
	}
	// We use sequenceLength * 1.5 as a heuristic to make sure we don't miss the sequence if the
	// stream is not perfectly aligned with the sequence (small whitespace differences etc).
	const targetPart = suffix.trimStart().slice(0, Math.floor(sequenceLength * 1.5));

	let buffer = '';

	for await (const chunk of stream) {
		buffer += chunk;

		// Check if the targetPart contains contains the buffer at any point
		if (buffer.length >= sequenceLength && targetPart.includes(buffer)) {
			return; // Stop processing when the sequence is found
		}

		// Yield chunk by chunk, ensuring not to exceed sequenceLength in the buffer
		while (buffer.length > sequenceLength) {
			yield buffer[0];
			buffer = buffer.slice(1);
		}
	}

	// Yield the remaining buffer if it is not contained in the `targetPart`
	if (buffer.length > 0) {
		yield buffer;
	}
}

// ---------------------------------------------------------------------------------------
// Chunk → line splitting (Continue core/diff/util.ts streamLines, string-chunk case only)
// ---------------------------------------------------------------------------------------

/**
 * Convert a stream of arbitrary chunks to a stream of lines.
 */
export async function* streamLines(streamCompletion: AsyncGenerator<string>): LineStream {
	let buffer = '';

	for await (const chunk of streamCompletion) {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			yield line;
		}
	}
	if (buffer.length > 0) {
		yield buffer;
	}
}

// ---------------------------------------------------------------------------------------
// Line-level transforms (Continue lineStream.ts)
// ---------------------------------------------------------------------------------------

export const CODE_STOP_BLOCK = '[/CODE]';
export const BRACKET_ENDING_CHARS = [')', ']', '}', ';'];
export const PREFIXES_TO_SKIP = ['<COMPLETION>'];
export const LINES_TO_STOP_AT = [
	'# End of file.',
	'<STOP EDITING HERE',
	'<|/updated_code|>',
	'```',
];
export const LINES_TO_REMOVE_BEFORE_START = [
	'<COMPLETION>',
	'[CODE]',
	'<START EDITING HERE>',
	'{{FILL_HERE}}',
];

function isBracketEnding(line: string): boolean {
	return line
		.trim()
		.split('')
		.some((char) => BRACKET_ENDING_CHARS.includes(char));
}

/**
 * Shared utility for validating patterns in lines to avoid code duplication.
 * Checks if a pattern appears in a valid context (not inside quotes or identifiers).
 */
export function validatePatternInLine(
	line: string,
	pattern: string,
): {
	isValid: boolean;
	patternIndex: number;
	beforePattern: string;
} {
	const patternIndex = line.indexOf(pattern);

	if (patternIndex === -1) {
		return { isValid: false, patternIndex: -1, beforePattern: '' };
	}

	// Check if pattern is preceded by a non-whitespace character
	// If so, it might be part of an identifier, so don't handle it
	if (patternIndex > 0) {
		const charBefore = line[patternIndex - 1];
		if (charBefore && !charBefore.match(/\s/)) {
			return { isValid: false, patternIndex, beforePattern: '' };
		}
	}

	// Check if pattern appears to be inside quotes
	// Simple heuristic: count unmatched quotes before the pattern
	const beforePattern = line.substring(0, patternIndex);
	const singleQuotes = (beforePattern.match(/'/g) || []).length;
	const doubleQuotes = (beforePattern.match(/"/g) || []).length;

	// If there's an odd number of quotes before pattern, we're likely inside quotes
	if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
		return { isValid: false, patternIndex, beforePattern };
	}

	return { isValid: true, patternIndex, beforePattern };
}

/**
 * Given a line, returns the replacement line to yield before stopping (a bare markdown
 * fence, or content preceding a '[/CODE]' marker), or undefined if streaming should
 * continue past this line.
 */
export function shouldChangeLineAndStop(line: string): string | undefined {
	if (line.trimStart() === '```') {
		return line;
	}

	// Check if [/CODE] appears in the line
	if (line.includes(CODE_STOP_BLOCK)) {
		const validation = validatePatternInLine(line, CODE_STOP_BLOCK);

		if (!validation.isValid) {
			return undefined;
		}

		// Get the trimmed line to check if [/CODE] is at logical start
		const trimmedLine = line.trimStart();

		if (trimmedLine.startsWith(CODE_STOP_BLOCK)) {
			// [/CODE] is at the logical start (after whitespace only)
			if (trimmedLine === CODE_STOP_BLOCK) {
				return line; // Return the whole line including leading whitespace
			}
		}

		// [/CODE] appears after some content (separated by whitespace) - return part before
		return validation.beforePattern.trimEnd();
	}

	return undefined;
}

/**
 * Filters out lines starting with '// Path: <PATH>' from a LineStream.
 *
 * @param stream The input stream of lines to filter.
 * @param comment The comment syntax to filter (e.g., '//' for JavaScript-style comments).
 */
export async function* avoidPathLine(stream: LineStream, comment?: string): LineStream {
	// Snippets are inserted as comments with a line at the start '// Path: <PATH>'.
	// Sometimes the model with copy this pattern, which is unwanted
	for await (const line of stream) {
		if (line.startsWith(`${comment} Path: `)) {
			continue;
		}
		yield line;
	}
}

/**
 * Filters out empty comment lines from a LineStream.
 *
 * @param stream The input stream of lines to filter.
 * @param comment The comment syntax to filter (e.g., '//' for JavaScript-style comments).
 */
export async function* avoidEmptyComments(stream: LineStream, comment?: string): LineStream {
	// Filter lines that are empty comments
	for await (const line of stream) {
		if (!comment || line.trim() !== comment) {
			yield line;
		}
	}
}

/**
 * Transforms a LineStream by adding newline characters between lines.
 */
export async function* streamWithNewLines(stream: LineStream): LineStream {
	let firstLine = true;
	for await (const nextLine of stream) {
		if (!firstLine) {
			yield '\n';
		}
		firstLine = false;
		yield nextLine;
	}
}

/**
 * Determines if two lines of text are considered repeated or very similar.
 *
 * This function checks if the Levenshtein distance between them is less than 10% of the
 * length of the second line. Lines shorter than 5 characters are never considered repeated.
 */
export function lineIsRepeated(a: string, b: string): boolean {
	if (a.length <= 4 || b.length <= 4) {
		return false;
	}

	const aTrim = a.trim();
	const bTrim = b.trim();
	return levenshteinDistance(aTrim, bTrim) / bTrim.length < 0.1;
}

/**
 * Filters a LineStream, stopping when a line similar to the provided one is encountered.
 *
 * This generator function processes the input stream, yielding lines until it encounters:
 * 1. An exact match to the provided line.
 * 2. A line that is considered repeated or very similar to the provided line.
 * 3. For lines ending with brackets, it allows exact matches of trimmed content.
 * When any of these conditions are met, it calls the fullStop function and stops yielding.
 */
export async function* stopAtSimilarLine(
	stream: LineStream,
	line: string,
	fullStop: () => void,
): AsyncGenerator<string> {
	const trimmedLine = line.trim();
	const lineIsBracketEnding = isBracketEnding(trimmedLine);

	for await (const nextLine of stream) {
		if (trimmedLine === '') {
			yield nextLine;
			continue;
		}

		if (lineIsBracketEnding && trimmedLine.trim() === nextLine.trim()) {
			yield nextLine;
			continue;
		}

		if (nextLine === line) {
			fullStop();
			break;
		}

		if (lineIsRepeated(nextLine, trimmedLine)) {
			fullStop();
			break;
		}

		yield nextLine;
	}
}

/**
 * Filters a LineStream, stopping when a line contains any of the specified stop phrases.
 */
export async function* stopAtLines(
	stream: LineStream,
	fullStop: () => void,
	linesToStopAt: string[] = LINES_TO_STOP_AT,
): LineStream {
	for await (const line of stream) {
		let shouldStop = false;

		// Check each stop phrase
		for (const stopAt of linesToStopAt) {
			if (line.includes(stopAt)) {
				const validation = validatePatternInLine(line, stopAt);

				if (!validation.isValid) {
					continue;
				}

				// Get the trimmed line to check if stop phrase is at logical start
				const trimmedLine = line.trimStart();

				if (trimmedLine.startsWith(stopAt)) {
					// Stop phrase is at the logical start (after whitespace only) - should stop
					shouldStop = true;
					break;
				} else {
					// Stop phrase appears after some content - check if it's separated by whitespace
					const contentBeforeStopPhrase = validation.beforePattern.trimEnd();
					if (contentBeforeStopPhrase.length < validation.beforePattern.length) {
						// There's whitespace before the stop phrase, so it's properly separated
						shouldStop = true;
						break;
					}
					// If no whitespace separation, it's part of larger text, so continue
				}
			}
		}

		if (shouldStop) {
			fullStop();
			break;
		}
		yield line;
	}
}

/**
 * Filters a LineStream, stopping when a line exactly matches one of the given lines.
 */
export async function* stopAtLinesExact(
	stream: LineStream,
	fullStop: () => void,
	linesToStopAt: string[],
): LineStream {
	for await (const line of stream) {
		if (linesToStopAt.some((stopAt) => line === stopAt)) {
			fullStop();
			break;
		}
		yield line;
	}
}

/**
 * Filters a LineStream, skipping specified prefixes on the first line.
 */
export async function* skipPrefixes(lines: LineStream): LineStream {
	let isFirstLine = true;
	for await (const line of lines) {
		if (isFirstLine) {
			const match = PREFIXES_TO_SKIP.find((prefix) => line.startsWith(prefix));
			if (match) {
				yield line.slice(match.length);
				continue;
			}
			isFirstLine = false;
		}
		yield line;
	}
}

/**
 * Filters a LineStream, stopping when a line repeats more than a specified number of times.
 *
 * This function yields lines from the input stream until a line is repeated
 * for a maximum of 3 consecutive times. When this limit is reached, it calls
 * the fullStop function and stops yielding. Only the first of the repeating
 * lines is yieled.
 */
export async function* stopAtRepeatingLines(
	lines: LineStream,
	fullStop: () => void,
): LineStream {
	let previousLine: string | undefined;
	let repeatCount = 0;
	const MAX_REPEATS = 3;

	for await (const line of lines) {
		if (line === previousLine) {
			repeatCount++;
			if (repeatCount === MAX_REPEATS) {
				fullStop();
				return;
			}
		} else {
			yield line;
			repeatCount = 1;
		}
		previousLine = line;
	}
}

/**
 * Yields lines until the first non-whitespace line has been yielded and the stream has
 * been running for more than `ms` milliseconds, then stops so the user sees a partial
 * completion instead of waiting on a slow model.
 */
export async function* showWhateverWeHaveAtXMs(lines: LineStream, ms: number): LineStream {
	const startTime = Date.now();
	let firstNonWhitespaceLineYielded = false;

	for await (const line of lines) {
		yield line;

		if (!firstNonWhitespaceLineYielded && line.trim() !== '') {
			firstNonWhitespaceLineYielded = true;
		}

		const isTakingTooLong = Date.now() - startTime > ms;
		if (isTakingTooLong && firstNonWhitespaceLineYielded) {
			break;
		}
	}
}

/**
 * Stops the stream at the first empty line after content (i.e. no double newlines).
 */
export async function* noDoubleNewLine(lines: LineStream): LineStream {
	let isFirstLine = true;

	for await (const line of lines) {
		if (line.trim() === '' && !isFirstLine) {
			return;
		}

		isFirstLine = false;

		yield line;
	}
}

// ---------------------------------------------------------------------------------------
// Markdown fence handling (Continue filterCodeBlock.ts + markdownUtils.ts +
// streamMarkdownUtils.ts, inlined)
// ---------------------------------------------------------------------------------------

/**
 * Determines if a code block header indicates markdown content.
 */
function headerIsMarkdown(header: string): boolean {
	return (
		header === 'md' ||
		header === 'markdown' ||
		header === 'gfm' ||
		header === 'github-markdown' ||
		header.includes(' md') ||
		header.includes(' markdown') ||
		header.includes(' gfm') ||
		header.includes(' github-markdown') ||
		header.split(' ')[0]?.split('.').pop() === 'md' ||
		header.split(' ')[0]?.split('.').pop() === 'markdown' ||
		header.split(' ')[0]?.split('.').pop() === 'gfm'
	);
}

/**
 * Determines if a file is a markdown file based on its filepath.
 */
function isMarkdownFile(filepath?: string): boolean {
	if (!filepath) {
		return false;
	}

	const ext = filepath.split('.').pop()?.toLowerCase() || '';
	return ['md', 'markdown', 'gfm'].includes(ext);
}

/**
 * Determines if the code block has nested markdown blocks.
 */
export function hasNestedMarkdownBlocks(firstLine: string, filepath?: string): boolean {
	return (
		(firstLine.startsWith('```') && headerIsMarkdown(firstLine.replace(/`/g, ''))) ||
		Boolean(filepath && isMarkdownFile(filepath))
	);
}

function shouldRemoveLineBeforeStart(line: string): boolean {
	return (
		line.trimStart().startsWith('```') ||
		LINES_TO_REMOVE_BEFORE_START.some((l) => line.trim() === l)
	);
}

/**
 * Processes block nesting logic and returns updated state.
 */
function processBlockNesting(
	line: string,
	seenFirstFence: boolean,
): { newSeenFirstFence: boolean; shouldSkip: boolean } {
	if (!seenFirstFence && shouldRemoveLineBeforeStart(line)) {
		return { newSeenFirstFence: false, shouldSkip: true };
	}

	if (!seenFirstFence) {
		return { newSeenFirstFence: true, shouldSkip: false };
	}

	return { newSeenFirstFence: seenFirstFence, shouldSkip: false };
}

/**
 * State tracker for markdown block analysis to avoid recomputing on each call.
 * Optimized to handle nested markdown code blocks.
 */
class MarkdownBlockStateTracker {
	private trimmedLines: string[];
	private bareBacktickPositions: number[];
	private markdownNestCount: number = 0;
	private lastProcessedIndex: number = -1;

	constructor(allLines: string[]) {
		this.trimmedLines = allLines.map((l) => l.trim());
		// Pre-compute positions of all bare backtick lines for faster lookup
		this.bareBacktickPositions = [];
		for (let i = 0; i < this.trimmedLines.length; i++) {
			if (this.trimmedLines[i].match(/^`+$/)) {
				this.bareBacktickPositions.push(i);
			}
		}
	}

	/**
	 * Determines if we should stop at the given markdown block position.
	 * Maintains state across calls to avoid redundant computation.
	 */
	shouldStopAtPosition(currentIndex: number): boolean {
		if (this.trimmedLines[currentIndex] !== '```') {
			return false;
		}

		// Process any lines we haven't seen yet up to currentIndex
		for (let j = this.lastProcessedIndex + 1; j <= currentIndex; j++) {
			const currentLine = this.trimmedLines[j];

			if (this.markdownNestCount > 0) {
				// Inside a markdown block
				if (currentLine.match(/^`+$/)) {
					// Found bare backticks - check if this is the last one
					if (j === currentIndex) {
						const remainingBareBackticks = this.getRemainingBareBackticksAfter(j);
						if (remainingBareBackticks === 0) {
							this.markdownNestCount = 0;
							this.lastProcessedIndex = j;
							return true;
						}
					}
				} else if (currentLine.startsWith('```')) {
					// Going into a nested codeblock
					this.markdownNestCount++;
				}
			} else {
				// Not inside a markdown block yet
				if (currentLine.startsWith('```')) {
					const header = currentLine.replace(/`/g, '');
					if (headerIsMarkdown(header)) {
						this.markdownNestCount = 1;
					}
				}
			}
		}

		this.lastProcessedIndex = currentIndex;
		return false;
	}

	/**
	 * Efficiently determines if there are remaining bare backticks after the given position.
	 */
	private getRemainingBareBackticksAfter(currentIndex: number): number {
		return this.bareBacktickPositions.filter((pos) => pos > currentIndex).length;
	}
}

/**
 * Collects all lines from a LineStream into an array for analysis.
 */
async function collectAllLines(stream: LineStream): Promise<string[]> {
	const allLines: string[] = [];
	for await (const line of stream) {
		allLines.push(line);
	}
	return allLines;
}

/**
 * Filters and processes lines from a code block, removing unnecessary markers and handling
 * edge cases. Includes markdown-aware processing to handle nested markdown blocks properly.
 *
 * 1. Removes initial lines that should be removed before the actual code starts.
 * 2. For markdown files, applies nested markdown block logic to avoid premature termination.
 * 3. For mixed content, uses simplified processing to avoid premature termination.
 * 4. For traditional code blocks, uses original logic.
 * 5. Yields processed lines that are part of the actual code block content.
 */
export async function* filterCodeBlockLines(rawLines: LineStream, filepath?: string): LineStream {
	// Collect all lines for analysis
	const allLines = await collectAllLines(rawLines);

	// Check if it has nested markdown blocks (like ```markdown or ```md)
	const firstLine = allLines[0] || '';
	const hasNestedMarkdown = hasNestedMarkdownBlocks(firstLine, filepath);

	// TARGETED FIX: Detect if this is mixed content (markdown headers + code blocks)
	// But exclude cases where we have nested markdown blocks
	const hasMarkdownHeaders = allLines.some(
		(line) => line.trim().startsWith('#') && !line.trim().startsWith('```'),
	);

	const hasCodeBlocks = allLines.some(
		(line) => line.trim().startsWith('```') && line.trim().length >= 3,
	);
	const isMixedContent = hasMarkdownHeaders && hasCodeBlocks && !hasNestedMarkdown;

	// If this is mixed content, use simplified processing
	if (isMixedContent) {
		for (let i = 0; i < allLines.length; i++) {
			const line = allLines[i];

			// Skip initial wrapper lines if they exist
			if (i === 0 && shouldRemoveLineBeforeStart(line)) {
				continue;
			}

			yield line;
		}
		return;
	}

	// Original logic for non-mixed content
	let seenFirstFence = false;
	let nestCount = 0;

	// Create optimized state tracker for markdown block analysis if needed
	let markdownStateTracker: MarkdownBlockStateTracker | undefined;
	if (hasNestedMarkdown) {
		markdownStateTracker = new MarkdownBlockStateTracker(allLines);
	}

	for (let i = 0; i < allLines.length; i++) {
		const line = allLines[i];

		// Process block nesting logic for the first fence
		const nesting = processBlockNesting(line, seenFirstFence);
		if (nesting.shouldSkip) {
			continue; // Filter out starting ``` or START block
		}
		if (!seenFirstFence && nesting.newSeenFirstFence) {
			seenFirstFence = true;
			nestCount = 1;
		}

		if (nestCount > 0) {
			// Inside a block including the outer block
			const changedEndLine = shouldChangeLineAndStop(line);
			if (typeof changedEndLine === 'string') {
				// Ending a block with just backticks (```) or STOP

				// For markdown files with nested markdown blocks, apply special logic
				if (hasNestedMarkdown && line.trim() === '```' && markdownStateTracker) {
					if (markdownStateTracker.shouldStopAtPosition(i)) {
						return; // Stop without yielding the final closing ```
					} else {
						// This is an inner block delimiter, yield it as content
						yield line;
						continue;
					}
				}

				// Original logic for non-markdown files or simple cases
				nestCount--;
				if (nestCount === 0) {
					// We've closed the outer wrapper - stop without yielding the closing ```
					return;
				} else {
					// This is a nested block closing, yield it as content
					yield line;
				}
			} else if (line.startsWith('```')) {
				// Going into a nested codeblock
				nestCount++;
				yield line;
			} else {
				// Otherwise just yield the line as content
				yield line;
			}
		}
	}
}
