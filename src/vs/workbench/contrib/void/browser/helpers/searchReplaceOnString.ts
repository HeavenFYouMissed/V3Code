/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ExtractedSearchReplaceBlock, extractSearchReplaceBlocks } from '../../common/helpers/extractCodeFromResult.js';
import { ORIGINAL, DIVIDER, FINAL } from '../../common/prompt/prompts.js';

const numLinesOfStr = (str: string) => str.split('\n').length;

const removeWhitespaceExceptNewlines = (str: string): string => {
	return str.replace(/[^\S\n]+/g, '');
};

const findTextInCode = (
	text: string,
	fileContents: string,
	canFallbackToRemoveWhitespace: boolean,
	opts: { startingAtLine?: number; returnType: 'lines' },
): readonly [number, number] | 'Not found' | 'Not unique' => {
	const returnAns = (contents: string, idx: number) => {
		const startLine = numLinesOfStr(contents.substring(0, idx + 1));
		const numLines = numLinesOfStr(text);
		const endLine = startLine + numLines - 1;
		return [startLine, endLine] as const;
	};

	const startingAtLineIdx = (contents: string) => opts?.startingAtLine !== undefined
		? contents.split('\n').slice(0, opts.startingAtLine).join('\n').length
		: 0;

	let idx = fileContents.indexOf(text, startingAtLineIdx(fileContents));
	if (idx !== -1) {
		return returnAns(fileContents, idx);
	}

	if (!canFallbackToRemoveWhitespace) {
		return 'Not found';
	}

	text = removeWhitespaceExceptNewlines(text);
	fileContents = removeWhitespaceExceptNewlines(fileContents);
	idx = fileContents.indexOf(text, startingAtLineIdx(fileContents));
	if (idx === -1) return 'Not found';
	const lastIdx = fileContents.lastIndexOf(text);
	if (lastIdx !== idx) return 'Not unique';
	return returnAns(fileContents, idx);
};

/** Apply search/replace blocks to a string without touching a live model (shadow staging). */
export function applySearchReplaceBlocksToString(modelStr: string, blocksStr: string): string {
	const blocks = extractSearchReplaceBlocks(blocksStr);
	if (blocks.length === 0) {
		throw new Error('No Search/Replace blocks were received!');
	}

	// Ambiguous-parse guard: if the edited CONTENT itself contains the block markers (a line of
	// `=======`, `<<<<<<< ORIGINAL`, or `>>>>>>> UPDATED` — common when editing docs that quote
	// the search/replace syntax), the parser mis-splits and silently produces truncated blocks
	// that still "match" the file, corrupting it while reporting success. A well-formed request
	// has exactly one ORIGINAL, one DIVIDER, and one UPDATED marker per parsed block; if ANY of the
	// three counts disagree the parse is ambiguous — refuse rather than apply a partial parse.
	// The DIVIDER (`=======`) is the CRITICAL one: a stray divider in content leaves the ORIGINAL/
	// UPDATED counts intact (so counting only those — the original H-2 fix — missed it) while the
	// parser splits the block at the wrong `=======`. This is exactly the reopened H-2/R-1 case.
	const originalMarkerCount = blocksStr.split(ORIGINAL).length - 1;
	const dividerMarkerCount = blocksStr.split(DIVIDER).length - 1;
	const finalMarkerCount = blocksStr.split(FINAL).length - 1;
	if (originalMarkerCount !== blocks.length || dividerMarkerCount !== blocks.length || finalMarkerCount !== blocks.length) {
		throw new Error(`edit_file parse is ambiguous: found ${originalMarkerCount} ORIGINAL / ${dividerMarkerCount} DIVIDER (=======) / ${finalMarkerCount} UPDATED markers but ${blocks.length} block(s) parsed — the content you're editing likely contains a block marker itself (most often a bare "=======" line). This edit was NOT applied (refusing to risk corrupting the file). Use rewrite_file for this change, or target a region that doesn't contain those marker lines.`);
	}

	const modelStrLines = modelStr.split('\n');
	const replacements: { origStart: number; origEnd: number; block: ExtractedSearchReplaceBlock }[] = [];

	for (const b of blocks) {
		// Exact-offset fast path: replace precisely the matched characters. The previous
		// line-granular path expanded a mid-line exact match to whole-line boundaries,
		// silently deleting everything else on those lines while reporting success —
		// catastrophic on files with very long single lines (e.g. prompt template literals).
		const exactIdx = modelStr.indexOf(b.orig);
		if (exactIdx !== -1) {
			if (modelStr.indexOf(b.orig, exactIdx + 1) !== -1) {
				throw new Error(`Search/Replace block failed (Not unique): the ORIGINAL text appears multiple times in the file — include more surrounding lines to make it unique: ${b.orig.slice(0, 120)}`);
			}
			replacements.push({ origStart: exactIdx, origEnd: exactIdx + b.orig.length - 1, block: b });
			continue;
		}

		// Whitespace-insensitive fallback (line-granular by necessity: char offsets in the
		// stripped string don't map back to the real file).
		const res = findTextInCode(b.orig, modelStr, true, { returnType: 'lines' });
		if (typeof res === 'string') {
			throw new Error(`Search/Replace block failed (${res}): ${b.orig.slice(0, 120)}`);
		}
		let [startLine, endLine] = res;
		startLine -= 1;
		endLine -= 1;

		const origStart = (startLine !== 0
			? modelStrLines.slice(0, startLine).join('\n') + '\n'
			: '').length;
		const origEnd = modelStrLines.slice(0, endLine + 1).join('\n').length - 1;

		// Mid-line guard: replacing these whole lines must remove exactly ORIGINAL (modulo
		// whitespace). If the stripped match started or ended mid-line, line expansion would
		// delete neighboring text ORIGINAL never mentioned — refuse instead of corrupting.
		const spanText = modelStr.slice(origStart, origEnd + 1);
		if (removeWhitespaceExceptNewlines(spanText) !== removeWhitespaceExceptNewlines(b.orig)) {
			throw new Error(`Search/Replace block failed (mid-line match): ORIGINAL matches only PART of a line, so applying it would destroy the rest of that line. Include the full line(s) in ORIGINAL and retry. Problematic ORIGINAL: ${b.orig.slice(0, 120)}`);
		}
		replacements.push({ origStart, origEnd, block: b });
	}

	replacements.sort((a, b) => a.origStart - b.origStart);
	for (let i = 1; i < replacements.length; i++) {
		if (replacements[i].origStart <= replacements[i - 1].origEnd) {
			throw new Error('Search/Replace blocks overlap.');
		}
	}

	let newCode = modelStr;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const { origStart, origEnd, block } = replacements[i];
		newCode = newCode.slice(0, origStart) + block.final + newCode.slice(origEnd + 1);
	}
	return newCode;
}
