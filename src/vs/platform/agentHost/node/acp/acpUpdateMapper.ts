/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type * as acp from '@agentclientprotocol/sdk';
import type { URI } from '../../../../base/common/uri.js';
import { hasKey } from '../../../../base/common/types.js';
import type { AgentSignal, IAgentActionSignal, IAgentToolPendingConfirmationSignal } from '../../common/agentService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ResponsePartKind, ToolCallCancellationReason, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, type MarkdownResponsePart, type ReasoningResponsePart, type ResponsePart, type ToolCallResponsePart, type ToolCallState, type ToolResultContent, type Turn, type UserMessage } from '../../common/state/sessionState.js';

/**
 * Pure mapping from Agent Client Protocol `session/update` notifications to
 * agent-host signals, plus a per-turn tracker that mirrors what the host
 * reducer builds so the transcript can be persisted by the provider.
 *
 * Reducer facts this mapping relies on (see `channels-session/reducer.ts`):
 * - `SessionDelta` / `SessionReasoning` APPEND to an existing part; the
 *   first chunk must therefore create the part via `SessionResponsePart`.
 * - `SessionToolCallReady` with `confirmed` moves Streaming/Running → Running
 *   and is otherwise ignored, so re-sending it is harmless.
 * - `SessionToolCallContentChanged` REPLACES content and only applies while
 *   Running, so content is accumulated here and re-sent in full.
 * - `SessionToolCallComplete` applies from Running or PendingConfirmation.
 * - Ending a turn cancels every tool call the agent never completed.
 */

/** Host-visible permission kinds derived from an ACP tool kind. */
export type AcpPermissionKind = IAgentToolPendingConfirmationSignal['permissionKind'];

export function permissionKindForToolKind(kind: acp.ToolKind | null | undefined): AcpPermissionKind {
	switch (kind) {
		case 'edit':
		case 'delete':
		case 'move':
			return 'write';
		case 'read':
		case 'search':
			return 'read';
		case 'execute':
			return 'shell';
		case 'fetch':
			return 'url';
		default:
			return undefined;
	}
}

export interface IAcpToolCallRecord {
	readonly toolCallId: string;
	title: string;
	kind: acp.ToolKind | undefined;
	status: acp.ToolCallStatus;
	content: ToolResultContent[];
	locations: acp.ToolCallLocation[];
	rawInput: unknown;
	rawOutput: unknown;
	/** `SessionToolCallReady` (or the permission card) has been emitted. */
	ready: boolean;
	/** `SessionToolCallComplete` has been emitted. */
	completed: boolean;
	/** A `session/request_permission` is outstanding for this call. */
	permissionPending: boolean;
}

const PLAN_TOOL_CALL_PREFIX = 'acp-plan-';

function rawInputToString(rawInput: unknown): string | undefined {
	if (rawInput === undefined || rawInput === null) {
		return undefined;
	}
	if (typeof rawInput === 'string') {
		return rawInput;
	}
	try {
		return JSON.stringify(rawInput, undefined, 2);
	} catch {
		return String(rawInput);
	}
}

/** Best-effort extraction of a shell command string from a tool call's raw input. */
export function commandFromRawInput(rawInput: unknown): string | undefined {
	if (typeof rawInput === 'string') {
		return rawInput;
	}
	if (typeof rawInput === 'object' && rawInput !== null) {
		const record = rawInput as Record<string, unknown>;
		for (const key of ['command', 'cmd', 'commandLine', 'script']) {
			const value = record[key];
			if (typeof value === 'string' && value.trim().length > 0) {
				return value;
			}
			if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
				return (value as string[]).join(' ');
			}
		}
	}
	return undefined;
}

export function contentBlockToText(block: acp.ContentBlock): string {
	switch (block.type) {
		case 'text':
			return block.text;
		case 'image':
			return `[image ${block.mimeType}]`;
		case 'audio':
			return `[audio ${block.mimeType}]`;
		case 'resource_link':
			return `[${block.name}](${block.uri})`;
		case 'resource': {
			const resource = block.resource;
			if (hasKey(resource, { text: true }) && typeof resource.text === 'string') {
				return resource.text;
			}
			return `[resource ${resource.uri}]`;
		}
		default:
			return '';
	}
}

