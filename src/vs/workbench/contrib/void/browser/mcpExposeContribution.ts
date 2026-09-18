/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// === CHAT SURFACE: MCP_CHAT ===
// Engine: NATIVE (IChatWidgetService + IChatService). The MCP send_chat/get_chat tools now
// drive the SAME native chat the user's visible sidebar renders — an MCP turn reveals the
// sidebar widget, calls acceptInput (exactly what typing + Enter does), and streams live
// (native tool cards + reasoning) while returning the transcript to the MCP caller. The
// legacy IChatThreadService is kept ONLY for run_subagent (launchSubagent). See CHAT_SURFACES_MAP.md.

/**
 * Renderer side of "V3Code as an MCP server".
 *
 * The MCP server itself lives in the main process (it binds a TCP port — see
 * electron-main/v3codeMcpServerChannel.ts). But the actual tools run HERE, in
 * the renderer, where IToolsService, the LSP context bridge, the semantic index
 * and the notes store all live. So this contribution:
 *
 *   1. registers a callback channel (`void-channel-toolHost`) that the
 *      main-process server calls INTO to list/run tools, and
 *   2. announces this window to the main server (handing it our IPC ctx so it
 *      can route back to us) which also triggers the server to start.
 *
 * This mirrors the proven McpGatewayToolBroker pattern
 * (workbench/contrib/mcp/electron-browser/mcpGatewayToolBrokerContribution.ts).
 */

import { Event } from '../../../../base/common/event.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';
import { IExternalAgentsService } from '../common/externalAgentsService.js';
import { MCP_BROWSER_TOOLS } from '../common/mcpExpose/browserTools.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { timeout } from '../../../../base/common/async.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { localize2 } from '../../../../nls.js';

