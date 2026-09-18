/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Pure hunk-quality gates for Turbo Draft (eval harness + runtime).
 * Keep this DI-free so mocha node tests can run it headless.
 */

import { ExtractedSearchReplaceBlock, extractSearchReplaceBlocks } from './helpers/extractCodeFromResult.js';
import { DIVIDER, FINAL, ORIGINAL } from './prompt/prompts.js';

export type TurboDraftHunkRejectReason =
	| 'no-blocks'
	| 'ambiguous-markers'
	| 'empty-orig-and-final'
	| 'unanchored-insertion'
	| 'not-found'
	| 'not-unique'
	| 'unchanged'
	| 'too-large'
	| 'overlap'
	| 'aggregate-noop'
	| 'partial-reject';

export interface TurboDraftHunkScore {
	index: number;
	orig: string;
	final: string;
	ok: boolean;
	reason?: TurboDraftHunkRejectReason;
	/** Char offset of exact match in file, if unique. */
	matchStart?: number;
}

export interface TurboDraftQualityReport {
	ok: boolean;
	scores: TurboDraftHunkScore[];
	/** Blocks that passed uniqueness / size / unchanged gates, still in order. */
	acceptedBlocks: ExtractedSearchReplaceBlock[];
	/**
	 * Individually valid blocks from a response that was rejected as a whole. Empty unless
	 * the reject reason is 'partial-reject'. These are non-overlapping and each matches the
	 * file uniquely, so they are safe to apply on their own — worth far more than nothing
	 * when the repair attempt then gives up.
	 */
	salvageableBlocks: ExtractedSearchReplaceBlock[];
	rejectSummary: Partial<Record<TurboDraftHunkRejectReason, number>>;
	/** Final file text after applying accepted blocks, when ok. */
	finalText?: string;
}

const DEFAULT_MAX_BLOCK_CHARS = 12_000;

function normalizeLF(s: string): string {
	return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function scoreTurboDraftBlocks(
	fileContents: string,
	blocksStr: string,
	opts?: { maxBlockChars?: number },
): TurboDraftQualityReport {
	const maxBlockChars = opts?.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;
	const source = normalizeLF(fileContents);
	const rejectSummary: Partial<Record<TurboDraftHunkRejectReason, number>> = {};
	const bump = (r: TurboDraftHunkRejectReason) => {
		rejectSummary[r] = (rejectSummary[r] ?? 0) + 1;
	};

	const blocks = extractSearchReplaceBlocks(blocksStr).filter(b => b.state === 'done' || (b.orig.length + b.final.length) > 0);
	if (blocks.length === 0) {
		bump('no-blocks');
		return { ok: false, scores: [], acceptedBlocks: [], salvageableBlocks: [], rejectSummary };
	}

	const originalMarkerCount = blocksStr.split(ORIGINAL).length - 1;
	const dividerMarkerCount = blocksStr.split(DIVIDER).length - 1;
	const finalMarkerCount = blocksStr.split(FINAL).length - 1;
	if (originalMarkerCount !== blocks.length || dividerMarkerCount !== blocks.length || finalMarkerCount !== blocks.length) {
		bump('ambiguous-markers');
		return {
			ok: false,
			scores: blocks.map((b, index) => ({ index, orig: b.orig, final: b.final, ok: false, reason: 'ambiguous-markers' as const })),
			acceptedBlocks: [],
			salvageableBlocks: [],
			rejectSummary,
		};
	}

	const scores: TurboDraftHunkScore[] = [];
	const acceptedBlocks: ExtractedSearchReplaceBlock[] = [];
	const claimedRanges: { start: number; end: number }[] = [];

	for (let index = 0; index < blocks.length; index++) {
		const b = blocks[index];
		const score: TurboDraftHunkScore = { index, orig: b.orig, final: b.final, ok: false };

		if (!b.orig.trim() && !b.final.trim()) {
			score.reason = 'empty-orig-and-final';
			bump(score.reason);
			scores.push(score);
			continue;
		}
		if (!b.orig) {
			score.reason = 'unanchored-insertion';
			bump(score.reason);
			scores.push(score);
			continue;
		}
		if (b.orig === b.final) {
			score.reason = 'unchanged';
			bump(score.reason);
			scores.push(score);
			continue;
		}
		if (b.orig.length > maxBlockChars || b.final.length > maxBlockChars) {
			score.reason = 'too-large';
			bump(score.reason);
			scores.push(score);
			continue;
		}

		const first = source.indexOf(b.orig);
		if (first === -1) {
			score.reason = 'not-found';
			bump(score.reason);
			scores.push(score);
			continue;
		}
		const second = source.indexOf(b.orig, first + 1);
		if (second !== -1) {
			score.reason = 'not-unique';
			bump(score.reason);
			scores.push(score);
			continue;
		}

		const end = first + b.orig.length;
		const overlaps = claimedRanges.some(r => !(end <= r.start || first >= r.end));
		if (overlaps) {
			score.reason = 'overlap';
			bump(score.reason);
			scores.push(score);
			continue;
		}

		claimedRanges.push({ start: first, end });
		score.ok = true;
		score.matchStart = first;
		acceptedBlocks.push(b);
		scores.push(score);
	}

	// All-or-nothing: any rejected block invalidates the whole response. acceptedBlocks stays
	// empty so no caller can apply half a draft by accident, but the good blocks are handed
	// back separately as a last resort for when the repair attempt also fails.
	if (acceptedBlocks.length !== blocks.length) {
		bump('partial-reject');
		return { ok: false, scores, acceptedBlocks: [], salvageableBlocks: acceptedBlocks, rejectSummary };
	}

	// Apply accepted blocks in reverse match order so earlier offsets stay valid.
	const ordered = [...scores]
		.filter(s => s.ok && s.matchStart !== undefined)
		.sort((a, b) => (b.matchStart ?? 0) - (a.matchStart ?? 0));
	let finalText = source;
	for (const s of ordered) {
		const start = s.matchStart!;
		finalText = finalText.slice(0, start) + s.final + finalText.slice(start + s.orig.length);
	}
	if (finalText === source) {
		bump('aggregate-noop');
		return { ok: false, scores, acceptedBlocks: [], salvageableBlocks: [], rejectSummary };
	}

	return {
		ok: true,
		scores,
		acceptedBlocks,
		salvageableBlocks: [],
		rejectSummary,
		finalText,
	};
}

/** Re-serialize accepted blocks into a marker string for applySearchReplaceBlocksToString. */
export function serializeTurboDraftBlocks(blocks: ExtractedSearchReplaceBlock[]): string {
	return blocks.map(b => `${ORIGINAL}\n${b.orig}\n${DIVIDER}\n${b.final}\n${FINAL}`).join('\n\n');
}
