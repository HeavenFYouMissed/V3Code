/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { canSubagentDelegate, SUBAGENT_MAX_NESTING_DEPTH } from './toolsServiceTypes.js'

/**
 * Pure admission/coordination decisions for background subagents, kept out of
 * chatThreadService so the policy is headless-testable (there is no DI test harness
 * for the thread service itself).
 */

// A parent thread may run at most this many background children at once.
export const MAX_BACKGROUND_SUBAGENTS_PER_PARENT = 3

// Hard ceiling across the whole window, so nested fan-out (3 per parent × depth 2)
// cannot silently multiply into a swarm of concurrent model streams.
export const MAX_BACKGROUND_SUBAGENTS_TOTAL = 8

/**
 * THE canonical subagent lifecycle vocabulary. Both the browser thread service and the
 * Agents UI import these — do not redeclare a local status/evidence union anywhere else,
 * or the UI and the service will silently disagree about what "done" means.
 */
export type SubagentStatus =
	| 'queued'              // admitted but waiting for a running slot
	| 'running'             // actively executing the agent loop
	| 'waiting-approval'    // paused on a tool that needs user confirmation
	| 'completed'           // finished, with evidence backing the claim
	| 'blocked'             // could not finish: approval denied/timed out, or claimed work it cannot evidence
	| 'failed'              // agent loop threw an error
	| 'cancelled'           // stopped by the user or parent

/** Terminal (finished) states. A terminal worker never re-enters running. */
export function isTerminalSubagentStatus(s: SubagentStatus): boolean {
	return s === 'completed' || s === 'blocked' || s === 'failed' || s === 'cancelled'
}

/** A single file mutation attributed to one worker's own tool call. */
export type SubagentFileTouch = { path: string, tool: string, at: number }

/** A command/test the worker itself ran, with the outcome we could observe. */
export type SubagentCommandRun = { command: string, status: 'pass' | 'fail' | 'unknown', at: number }

/**
 * Evidence accumulated from a worker's OWN tool calls. Never derived from a repository-wide
 * diff: a global diff attributes the user's and sibling workers' edits to whichever worker
 * happened to finish last.
 */
export type SubagentEvidence = {
	/** Files this worker's mutation tools actually wrote to. */
	filesTouched: string[]
	/** Per-file attribution detail (which tool, when). */
	fileTouchDetail: SubagentFileTouch[]
	/** Commands/tests this worker ran. */
	commandsRun: SubagentCommandRun[]
	/** Total successful tool calls this worker made. */
	toolsRun: number
	/** Why the worker blocked or failed, when applicable. */
	blockedReason?: string
}

/** Live activity snapshot — what the worker is doing right now. */
export type SubagentActivity = {
	/** Last tool the worker called (or is waiting on). */
	lastToolName?: string
	/** Epoch ms of that last tool call. */
	lastToolTimestamp?: number
	/** File the worker is currently operating on, when the tool contract names one. */
	currentFile?: string
	/** Bounded progress milestones reported by the worker itself. */
	milestones: string[]
	/** Bounded rolling log of recent tool calls, newest last. */
	recentTools: { tool: string, at: number, file?: string }[]
}

export function emptySubagentEvidence(): SubagentEvidence {
	return { filesTouched: [], fileTouchDetail: [], commandsRun: [], toolsRun: 0 }
}

export function emptySubagentActivity(): SubagentActivity {
	return { milestones: [], recentTools: [] }
}

/** Bound on the rolling per-worker tool log so a long worker cannot bloat state. */
export const MAX_RECENT_TOOLS_PER_WORKER = 25

/** Tools whose successful execution means this worker actually WROTE to a file. */
export const SUBAGENT_FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
	'edit_file', 'rewrite_file', 'append_file', 'create_file_or_folder', 'delete_file_or_folder',
])

/** Tools whose successful execution means this worker ran a shell command. */
export const SUBAGENT_COMMAND_TOOLS: ReadonlySet<string> = new Set([
	'run_command', 'run_persistent_command',
])

/**
 * Fold one observed tool call into a worker's activity + evidence. Pure so the real
 * attribution rules are testable without a DI harness. `succeeded` is false for rejected,
 * errored, or interrupted calls — those update activity but never count as evidence.
 */