import { IChatWidget, IChatWidgetService, ChatViewPaneTarget } from '../../chat/browser/chat.js';
import { IChatService, IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../chat/common/chatService/chatService.js';
import { IChatModel, IChatResponseModel, IResponse } from '../../chat/common/model/chatModel.js';
import { IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';

import { IToolsService, ToolCallContext } from './toolsService.js';
import { IBeastService } from './beastService.js';
import { IMemoryService } from './memoryService.js';
import { IChatThreadService } from './chatThreadService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { FeatureName } from '../common/voidSettingsTypes.js';
import { boundMcpText } from '../common/mcpExpose/localCollaboration.js';
import { acceptReviewJob, reviewChatTail } from '../common/mcpExpose/reviewTools.js';
import { builtinTools, inputSchemaOfTool } from '../common/prompt/prompts.js';
import { BuiltinToolName } from '../common/toolsServiceTypes.js';
import {
	V3CODE_MCP_EXPOSE_CHANNEL,
	V3CODE_MCP_TOOLHOST_CHANNEL,
	ExposedToolDescriptor,
	McpExposeEndpoint,
	ToolHostCallPayload,
	ToolHostCallResult,
} from '../common/mcpExpose/mcpExposeTypes.js';

// Explicit allowlist of the read-only "intelligence" tools we expose. We do NOT
// auto-expose every read-only tool — this list is deliberately curated so we
// never surface edits/terminal/git-write/subagent tools over the open endpoint.
const READ_TOOLS: BuiltinToolName[] = [
	'read_file',
	'ls_dir',
	'git_diff',
	'git_log',
	'semantic_search',
	'pack_context',
	'get_symbol_context',
	'get_call_graph',
	'get_file_context',
	'get_file_dependencies',
	'get_project_briefing',
	'find_text',
	'list_notes',
	'search_notes',
	'workspace_delta',
	// Pull-first memory search and bounded checkpoint expansion.
	'search_memory',
	'get_memory_checkpoint',
	// Shadow archive break-glass dig (read-only) — lets an external agent recover memory
	// that decayed/was never curated, then fetch the full raw record.
	'deep_recall',
	'get_shadow_record',
	// Self-check: the editor's live workspace error list (no recompile).
	'get_build_errors',
	// Self-check: which files changed in the working tree this session (read-only git status).
	'session_diff',
	// Discovery reliability: code-search index health + opt-in background re-scan.
	'index_health',
	// Recent edits journal — what was just changed (so the agent doesn't re-edit it).
	'recent_edits',
	// Team board (read side): external agents see who is working where before editing.
	'team_board',
];

// Memory writes — separated so a setting can gate them later. Exposed by default
// in v1 (it's the user's own machine and the whole point is the memory boost).
const WRITE_TOOLS: BuiltinToolName[] = [
	'remember',
	'forget',
	'recover_session_anchors',
	// Team board (write side): external agents (terminal, other editors' agents) check in on
	// the same shared board the in-editor agent and its subagents use, so every agent touching
	// this workspace can see — and avoid — everyone else.
	'team_checkin',
	// Frozen shared decisions (read side flows through team_board, already exposed).
	'team_contract',
];

// External agents decide whether to use MCP largely from the listTools descriptions. Put the
// editor-intelligence routing rule at the decision point instead of hoping every client loaded
// a separate skill first. The original descriptions remain appended for parameter semantics.
//
// Each hint leads with a WHEN clause naming a concrete situation, because that is what an agent
// matches against mid-task. `initialize` instructions are read once at session start and fade;
// these descriptions are re-read at EVERY tool-selection decision, so this is the durable
// surface — the floor under the instructions' ceiling. Keep the "WHEN:" prefix on memory tools:
// without a trigger they read as optional extras and go uncalled, which is exactly the failure
// this map exists to fix.
const MCP_FIRST_HINTS: Partial<Record<BuiltinToolName, string>> = {
	semantic_search: 'PREFERRED for conceptual "where/how" exploration; use before broad text search or filesystem grep.',
	pack_context: 'PREFERRED when you know a file and symbol; use before reading the whole file. Returns the definition plus callers, callees, and references from live editor intelligence.',
	get_symbol_context: 'PREFERRED for exact symbol understanding; use before manually collecting references with grep.',
	get_file_context: 'PREFERRED for a structural map of one file; use before reading it linearly when you do not yet know the target symbol.',
	get_file_dependencies: 'PREFERRED for imports/dependents and change impact; use before manually chasing import strings.',
	get_build_errors: 'Use after edits to read the editor\'s live diagnostics before falling back to a full build.',
	search_memory: 'WHEN: the user references the past ("we decided", "last time", "you said", "why is it like this"), you are about to state a project convention or architectural decision, you are about to redo work that may already exist, or you are about to contradict something. This workspace has an INDEXED history of prior sessions, decisions, and corrections that is NOT in your context — you only see it by calling this. Answering from assumption when that history exists is the most expensive mistake here. Returns dated evidence, never current instructions.',
	get_memory_checkpoint: 'WHEN: a search_memory hit looks decisive and you need proof before acting on it. Expands one compaction checkpoint into its exact persisted source events (paginated). Use for "show me what was actually said/decided", not for browsing.',
	deep_recall: 'LAST RESORT for history: try search_memory first. Use only when search_memory returns nothing and you have concrete reason to believe the memory exists (older than the index, or never curated).',
	list_notes: 'Durable symbol-attached notes saved by past sessions — read before assuming how a symbol behaves.',
	search_notes: 'Keyword search across durable symbol notes; faster than paging list_notes when you know the term.',
	remember: 'WHEN: the user corrects you, states a preference or constraint, or you discover a non-obvious gotcha. Save it immediately against the symbol — do not wait to be asked, and do not batch it to the end of the task. This is why the next session starts smarter.',
	recover_session_anchors: 'GUARDED RECOVERY only when continuity reports missing anchors after a workspace transition. Prefer recorded thread origins; require explicit confirmation before attributing legacy threadless notes/editorial or an unrecorded origin.',
};

// Starts a read-only research job and returns its handle without awaiting completion.
// Status and findings remain available through the separate polling tools.
type SubagentRunner = (opts: { description: string; prompt: string }) => Promise<{ job_id?: string; result: string; status: string }>;

// The "drive the real open chat" loop. send_chat injects a message into the
// currently-open chat thread (the same path the sidebar UI uses, so it renders
// live + uses the user's selected model), fires the agent, waits for the turn to
// settle, and returns the produced transcript. get_chat just reads the thread.
export type ChatTurnStatus = 'completed' | 'awaiting_user' | 'error' | 'timeout';
type ChatSender = (opts: { message: string; threadId?: string; timeoutMs?: number; autoApprove?: boolean; newThread?: boolean }) => Promise<{ status: ChatTurnStatus; text: string }>;
type ChatReader = (opts: { threadId?: string; format?: 'json' | 'markdown'; lastN?: number; maxChars?: number }) => Promise<{ status: 'ok' | 'error'; text: string }>;
type ChatCanceller = (opts: { threadId?: string }) => Promise<{ status: 'ok' | 'error'; text: string }>;

/**
 * Structured get_chat(format:"json") snapshot. This is a CONTRACT: the v-go phone adapter
 * parses this exact shape, so field names/semantics must not drift. running: null = no turn live.
 * Tool calls are their own role:'tool' message (one entry in `tools`), matching the transcript order.
 */
interface ChatSnapshotTool { name: string; type: string; params: unknown; result: string }
interface ChatSnapshotMessage { role: 'user' | 'assistant' | 'tool' | 'system'; content: string; thinking?: string; tools: ChatSnapshotTool[] }
interface ChatSnapshot {
	threadId: string;
	model: string;
	running: 'LLM' | 'tool' | 'awaiting_user' | 'idle' | null;
	messages: ChatSnapshotMessage[];
	partial: { thinking?: string; content?: string };
}

const booleanArg = (value: unknown): boolean => value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
const numberArg = (value: unknown): number | undefined => {
	const parsed = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN);
	return Number.isFinite(parsed) ? parsed : undefined;
};


// Custom (non-builtin) MCP tool: one-call session orient. Bundles briefing + index
// health so agents stop skipping the "what state is this project in?" step.
const ORIENT_TOOL: ExposedToolDescriptor = {
	name: 'orient',
	description: 'Compact workspace identity, index readiness and memory availability. For an outside-agent notebook and inbox use agent_session resume. Set detailed=true only when you need the longer project briefing.',
	inputSchema: {
		type: 'object',
		properties: {
			include_notes: { type: 'boolean', default: true, description: 'Whether to include saved symbol notes in the briefing. Defaults to true.' },
			detailed: { type: 'boolean', default: false },
		},
		additionalProperties: false,
	},
};

// Custom (non-builtin) MCP tool: lets an external agent delegate a self-contained
// research/analysis task INTO the editor, where it runs against the live workspace
// with the user's own model. This is the force-multiplier tool.
const SUBAGENT_TOOL: ExposedToolDescriptor = {
	name: 'run_subagent',
	description: 'Start a READ-ONLY research worker on the editor model. Returns job_id immediately, without waiting for completion. Poll subagent_status for progress and subagent_result for findings; subagent_cancel stops it. The worker cannot edit files or run terminal commands. Keep the same project/window binding when polling. Jobs belong to the current editor runtime; a reload may interrupt them.',
	inputSchema: {
		type: 'object',
		properties: {
			prompt: { type: 'string', description: 'The full, self-contained instruction for the subagent. It has no memory of your conversation — include all needed context.' },
			description: { type: 'string', description: 'Optional short label for the task (e.g. "find all callers of X").' },
		},
		required: ['prompt'],
		additionalProperties: false,
	},
};

const SUBAGENT_JOB_TOOLS: ExposedToolDescriptor[] = ['subagent_status', 'subagent_result', 'subagent_cancel'].map(name => ({
	name,
	description: name === 'subagent_cancel' ? 'Cancel an external research job by job_id; never cancels the user chat.' : 'Read an external research job status, live activity and available findings. A running job is not a completed result. Unknown IDs fail explicitly; keep the launching project/window binding.',
	inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
}));

// Custom (non-builtin) MCP tool: drive the user's REAL open chat. This is the
// remote testing/debugging loop — an outside agent (Claude Code, etc.) types a
// message into the live chat, the V3Code agent runs on the user's selected model
// (rendering live in the editor's chat panel), and the assistant reply + reasoning
// + tool calls come back. Pair with get_chat to poll a long-running turn.
const SEND_CHAT_TOOL: ExposedToolDescriptor = {
	name: 'send_chat',
	description: 'Drive the user\'s REAL open V3Code chat. Sends a message into the currently-open chat thread (or a fresh one — see new_thread), fires the agent on the user\'s selected model, waits for the turn to finish, and returns the assistant reply + reasoning + tool calls. The turn renders live in the editor\'s chat panel (the user sees it and the model picked). By DEFAULT it continues the same conversation, so repeated calls are a multi-turn chat with full prior context. Use this to test/debug what the agent actually does and thinks. If a turn pauses for tool approval it returns status "awaiting_user" — pass auto_approve:true for unattended loops.',
	inputSchema: {
		type: 'object',
		properties: {
			message: { type: 'string', description: 'The message to type into the chat and send.' },
			thread_id: { type: 'string', description: 'Optional. Target a specific chat session by its resource-URI id — the exact string returned in the "thread ..." header of a prior send_chat/get_chat transcript. Defaults to the currently-open sidebar chat.' },
			new_thread: { type: 'boolean', default: false, description: 'Start a FRESH chat (New Chat in the visible sidebar — clean context, no prior memory) before sending. Defaults to false. Ignores thread_id when true.' },
			timeout_ms: { type: 'integer', minimum: 1, maximum: 600_000, default: 180_000, description: 'Maximum milliseconds to wait for the turn to finish. On expiry the turn is aborted and status is "timeout".' },
			auto_approve: { type: 'boolean', default: false, description: 'Auto-approve tool-approval prompts so an unattended loop does not stall. Defaults to false.' },
		},
		required: ['message'],
		additionalProperties: false,
	},
};

// Custom (non-builtin) MCP tool: read the live chat without sending. For polling
// while a turn streams, or inspecting state when a turn is awaiting_user.
const GET_CHAT_TOOL: ExposedToolDescriptor = {
	name: 'get_chat',
	description: 'Read a bounded tail of the user\'s currently-open V3Code chat thread, including whether a turn is running and available partial output. Use last_n and max_chars to control size. Read-only — inspect state without sending a message.',
	inputSchema: {
		type: 'object',
		properties: {
			last_n: { type: 'integer', minimum: 1, maximum: 100, default: 10, description: 'Return the last N request/response turns, not the full history.' },
			max_chars: { type: 'integer', minimum: 1000, maximum: 60000, default: 24000, description: 'Response character budget. Truncation is reported; JSON stays valid.' },
			thread_id: { type: 'string', description: 'Optional. Read a specific chat session by its resource-URI id (the string returned in a send_chat/get_chat "thread ..." header); defaults to the currently-open sidebar chat.' },
			format: { type: 'string', enum: ['json', 'markdown'], default: 'markdown', description: '"json" for a structured snapshot { threadId, model, running, messages[], partial } or "markdown" for the readable transcript.' },
		},
		additionalProperties: false,
	},
};

// Custom (non-builtin) MCP tool: abort the running turn in the user's open chat.
const CANCEL_CHAT_TOOL: ExposedToolDescriptor = {
	name: 'cancel_chat',
	description: 'Abort the currently-running turn in the user\'s V3Code chat. Targets thread_id when supplied, otherwise the currently-open thread. Returns {"status":"ok"} on success, or {"status":"error","message":...} if there is no such thread.',
	inputSchema: {
		type: 'object',
		properties: {
			thread_id: { type: 'string', description: 'Optional. Abort a specific chat session by its resource-URI id; defaults to the currently-open sidebar chat.' },
		},
		additionalProperties: false,
	},
};

// Custom (non-builtin) MCP tools backed by the beast sidecar (Phase C). These
// live here — not in builtinTools — because they answer from the native
// trigram/tag index in ~ms, offline, independent of the semantic index.
const SYMBOL_LOOKUP_TOOL: ExposedToolDescriptor = {
	name: 'symbol_lookup',
	description: 'Instant def/ref lookup from the beast sidecar\'s tree-sitter tag index: where is SYMBOL defined and who references it, answered in milliseconds without the language server. Use when you know a symbol name and want its definition site or callers. Complements semantic_search (conceptual queries) — this is the exact-symbol tool.',
	inputSchema: {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'The exact symbol name (function, class, type, const).' },
			defs_only: { type: 'boolean', default: false, description: 'Return only definition sites. Defaults to false, which returns definitions and references.' },
		},
		required: ['name'],
		additionalProperties: false,
	},
};

