/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Durable task authority — the session's primary task as a PERSISTED record, not a
 * per-turn recomputation. Before this, "the task" was whatever the latest user message
 * looked like, so a cosmetic side request silently became the task and one condense
 * pass erased the original ask from the wire (the Bot/Agent-swap drift incident).
 *
 * Contract:
 * - The FIRST user message of a thread creates the task; its text is stored verbatim.
 * - Only an explicit user switch ("switch to", "forget that", "new task", ...) replaces
 *   the primary goal — never a side request, never a model decision.
 * - Side requests are queued and labeled; they never silently promote over the primary.
 * - update_plan full-replaces are guarded by lastTurnKind (a side turn cannot replace
 *   the primary task's plan).
 * - The rendered <durable_task> block is injected next to <current_turn> every round
 *   start and survives condensation (rebuilt from disk, not from history).
 *
 * This module is pure and headlessly testable; file IO lives in the callers.
 */

import { generateUuid } from '../../../../../base/common/uuid.js';

export type DurableTaskStatus = 'active' | 'completed' | 'cancelled' | 'superseded';
export type DurableTaskOrigin = 'first_user_message' | 'task_switch' | 'promoted_side';
/** How the latest user turn related to the durable task — the update_plan guard reads this. */
export type DurableTaskTurnKind = 'work' | 'side' | 'switch' | 'complete';

export interface DurableTaskSideRequest {
	id: string;
	text: string;
	queuedAt: number;
	status: 'pending' | 'done';
}

export interface DurableTask {
	taskId: string;
	/** Bumps on every authoritative mutation of the record (side-queue append, completion).
	 *  A task SWITCH keeps revision 1 under a NEW taskId — identity changes beat numbers. */
	revision: number;
	verbatimGoal: string;
	constraints: string[];
	approvalGates: string[];
	currentPhase: string;
	status: DurableTaskStatus;
	sideQueue: DurableTaskSideRequest[];
	createdFrom: DurableTaskOrigin;
	createdAt: number;
	updatedAt: number;
}

export interface DurableTaskFile {
	threadId: string;
	updatedAt: number;
	lastTurnKind: DurableTaskTurnKind;
	task: DurableTask;
	/** Newest first, capped — evidence of what the user moved away from. */
	superseded: DurableTask[];
}

export const DURABLE_TASK_VERBATIM_MAX_CHARS = 4_000;
export const DURABLE_TASK_SIDE_TEXT_MAX_CHARS = 500;
export const DURABLE_TASK_SIDE_QUEUE_MAX = 8;
export const DURABLE_TASK_SUPERSEDED_MAX = 3;
export const DURABLE_TASK_CONSTRAINTS_MAX = 6;
export const DURABLE_TASK_RENDER_MAX_CHARS = 1_500;

const DURABLE_TASK_LINE_MAX_CHARS = 300;

const CONSTRAINT_RE = /\b(never|always|must|don'?t|do not|keep\b|only after|without asking|no [a-z]+ without)\b/i;
const APPROVAL_GATE_RE = /\b(stop and (report|ask|check)|ask (me )?before|wait for (me|my|approval)|confirm (with me )?first|don'?t \w+ until|report before)\b/i;
const ORIENTATION_ONLY_RE = /^(?:hi|hello|hey|yo|thanks|thank you|what can you do|who are you|help|open (?:this|the) (?:folder|project|workspace)|show (?:me )?(?:this|the) (?:folder|project|workspace))[.!?\s]*$/i;

function capLine(text: string, max: number): string {
	const t = text.trim().replace(/\s+/g, ' ');
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Cap WITHOUT flattening — the goal is the user's words verbatim, newlines included. */
function capVerbatim(text: string, max: number): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Pull user-stated constraints and approval gates out of the verbatim goal, capped and
 *  deduped. Heuristic on purpose: they are rendered as "extracted from your words", and
 *  the verbatim goal is always rendered alongside as the source of truth. */
export function extractConstraintsAndGates(verbatimGoal: string): { constraints: string[]; approvalGates: string[] } {
	const constraints: string[] = [];
	const approvalGates: string[] = [];
	for (const rawLine of verbatimGoal.split(/\n|(?<=[.!?])\s+/)) {
		const line = capLine(rawLine, DURABLE_TASK_LINE_MAX_CHARS);
		if (line.length < 8) continue;
		if (APPROVAL_GATE_RE.test(line)) {
			if (!approvalGates.includes(line)) approvalGates.push(line);
		} else if (CONSTRAINT_RE.test(line)) {
			if (!constraints.includes(line)) constraints.push(line);
		}
		if (constraints.length >= DURABLE_TASK_CONSTRAINTS_MAX && approvalGates.length >= DURABLE_TASK_CONSTRAINTS_MAX) break;
	}
	return {
		constraints: constraints.slice(0, DURABLE_TASK_CONSTRAINTS_MAX),
		approvalGates: approvalGates.slice(0, DURABLE_TASK_CONSTRAINTS_MAX),
	};
}

export function createDurableTaskFile(threadId: string, verbatimGoal: string, createdFrom: DurableTaskOrigin, now: number): DurableTaskFile {
	const goal = capVerbatim(verbatimGoal, DURABLE_TASK_VERBATIM_MAX_CHARS);
	const { constraints, approvalGates } = extractConstraintsAndGates(goal);
	return {
		threadId,
		updatedAt: now,
		lastTurnKind: createdFrom === 'task_switch' ? 'switch' : 'work',
		task: {
			taskId: `dt_${generateUuid().slice(0, 8)}`,
			revision: 1,
			verbatimGoal: goal,
			constraints,
			approvalGates,
			currentPhase: 'Execute and verify the primary goal',
			status: 'active',
			sideQueue: [],
			createdFrom,
			createdAt: now,
			updatedAt: now,
		},
		superseded: [],
	};
}

export interface ApplyTurnInput {
	threadId: string;
	/** The live user message, ephemeral tail already stripped. */
	message: string;
	isContinuation: boolean;
	hasTaskCommand: boolean;
	hasSwitchIntent: boolean;
	hasSwitchBackIntent?: boolean;
	hasPromoteIntent?: boolean;
	hasCompleteIntent?: boolean;
	hasCancelIntent?: boolean;
	hasGenuineTaskIntent?: boolean;
	hasPriorAssistantTurn: boolean;
	liveTaskInFlight: boolean;
	now: number;
}

export type ApplyTurnAction = 'created' | 'switched' | 'restored' | 'promoted' | 'side-queued' | 'resumed' | 'completed' | 'cancelled' | 'ignored' | 'none';

export function isGenuineTaskMessage(message: string, hasTaskCommand: boolean): boolean {
	const text = message.trim();
	if (!text || ORIENTATION_ONLY_RE.test(text)) return false;
	return hasTaskCommand || text.length >= 8;
}

export function durableTaskLanguageSignals(message: string): Pick<ApplyTurnInput, 'hasSwitchBackIntent' | 'hasPromoteIntent' | 'hasCompleteIntent' | 'hasCancelIntent'> {
	const text = message.trim();
	return {
		hasSwitchBackIntent: /\b(?:switch|go|return) back\b/i.test(text),
		hasPromoteIntent: /\b(?:make|promote|move)\b[^.!?\n]{0,80}\b(?:primary|main) (?:task|work)\b/i.test(text),
		hasCompleteIntent: /\b(?:mark )?(?:the |this |that )?(?:primary )?(?:task|work)\b[^.!?\n]{0,40}\b(?:done|complete|completed|finished)\b/i.test(text),
		hasCancelIntent: /\b(?:cancel|drop|abandon)\b[^.!?\n]{0,40}\b(?:the |this |that )?(?:task|work)\b|\bstop working on\b/i.test(text),
	};
}

/** Apply one user turn to the durable task record. The rules that make drift impossible:
 *  - no record yet → the live message BECOMES the task (verbatim), whatever its shape;
 *  - explicit switch vocabulary → NEW task, old one preserved under superseded;
 *  - continuation/approval ("yes do it") → resumes the SAME task, never a switch;
 *  - a short non-command aside, or any non-command message while a task is mid-flight,
 *    is a SIDE REQUEST — queued, never promoted;
 *  - anything else leaves the primary goal untouched. */
export function applyTurnToDurableTask(existing: DurableTaskFile | null, input: ApplyTurnInput): { file: DurableTaskFile | null; action: ApplyTurnAction } {
	const message = input.message.trim();
	if (!existing) {
		if (!(input.hasGenuineTaskIntent ?? isGenuineTaskMessage(message, input.hasTaskCommand))) {
			return { file: null, action: 'ignored' };
		}
		return { file: createDurableTaskFile(input.threadId, message, 'first_user_message', input.now), action: 'created' };
	}
	const file: DurableTaskFile = { ...existing, task: { ...existing.task, sideQueue: [...existing.task.sideQueue] }, superseded: [...existing.superseded] };
	file.updatedAt = input.now;
	file.task.updatedAt = input.now;
	// A queued side request belongs to the turn that queued it. Once the user speaks again,
	// that side turn is over unless they explicitly promote it.
	if (file.lastTurnKind === 'side' && !input.hasPromoteIntent) {
		const pending = [...file.task.sideQueue].reverse().find(side => side.status === 'pending');
		if (pending) pending.status = 'done';
	}

	if (input.hasSwitchBackIntent && !input.isContinuation && file.superseded.length > 0) {
		const previous = { ...file.task, status: 'superseded' as const, updatedAt: input.now };
		const restored = { ...file.superseded[0], status: 'active' as const, revision: file.superseded[0].revision + 1, updatedAt: input.now };
		file.superseded = [previous, ...file.superseded.slice(1)].slice(0, DURABLE_TASK_SUPERSEDED_MAX);
		file.task = restored;
		file.lastTurnKind = 'switch';
		return { file, action: 'restored' };
	}

	if (input.hasPromoteIntent && !input.isContinuation) {
		const side = [...file.task.sideQueue].reverse().find(candidate => candidate.status === 'pending');
		if (side) {
			side.status = 'done';
			const previous: DurableTask = { ...file.task, sideQueue: [...file.task.sideQueue], status: 'superseded', updatedAt: input.now };
			file.superseded = [previous, ...file.superseded].slice(0, DURABLE_TASK_SUPERSEDED_MAX);
			file.task = createDurableTaskFile(input.threadId, side.text, 'promoted_side', input.now).task;
			file.lastTurnKind = 'switch';
			return { file, action: 'promoted' };
		}
	}

	if (input.hasSwitchIntent && !input.isContinuation) {
		const previous: DurableTask = { ...file.task, status: 'superseded', updatedAt: input.now };
		file.superseded = [previous, ...file.superseded].slice(0, DURABLE_TASK_SUPERSEDED_MAX);
		const fresh = createDurableTaskFile(input.threadId, message, 'task_switch', input.now);
		file.task = fresh.task;
		file.lastTurnKind = 'switch';
		return { file, action: 'switched' };
	}

	if (input.hasCompleteIntent || input.hasCancelIntent) {
		file.task.status = input.hasCancelIntent ? 'cancelled' : 'completed';
		file.task.revision += 1;
		file.lastTurnKind = 'complete';
		return { file, action: input.hasCancelIntent ? 'cancelled' : 'completed' };
	}

	if (file.task.status !== 'active') {
		if (!(input.hasGenuineTaskIntent ?? isGenuineTaskMessage(message, input.hasTaskCommand))) {
			return { file, action: 'ignored' };
		}
		const previous = { ...file.task };
		const fresh = createDurableTaskFile(input.threadId, message, 'first_user_message', input.now);
		fresh.superseded = [previous, ...file.superseded].slice(0, DURABLE_TASK_SUPERSEDED_MAX);
		return { file: fresh, action: 'created' };
	}

	if (input.isContinuation) {
		file.lastTurnKind = 'work';
		return { file, action: 'resumed' };
	}

	const isShortAside = !input.hasTaskCommand && message.length <= 60;
	const isMidFlightAside = !input.hasTaskCommand && input.liveTaskInFlight;
	if (!input.hasTaskCommand && (isShortAside || isMidFlightAside)) {
		if (message.length >= 3) {
			file.task.sideQueue.push({ id: `side_${generateUuid().slice(0, 8)}`, text: capLine(message, DURABLE_TASK_SIDE_TEXT_MAX_CHARS), queuedAt: input.now, status: 'pending' });
			if (file.task.sideQueue.length > DURABLE_TASK_SIDE_QUEUE_MAX) {
				file.task.sideQueue = file.task.sideQueue.slice(file.task.sideQueue.length - DURABLE_TASK_SIDE_QUEUE_MAX);
			}
			file.task.revision += 1;
		}
		file.lastTurnKind = 'side';
		return { file, action: 'side-queued' };
	}

	file.lastTurnKind = 'work';
	return { file, action: 'none' };
}

/** Render the <durable_task> block for the live-turn injection. Bounded by
 *  DURABLE_TASK_RENDER_MAX_CHARS so it can sit next to <current_turn> forever. */
export function renderDurableTaskBlock(file: DurableTaskFile, maxChars: number = DURABLE_TASK_RENDER_MAX_CHARS): string {
	const task = file.task;
	if (task.status !== 'active') return '';
	const forbidden = task.constraints.filter(constraint => /\b(?:never|do not|don't|forbid|without approval|no\s+\w+)\b/i.test(constraint));
	const workspace = task.constraints.filter(constraint => /\b(?:workspace|worktree|branch|directory|folder|only here|work only)\b/i.test(constraint));
	const lines: string[] = [
		'',
		'',
		'<durable_task>',
	];
	if (task.approvalGates.length) lines.push(`Approval gates (user-stated — obey before acting): ${task.approvalGates.map(g => `"${g}"`).join(' · ')}`);
	if (forbidden.length) lines.push(`Forbidden actions (user-stated): ${forbidden.map(c => `"${c}"`).join(' · ')}`);
	if (workspace.length) lines.push(`Workspace/worktree boundary (user-stated): ${workspace.map(c => `"${c}"`).join(' · ')}`);
	lines.push(`Primary goal (the user's words, task ${task.taskId} rev ${task.revision}): "${capVerbatim(task.verbatimGoal, 500)}"`);
	lines.push(`Current phase: ${capLine(task.currentPhase, 220)}`);
	const pending = task.sideQueue.filter(s => s.status === 'pending');
	if (pending.length) lines.push(`Side queue (real user asks — do them, but never as a silent replacement of the primary goal): ${pending.map(s => `"${s.text}"`).join(' · ')}`);
	const remainingConstraints = task.constraints.filter(constraint => !forbidden.includes(constraint) && !workspace.includes(constraint));
	if (remainingConstraints.length) lines.push(`Other constraints: ${remainingConstraints.map(c => `"${c}"`).join(' · ')}`);
	lines.push(`Authority: preserve this task across compaction. <current_turn> may refine it; only explicit switch, promotion, completion, or cancellation changes ownership.`);
	lines.push('</durable_task>');
	const rendered = lines.join('\n');
	return rendered.length <= maxChars ? rendered : `${rendered.slice(0, maxChars - 40)}\n…</durable_task>`;
}

export function parseDurableTaskFile(raw: string): DurableTaskFile | null {
	try {
		const data = JSON.parse(raw) as Partial<DurableTaskFile>;
		if (!data || typeof data.threadId !== 'string') return null;
		const task = data.task;
		if (!task || typeof task.taskId !== 'string' || typeof task.verbatimGoal !== 'string') return null;
		return {
			threadId: data.threadId,
			updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
			lastTurnKind: data.lastTurnKind === 'side' || data.lastTurnKind === 'switch' || data.lastTurnKind === 'complete' ? data.lastTurnKind : 'work',
			task: {
				taskId: task.taskId,
				revision: typeof task.revision === 'number' ? task.revision : 1,
				verbatimGoal: task.verbatimGoal,
				constraints: Array.isArray(task.constraints) ? task.constraints.filter(c => typeof c === 'string') : [],
				approvalGates: Array.isArray(task.approvalGates) ? task.approvalGates.filter(g => typeof g === 'string') : [],
				currentPhase: typeof task.currentPhase === 'string' && task.currentPhase.trim() ? task.currentPhase : 'Execute and verify the primary goal',
				status: task.status === 'completed' || task.status === 'cancelled' || task.status === 'superseded' ? task.status : 'active',
				sideQueue: Array.isArray(task.sideQueue)
					? task.sideQueue.filter(s => s && typeof s.text === 'string').map(s => ({ id: typeof s.id === 'string' ? s.id : `side_${generateUuid().slice(0, 8)}`, text: s.text, queuedAt: typeof s.queuedAt === 'number' ? s.queuedAt : 0, status: s.status === 'done' ? 'done' as const : 'pending' as const }))
					: [],
				createdFrom: task.createdFrom === 'task_switch' || task.createdFrom === 'promoted_side' ? task.createdFrom : 'first_user_message',
				createdAt: typeof task.createdAt === 'number' ? task.createdAt : 0,
				updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0,
			},
			superseded: Array.isArray(data.superseded) ? (data.superseded as DurableTask[]).slice(0, DURABLE_TASK_SUPERSEDED_MAX) : [],
		};
	} catch {
		return null;
	}
}

export function serializeDurableTaskFile(file: DurableTaskFile): string {
	return `${JSON.stringify(file, null, 2)}\n`;
}

/** The update_plan guard: a FULL replace (merge falsy) issued while the latest user turn
 *  is a side request is rejected — side requests never silently replace the primary task's
 *  plan. With no record (non-native surfaces) the call proceeds unguarded, as before. */
export function shouldRejectPlanReplace(taskFile: DurableTaskFile | null, merge: boolean | undefined): boolean {
	return !merge && taskFile !== null && taskFile.lastTurnKind === 'side';
}

export function applyPlanLifecycleToDurableTask(file: DurableTaskFile, todos: readonly { content: string; status: string }[], now: number): DurableTaskFile {
	const next: DurableTaskFile = { ...file, task: { ...file.task, sideQueue: [...file.task.sideQueue] }, superseded: [...file.superseded], updatedAt: now };
	if (!todos.length) return next;
	const open = todos.filter(todo => todo.status !== 'completed' && todo.status !== 'cancelled');
	const inProgress = open.find(todo => todo.status === 'in_progress') ?? open[0];
	if (inProgress) {
		next.task.currentPhase = capLine(inProgress.content, 220);
		next.task.status = 'active';
	} else {
		next.task.currentPhase = 'Primary task finished';
		next.task.status = todos.every(todo => todo.status === 'cancelled') ? 'cancelled' : 'completed';
		next.lastTurnKind = 'complete';
	}
	next.task.revision += 1;
	next.task.updatedAt = now;
	return next;
}