function summarizeDiff(diff: acp.Diff): string {
	const header = diff.oldText === undefined || diff.oldText === null ? `Create ${diff.path}` : `Edit ${diff.path}`;
	const oldLines = diff.oldText ? diff.oldText.split('\n').length : 0;
	const newLines = diff.newText.split('\n').length;
	return `${header} (${oldLines} → ${newLines} lines)`;
}

export function toolCallContentToResult(content: readonly acp.ToolCallContent[] | null | undefined): ToolResultContent[] {
	const out: ToolResultContent[] = [];
	for (const block of content ?? []) {
		switch (block.type) {
			case 'content': {
				const text = contentBlockToText(block.content);
				if (text) {
					out.push({ type: ToolResultContentType.Text, text });
				}
				break;
			}
			case 'diff':
				out.push({ type: ToolResultContentType.Text, text: summarizeDiff(block) });
				break;
			case 'terminal':
				out.push({ type: ToolResultContentType.Text, text: `Terminal ${block.terminalId}` });
				break;
		}
	}
	return out;
}

export function planToMarkdown(entries: readonly acp.PlanEntry[]): string {
	if (entries.length === 0) {
		return '_(empty plan)_';
	}
	return entries.map(entry => {
		const box = entry.status === 'completed' ? '[x]' : entry.status === 'in_progress' ? '[~]' : '[ ]';
		return `- ${box} ${entry.content}`;
	}).join('\n');
}

/**
 * Tracks one prompt turn: which parts exist, which tool calls are in which
 * state, and a mirrored `responseParts` array for transcript persistence.
 */
export class AcpTurnTracker {

	readonly responseParts: ResponsePart[] = [];

	private _markdownPart: MarkdownResponsePart | undefined;
	private _reasoningPart: ReasoningResponsePart | undefined;
	private readonly _toolCalls = new Map<string, IAcpToolCallRecord>();
	private readonly _toolCallParts = new Map<string, ToolCallResponsePart>();
	private _partCounter = 0;
	private _planStarted = false;

	constructor(
		readonly session: URI,
		readonly turnId: string,
		readonly userMessage: UserMessage,
	) { }

	get toolCalls(): ReadonlyMap<string, IAcpToolCallRecord> {
		return this._toolCalls;
	}

	getToolCall(toolCallId: string): IAcpToolCallRecord | undefined {
		return this._toolCalls.get(toolCallId);
	}

	/** Most recent tool call the agent has not completed yet, if any. */
	get currentToolCall(): IAcpToolCallRecord | undefined {
		let last: IAcpToolCallRecord | undefined;
		for (const record of this._toolCalls.values()) {
			if (!record.completed) {
				last = record;
			}
		}
		return last;
	}

	private _nextPartId(prefix: string): string {
		return `${prefix}-${this.turnId}-${++this._partCounter}`;
	}

	private _action(action: IAgentActionSignal['action']): IAgentActionSignal {
		return { kind: 'action', session: this.session, action };
	}

	/** Any non-text event ends the current markdown/reasoning streams. */
	private _breakTextStreams(): void {
		this._markdownPart = undefined;
		this._reasoningPart = undefined;
	}

	appendMarkdown(text: string): AgentSignal[] {
		if (!text) {
			return [];
		}
		this._reasoningPart = undefined;
		if (!this._markdownPart) {
			const part: MarkdownResponsePart = { kind: ResponsePartKind.Markdown, id: this._nextPartId('md'), content: text };
			this._markdownPart = part;
			this.responseParts.push(part);
			return [this._action({ type: ActionType.SessionResponsePart, turnId: this.turnId, part: { ...part } })];
		}
		this._markdownPart.content += text;
		return [this._action({ type: ActionType.SessionDelta, turnId: this.turnId, partId: this._markdownPart.id, content: text })];
	}

	appendReasoning(text: string): AgentSignal[] {
		if (!text) {
			return [];
		}
		this._markdownPart = undefined;
		if (!this._reasoningPart) {
			const part: ReasoningResponsePart = { kind: ResponsePartKind.Reasoning, id: this._nextPartId('rs'), content: text };
			this._reasoningPart = part;
			this.responseParts.push(part);
			return [this._action({ type: ActionType.SessionResponsePart, turnId: this.turnId, part: { ...part } })];
		}
		this._reasoningPart.content += text;
		return [this._action({ type: ActionType.SessionReasoning, turnId: this.turnId, partId: this._reasoningPart.id, content: text })];
	}