const IMPACT_TRACE_TOOL: ExposedToolDescriptor = {
	name: 'impact_trace',
	description: 'Blast-radius analysis from the beast sidecar\'s dependency graph: what files (transitively) depend on a FILE or SYMBOL — i.e. what could break if it changes. Each impacted file names the symbol and hop distance. Use before refactors, or to understand how central a piece of code is. Hub files (depended on by a large share of the repo) are flagged but not traversed through.',
	inputSchema: {
		type: 'object',
		properties: {
			target: { type: 'string', description: 'A file path (or unique path suffix) or an exact symbol name.' },
			depth: { type: 'integer', minimum: 1, default: 2, description: 'Maximum hops to ripple out. Defaults to 2.' },
		},
		required: ['target'],
		additionalProperties: false,
	},
};

/** IServerChannel the main-process MCP server calls into to list/run tools. */
class ToolHostChannel implements IServerChannel {

	constructor(
		private readonly toolsService: IToolsService,
		private readonly logService: ILogService,
		private readonly exposeWrites: () => boolean,
		private readonly exposeSubagents: () => boolean,
		private readonly runSubagent: SubagentRunner,
		private readonly exposeChat: () => boolean,
		private readonly sendChat: ChatSender,
		private readonly readChat: ChatReader,
		private readonly cancelChat: ChatCanceller,
		private readonly beastService: IBeastService,
		private readonly memoryService: IMemoryService,
		private readonly workspace: IWorkspaceContextService,
		private readonly dialogService: IDialogService,
		private readonly workingCopyService: IWorkingCopyService,
		private readonly isBusy: () => boolean,
		private readonly inspectSubagent: (id: string, cancel: boolean) => Promise<Record<string, unknown>>,
		private readonly nativeToolsService: ILanguageModelToolsService,
		private readonly externalAgents: IExternalAgentsService,
	) { }

	listen(_ctx: unknown, event: string): Event<any> {
		throw new Error(`[v3code-toolhost] no events to listen to: ${event}`);
	}

	async call(_ctx: unknown, command: string, params?: any): Promise<any> {
		if (command === 'managedBrowserConsent') {
			this.checkRoots(params.expectedRoots);
			const state = this.externalAgents.state;
			return state.hostEnabled && state.catalogue.enabledIds.includes(params.agentId)
				&& state.catalogue.agents.some(entry => entry.id === params.agentId && entry.browserAccess === true);
		}
		if (command === 'listTools') {
			return this._listTools();
		}
		if (command === 'callTool') {
			const p = params as ToolHostCallPayload;
			this.checkRoots(p.expectedRoots);
			const result = await this._callTool(p?.name, p?.args ?? {}, p.browserApproved === true);
			this.checkRoots(p.expectedRoots);
			return result;
		}
		if (command === 'switchProject') {
			this.checkRoots(params.expectedRoots);
			if (this.workingCopyService.hasDirty || this.isBusy()) { throw new Error('Workspace is dirty or an agent is running; finish/save work before switching. Nothing changed.'); }
			const approval = await this.dialogService.confirm({ message: 'An external agent wants to change this workspace', detail: `${params.mode}: ${params.path}\nExisting notebook memory stays in its original project.`, primaryButton: 'Change Workspace' });
			if (!approval.confirmed) { return { text: 'Workspace change cancelled. Nothing changed.', isError: true }; }
			this.checkRoots(params.expectedRoots);
			if (this.workingCopyService.hasDirty || this.isBusy()) { throw new Error('Workspace became busy; nothing changed.'); }
			const text = await this._callBuiltin('open_project', { path: params.path, mode: params.mode });
			return { text };
		}
		throw new Error(`[v3code-toolhost] unknown command: ${command}`);
	}

	private checkRoots(expected?: string[]): void {
		if (expected && JSON.stringify([...expected].sort()) !== JSON.stringify(this.workspace.getWorkspace().folders.map(f => f.uri.fsPath).sort())) {
			throw new Error('Workspace changed; select the correct project before retrying.');
		}
	}

