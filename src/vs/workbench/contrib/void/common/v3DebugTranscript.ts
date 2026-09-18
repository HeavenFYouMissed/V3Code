/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IReader } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../chat/common/chatService/chatService.js';
import { isToolResultInputOutputDetails } from '../../chat/common/tools/languageModelToolsService.js';
import { formatEvidenceData, V3DebugEvidenceLine, V3DebugSessionPhase } from './debugSessionTypes.js';

/**
 * Pure presentation helpers for the Debug-only transcript. Everything here maps OBSERVED
 * tool state to labels, categories, groups and status text — no timers, no inference about
 * what the model is about to do, no second state machine. The chat list renderer and the
 * tool invocation part call these; the node tests exercise them directly.
 */

export const V3_TRANSCRIPT_DENSITY_SETTING_ID = 'v3code.chat.transcriptDensity';
export type V3TranscriptDensity = 'verbose' | 'standard' | 'compact' | 'minimal';
export const V3_TRANSCRIPT_DENSITY_DEFAULT: V3TranscriptDensity = 'standard';
export const V3_TRANSCRIPT_DENSITIES: readonly V3TranscriptDensity[] = ['verbose', 'standard', 'compact', 'minimal'];

export function parseTranscriptDensity(value: unknown): V3TranscriptDensity {
	return typeof value === 'string' && (V3_TRANSCRIPT_DENSITIES as readonly string[]).includes(value)
		? value as V3TranscriptDensity
		: V3_TRANSCRIPT_DENSITY_DEFAULT;
}

/** Preparing arguments is not executing a command: streaming stays distinct from running. */
export type V3ToolLifecycle = 'preparing' | 'awaiting-approval' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
export type V3ToolCategory = 'read' | 'edit' | 'command';

/** A plain snapshot of what the model exposes about one tool call. */
export interface V3ToolObservation {
	readonly isSerialized: boolean;
	readonly stateKind: IChatToolInvocation.StateKind | undefined;
	readonly confirmed: 'confirmed' | 'denied' | 'skipped' | undefined;
	readonly isComplete: boolean;
	readonly isError: boolean;
}

export function observeToolInvocation(invocation: IChatToolInvocation | IChatToolInvocationSerialized, reader?: IReader): V3ToolObservation {
	const confirmState = IChatToolInvocation.executionConfirmedOrDenied(invocation, reader);
	const confirmed = confirmState?.type === ToolConfirmKind.Denied ? 'denied'
		: confirmState?.type === ToolConfirmKind.Skipped ? 'skipped'
			: confirmState ? 'confirmed' : undefined;
	const details = IChatToolInvocation.resultDetails(invocation, reader);
	return {
		isSerialized: invocation.kind === 'toolInvocationSerialized',
		stateKind: invocation.kind === 'toolInvocation' ? invocation.state.read(reader).type : undefined,
		confirmed,
		isComplete: IChatToolInvocation.isComplete(invocation, reader),
		isError: isToolResultInputOutputDetails(details) && details.isError === true,
	};
}

export interface V3ToolLifecycleDescription {
	readonly lifecycle: V3ToolLifecycle;
	readonly label: string;
	/** Observed active work — the only time the sheen may run. */
	readonly isActive: boolean;
}

export function describeToolLifecycle(observation: V3ToolObservation): V3ToolLifecycleDescription {
	const make = (lifecycle: V3ToolLifecycle, label: string, isActive = false): V3ToolLifecycleDescription => ({ lifecycle, label, isActive });
	if (!observation.isSerialized) {
		if (observation.stateKind === IChatToolInvocation.StateKind.Streaming) {
			return make('preparing', localize('v3debug.preparing', "Preparing"), true);
		}
		if (observation.stateKind === IChatToolInvocation.StateKind.WaitingForConfirmation || observation.stateKind === IChatToolInvocation.StateKind.WaitingForPostApproval) {
			return make('awaiting-approval', localize('v3debug.awaitingApproval', "Awaiting approval"));
		}
	}
	if (observation.confirmed === 'denied') {
		return make('cancelled', localize('v3debug.cancelled', "Cancelled"));
	}
	if (observation.confirmed === 'skipped') {
		return make('skipped', localize('v3debug.skipped', "Skipped"));
	}
	// A serialized call is always complete; a live one that is neither streaming nor waiting
	// and not yet complete is executing.
	if (!observation.isSerialized && !observation.isComplete) {
		return make('running', localize('v3debug.running', "Running"), true);
	}
	if (observation.isError) {
		return make('failed', localize('v3debug.failed', "Failed"));
	}
	return make('succeeded', localize('v3debug.done', "Done"));
}

