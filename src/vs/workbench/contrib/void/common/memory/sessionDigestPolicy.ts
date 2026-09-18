/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Automatic compaction is durable-before-drop: a history prefix may leave the live wire only
 * after a checkpoint covering that exact prefix (or a longer one) is known to exist. These pure
 * helpers keep the boundary arithmetic testable without constructing the editor services.
 */

/** Avoid writing a fresh checkpoint for every single message appended to a long-running thread. */
export const SESSION_DIGEST_MIN_ADVANCE = 3;

export type WorkspaceHistoryBoundaryState = Readonly<{
	workspaceIdentity: string;
	messageCount: number;
}>;

export type WorkspaceHistoryBoundaryObservation = Readonly<{
	workspaceIdentity: string;
	totalMessageCount: number;
	currentTurnStart: number;
	detectedWorkspaceMutationBoundary: number;
}>;

/**
 * Keep the conversation turn that performed a live project swap, but classify everything before
 * it as previous-workspace history. The same rule also handles a manual workspace change: on the
 * first request after the folder identity changes, the newest user turn remains live.
 *
 * A detected open_project/close_project boundary survives an editor restart because it is derived
 * from the persisted tool transcript. The in-memory identity comparison covers UI-driven swaps.
 */
export function resolveWorkspaceHistoryBoundary(
	previous: WorkspaceHistoryBoundaryState | undefined,
	observation: WorkspaceHistoryBoundaryObservation,
): WorkspaceHistoryBoundaryState {
	const total = Math.max(0, Math.floor(observation.totalMessageCount));
	const detected = Math.max(0, Math.min(total, Math.floor(observation.detectedWorkspaceMutationBoundary)));
	const turnStart = Math.max(0, Math.min(total, Math.floor(observation.currentTurnStart)));
	const priorBoundary = Math.max(0, Math.min(total, Math.floor(previous?.messageCount ?? 0)));
	const changedWorkspace = previous !== undefined && previous.workspaceIdentity !== observation.workspaceIdentity;
	const messageCount = changedWorkspace
		? Math.max(detected, turnStart)
		: Math.max(priorBoundary, detected);
	return { workspaceIdentity: observation.workspaceIdentity, messageCount };
}

/**
 * Return the prefix that is safe to remove now. A previously durable, shorter boundary remains
 * useful while persistence for the newly-grown boundary is in flight; this is what prevents the
 * old moving-boundary chase from retaining the entire transcript forever.
 */
export function acceptedSessionDigestDropCount(requestedDroppedCount: number, durableDroppedCount: number | undefined): number {
	if (!Number.isFinite(requestedDroppedCount) || requestedDroppedCount <= 0) { return 0; }
	if (!Number.isFinite(durableDroppedCount) || durableDroppedCount === undefined || durableDroppedCount <= 0) { return 0; }
	return durableDroppedCount <= requestedDroppedCount ? Math.floor(durableDroppedCount) : 0;
}

/** Whether this observed boundary should start a new best-effort durable write. */
export function shouldPersistSessionDigestBoundary(input: {
	requestedDroppedCount: number;
	durableDroppedCount: number | undefined;
	exactBoundaryPending: boolean;
	exactBoundaryDurable: boolean;
	minAdvance?: number;
}): boolean {
	const requested = Math.floor(input.requestedDroppedCount);
	if (!Number.isFinite(requested) || requested <= 0 || input.exactBoundaryPending || input.exactBoundaryDurable) { return false; }
	const durable = input.durableDroppedCount;
	if (durable !== undefined && requested - durable < (input.minAdvance ?? SESSION_DIGEST_MIN_ADVANCE)) { return false; }
	return true;
}

/** Choose the digest to surface: MONOTONIC by covered boundary (meta.droppedCount), never
 *  by write/completion timestamp — a stale LLM fold that finishes late with a smaller
 *  covered boundary must never regress the digest. Within the same boundary the LLM fold
 *  (meta.llm === true) beats the heuristic fact sheet. */
export function rankMonotonicDigests<T extends { meta?: Record<string, unknown> | undefined }>(digests: readonly T[]): T[] {
	return [...digests].sort((a, b) => {
		const droppedA = Number(a.meta?.['droppedCount']) || 0;
		const droppedB = Number(b.meta?.['droppedCount']) || 0;
		if (droppedB !== droppedA) { return droppedB - droppedA; }
		const llmA = a.meta?.['llm'] === true ? 1 : 0;
		const llmB = b.meta?.['llm'] === true ? 1 : 0;
		return llmB - llmA;
	});
}

export function selectMonotonicDigest<T extends { meta?: Record<string, unknown> | undefined }>(digests: readonly T[]): T | undefined {
	return rankMonotonicDigests(digests)[0];
}

/** Walk ranked digests and keep the first whose checkpoint is valid. An invalid LLM
 *  fold must not blank a valid older heuristic — it is skipped, not treated as empty. */
export function selectValidMonotonicDigest<T extends { meta?: Record<string, unknown> | undefined }>(
	digests: readonly T[],
	isValid: (digest: T) => boolean,
): T | undefined {
	return rankMonotonicDigests(digests).find(isValid);
}

/** A persisted boundary note may only be APPLIED (restored onto the wire / allowed to
 *  authorize drops) when its complete checkpoint exists and it was not aborted. A note
 *  alone is an aborted or legacy write — never a boundary. */
export function boundaryNoteApplicable(input: { aborted: boolean; hasCheckpoint: boolean }): boolean {
	return !input.aborted && input.hasCheckpoint;
}

export type WorkspaceTransitionStamp = {
	tool: 'open_project' | 'close_project';
	changed?: boolean;
	removed?: boolean;
};

/** Explicit structured event appended to the prose `stringOfResult`. Never parse the
 *  human-readable UI sentence as workspace state. */
export function formatWorkspaceTransitionStamp(stamp: WorkspaceTransitionStamp): string {
	return `\n<workspace_transition>${JSON.stringify(stamp)}</workspace_transition>`;
}

/** Recover the workspace-mutation outcome from the stamped event only. Prose and
 *  coincidental JSON fragments are ignored. */
export function workspaceMutationResultFromToolContent(toolName: string, content: string): { changed?: boolean; removed?: boolean } | null {
	if (toolName !== 'open_project' && toolName !== 'close_project') { return null; }
	const tagged = /<workspace_transition>([\s\S]*?)<\/workspace_transition>/.exec(content);
	if (!tagged) { return null; }
	try {
		const parsed: unknown = JSON.parse(tagged[1]);
		if (!parsed || typeof parsed !== 'object') { return null; }
		const record = parsed as Record<string, unknown>;
		if (record['tool'] !== toolName) { return null; }
		return {
			...(typeof record['changed'] === 'boolean' ? { changed: record['changed'] } : {}),
			...(typeof record['removed'] === 'boolean' ? { removed: record['removed'] } : {}),
		};
	} catch {
		return null;
	}
}