export function recordSubagentToolCall(
	prev: { activity: SubagentActivity, evidence: SubagentEvidence },
	call: { tool: string, file?: string, command?: string, commandStatus?: 'pass' | 'fail' | 'unknown', succeeded: boolean, at: number },
): { activity: SubagentActivity, evidence: SubagentEvidence } {
	const recentTools = [...prev.activity.recentTools, { tool: call.tool, at: call.at, ...(call.file ? { file: call.file } : {}) }]
		.slice(-MAX_RECENT_TOOLS_PER_WORKER)
	const activity: SubagentActivity = {
		...prev.activity,
		lastToolName: call.tool,
		lastToolTimestamp: call.at,
		...(call.file ? { currentFile: call.file } : {}),
		recentTools,
	}
	if (!call.succeeded) return { activity, evidence: prev.evidence }

	const evidence: SubagentEvidence = {
		...prev.evidence,
		toolsRun: prev.evidence.toolsRun + 1,
		filesTouched: [...prev.evidence.filesTouched],
		fileTouchDetail: [...prev.evidence.fileTouchDetail],
		commandsRun: [...prev.evidence.commandsRun],
	}
	if (SUBAGENT_FILE_MUTATION_TOOLS.has(call.tool) && call.file) {
		if (!evidence.filesTouched.includes(call.file)) evidence.filesTouched.push(call.file)
		evidence.fileTouchDetail.push({ path: call.file, tool: call.tool, at: call.at })
	}
	if (SUBAGENT_COMMAND_TOOLS.has(call.tool) && call.command) {
		evidence.commandsRun.push({ command: call.command, status: call.commandStatus ?? 'unknown', at: call.at })
	}
	return { activity, evidence }
}

/**
 * Phrases a worker uses when it CLAIMS it changed files. Matched against the worker's own
 * final report to catch the "I updated foo.ts" report from a worker whose tool calls
 * touched nothing.
 */
const CLAIMED_EDIT_RE = /\b(?:i\s+)?(?:edited|updated|modified|rewrote|refactored|patched|fixed|implemented|added|created|removed|deleted|changed|wrote)\b/i

/** Phrases in the TASK that mean the parent asked for file changes. */
const TASK_ASKS_FOR_EDITS_RE = /\b(?:edit|update|modify|rewrite|refactor|patch|fix|implement|add|create|remove|delete|change|write|migrate|rename)\b/i

export type WorkerOutcomeAssessment =
	| { status: 'completed' }
	| { status: 'blocked', reason: string }

/**
 * Guard against FALSE SUCCESS: a write worker that reports edits it cannot evidence must
 * not be handed to the parent as `completed`. Research workers are exempt (they are
 * supposed to change nothing), and a work worker that only investigated and says so is
 * fine — we block on the CLAIM/EVIDENCE mismatch, not on "no files changed".
 */
export function assessWorkerOutcome(opts: {
	profile: 'work' | 'research'
	task: string
	report: string
	evidence: SubagentEvidence
}): WorkerOutcomeAssessment {
	if (opts.profile !== 'work') return { status: 'completed' }
	if (opts.evidence.filesTouched.length > 0) return { status: 'completed' }

	const claimsEdits = CLAIMED_EDIT_RE.test(opts.report)
	if (claimsEdits) {
		return {
			status: 'blocked',
			reason: 'Worker reported file changes but none of its own tool calls wrote to a file. Treated as blocked so the parent does not integrate an unverified claim.',
		}
	}
	const taskAskedForEdits = TASK_ASKS_FOR_EDITS_RE.test(opts.task)
	if (taskAskedForEdits && opts.evidence.toolsRun === 0) {
		return {
			status: 'blocked',
			reason: 'Worker was asked to change files but ran no tools and changed nothing.',
		}
	}
	return { status: 'completed' }
}

export type SubagentAdmission =
	| { ok: true, queued: false }
	| { ok: true, queued: true, queuePosition: number, reason: string }
	| { ok: false, reason: string }

/** Maximum workers that can be queued per parent beyond the running cap. Prevents
 *  unbounded prompt-driven backlog: 3 running + 5 queued = 8 max per parent. */
export const MAX_QUEUED_SUBAGENTS_PER_PARENT = 5