/** Mirrors the native tool id prefix in browser/v3codeToolIds.ts (common code cannot import the browser layer). */
export const V3_NATIVE_TOOL_ID_PREFIX = 'v3code_';

const V3_EDIT_TOOL_IDS = new Set(['create_file_or_folder', 'rewrite_file', 'append_file', 'edit_file'].map(name => V3_NATIVE_TOOL_ID_PREFIX + name));
const V3_COMMAND_TOOL_IDS = new Set(['run_command', 'run_persistent_command', 'run_tests'].map(name => V3_NATIVE_TOOL_ID_PREFIX + name));
export const V3_ASK_USER_TOOL_ID = V3_NATIVE_TOOL_ID_PREFIX + 'ask_user';

export function categorizeDebugTool(toolId: string, toolSpecificDataKind: string | undefined): V3ToolCategory {
	if (toolSpecificDataKind === 'terminal' || V3_COMMAND_TOOL_IDS.has(toolId)) {
		return 'command';
	}
	if (V3_EDIT_TOOL_IDS.has(toolId)) {
		return 'edit';
	}
	return 'read';
}

/**
 * One rendered item of a response, in transcript order. `kind: 'tool'` is a visible tool
 * card; `boundary` is narration, thinking or any other visible part (a group never crosses
 * it); `transparent` is an invisible part (hidden tool, no-content placeholder) that neither
 * joins nor breaks a group.
 */
export type V3TranscriptItem =
	| { readonly kind: 'tool'; readonly id: string; readonly lifecycle: V3ToolLifecycle; readonly category: V3ToolCategory }
	| { readonly kind: 'boundary' }
	| { readonly kind: 'transparent' };

export interface V3ToolGroupPlan {
	/** Index of the first member in the item list. */
	readonly start: number;
	/** Index one past the last member. */
	readonly end: number;
	readonly memberIds: readonly string[];
	/** Minimal density wraps single completed cards too; they start collapsed. */
	readonly single: boolean;
}

/**
 * Only consecutive SUCCEEDED tool cards ever group. Active, awaiting, failed, cancelled and
 * skipped cards stay individually visible and break the run, as does any narration.
 */
export function planDebugToolGroups(items: readonly V3TranscriptItem[], density: V3TranscriptDensity): V3ToolGroupPlan[] {
	if (density === 'verbose') {
		return [];
	}
	const minSize = density === 'minimal' ? 1 : 2;
	const sameCategoryOnly = density === 'standard';
	const groups: V3ToolGroupPlan[] = [];
	let run: { start: number; end: number; ids: string[]; category: V3ToolCategory } | undefined;
	const flush = () => {
		if (run && run.ids.length >= minSize) {
			groups.push({ start: run.start, end: run.end, memberIds: run.ids, single: run.ids.length === 1 });
		}
		run = undefined;
	};
	items.forEach((item, index) => {
		if (item.kind === 'transparent') {
			return;
		}
		if (item.kind === 'boundary' || item.lifecycle !== 'succeeded') {
			flush();
			return;
		}
		if (run && sameCategoryOnly && run.category !== item.category) {
			flush();
		}
		if (!run) {
			run = { start: index, end: index + 1, ids: [item.id], category: item.category };
		} else {
			run.end = index + 1;
			run.ids.push(item.id);
		}
	});
	flush();
	return groups;
}

/** Counts operations — never invents "distinct files". */
export function debugGroupTitle(count: number): string {
	return count === 1
		? localize('v3debug.oneOperation', "1 operation")
		: localize('v3debug.nOperations', "{0} operations", count);
}

/**
 * Remembers whether the user expanded a group, keyed by response identity plus group
 * identity, so a virtualized rerender restores it. Every member id is a key: an earlier
 * tool that completes late and joins the front of a group must not lose the state.
 */
export class V3DebugGroupExpansionStore {
	private readonly _expanded = new Map<string, boolean>();

	static key(responseId: string, memberId: string): string {
		return `${responseId}::${memberId}`;
	}

	get(responseId: string, memberIds: readonly string[]): boolean | undefined {
		for (const memberId of memberIds) {
			const value = this._expanded.get(V3DebugGroupExpansionStore.key(responseId, memberId));
			if (value !== undefined) {
				return value;
			}
		}
		return undefined;
	}

	set(responseId: string, memberIds: readonly string[], expanded: boolean): void {
		for (const memberId of memberIds) {
			this._expanded.set(V3DebugGroupExpansionStore.key(responseId, memberId), expanded);
		}
	}

	clear(): void {
		this._expanded.clear();
	}
}

export interface V3LiveStatusEntry {
	readonly lifecycle: V3ToolLifecycle;
	/** ask_user waits for an answer rather than an approval. */
	readonly isQuestion?: boolean;
}