	private _setToolCallState(record: IAcpToolCallRecord, state: ToolCallState): void {
		const part = this._toolCallParts.get(record.toolCallId);
		if (part) {
			part.toolCall = state;
		}
	}

	private _toolCallBase(record: IAcpToolCallRecord) {
		return {
			toolCallId: record.toolCallId,
			toolName: record.kind ?? 'other',
			displayName: record.title,
			_meta: record.kind ? { toolKind: record.kind } : undefined,
		};
	}

	/** Registers a tool call (idempotent) and returns the `SessionToolCallStart` signal when new. */
	startToolCall(toolCall: acp.ToolCall | acp.ToolCallUpdate): { record: IAcpToolCallRecord; signals: AgentSignal[] } {
		const existing = this._toolCalls.get(toolCall.toolCallId);
		if (existing) {
			return { record: existing, signals: [] };
		}
		this._breakTextStreams();
		const record: IAcpToolCallRecord = {
			toolCallId: toolCall.toolCallId,
			title: toolCall.title ?? toolCall.toolCallId,
			kind: toolCall.kind ?? undefined,
			status: toolCall.status ?? 'pending',
			content: toolCallContentToResult(toolCall.content),
			locations: [...(toolCall.locations ?? [])],
			rawInput: toolCall.rawInput,
			rawOutput: toolCall.rawOutput,
			ready: false,
			completed: false,
			permissionPending: false,
		};
		this._toolCalls.set(record.toolCallId, record);
		const base = this._toolCallBase(record);
		const part: ToolCallResponsePart = { kind: ResponsePartKind.ToolCall, toolCall: { status: ToolCallStatus.Streaming, ...base } };
		this._toolCallParts.set(record.toolCallId, part);
		this.responseParts.push(part);
		return {
			record,
			signals: [this._action({ type: ActionType.SessionToolCallStart, turnId: this.turnId, ...base })],
		};
	}

