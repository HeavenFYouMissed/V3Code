/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { sha256 } from '../semanticIndex/hashing.js';

export type SessionAnchorKind = 'plan' | 'note' | 'editorial' | 'snapshot';
export type SessionTransitionKind = 'replacement' | 'multi-root-attach';

/** Canonical work-scoped state. The row lives in the existing per-profile global
 * memory database; workspace stores and files are compatibility projections only. */
export interface SessionAnchor {
	anchorId: string;
	profileId: string;
	threadId: string;
	originWorkspaceId: string;
	originRoot: string;
	kind: SessionAnchorKind;
	relativePath?: string;
	symbol?: string;
	revision: number;
	updateIdentity: string;
	payload: unknown;
	updatedAt: number;
	deletedAt?: number;
}

export type SessionAnchorInput = Omit<SessionAnchor, 'revision'> & { revision?: number };

export interface SessionWorkspaceTransition {
	id: string;
	profileId: string;
	threadId: string;
	kind: SessionTransitionKind;
	fromWorkspaceId: string;
	fromRoot: string;
	toWorkspaceId: string;
	toRoot: string;
	createdAt: number;
}

/** Write-ahead record for a workspace swap that has been REQUESTED but not yet
 * observed. Persisted in the per-profile global DB at begin time, because the first
 * swap of a session takes the createAndEnterWorkspace branch, which reloads the
 * window — an in-renderer pending field dies with the renderer and the transition
 * was never recorded, which is exactly how thread memory lost its trail. */
export interface PendingSessionTransition {
	token: string;
	profileId: string;
	threadId: string;
	kind: SessionTransitionKind;
	targetRoot: string;
	fromWorkspaceId: string;
	fromRoot: string;
	createdAt: number;
}

/** A pending transition completes only when the live workspace matches what the swap
 * asked for — a replacement must end as exactly that single root; an attach just needs
 * the root present. Pure so the reload-reconcile path is headless-testable. */
export function transitionShapeMatches(kind: SessionTransitionKind, targetRoot: string, roots: readonly string[]): boolean {
	const targetAttached = roots.includes(targetRoot);
	return kind === 'replacement' ? roots.length === 1 && targetAttached : targetAttached;
}

/** A write-ahead pending may COMPLETE only while fresh. The swap reload takes seconds
 * (minutes after a crash); beyond that, a shape-matching workspace is far more likely a
 * later unrelated open of the same folder — completing then would record a transition
 * for a swap that never finished, which recovery would wrongly trust. A stale pending
 * falls back to the explicit, user-confirmed recover_session_anchors path (the safer
 * failure). The 7-day row TTL is CLEANUP, not a completion window. */
export const PENDING_TRANSITION_COMPLETION_WINDOW_MS = 15 * 60 * 1000;

export function isPendingTransitionFresh(createdAt: number, now: number): boolean {
	return now - createdAt <= PENDING_TRANSITION_COMPLETION_WINDOW_MS;
}

/** One-line manifest of what a workspace swap carried — and what it never carries.
 * Every memory operation should report its manifest: a swap that carries four topics
 * and silently leaves three behind makes the agent guess what it knows. */
export function describeCarriedContinuity(summary: Pick<SessionContinuitySummary, 'carried' | 'origins' | 'status'>): string {
	const { notes, editorial, planItems, snapshots } = summary.carried;
	const total = notes + editorial + planItems + snapshots;
	const from = summary.origins.length > 0 ? ` from ${summary.origins.join(', ')}` : '';
	const carriedText = total === 0
		? `No thread memory carried${from} (this thread had recorded nothing carryable).`
		: `Thread memory carried${from}: ${notes} symbol note(s), ${editorial} editorial topic(s), ${planItems} plan item(s), ${snapshots} snapshot(s).`;
	return `${carriedText} Workspace-level auto-topics (roadmap, hot-files, quirks, decisions, symbols) and chat history are per-workspace and stayed behind — recover_session_anchors can import an origin explicitly if something is missing.`;
}

export interface SessionContinuitySummary {
	threadId: string;
	currentWorkspaceId: string;
	currentRoot: string;
	origins: string[];
	carried: { notes: number; editorial: number; planItems: number; snapshots: number };
	anchors: SessionAnchor[];
	status: 'none' | 'available' | 'rehydrated';
}

export interface ActivePlanPayload {
	threadId: string;
	taskId: string | null;
	updatedAt: number;
	todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>;
}

export function stableAnchorId(kind: SessionAnchorKind, threadId: string, sourceId: string): string {
	return `sa:${kind}:${sha256(`${threadId}:${sourceId}`).slice(0, 40)}`;
}