/**
 * Text for the single `.v3-chat-live-status` region of an active Debug response. Derived only
 * from observed activity: empty when nothing is active — never "Wrapping up", never a timer.
 */
export function debugLiveStatusText(entries: readonly V3LiveStatusEntry[]): string {
	let preparing = 0, running = 0, approvals = 0, questions = 0;
	for (const entry of entries) {
		if (entry.lifecycle === 'preparing') { preparing++; }
		else if (entry.lifecycle === 'running') { running++; }
		else if (entry.lifecycle === 'awaiting-approval') { entry.isQuestion ? questions++ : approvals++; }
	}
	const parts: string[] = [];
	if (running > 0) {
		parts.push(running === 1 ? localize('v3debug.status.running1', "Running 1 operation") : localize('v3debug.status.runningN', "Running {0} operations", running));
	}
	if (preparing > 0) {
		parts.push(preparing === 1 ? localize('v3debug.status.preparing1', "Preparing 1 operation") : localize('v3debug.status.preparingN', "Preparing {0} operations", preparing));
	}
	if (approvals > 0) {
		parts.push(approvals === 1 ? localize('v3debug.status.approval1', "1 operation awaiting your approval") : localize('v3debug.status.approvalN', "{0} operations awaiting your approval", approvals));
	}
	if (questions > 0) {
		parts.push(localize('v3debug.status.question', "Waiting for your answer"));
	}
	return parts.join(' · ');
}

/**
 * True when the status text describes work that is actually happening. The sheen is a claim
 * about the machine, so it must not run when the only thing in flight is the user being
 * asked a question — an animated "Waiting for your answer" says something is happening when
 * the truth is that nothing is until the user speaks.
 */
export function debugLiveStatusIsActive(entries: readonly V3LiveStatusEntry[]): boolean {
	return entries.some(entry => entry.lifecycle === 'preparing' || entry.lifecycle === 'running');
}

/**
 * Shown while the response is still streaming and no operation is in flight. Deliberately one
 * fixed word rather than a rotating label: the panel must not read as dead between tool calls,
 * and it must not invent progress either. "Working" is true for exactly as long as the model
 * is still producing this response, which is what the caller gates it on.
 */
export function v3DebugIdleWorkingText(): string {
	return localize('v3debug.status.working', "Working");
}

/** How many evidence lines the inline panel renders. The file keeps every line. */
export const V3_EVIDENCE_PANEL_MAX_LINES = 12;

/**
 * The panel's tone is the single claim it makes about the sink, and there are exactly four:
 * 'starting' (coming up), 'waiting' (up, nothing recorded yet), 'live' (up, evidence recorded)
 * and 'off' (not running, with a reason when one is known).
 */
export type V3EvidencePanelTone = 'live' | 'waiting' | 'starting' | 'off';

export interface V3EvidenceLineViewModel {
	/** 1-based line number in the evidence file — the number a verdict cites. */
	readonly index: number;
	readonly message: string;
	readonly location?: string;
	readonly data?: string;
	readonly hypothesisId?: string;
	/** False for a line the previous run recorded — kept, and shown as such. */
	readonly isThisRun: boolean;
}

export interface V3EvidencePanelViewModel {
	readonly tone: V3EvidencePanelTone;
	readonly badge: string;
	readonly summary: string;
	readonly footer?: string;
	readonly hint?: string;
	/** Offered only while nothing has been recorded: the line that proves the sink works. */
	readonly instrumentLine?: string;
	readonly logPath?: string;
	readonly lines: readonly V3EvidenceLineViewModel[];
	/** True when the tail still carries lines from an earlier run, so the view can divide them. */
	readonly hasEarlier: boolean;
}

export interface V3EvidencePanelInput {
	/**
	 * The sink's phase, taken verbatim from the session state rather than flattened into a
	 * boolean. 'starting' is a real phase with a real duration, and collapsing it into
	 * "not running" is precisely how the panel would end up lying about the sink.
	 */
	readonly phase: V3DebugSessionPhase;
	readonly endpoint?: string;
	readonly sessionId?: string;
	readonly logPath?: string;
	/** Why no sink is running, when the service knows. */
	readonly reason?: string;
	readonly lines: readonly V3DebugEvidenceLine[];
	readonly lineCount: number;
	readonly runMark: number;
	readonly maxLines?: number;
}

/**
 * The one line someone can paste into a running app to prove the sink is reachable. A single
 * line on purpose: it goes into a browser console, a scratch file, or a panel the user copies
 * from, and a multi-line snippet is the thing that gets truncated on paste.
 */