	/** Marks the call Running without confirmation (agent proceeded on its own). */
	readyToolCall(record: IAcpToolCallRecord): AgentSignal[] {
		if (record.ready) {
			return [];
		}
		record.ready = true;
		const toolInput = rawInputToString(record.rawInput);
		this._setToolCallState(record, {
			status: ToolCallStatus.Running,
			...this._toolCallBase(record),
			invocationMessage: record.title,
			toolInput,
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
		return [this._action({
			type: ActionType.SessionToolCallReady,
			turnId: this.turnId,
			toolCallId: record.toolCallId,
			invocationMessage: record.title,
			toolInput,
			confirmed: ToolCallConfirmationReason.NotNeeded,
		})];
	}

	/**
	 * Builds the `pending_confirmation` signal for a permission request. The
	 * host decides between auto-approval and a confirmation card; either way
	 * the tool call is Ready afterwards.
	 */
	requestPermission(record: IAcpToolCallRecord, confirmationTitle: string): AgentSignal[] {
		record.ready = true;
		record.permissionPending = true;
		const permissionKind = permissionKindForToolKind(record.kind);
		const permissionPath = record.locations[0]?.path;
		const toolInput = permissionKind === 'shell' ? commandFromRawInput(record.rawInput) : rawInputToString(record.rawInput);
		this._setToolCallState(record, {
			status: ToolCallStatus.PendingConfirmation,
			...this._toolCallBase(record),
			invocationMessage: record.title,
			toolInput,
			confirmationTitle,
		});
		const signal: IAgentToolPendingConfirmationSignal = {
			kind: 'pending_confirmation',
			session: this.session,
			state: {
				status: ToolCallStatus.PendingConfirmation,
				...this._toolCallBase(record),
				invocationMessage: record.title,
				toolInput,
				confirmationTitle,
			},
			permissionKind,
			permissionPath,
		};
		return [signal];
	}

	permissionAnswered(record: IAcpToolCallRecord, approved: boolean): void {
		record.permissionPending = false;
		if (approved) {
			this._setToolCallState(record, {
				status: ToolCallStatus.Running,
				...this._toolCallBase(record),
				invocationMessage: record.title,
				toolInput: rawInputToString(record.rawInput),
				confirmed: ToolCallConfirmationReason.UserAction,
			});
		}
	}

	/** Re-sends the full accumulated content of a running call. */
	contentChanged(record: IAcpToolCallRecord): AgentSignal[] {
		if (!record.ready || record.completed) {
			return [];
		}
		const part = this._toolCallParts.get(record.toolCallId);
		if (part && part.toolCall.status === ToolCallStatus.Running) {
			part.toolCall = { ...part.toolCall, content: [...record.content] };
		}
		return [this._action({
			type: ActionType.SessionToolCallContentChanged,
			turnId: this.turnId,
			toolCallId: record.toolCallId,
			content: [...record.content],
		})];
	}

	/** Adds host-produced content (for example a tracked file edit) to a running call. */
	appendToolCallContent(record: IAcpToolCallRecord, content: ToolResultContent): AgentSignal[] {
		record.content.push(content);
		return this.contentChanged(record);
	}

	completeToolCall(record: IAcpToolCallRecord, success: boolean, errorMessage?: string): AgentSignal[] {
		if (record.completed) {
			return [];
		}
		const signals: AgentSignal[] = [];
		if (!record.ready) {
			signals.push(...this.readyToolCall(record));
		}
		record.completed = true;
		record.permissionPending = false;
		const result = {
			success,
			pastTenseMessage: record.title,
			content: [...record.content],
			...(errorMessage ? { error: { message: errorMessage } } : {}),
		};
		this._setToolCallState(record, {
			status: ToolCallStatus.Completed,
			...this._toolCallBase(record),
			invocationMessage: record.title,
			toolInput: rawInputToString(record.rawInput),
			confirmed: ToolCallConfirmationReason.NotNeeded,
			...result,
		});
		signals.push(this._action({ type: ActionType.SessionToolCallComplete, turnId: this.turnId, toolCallId: record.toolCallId, result }));
		return signals;
	}

	applyToolCallUpdate(update: acp.ToolCallUpdate): AgentSignal[] {
		const { record, signals } = this.startToolCall(update);
		if (update.title) {
			record.title = update.title;
		}
		if (update.kind) {
			record.kind = update.kind;
		}
		if (update.locations) {
			record.locations = [...update.locations];
		}
		if (update.rawInput !== undefined) {
			record.rawInput = update.rawInput;
		}
		if (update.rawOutput !== undefined) {
			record.rawOutput = update.rawOutput;
		}
		let contentChanged = false;
		if (update.content) {
			record.content = toolCallContentToResult(update.content);
			contentChanged = true;
		}
		// A missing status means "unchanged" — never infer completion from it.
		if (update.status) {
			record.status = update.status;
		}
		if (record.status === 'in_progress' && !record.ready && !record.permissionPending) {
			signals.push(...this.readyToolCall(record));
		}
		if (record.status === 'completed') {
			signals.push(...this.completeToolCall(record, true));
			return signals;
		}
		if (record.status === 'failed') {
			const error = typeof record.rawOutput === 'string' ? record.rawOutput : undefined;
			signals.push(...this.completeToolCall(record, false, error));
			return signals;
		}
		if (contentChanged) {
			signals.push(...this.contentChanged(record));
		}
		return signals;
	}

	/** Renders the agent's plan as a live "Plan" card that updates in place. */
	applyPlan(entries: readonly acp.PlanEntry[]): AgentSignal[] {
		const toolCallId = `${PLAN_TOOL_CALL_PREFIX}${this.turnId}`;
		const markdown = planToMarkdown(entries);
		const signals: AgentSignal[] = [];
		let record = this._toolCalls.get(toolCallId);
		if (!record) {
			const started = this.startToolCall({ toolCallId, title: 'Plan', kind: 'think', status: 'in_progress' });
			record = started.record;
			signals.push(...started.signals);
			signals.push(...this.readyToolCall(record));
			this._planStarted = true;
		}
		record.content = [{ type: ToolResultContentType.Text, text: markdown }];
		signals.push(...this.contentChanged(record));
		const allDone = entries.length > 0 && entries.every(e => e.status === 'completed');
		if (allDone) {
			signals.push(...this.completeToolCall(record, true));
		}
		return signals;
	}

	/** Settles the plan card (if any) when the turn ends. */
	finishPlan(): AgentSignal[] {
		if (!this._planStarted) {
			return [];
		}
		const record = this._toolCalls.get(`${PLAN_TOOL_CALL_PREFIX}${this.turnId}`);
		return record ? this.completeToolCall(record, true) : [];
	}

	/** Snapshot of the turn for the persisted transcript. */
	toTurn(state: TurnState, error?: { errorType: string; message: string }): Turn {
		return {
			id: this.turnId,
			userMessage: this.userMessage,
			responseParts: this.responseParts.map(part => part.kind === ResponsePartKind.ToolCall ? { kind: part.kind, toolCall: settleToolCallState(part.toolCall) } : { ...part }),
			usage: undefined,
			state,
			error,
		};
	}
}

/** Mirrors the reducer's end-of-turn rule: anything not finished is Cancelled/Skipped. */
function settleToolCallState(tc: ToolCallState): ToolCallState {
	if (tc.status === ToolCallStatus.Completed || tc.status === ToolCallStatus.Cancelled) {
		return tc;
	}
	return {
		status: ToolCallStatus.Cancelled,
		toolCallId: tc.toolCallId,
		toolName: tc.toolName,
		displayName: tc.displayName,
		_meta: tc._meta,
		invocationMessage: tc.status === ToolCallStatus.Streaming ? (tc.invocationMessage ?? '') : tc.invocationMessage,
		toolInput: tc.status === ToolCallStatus.Streaming ? undefined : tc.toolInput,
		reason: ToolCallCancellationReason.Skipped,
	};
}

/**
 * Maps one `session/update` payload to host signals. Updates that only carry
 * session-level metadata (modes, config options, commands, usage,
 * compaction) produce no signals here; the session owner reads them from
 * the notification directly.
 */
export function mapSessionUpdate(update: acp.SessionUpdate, tracker: AcpTurnTracker): AgentSignal[] {
	switch (update.sessionUpdate) {
		case 'agent_message_chunk':
			return tracker.appendMarkdown(contentBlockToText(update.content));
		case 'agent_thought_chunk':
			return tracker.appendReasoning(contentBlockToText(update.content));
		case 'tool_call': {
			const { record, signals } = tracker.startToolCall(update);
			if (record.status === 'in_progress') {
				signals.push(...tracker.readyToolCall(record));
				if (record.content.length > 0) {
					signals.push(...tracker.contentChanged(record));
				}
			} else if (record.status === 'completed') {
				signals.push(...tracker.completeToolCall(record, true));
			} else if (record.status === 'failed') {
				signals.push(...tracker.completeToolCall(record, false));
			}
			return signals;
		}
		case 'tool_call_update':
			return tracker.applyToolCallUpdate(update);
		case 'plan':
			return tracker.applyPlan(update.entries);
		case 'session_info_update':
			return update.title
				? [{ kind: 'action', session: tracker.session, action: { type: ActionType.SessionTitleChanged, title: update.title } }]
				: [];
		case 'user_message_chunk':
		case 'available_commands_update':
		case 'current_mode_update':
		case 'config_option_update':
		case 'usage_update':
		case 'plan_update':
		case 'plan_removed':
		case 'compaction_update':
		case 'compaction_summary_chunk':
		default:
			return [];
	}
}

export interface IStopOutcome {
	readonly signals: AgentSignal[];
	readonly turnState: TurnState;
	readonly error?: { errorType: string; message: string };
}

/** Maps the `session/prompt` result to the signal that ends the host turn. */
export function mapStopReason(stopReason: acp.StopReason, tracker: AcpTurnTracker): IStopOutcome {
	const signals: AgentSignal[] = [...tracker.finishPlan()];
	const action = (a: IAgentActionSignal['action']): IAgentActionSignal => ({ kind: 'action', session: tracker.session, action: a });
	switch (stopReason) {
		case 'end_turn':
			signals.push(action({ type: ActionType.SessionTurnComplete, turnId: tracker.turnId }));
			return { signals, turnState: TurnState.Complete };
		case 'cancelled':
			signals.push(action({ type: ActionType.SessionTurnCancelled, turnId: tracker.turnId }));
			return { signals, turnState: TurnState.Cancelled };
		case 'max_tokens':
		case 'max_turn_requests':
		case 'refusal':
		default: {
			const message = stopReason === 'refusal'
				? 'The agent declined to continue this turn.'
				: stopReason === 'max_tokens'
					? 'The agent stopped because it reached its token limit.'
					: stopReason === 'max_turn_requests'
						? 'The agent stopped because it reached its request limit for this turn.'
						: `The agent stopped (${stopReason}).`;
			const error = { errorType: `acp_stop_${stopReason}`, message };
			signals.push(action({ type: ActionType.SessionError, turnId: tracker.turnId, error }));
			return { signals, turnState: TurnState.Error, error };
		}
	}
}