	private _exposedNames(): BuiltinToolName[] {
		return this.exposeWrites() ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS];
	}

	private async _listTools(): Promise<ExposedToolDescriptor[]> {
		const out: ExposedToolDescriptor[] = [ORIENT_TOOL];
		for (const tool of this.nativeToolsService.getTools(undefined)) {
			if (MCP_BROWSER_TOOLS.has(tool.id) && tool.inputSchema) {
				out.push({ name: tool.id, description: tool.modelDescription, inputSchema: tool.inputSchema as ExposedToolDescriptor['inputSchema'] });
			}
		}
		for (const name of this._exposedNames()) {
			const def = builtinTools[name];
			if (!def) { continue; }
			const hint = MCP_FIRST_HINTS[name];
			out.push({ name, description: hint ? `${hint} ${def.description}` : def.description, inputSchema: inputSchemaOfTool(def as typeof builtinTools[BuiltinToolName] & { params: Record<string, { description: string }> }) });
		}
		if (this.exposeSubagents()) {
			out.push(SUBAGENT_TOOL, ...SUBAGENT_JOB_TOOLS);
		}
		if (this.exposeChat()) {
			out.push(SEND_CHAT_TOOL, GET_CHAT_TOOL, CANCEL_CHAT_TOOL);
		}
		// Beast sidecar tools appear only when the sidecar actually answers
		// (availability is cached in the service — this is not a spawn per list).
		if (await this.beastService.isAvailable()) {
			out.push(SYMBOL_LOOKUP_TOOL, IMPACT_TRACE_TOOL);
		}
		return out;
	}

	private async _callBuiltin(name: BuiltinToolName, args: Record<string, unknown>): Promise<string> {
		const validate = (this.toolsService.validateParams as Record<string, (p: unknown) => unknown>)[name];
		const params = validate(args);
		const ctx: ToolCallContext = {};
		const { result } = await (this.toolsService.callTool as Record<string, (p: unknown, c?: ToolCallContext) => Promise<{ result: unknown }>>)[name](params, ctx);
		const awaited = await result;
		const toStr = (this.toolsService.stringOfResult as Record<string, (p: unknown, r: unknown) => string>)[name];
		return toStr(params, awaited);
	}

	/**
	 * One line telling the agent whether this workspace actually HAS recallable history.
	 *
	 * Deliberately a measured count, not a slogan: "18 snapshots" is a fact an agent acts on,
	 * while "memory is available" reads as boilerplate and gets ignored. Says so explicitly when
	 * empty too — a wrong "history exists" claim would send agents chasing nothing.
	 * Never throws: orient must still answer if the memory store is unavailable.
	 */
	private async _memoryLine(threadId?: string): Promise<string> {
		try {
			const checkpoints = await this.memoryService.listCheckpoints(threadId, 200);
			if (checkpoints.length === 0) {
				return threadId
					? 'No compaction snapshots are anchored to this active session yet. search_memory still covers saved facts, notes, and archived sessions.'
					: 'No compaction snapshots yet in this workspace. search_memory still covers saved facts, notes, and archived sessions.';
			}
			const oldest = checkpoints.reduce((min, c) => Math.min(min, c.startedAt || Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
			const span = Number.isFinite(oldest) && oldest !== Number.MAX_SAFE_INTEGER
				? ` reaching back to ${new Date(oldest).toISOString().slice(0, 10)}`
				: '';
			return `${checkpoints.length} compaction snapshot(s)${span} are anchored to this active session, plus saved facts and symbol notes. `
				+ 'That history is NOT in your context — call search_memory to see it.';
		} catch (e) {
			this.logService.warn('[v3code-toolhost] orient memory probe failed', e);
			return 'Memory index state unavailable right now; search_memory may still answer.';
		}
	}

	private async _orient(args: Record<string, unknown>): Promise<ToolHostCallResult> {
		const [health, memory] = await Promise.all([
			this._callBuiltin('index_health', { rebuild: false }).catch(() => 'Index health unavailable'),
			this._memoryLine(),
		]);
		const roots = this.workspace.getWorkspace().folders.map(f => f.uri.fsPath);
		const briefing = booleanArg(args.detailed) ? await this._callBuiltin('get_project_briefing', { include_notes: args.include_notes ?? false }) : '';
		return { text: [
			'# V3Code project', ...roots, health, memory,
			'Outside agents: agent_session resume returns your notebook, shared board and unread messages.',
			'Conceptual code search: semantic_search. Exact text: find_text. Known symbol: pack_context.',
			briefing.length > 6000 ? briefing.slice(0, 6000) + '\n[Briefing truncated; get_project_briefing provides full detail.]' : briefing,
		].filter(Boolean).join('\n') };
	}

	private async _callTool(name: string, args: Record<string, unknown>, browserApproved = false): Promise<ToolHostCallResult> {
		if (SUBAGENT_JOB_TOOLS.some(tool => tool.name === name)) {
			if (!this.exposeSubagents()) { return { text: 'Subagents are not exposed.', isError: true }; }
			try {
				if (typeof args.job_id !== 'string' || !args.job_id.trim()) { throw new Error('job_id is required.'); }
				return { text: JSON.stringify(await this.inspectSubagent(args.job_id, name === 'subagent_cancel')) };
			} catch (error) { return { text: String(error), isError: true }; }
		}
		if (name === ORIENT_TOOL.name) {
			return this._orient(args);
		}
		// Custom subagent tool — bypasses the generic builtin path; runs a real
		// agent loop on the user's model and returns the result synchronously.
		if (name === SUBAGENT_TOOL.name) {
			if (!this.exposeSubagents()) {
				return { text: `Tool "${name}" is not exposed by V3Code.`, isError: true };
			}
			const prompt = typeof args.prompt === 'string' ? args.prompt : '';
			if (!prompt.trim()) {
				return { text: 'run_subagent requires a non-empty "prompt".', isError: true };
			}
			const description = typeof args.description === 'string' && args.description.trim() ? args.description : 'External MCP task';
			try {
				const res = await this.runSubagent({ description, prompt });
				return { text: JSON.stringify(res), isError: res.status === 'failed' };
			} catch (e) {
				this.logService.warn('[v3code-toolhost] run_subagent failed', e);
				const msg = e instanceof Error ? e.message : String(e);
				return { text: `run_subagent failed: ${msg}`, isError: true };
			}
		}

		// Custom chat-driving tools — drive/read the user's real open chat thread.
		if (name === SEND_CHAT_TOOL.name) {
			if (!this.exposeChat()) {
				return { text: `Tool "${name}" is not exposed by V3Code.`, isError: true };
			}
			const message = typeof args.message === 'string' ? args.message : '';
			if (!message.trim()) {
				return { text: 'send_chat requires a non-empty "message".', isError: true };
			}
			const threadId = typeof args.thread_id === 'string' && args.thread_id.trim() ? args.thread_id.trim() : undefined;
			const timeoutMs = numberArg(args.timeout_ms);
			const autoApprove = booleanArg(args.auto_approve);
			const newThread = booleanArg(args.new_thread);
			try {
				const res = await this.sendChat({ message, threadId, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined, autoApprove, newThread });
				return { text: res.text, isError: res.status === 'error' };
			} catch (e) {
				this.logService.warn('[v3code-toolhost] send_chat failed', e);
				const msg = e instanceof Error ? e.message : String(e);
				return { text: `send_chat failed: ${msg}`, isError: true };
			}
		}
		if (name === GET_CHAT_TOOL.name) {
			if (!this.exposeChat()) {
				return { text: `Tool "${name}" is not exposed by V3Code.`, isError: true };
			}
			const threadId = typeof args.thread_id === 'string' && args.thread_id.trim() ? args.thread_id.trim() : undefined;
			const format = args.format === 'json' ? 'json' as const : undefined;
			try {
				const res = await this.readChat({ threadId, format, lastN: numberArg(args.last_n), maxChars: numberArg(args.max_chars) });
				return { text: res.text, isError: res.status === 'error' };
			} catch (e) {
				this.logService.warn('[v3code-toolhost] get_chat failed', e);
				const msg = e instanceof Error ? e.message : String(e);
				return { text: `get_chat failed: ${msg}`, isError: true };
			}
		}
		if (name === CANCEL_CHAT_TOOL.name) {
			if (!this.exposeChat()) {
				return { text: `Tool "${name}" is not exposed by V3Code.`, isError: true };
			}
			const threadId = typeof args.thread_id === 'string' && args.thread_id.trim() ? args.thread_id.trim() : undefined;
			try {
				const res = await this.cancelChat({ threadId });
				return { text: res.text, isError: res.status === 'error' };
			} catch (e) {
				this.logService.warn('[v3code-toolhost] cancel_chat failed', e);
				const msg = e instanceof Error ? e.message : String(e);
				return { text: `cancel_chat failed: ${msg}`, isError: true };
			}
		}

		// Beast sidecar tools (Phase C) — answered by the native index in ~ms.
		if (name === SYMBOL_LOOKUP_TOOL.name) {
			const symbolName = typeof args.name === 'string' ? args.name.trim() : '';
			if (!symbolName) {
				return { text: 'symbol_lookup requires a non-empty "name".', isError: true };
			}
			const defsOnly = booleanArg(args.defs_only);
			const tags = await this.beastService.symbolLookup(symbolName, { defsOnly });
			if (tags.length === 0) {
				return { text: `No tags found for "${symbolName}" (sidecar index may still be building, or the symbol is dynamic).` };
			}
			const lines = tags.map(t => `${t.is_definition ? 'def' : 'ref'}  ${t.path}:${t.line}  ${t.name} (${t.kind})`);
			return { text: `${tags.length} tag(s) for "${symbolName}":\n${lines.join('\n')}` };
		}
		if (name === IMPACT_TRACE_TOOL.name) {
			const target = typeof args.target === 'string' ? args.target.trim() : '';
			if (!target) {
				return { text: 'impact_trace requires a non-empty "target".', isError: true };
			}
			const rawDepth = numberArg(args.depth);
			const depth = rawDepth === undefined ? undefined : Math.max(1, Math.floor(rawDepth));
			const impacted = await this.beastService.trace(target, { depth });
			if (impacted.length === 0) {
				return { text: `No cross-file impact found for "${target}" — nothing else references it through the tag graph (or the sidecar index is still building).` };
			}
			const lines = impacted.map(i => `hop ${i.distance}${i.is_hub ? ' [hub]' : ''}  ${i.file}  — ${i.why}`);
			return { text: `${impacted.length} file(s) impacted if "${target}" changes:\n${lines.join('\n')}` };
		}

		if (MCP_BROWSER_TOOLS.has(name)) {
			if (!browserApproved) {
				const approved = await this.dialogService.confirm({
					message: 'Allow this external agent to use the V3Code browser?',
					detail: `${name}\n${JSON.stringify(args).slice(0, 2000)}\nBrowser actions may read signed-in pages or change their content.`,
					primaryButton: 'Allow browser action',
				});
				if (!approved.confirmed) { return { text: 'Browser access denied by the user.', isError: true }; }
			}
			const cancellation = new CancellationTokenSource();
			const timer = setTimeout(() => cancellation.cancel(), 120_000);
			try {
				const result = await this.nativeToolsService.invokeTool({ callId: generateUuid(), toolId: name, parameters: args, context: undefined, preToolUseResult: browserApproved ? { permissionDecision: 'allow', permissionDecisionReason: 'Browser enabled for this external agent by the user.' } : undefined }, async text => Math.ceil(text.length / 4), cancellation.token);
				return {
					text: result.content.filter(part => part.kind === 'text').map(part => part.value).join('\n'),
					images: result.content.flatMap(part => part.kind === 'data' && part.value.mimeType.startsWith('image/') ? [{ data: encodeBase64(part.value.data), mimeType: part.value.mimeType }] : []),
					isError: !!result.toolResultError,
				};
			} finally { clearTimeout(timer); cancellation.dispose(); }
		}
		if (!new Set<string>(this._exposedNames()).has(name)) {
			return { text: `Tool "${name}" is not exposed by V3Code.`, isError: true };
		}
		try {
			const validate = (this.toolsService.validateParams as Record<string, (p: unknown) => unknown>)[name];
			const params = validate(args);
			// External calls must never adopt a chat the user happens to have focused.
			const ctx: ToolCallContext = {};
			const { result } = await (this.toolsService.callTool as Record<string, (p: unknown, c?: ToolCallContext) => Promise<{ result: unknown }>>)[name](params, ctx);
			const awaited = await result;
			const toStr = (this.toolsService.stringOfResult as Record<string, (p: unknown, r: unknown) => string>)[name];
			const tokenBudget = name === 'pack_context' ? numberArg(args.max_tokens) ?? 3000 : 15000;
			const text = boundMcpText(toStr(params, awaited), Math.max(500, Math.min(15000, tokenBudget)) * 4);
			return { text };
		} catch (e) {
			this.logService.warn(`[v3code-toolhost] tool "${name}" failed`, e);
			const msg = e instanceof Error ? e.message : String(e);
			return { text: `Tool "${name}" failed: ${msg}`, isError: true };
		}
	}
}

export class V3codeMcpExposeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.mcpExpose';

	private _subagentSeq = 0;
	/** Last announced mcpExposeEnabled value; `undefined` = never announced (or the last attempt failed). */
	private _announcedEnabled: boolean | undefined;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IToolsService private readonly toolsService: IToolsService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@IBeastService private readonly beastService: IBeastService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatService private readonly chatService: IChatService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IMemoryService private readonly memoryService: IMemoryService,
		@IDialogService private readonly dialogService: IDialogService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@ILanguageModelToolsService private readonly nativeToolsService: ILanguageModelToolsService,
		@IExternalAgentsService private readonly externalAgents: IExternalAgentsService,
	) {
		super();

		// 1) register the callback channel the main-process server calls into.
		const channel = new ToolHostChannel(
			this.toolsService,
			this.logService,
			() => true, // expose memory writes (remember/forget) in v1
			() => true, // expose run_subagent in v1
			(opts) => {
				// External agents get research (read-only) children: the outward MCP surface
				// advertises exactly that, and an outside agent must not edit this workspace
				// through a side door.
				const launch = this.chatThreadService.launchSubagent({
					parentThreadId: 'mcp-external',
					parentToolId: `mcp-subagent-${++this._subagentSeq}`,
					description: opts.description,
					prompt: opts.prompt,
					profile: 'research',
				});
				return Promise.resolve(acceptReviewJob(launch, error => this.logService.warn('[v3code-toolhost] research completion failed', error)));
			},
			() => true, // expose send_chat/get_chat (drive the real open chat) in v1
			(opts) => this._sendChat(opts),
			(opts) => this._readChat(opts),
			(opts) => this._cancelChat(opts),
			this.beastService,
			this.memoryService,
			this.workspaceService,
			this.dialogService,
			this.workingCopyService,
			() => this.chatService.requestInProgressObs.get()
				|| Object.values(this.chatThreadService.streamState).some(state => !!state?.isRunning && state.isRunning !== 'idle')
				|| Object.values(this.chatThreadService.subagentState).some(worker => ['running', 'queued', 'waiting-approval'].includes(worker.status)),
			async (id, cancel) => {
				const worker = this.chatThreadService.subagentState[id];
				if (!worker || worker.parentThreadId !== 'mcp-external') { throw new Error('Unknown external research job in this editor window. It may have been interrupted by reload.'); }
				if (cancel) { await this.chatThreadService.cancelSubagent(id); }
				const current = this.chatThreadService.subagentState[id];
				const partial = this.chatThreadService.state.allThreads[id]?.messages.filter(message => message.role === 'assistant').at(-1)?.displayContent ?? '';
				return { job_id: id, status: current.status, description: current.description, created_at: current.createdAt, finished_at: current.finishedAt, activity: current.activity, evidence: current.evidence, partial: boundMcpText(partial, 8000), result: boundMcpText(current.result ?? '', 24000), error: current.error };
			},
			this.nativeToolsService,
			this.externalAgents,
		);
		this.mainProcessService.registerChannel(V3CODE_MCP_TOOLHOST_CHANNEL, channel);

		// 2) announce on startup + whenever the workspace shape changes, and follow the
		//    mcpExposeEnabled setting so it can be toggled without restarting the editor.
		// force=true on folder changes: the enabled flag is unchanged, but the published
		// workspace roots are not, and those are what a client uses to pick this instance.
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this._announce(true)));
		this._register(this.settingsService.onDidChangeState(() => this._announce()));
		this._announce();
	}

	/**
	 * Register (or retract) this window with the main-process MCP server.
	 *
	 * Guarded by mcpExposeEnabled so a second running editor can be silenced: with two builds
	 * up, an external agent otherwise has two candidate endpoints and no way to know which one
	 * it reached. Re-announces are idempotent on the server (it re-keys by IPC ctx), so firing
	 * this on every settings change is safe.
	 */
	private async _announce(force = false): Promise<void> {
		const enabled = this.settingsService.state.globalSettings.mcpExposeEnabled !== false;
		if (!force && enabled === this._announcedEnabled) { return; }   // nothing changed; skip the IPC round-trip
		this._announcedEnabled = enabled;
		try {
			const ch = this.mainProcessService.getChannel(V3CODE_MCP_EXPOSE_CHANNEL);
			if (!enabled) {
				await ch.call('unregister');
				this.logService.info('[v3code-mcp] intelligence server disabled for this window (mcpExposeEnabled=false)');
				return;
			}
			const roots = this.workspaceService.getWorkspace().folders.map(f => f.uri.fsPath);
			const endpoint = await ch.call('register', { workspaceRoots: roots, workspaceUris: this.workspaceService.getWorkspace().folders.map(f => f.uri.toString()) }) as McpExposeEndpoint | undefined;
			if (endpoint) {
				this.logService.info(`[v3code-mcp] intelligence server ready at ${endpoint.url} (roots: ${roots.join(', ') || 'none'})`);
			}
		} catch (e) {
			this._announcedEnabled = undefined;   // let the next event retry rather than latching a failed state
			this.logService.warn('[v3code-mcp] failed to start intelligence server', e);
		}
	}

	// ---- send_chat / get_chat: drive + read the user's real open chat ----

	private _currentChatModelLabel(): string {
		try {
			const sel = this.settingsService.state.modelSelectionOfFeature['Chat' as FeatureName];
			if (sel) { return `${sel.providerName}/${sel.modelName}`; }
		} catch { /* settings not ready */ }
		return 'unknown';
	}

	/**
	 * Resolves once the revealed widget has a viewModel AND the default agent for
	 * its mode is registered — mirrors OpenChatGlobalAction.run + the module-private
	 * waitForDefaultAgent in chatActions.ts. Without this, acceptInput can drop the
	 * request (no view model) or route to no agent (agent not yet registered).
	 */
	private async _waitForWidgetReady(widget: IChatWidget): Promise<void> {
		while (!widget.viewModel) {
			await Event.toPromise(widget.onDidChangeViewModel);
		}
		const mode = widget.input.currentModeKind;
		if (this.chatAgentService.getDefaultAgent(ChatAgentLocation.Chat, mode)) { return; }
		await Promise.race([
			Event.toPromise(Event.filter(this.chatAgentService.onDidChangeAgents, () =>
				Boolean(this.chatAgentService.getDefaultAgent(ChatAgentLocation.Chat, mode)))),
			timeout(60_000).then(() => { throw new Error('Timed out waiting for default agent'); }),
		]);
	}

	private async _sendChat(opts: { message: string; threadId?: string; timeoutMs?: number; autoApprove?: boolean; newThread?: boolean }): Promise<{ status: ChatTurnStatus; text: string }> {
		const message = (opts.message ?? '').trim();
		if (!message) { return { status: 'error', text: 'send_chat requires a non-empty "message".' }; }

		const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 180_000, 5_000), 600_000);
		const autoApprove = opts.autoApprove ?? false;

		// Reveal the visible sidebar chat WITHOUT stealing keyboard focus (preserveFocus).
		let widget = await this.chatWidgetService.revealWidget(true);
		if (!widget) { return { status: 'error', text: 'no chat widget' }; }

		// Thread selection. new_thread => clear the visible widget to a fresh session.
		// thread_id (a session-resource URI string returned in a prior transcript header)
		// => open that specific session in the view. Default => the current widget.
		if (opts.newThread) {
			try { await widget.clear(); }
			catch (e) { this.logService.warn('[v3code-mcp] clear (new_thread) failed', e); }
		} else if (opts.threadId) {
			try {
				const targeted = await this.chatWidgetService.openSession(URI.parse(opts.threadId), ChatViewPaneTarget, { preserveFocus: true });
				if (targeted) { widget = targeted; }
			} catch (e) {
				this.logService.warn('[v3code-mcp] openSession failed; using current widget', e);
			}
		}

		await this._waitForWidgetReady(widget);
		const viewModel = widget.viewModel;
		if (!viewModel) { return { status: 'error', text: 'chat widget has no view model' }; }
		const sessionResource = viewModel.sessionResource;

		// Gotcha #3: if the visible turn is already paused waiting for the user (tool
		// approval / elicitation) and we're NOT auto-approving, acceptInput would CANCEL
		// that pending turn. Bail out instead so we never clobber the user's live prompt.
		if (viewModel.model.requestNeedsInput.get() && !autoApprove) {
			return { status: 'awaiting_user', text: this._sendHeader(sessionResource, 'awaiting_user') + '\n\n(a turn is already waiting for the user; pass auto_approve:true to drive it)' };
		}

		// Gotcha #1: preserve any half-typed user draft — acceptInput(query) sends the
		// passed query but clears the input box; restore the draft afterwards.
		const savedInput = widget.getInput();

		// Timeout-safety: a master deadline wraps the ENTIRE turn, including acceptInput.
		// That await can hang indefinitely if the model never starts streaming, so without
		// this race a hung turn would hang send_chat (and the remote client) forever. On
		// expiry we cancel the run and report "timeout" so the loop always recovers.
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<ChatTurnStatus>((resolve) => {
			deadlineTimer = setTimeout(() => resolve('timeout'), timeoutMs);
		});
		const run = (async (): Promise<ChatTurnStatus> => {
			// acceptInput(query) is exactly what typing + Enter does; renders live in the sidebar.
			const response = await widget.acceptInput(message);
			if (!response) { return 'error'; }
			return this._awaitNativeTurn(response, autoApprove);
		})();

		let status: ChatTurnStatus;
		try {
			status = await Promise.race([run, deadline]);
		} finally {
			if (deadlineTimer !== undefined) { clearTimeout(deadlineTimer); }
			try { widget.setInput(savedInput); } catch { /* best effort */ }
		}
		if (status === 'timeout') {
			void this.chatService.cancelCurrentRequestForSession(sessionResource, 'mcp-send-chat-timeout').catch(() => { /* best effort */ });
		}

		const response = viewModel.model.getRequests().at(-1)?.response;
		const text = response
			? this._formatNativeResponse(response, { sessionResource, model: this._currentChatModelLabel(), status })
			: this._sendHeader(sessionResource, status) + '\n\n(no response was produced)';
		return { status, text };
	}

	/**
	 * Resolves when a native response settles. Watches response.onDidChange:
	 * - isComplete => 'completed' (or 'error' if result.errorDetails)
	 * - isPendingConfirmation => if autoApprove and it's tool confirmation(s), confirm
	 *   them and keep waiting; otherwise (non-tool confirmation, or not autoApprove) => 'awaiting_user'.
	 * The listener + master deadline are disposed on every exit path by the caller/race.
	 */
	private _awaitNativeTurn(response: IChatResponseModel, autoApprove: boolean): Promise<ChatTurnStatus> {
		return new Promise<ChatTurnStatus>((resolve) => {
			let done = false;
			let listener: IDisposable | undefined;
			const finish = (s: ChatTurnStatus) => {
				if (done) { return; }
				done = true;
				listener?.dispose();
				resolve(s);
			};
			const evaluate = () => {
				if (done) { return; }
				if (response.isComplete) {
					finish(response.result?.errorDetails ? 'error' : 'completed');
					return;
				}
				if (response.isPendingConfirmation.get()) {
					// Distinguish tool-approval (auto-approvable) from elicitation /
					// questionCarousel / confirmation (need a real user).
					const toolParts = response.response.value.filter((p): p is IChatToolInvocation =>
						p.kind === 'toolInvocation');
					const waitingTools = toolParts.filter(p => {
						const st = p.state.get().type;
						return st === IChatToolInvocation.StateKind.WaitingForConfirmation
							|| st === IChatToolInvocation.StateKind.WaitingForPostApproval;
					});
					const hasNonToolConfirmation = response.response.value.some(p =>
						(p.kind === 'confirmation' && !p.isUsed)
						|| (p.kind === 'questionCarousel' && !p.isUsed)
						|| (p.kind === 'elicitation2'));
					if (autoApprove && waitingTools.length > 0 && !hasNonToolConfirmation) {
						for (const p of waitingTools) {
							const st = p.state.get();
							if (st.type === IChatToolInvocation.StateKind.WaitingForConfirmation
								|| st.type === IChatToolInvocation.StateKind.WaitingForPostApproval) {
								try { st.confirm({ type: ToolConfirmKind.UserAction }); }
								catch (e) { this.logService.warn('[v3code-mcp] tool auto-approve failed', e); }
							}
						}
						return; // keep waiting; the turn resumes
					}
					finish('awaiting_user');
				}
			};
			listener = response.onDidChange(() => evaluate());
			evaluate(); // seed one immediate evaluation (turn may already be settled)
		});
	}

	private async _readChat(opts: { threadId?: string; format?: 'json' | 'markdown'; lastN?: number; maxChars?: number }): Promise<{ status: 'ok' | 'error'; text: string }> {
		const lastN = Math.max(1, Math.min(100, Math.floor(opts.lastN ?? 10)));
		const maxChars = Math.max(1000, Math.min(60000, Math.floor(opts.maxChars ?? 24000)));
		const asJson = opts.format === 'json';
		let sessionResource: URI | undefined;
		if (opts.threadId) {
			sessionResource = URI.parse(opts.threadId);
		} else {
			const widget = this.chatWidgetService.lastFocusedWidget
				?? this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat).at(0);
			sessionResource = widget?.viewModel?.sessionResource;
		}
		if (!sessionResource) {
			const msg = 'no chat session to read.';
			return { status: 'error', text: asJson ? JSON.stringify({ status: 'error', message: msg }) : msg };
		}

		const model = this.chatService.getSession(sessionResource);
		if (!model) {
			const msg = `No chat session "${sessionResource.toString()}".`;
			return { status: 'error', text: asJson ? JSON.stringify({ status: 'error', message: msg }) : msg };
		}

		if (asJson) {
			const snapshot = this._structuredSnapshot(model, sessionResource, lastN);
			return { status: 'ok', text: reviewChatTail(snapshot, maxChars, model.getRequests().length > lastN) };
		}

		const running = model.requestInProgress.get();
		const lines: string[] = [this._readHeader(sessionResource, running ? 'live:running' : 'live:idle')];
		let lastResponse: IResponse | undefined;
		for (const request of model.getRequests().slice(-lastN)) {
			lines.push('', `[user] ${trunc(request.message.text, 2000)}`);
			if (request.response) {
				lines.push(this._formatResponseBody(request.response.response));
				lastResponse = request.response.response;
			}
		}
		let text = lines.join('\n');
		if (running && lastResponse) {
			text += `\n\n[streaming-now]\n${trunc(lastResponse.toString(), 4000)}`;
		}
		return { status: 'ok', text: boundMcpText((model.getRequests().length > lastN ? '[Older turns omitted; increase last_n to read more.]\n' : '') + text, maxChars) };
	}

	private async _cancelChat(opts: { threadId?: string }): Promise<{ status: 'ok' | 'error'; text: string }> {
		let sessionResource: URI | undefined;
		if (opts.threadId) {
			sessionResource = URI.parse(opts.threadId);
		} else {
			const widget = this.chatWidgetService.lastFocusedWidget
				?? this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Chat).at(0);
			sessionResource = widget?.viewModel?.sessionResource;
		}
		if (!sessionResource || !this.chatService.getSession(sessionResource)) {
			return { status: 'error', text: JSON.stringify({ status: 'error', message: `No chat thread "${opts.threadId ?? '(open)'}".` }) };
		}
		await this.chatService.cancelCurrentRequestForSession(sessionResource, 'mcp-cancel_chat');
		return { status: 'ok', text: JSON.stringify({ status: 'ok' }) };
	}

	/**
	 * Build the structured get_chat(json) snapshot from the NATIVE model. Emits a flat,
	 * transcript-ordered message list: each request -> a user message, then the assistant's
	 * text/thinking (flushed around tool calls), with each tool call as its own role:'tool'
	 * message. Matches the v-go phone adapter's ChatSnapshot contract.
	 */
	private _structuredSnapshot(model: IChatModel, sessionResource: URI, lastN = 10): ChatSnapshot {
		const messages: ChatSnapshotMessage[] = [];
		let inProgress: IChatResponseModel | undefined;
		for (const request of model.getRequests().slice(-lastN)) {
			messages.push({ role: 'user', content: request.message.text, tools: [] });
			const response = request.response;
			if (!response) { continue; }
			if (!response.isComplete) { inProgress = response; }
			let content = '';
			let thinking = '';
			const flush = () => {
				if (content.trim() || thinking.trim()) {
					messages.push({ role: 'assistant', content: content.trim(), thinking: thinking.trim() || undefined, tools: [] });
				}
				content = '';
				thinking = '';
			};
			for (const part of response.response.value) {
				switch (part.kind) {
					case 'markdownContent':
						content += (content ? '\n' : '') + mdToString(part.content);
						break;
					case 'thinking': {
						const v = Array.isArray(part.value) ? part.value.join('') : (part.value ?? '');
						thinking += (thinking ? '\n' : '') + v;
						break;
					}
					case 'toolInvocation':
					case 'toolInvocationSerialized':
						flush();
						messages.push({ role: 'tool', content: '', tools: [this._toolFromPart(part)] });
						break;
					default:
						break;
				}
			}
			flush();
		}
		return {
			threadId: sessionResource.toString(),
			model: this._currentChatModelLabel(),
			running: this._runningState(model, inProgress),
			messages,
			partial: this._partialFromResponse(inProgress),
		};
	}

	/** Map one native tool-invocation part to the { name, type, params, result } contract shape. */
	private _toolFromPart(part: IChatToolInvocation | IChatToolInvocationSerialized): ChatSnapshotTool {
		let type: string;
		if (part.kind === 'toolInvocationSerialized') {
			type = part.isComplete ? 'success' : 'tool_request';
		} else {
			switch (part.state.get().type) {
				case IChatToolInvocation.StateKind.Cancelled: type = 'rejected'; break;
				case IChatToolInvocation.StateKind.Completed: type = 'success'; break;
				default: type = 'tool_request'; break;
			}
		}
		return {
			name: part.toolId,
			type,
			params: IChatToolInvocation.getParameters(part) ?? {},
			result: this._stringifyToolResult(part),
		};
	}

	private _stringifyToolResult(part: IChatToolInvocation | IChatToolInvocationSerialized): string {
		const rd = IChatToolInvocation.resultDetails(part) as unknown;
		if (rd === undefined || rd === null) { return ''; }
		if (typeof rd === 'string') { return trunc(rd, 8000); }
		if (typeof rd === 'object' && rd !== null && 'output' in rd && typeof (rd as { output: unknown }).output === 'string') {
			return trunc((rd as { output: string }).output, 8000);
		}
		try { return trunc(JSON.stringify(rd), 8000); } catch { return ''; }
	}

	/** Native running sub-state mapped to the contract enum. null = no turn live. */
	private _runningState(model: IChatModel, inProgress: IChatResponseModel | undefined): ChatSnapshot['running'] {
		if (!model.requestInProgress.get()) { return null; }
		if (inProgress) {
			if (inProgress.isPendingConfirmation.get()) { return 'awaiting_user'; }
			const toolActive = inProgress.response.value.some(p =>
				p.kind === 'toolInvocation'
				&& (p.state.get().type === IChatToolInvocation.StateKind.Executing
					|| p.state.get().type === IChatToolInvocation.StateKind.Streaming
					|| p.state.get().type === IChatToolInvocation.StateKind.WaitingForPostApproval));
			if (toolActive) { return 'tool'; }
		}
		return 'LLM';
	}

	private _partialFromResponse(inProgress: IChatResponseModel | undefined): { thinking?: string; content?: string } {
		if (!inProgress || inProgress.isComplete) { return {}; }
		let content = '';
		let thinking = '';
		for (const part of inProgress.response.value) {
			if (part.kind === 'markdownContent') {
				content += mdToString(part.content);
			} else if (part.kind === 'thinking') {
				thinking += Array.isArray(part.value) ? part.value.join('') : (part.value ?? '');
			}
		}
		return {
			thinking: thinking.trim() ? trunc(thinking, 4000) : undefined,
			content: content.trim() ? trunc(content, 4000) : undefined,
		};
	}

	private _sendHeader(sessionResource: URI, status: string): string {
		return `# V3Code chat (thread ${sessionResource.toString()} · model ${this._currentChatModelLabel()} · status ${status})`;
	}

	private _readHeader(sessionResource: URI, status: string): string {
		return `# V3Code chat (thread ${sessionResource.toString()} · model ${this._currentChatModelLabel()} · status ${status})`;
	}

	/** Formats a single native response's content parts into transcript lines. */
	private _formatNativeResponse(response: IChatResponseModel, meta: { sessionResource: URI; model: string; status: ChatTurnStatus }): string {
		const header = `# V3Code chat (thread ${meta.sessionResource.toString()} · model ${meta.model} · status ${meta.status})`;
		const body = this._formatResponseBody(response.response);
		return body.trim() ? `${header}\n${body}` : `${header}\n\n${trunc(response.response.getMarkdown() || '(no assistant output or tool calls were produced)', 8000)}`;
	}

	private _formatResponseBody(resp: IResponse): string {
		const lines: string[] = [];
		for (const part of resp.value) {
			switch (part.kind) {
				case 'markdownContent':
					lines.push('', `[assistant] ${trunc(mdToString(part.content), 8000)}`);
					break;
				case 'thinking': {
					const v = Array.isArray(part.value) ? part.value.join('') : (part.value ?? '');
					if (v.trim()) { lines.push('', `[thinking] ${trunc(v, 6000)}`); }
					break;
				}
				case 'toolInvocation': {
					const msg = mdToString(part.pastTenseMessage ?? part.invocationMessage);
					lines.push('', `[tool:${part.toolId}] ${toolStateName(part.state.get().type)}${msg ? ` — ${trunc(msg, 2000)}` : ''}`);
					break;
				}
				case 'toolInvocationSerialized': {
					const msg = mdToString(part.pastTenseMessage ?? part.invocationMessage);
					lines.push('', `[tool:${part.toolId}] ${part.isComplete ? 'Completed' : 'Incomplete'}${msg ? ` — ${trunc(msg, 2000)}` : ''}`);
					break;
				}
				default:
					break;
			}
		}
		return lines.join('\n');
	}
}