export function evidenceInstrumentLine(endpoint: string, sessionId: string): string {
	return `fetch('${endpoint}',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'${sessionId}'},body:JSON.stringify({sessionId:'${sessionId}',location:'FILE:LINE',message:'what you observed here',hypothesisId:'H1',timestamp:Date.now()})}).catch(()=>{})`;
}

/**
 * View model for the inline evidence panel — the half of Debug mode the user can actually see.
 * Pure: it never reads a file, never polls, and never claims activity the caller did not
 * observe. 'Live' means exactly "a sink is up right now"; 'Waiting' means it is up and nothing
 * has landed yet, which is a real state and must not be dressed up as progress; 'Starting'
 * means it is being brought up, which is also real and must not be dressed up as absent.
 */
export function planEvidencePanel(input: V3EvidencePanelInput): V3EvidencePanelViewModel {
	const maxLines = Math.max(1, input.maxLines ?? V3_EVIDENCE_PANEL_MAX_LINES);

	// 'starting' is the spawn plus up to a 6s handshake — long enough to read. Claiming "no
	// runtime-evidence sink is running" during it is a false statement made by the one panel
	// whose entire job is to state the sink's condition honestly, so it gets its own tone.
	if (input.phase === 'starting') {
		return {
			tone: 'starting',
			badge: localize('v3debug.evidence.badgeStarting', "Starting"),
			summary: localize('v3debug.evidence.startingSummary', "Bringing up the runtime-evidence sink…"),
			hint: localize('v3debug.evidence.startingHint', "The endpoint and the evidence file appear here as soon as it is listening."),
			lines: [],
			hasEarlier: false,
		};
	}

	if (input.phase !== 'running') {
		return {
			tone: 'off',
			badge: localize('v3debug.evidence.badgeOff', "Off"),
			summary: input.reason ?? localize('v3debug.evidence.offSummary', "No runtime-evidence sink is running."),
			hint: input.reason ? undefined : localize('v3debug.evidence.offHint', "Debug still works — it just investigates without runtime instrumentation."),
			lines: [],
			hasEarlier: false,
		};
	}

	const endpoint = input.endpoint ?? '';
	const visible = input.lines.slice(-maxLines);
	const lines: V3EvidenceLineViewModel[] = visible.map(line => ({
		index: line.index + 1,
		message: line.message,
		location: line.location,
		data: formatEvidenceData(line.data),
		hypothesisId: line.hypothesisId,
		isThisRun: !line.beforeRunMark,
	}));
	const recorded = Math.max(0, input.lineCount);
	const thisRun = Math.max(0, recorded - Math.max(0, input.runMark));
	const linesLabel = recorded === 1
		? localize('v3debug.evidence.oneLine', "1 line")
		: localize('v3debug.evidence.nLines', "{0} lines", recorded);
	const runLabel = thisRun === 0
		? localize('v3debug.evidence.runNone', "none in this run yet")
		: thisRun === 1
			? localize('v3debug.evidence.runOne', "1 in this run")
			: localize('v3debug.evidence.runN', "{0} in this run", thisRun);
	const summary = endpoint ? `${endpoint} · ${linesLabel} · ${runLabel}` : `${linesLabel} · ${runLabel}`;

	if (lines.length === 0) {
		return {
			tone: 'waiting',
			badge: localize('v3debug.evidence.badgeWaiting', "Waiting"),
			summary,
			hint: localize('v3debug.evidence.waitingHint', "Nothing has reached the endpoint yet. The first line that does appears here."),
			instrumentLine: endpoint && input.sessionId ? evidenceInstrumentLine(endpoint, input.sessionId) : undefined,
			logPath: input.logPath,
			lines,
			hasEarlier: false,
		};
	}

	return {
		tone: 'live',
		badge: localize('v3debug.evidence.badgeLive', "Live"),
		summary,
		footer: recorded > lines.length
			? localize('v3debug.evidence.tail', "Showing the last {0} of {1} lines.", lines.length, recorded)
			: undefined,
		logPath: input.logPath,
		lines,
		hasEarlier: lines.some(line => !line.isThisRun),
	};
}

/** Streamed arguments shown while a tool call is still being prepared. Text only — never markdown. */
export function formatStreamedToolInput(partialInput: unknown, maxChars = 400): string {
	let text: string;
	if (partialInput === undefined || partialInput === null) {
		return '';
	} else if (typeof partialInput === 'string') {
		text = partialInput;
	} else if (typeof partialInput === 'object') {
		text = Object.entries(partialInput as Record<string, unknown>)
			.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
			.join('\n');
	} else {
		text = String(partialInput);
	}
	text = text.trim();
	if (text.length > maxChars) {
		text = text.slice(0, maxChars) + '…';
	}
	return text;
}