export function subagentAdmission(opts: {
	/** Nesting depth of the child being launched (parent depth + 1; 1 for a root launch). */
	depth: number,
	/** Children of this parent currently in 'running' state. */
	runningForParent: number,
	/** All subagents currently in 'running' state in this window. */
	runningTotal: number,
	/** Children of this parent currently in 'queued' state. */
	queuedForParent?: number,
	/** All subagents currently in 'running' or 'queued' state in this window. */
	activeTotal?: number,
}): SubagentAdmission {
	if (!canSubagentDelegate(opts.depth - 1)) {
		return { ok: false, reason: `Subagent nesting is limited to ${SUBAGENT_MAX_NESTING_DEPTH} levels. Do this task yourself instead of delegating further.` }
	}
	const queuedForParent = opts.queuedForParent ?? 0
	const activeTotal = opts.activeTotal ?? opts.runningTotal
	// Hard ceiling: running + queued across the whole window must stay within the total cap.
	if (activeTotal >= MAX_BACKGROUND_SUBAGENTS_TOTAL) {
		return { ok: false, reason: `At most ${MAX_BACKGROUND_SUBAGENTS_TOTAL} background subagents (running + queued) may exist at once in this window. Wait for one to finish before launching another.` }
	}
	// Can run immediately if both parent and global running slots are available.
	if (opts.runningForParent < MAX_BACKGROUND_SUBAGENTS_PER_PARENT && opts.runningTotal < MAX_BACKGROUND_SUBAGENTS_TOTAL) {
		return { ok: true, queued: false }
	}
	// Otherwise queue, as long as the per-parent queue isn't full.
	if (queuedForParent >= MAX_QUEUED_SUBAGENTS_PER_PARENT) {
		return { ok: false, reason: `At most ${MAX_QUEUED_SUBAGENTS_PER_PARENT} background subagents may be queued for one parent thread. Wait for one to finish before launching another.` }
	}
	const position = queuedForParent + 1
	return {
		ok: true,
		queued: true,
		queuePosition: position,
		reason: `All ${MAX_BACKGROUND_SUBAGENTS_PER_PARENT} running slots are occupied. Queued at position ${position} — the worker will start automatically when a slot opens.`,
	}
}

/** One entry in the global FIFO wait queue, in insertion order. */
export type QueueEntry = { subagentThreadId: string, parentThreadId: string }

/**
 * Decide which queued workers may start now, scanning the GLOBAL FIFO queue in insertion
 * order. This is deliberately not per-parent: a slot freed by parent A must be offered to
 * the oldest globally-eligible worker, even if that worker belongs to parent B. The
 * per-parent running cap is still honoured, and a parent that is at its cap is SKIPPED
 * rather than blocking the queue behind it — otherwise one saturated parent starves
 * everyone else's workers forever.
 *
 * Pure, so cross-parent drain behaviour is testable without the thread service.
 */
export function selectDrainableSubagents(opts: {
	/** Global FIFO queue, oldest first. */
	queue: readonly QueueEntry[]
	/** Currently running count per parent thread id. */
	runningByParent: Readonly<Record<string, number>>
	/** Currently running count across the whole window. */
	runningTotal: number
	/** Ids still genuinely in 'queued' state (stale queue entries are ignored). */
	isStillQueued: (subagentThreadId: string) => boolean
}): string[] {
	const started: string[] = []
	const running = { ...opts.runningByParent }
	let total = opts.runningTotal
	for (const entry of opts.queue) {
		if (total >= MAX_BACKGROUND_SUBAGENTS_TOTAL) break
		if (!opts.isStillQueued(entry.subagentThreadId)) continue
		const parentRunning = running[entry.parentThreadId] ?? 0
		// Skip (do not break): this parent is saturated, but a later entry under a
		// different parent may still be eligible for the free global slot.
		if (parentRunning >= MAX_BACKGROUND_SUBAGENTS_PER_PARENT) continue
		started.push(entry.subagentThreadId)
		running[entry.parentThreadId] = parentRunning + 1
		total += 1
	}
	return started
}

/**
 * Recompute 1-based queue positions per parent after a drain or cancellation, so a queued
 * worker never reports a stale "position 3" once the workers ahead of it have started.
 */
export function recomputeQueuePositions(
	queue: readonly QueueEntry[],
	isStillQueued: (subagentThreadId: string) => boolean,
): Map<string, number> {
	const perParent = new Map<string, number>()
	const positions = new Map<string, number>()
	for (const entry of queue) {
		if (!isStillQueued(entry.subagentThreadId)) continue
		const next = (perParent.get(entry.parentThreadId) ?? 0) + 1
		perParent.set(entry.parentThreadId, next)
		positions.set(entry.subagentThreadId, next)
	}
	return positions
}

