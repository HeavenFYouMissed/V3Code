/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Pure Turbo Draft run-state helpers (headless / unit-testable).
 * Stages advance only via real checkpoints — never fake timers.
 */

export type TurboDraftPhase =
	| 'idle'
	| 'reading'
	| 'recognizing'
	| 'findingRelated'
	| 'organizing'
	| 'restructuring'
	| 'validating'
	| 'repairing'
	| 'creatingTabs'
	| 'ready'
	| 'verifying'
	| 'autoFixing'
	| 'completed'
	| 'noChanges'
	| 'sourceChanged'
	| 'cancelled'
	| 'error';

export type TurboDraftTerminalPhase =
	| 'ready'
	| 'completed'
	| 'noChanges'
	| 'sourceChanged'
	| 'cancelled'
	| 'error';

/** Ordered progress stages shown in the dock (excludes idle/terminals except ready). */
export const TURBO_DRAFT_PROGRESS_STAGES: TurboDraftPhase[] = [
	'reading',
	'recognizing',
	'findingRelated',
	'organizing',
	'restructuring',
	'validating',
	'repairing',
	'creatingTabs',
	'ready',
	// Post-review stages. Only reached after the developer resolves the hunks, and the dock
	// hides them unless they were actually entered.
	'verifying',
	'autoFixing',
];

const TERMINAL: ReadonlySet<TurboDraftPhase> = new Set([
	'ready',
	'completed',
	'noChanges',
	'sourceChanged',
	'cancelled',
	'error',
]);

const STAGE_RANK: ReadonlyMap<TurboDraftPhase, number> = new Map(
	TURBO_DRAFT_PROGRESS_STAGES.map((p, i) => [p, i]),
);

export function isTurboDraftTerminalPhase(phase: TurboDraftPhase): phase is TurboDraftTerminalPhase {
	return TERMINAL.has(phase);
}

export function isTurboDraftBusyPhase(phase: TurboDraftPhase): boolean {
	return phase !== 'idle' && !isTurboDraftTerminalPhase(phase);
}

/**
 * Legal monotonic advance: progress stages may only move forward; terminals are sticky
 * except ready → completed / cancelled / error / sourceChanged.
 */
export function canTransitionTurboDraftPhase(from: TurboDraftPhase, to: TurboDraftPhase): boolean {
	if (from === to) { return true; }
	if (from === 'idle') {
		return to === 'reading' || to === 'cancelled' || to === 'error';
	}
	if (from === 'ready') {
		// Verification runs after review, so 'ready' is no longer strictly terminal.
		return to === 'verifying' || to === 'completed' || to === 'cancelled' || to === 'error' || to === 'sourceChanged';
	}
	if (isTurboDraftTerminalPhase(from)) {
		return false;
	}
	if (isTurboDraftTerminalPhase(to)) {
		return true;
	}
	// One repair pass may re-enter validating after repairing.
	if (from === 'repairing' && to === 'validating') {
		return true;
	}
	const fromRank = STAGE_RANK.get(from);
	const toRank = STAGE_RANK.get(to);
	if (fromRank === undefined || toRank === undefined) { return false; }
	return toRank >= fromRank;
}

export interface TurboDraftStageDetail {
	fileLines?: number;
	acceptedEditCount?: number;
	chatTurnCount?: number;
	relatedSnippetCount?: number;
	relatedFileCount?: number;
	/** Live problems the language server reported in the file before drafting. */
	diagnosticCount?: number;
	/** Real signatures pulled for symbols near the cursor. */
	signatureCount?: number;
	/** Errors the applied draft introduced that were not present before it. */
	newErrorCount?: number;
	modelLabel?: string;
	/** Estimated tokens in the system + user prompt actually sent for this attempt. */
	promptTokens?: number;
	streamedChars?: number;
	validHunkCount?: number;
	pendingHunks?: number;
	currentHunkIndex?: number;
	message?: string;
}

export interface TurboDraftStageHistoryEntry {
	phase: TurboDraftPhase;
	at: number;
	detail?: string;
}

export function appendStageHistory(
	history: readonly TurboDraftStageHistoryEntry[],
	phase: TurboDraftPhase,
	at: number,
	detail?: string,
): TurboDraftStageHistoryEntry[] {
	const last = history[history.length - 1];
	if (last?.phase === phase) {
		return history.map((e, i) => i === history.length - 1 ? { ...e, at, detail: detail ?? e.detail } : e);
	}
	return [...history, { phase, at, detail }];
}