export function sessionAnchorUpdateIdentity(payload: unknown, deletedAt?: number): string {
	return sha256(JSON.stringify({ payload, deletedAt: deletedAt ?? null }));
}

export function transitionId(input: Omit<SessionWorkspaceTransition, 'id'>): string {
	return `sat:${sha256(`${input.profileId}:${input.threadId}:${input.kind}:${input.fromWorkspaceId}:${input.toWorkspaceId}:${input.createdAt}`).slice(0, 40)}`;
}

/** Deterministic union rule used for current-workspace projections plus canonical
 * anchors. A tombstone wins over an older live row and prevents resurrection. */
export function dedupeSessionAnchors(anchors: readonly SessionAnchor[], includeDeleted = false): SessionAnchor[] {
	const byId = new Map<string, SessionAnchor>();
	for (const anchor of anchors) {
		const current = byId.get(anchor.anchorId);
		if (!current
			|| anchor.revision > current.revision
			|| (anchor.revision === current.revision && anchor.updatedAt > current.updatedAt)
			|| (anchor.revision === current.revision && anchor.updatedAt === current.updatedAt && anchor.updateIdentity > current.updateIdentity)) {
			byId.set(anchor.anchorId, anchor);
		}
	}
	return [...byId.values()]
		.filter(anchor => includeDeleted || anchor.deletedAt === undefined)
		.sort((a, b) => b.updatedAt - a.updatedAt || a.anchorId.localeCompare(b.anchorId));
}

export function isActivePlanPayload(value: unknown): value is ActivePlanPayload {
	if (!value || typeof value !== 'object') { return false; }
	const candidate = value as Partial<ActivePlanPayload>;
	return typeof candidate.threadId === 'string'
		&& (candidate.taskId === null || typeof candidate.taskId === 'string')
		&& typeof candidate.updatedAt === 'number'
		&& Array.isArray(candidate.todos);
}

export function summarizeSessionContinuity(
	threadId: string,
	currentWorkspaceId: string,
	currentRoot: string,
	anchors: readonly SessionAnchor[],
): SessionContinuitySummary {
	const live = dedupeSessionAnchors(anchors);
	const carried = live.filter(anchor => anchor.originWorkspaceId !== currentWorkspaceId);
	const plan = carried.find(anchor => anchor.kind === 'plan' && isActivePlanPayload(anchor.payload));
	return {
		threadId,
		currentWorkspaceId,
		currentRoot,
		origins: [...new Set(carried.map(anchor => anchor.originRoot).filter(Boolean))].sort(),
		carried: {
			notes: carried.filter(anchor => anchor.kind === 'note').length,
			editorial: carried.filter(anchor => anchor.kind === 'editorial').length,
			planItems: plan && isActivePlanPayload(plan.payload) ? plan.payload.todos.length : 0,
			snapshots: carried.filter(anchor => anchor.kind === 'snapshot').length,
		},
		anchors: live,
		status: carried.length ? 'available' : 'none',
	};
}

export function formatSessionContinuity(summary: SessionContinuitySummary): string {
	if (summary.status === 'none') { return ''; }
	const origin = summary.origins.join(', ') || '(recorded workspace)';
	return [
		'## Session continuity',
		'Active session has anchors from another workspace.',
		`origin: ${origin}`,
		`carried: ${summary.carried.notes} notes, ${summary.carried.editorial} editorial, plan (${summary.carried.planItems} items), ${summary.carried.snapshots} snapshots`,
		`status: ${summary.status}`,
	].join('\n');
}

/** A destination plan owned by another thread is never a writable projection target.
 * The canonical plan remains readable in-memory without touching that file. */
export function mayWritePlanProjection(existingThreadId: string | undefined, activeThreadId: string): boolean {
	return !existingThreadId || existingThreadId === activeThreadId;
}

/** Workspace-relative symbol paths are portable. Absolute paths are retained as
 * unresolved metadata and are never silently rebased into a new root. */
export function isPortableRelativePath(path: string | undefined): boolean {
	if (!path || path.includes('\0')) { return false; }
	return !path.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(path) && !path.split(/[\\/]+/).includes('..');
}

/** Recovery never broad-scans. A recorded thread transition is sufficient for its
 * exact origin; any other explicit origin needs a confirmed repair action. */
export function mayRecoverSessionOrigin(originRoot: string, recordedRoots: ReadonlySet<string>, confirmed: boolean): boolean {
	return recordedRoots.has(originRoot) || confirmed;
}

/** Legacy notes/editorial predate thread ownership and cannot be attributed by
 * inference. Only an explicitly confirmed recovery may claim them for a thread. */
export function mayAttributeLegacyThreadlessMemory(confirmed: boolean): boolean {
	return confirmed;
}