/**
 * Heuristic overlap check between two team-board `where` claims. Claims are free text
 * ("src/foo/, src/bar/baz.ts") — split into path-ish tokens and flag when one claim's
 * token is a prefix of the other's. Deliberately favors warning over silence: an
 * occasional false positive costs a sentence, a missed clash costs corrupted work.
 */
export function teamClaimsOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
	const tokens = (s: string) => s.toLowerCase().split(/[,\s]+/).map(t => t.replace(/^[./]+|[/]+$/g, '')).filter(t => t.length > 2)
	if (!a || !b) return false
	const ta = tokens(a); const tb = tokens(b)
	return ta.some(x => tb.some(y => x.startsWith(y) || y.startsWith(x)))
}

// ---- Team contracts (frozen shared decisions) + batch reconcile ----

/** A contract older than this is flagged stale on the board — most likely a leftover from
 *  a finished effort the foreman forgot to clear. Flagged, never auto-deleted: contracts
 *  belong to the parent effort, which survives reloads (unlike sub:* claims). */
export const TEAM_CONTRACT_STALE_MS = 48 * 60 * 60 * 1000

export function isContractStale(updatedAtIso: string, now: number): boolean {
	const t = Date.parse(updatedAtIso)
	return Number.isFinite(t) && now - t > TEAM_CONTRACT_STALE_MS
}

// Caps so a runaway board cannot bloat every child's context.
export const MAX_INJECTED_CONTRACTS = 40
export const MAX_CONTRACT_VALUE_CHARS = 2000

export type ContractLike = { key: string, value: string, rationale: string | null, stale?: boolean }

/** The FROZEN TEAM CONTRACTS block prepended to every subagent preamble ('' when none). */
export function formatContractsBlock(contracts: readonly ContractLike[]): string {
	if (contracts.length === 0) return ''
	const shown = contracts.slice(0, MAX_INJECTED_CONTRACTS)
	const lines = shown.map(c => {
		const value = c.value.length > MAX_CONTRACT_VALUE_CHARS ? c.value.slice(0, MAX_CONTRACT_VALUE_CHARS) + '…' : c.value
		return `- ${c.key} = ${value}${c.rationale ? ` (${c.rationale})` : ''}${c.stale ? ' [stale]' : ''}`
	})
	const omitted = contracts.length - shown.length
	return `FROZEN TEAM CONTRACTS — locked shared decisions; use these values exactly, do not re-derive or change them:\n${lines.join('\n')}${omitted > 0 ? `\n(+${omitted} more — read team_board)` : ''}\n\n`
}

/** Fire the reconcile prompt when a batch of parallel workers has fully landed: nothing
 *  still running, at least two reached a terminal state, and at least one actually
 *  completed (an all-cancelled batch — parent Stop cascade — has nothing to reconcile). */
export function shouldReconcileBatch(batch: { running: number, terminal: number, completed: number }): boolean {
	return batch.running === 0 && batch.terminal >= 2 && batch.completed >= 1
}

export function formatReconcilePrompt(terminal: number, contracts: readonly ContractLike[]): string {
	const contractsLine = contracts.length > 0
		? `Contracts in force: ${contracts.map(c => `${c.key} = ${c.value}`).join('; ')}.`
		: 'No contracts were frozen for this batch — if the workers had to share any value, decision, or interface, freeze it with team_contract before the next phase.'
	return `[All ${terminal} background subagents have finished — RECONCILE before integrating or reporting]\nParallel workers do not stomp, they DIVERGE: same question, incompatible answers. Cross-check their outputs against EACH OTHER and against the frozen contracts — divergent values, files that should reference each other but don't, contradictions, one worker's fix undoing another's. ${contractsLine} Fix divergences — directly if you can edit in this mode, otherwise via a narrow follow-up worker — and for larger ones dispatch the next phase with the corrected contract. Only then integrate and report.`
}

export function overlappingClaims<T extends { agentId: string, where: string | null }>(
	where: string | null | undefined,
	entries: readonly T[],
	selfAgentId: string,
): T[] {
	return entries.filter(e => e.agentId !== selfAgentId && teamClaimsOverlap(where, e.where))
}