function trunc(s: string, n: number): string {
	if (typeof s !== 'string') { return ''; }
	return s.length <= n ? s : `${s.slice(0, n)}… [+${s.length - n} chars]`;
}

/** Coerce a chat message value (plain string or IMarkdownString) to a plain string. */
function mdToString(v: string | IMarkdownString | undefined): string {
	if (!v) { return ''; }
	return typeof v === 'string' ? v : v.value;
}

/** Human label for a native tool-invocation state (const enum can't be reverse-indexed). */
function toolStateName(state: IChatToolInvocation.StateKind): string {
	switch (state) {
		case IChatToolInvocation.StateKind.Streaming: return 'Streaming';
		case IChatToolInvocation.StateKind.WaitingForConfirmation: return 'WaitingForConfirmation';
		case IChatToolInvocation.StateKind.Executing: return 'Executing';
		case IChatToolInvocation.StateKind.WaitingForPostApproval: return 'WaitingForPostApproval';
		case IChatToolInvocation.StateKind.Completed: return 'Completed';
		case IChatToolInvocation.StateKind.Cancelled: return 'Cancelled';
		default: return 'Unknown';
	}
}

registerWorkbenchContribution2(V3codeMcpExposeContribution.ID, V3codeMcpExposeContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() { super({ id: 'v3code.showExternalCollaboration', title: localize2('externalCollaboration', 'V3Code: Show External Agent Board and Shared Memory'), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		const snapshot = await accessor.get(IMainProcessService).getChannel(V3CODE_MCP_EXPOSE_CHANNEL).call('collaborationRead');
		await accessor.get(IEditorService).openEditor({ contents: '# External agents — current project snapshot\n\nRun this command again to refresh. Private notebooks are excluded.\n\n```json\n' + JSON.stringify(snapshot, null, 2) + '\n```', languageId: 'markdown', options: { pinned: true } });
	}
});
