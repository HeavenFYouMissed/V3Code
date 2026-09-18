/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { URI } from '../../../../base/common/uri.js'
import {
	CallGraphOutput,
	FileContextOutput,
	FileDependenciesOutput,
	PackContextTask,
	PackContextOutput,
	ProjectBriefingOutput,
	SymbolContextOutput,
	SymbolNote,
} from './contextBridge/contextBridgeTypes.js';
import { AgentRole, ChatEvent, EditorialBranch, MemoryCheckpointEvidence, MemoryIndexDocumentKind, MemoryKind, MemorySearchHit, ShadowHit, ShadowRecord } from './memory/memoryTypes.js';
import { EditEntry } from './recentEditsTypes.js';
import { RawMCPToolCall } from './mcpServiceTypes.js';
import type { SnakeCaseKeys } from './prompt/toolContract.js';
import { Hit as SemanticHit, IndexStatus } from './semanticIndex/semanticIndexTypes.js';
import { BeastImpacted, BeastSymbolTag } from './beastTypes.js';
import { RawToolParamsObj } from './sendLLMMessageTypes.js';



export type TerminalResolveReason =
	// timeoutSec/cause/mightBeWaitingForInput let the stringifier report the REAL wait and
	// why, instead of a hardcoded "8s of inactivity" that lies when timeout_seconds was set.
	| { type: 'timeout', timeoutSec?: number, cause?: 'inactivity' | 'wall_clock' | 'handoff', mightBeWaitingForInput?: boolean }
	// exitCode is undefined when shell integration reported command-finished without a code
	// (some PowerShell/zsh setups) — stamping 0 made the model declare victory on failures.
	| { type: 'done', exitCode: number | undefined }

export type LintErrorItem = { code: string, message: string, startLineNumber: number, endLineNumber: number }

// One workspace-wide problem from the editor's live language servers (get_build_errors).
export type BuildProblem = { file: string, line: number, col: number, severity: 'error' | 'warning', code: string, message: string }

// Partial of IFileStat
export type ShallowDirectoryItem = {
	uri: URI;
	name: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}


export const approvalTypeOfBuiltinToolName: Partial<{ [T in BuiltinToolName]?: 'edits' | 'terminal' | 'MCP tools' | 'computer' | 'projects' }> = {
	// Computer use drives the real mouse, keyboard and screen, so every one of these tools —
	// including the read-only ones, which capture whatever the user happens to have on screen —
	// sits behind its own approval type rather than borrowing 'terminal' or 'edits'.
	'computer_read_screen': 'computer',
	'computer_read_screen_changes': 'computer',
	'computer_screenshot': 'computer',
	'computer_click': 'computer',
	'computer_type': 'computer',
	'computer_key': 'computer',
	'computer_scroll': 'computer',
	'computer_cursor': 'computer',
	'computer_wait_for_stable': 'computer',
	'computer_list_apps': 'computer',
	'computer_drag': 'computer',
	'computer_hover': 'computer',
	'computer_clipboard_read': 'computer',
	'computer_clipboard_write': 'computer',
	'computer_open_app': 'computer',
	// Project selection changes the live editor context and restarts workspace
	// services. Keep it behind its own deny-by-default approval category.
	'open_project': 'projects',
	'close_project': 'projects',
	// Reloading interrupts the live workbench and active agent turn. Reuse the
	// project-context approval boundary, but give it dedicated confirmation copy.
	'reload_window': 'projects',
	// Recovery can attribute legacy threadless records and write canonical anchors.
	// Treat it as an explicit repair action, not an ordinary background memory write.
	'recover_session_anchors': 'projects',

	'create_file_or_folder': 'edits',
	'delete_file_or_folder': 'edits',
	'rewrite_file': 'edits',
	'append_file': 'edits',
	'edit_file': 'edits',
	'run_command': 'terminal',
	'run_persistent_command': 'terminal',
	'open_persistent_terminal': 'terminal',
	'kill_persistent_terminal': 'terminal',
	// Behavior sandbox executes code in an isolated vm — gate behind terminal approval.
	'run_sandbox': 'terminal',
	// Context Bridge memory tools carry NO approval type: memory writes are notes about the
	// work, not edits to the user's code, and an approval prompt on every remember/forget
	// killed the "save the moment you learn it" behavior the agent prompt demands. This also
	// makes them available in read mode — recording what you learned while reading is exactly
	// when memory should be written. (find_text was always read-only.)
	// Git write operations
	// Worktree/branch tidy-up runs git push / worktree remove / branch -d (never forced) —
	// same approval boundary as the other git writes; the plan action rides along.
	'repo_hygiene': 'terminal',
	'git_stage': 'terminal',
	'git_commit': 'terminal',
	'git_push': 'terminal',
	'git_pull': 'terminal',
	'git_fetch': 'terminal',
	'git_checkout': 'terminal',
	'git_stash': 'terminal',
	'git_merge': 'terminal',
	'git_rebase': 'terminal',
	'git_cherry_pick': 'terminal',
	'git_restore': 'terminal',
	'git_reset': 'terminal',
	'rename_symbol': 'edits',
	'run_tests': 'terminal',
	// Writes a generated image file into the workspace.
	'generate_image': 'edits',
	// Integrated browser automation (Playwright) — gate actions that mutate page state / navigate away.
	'open_browser_page': 'MCP tools',
	'click_element': 'MCP tools',
	'type_in_page': 'MCP tools',
	'navigate_page': 'MCP tools',
	'hover_element': 'MCP tools',
	'drag_element': 'MCP tools',
	'handle_dialog': 'MCP tools',
	'run_playwright_code': 'MCP tools',
	'reconstruct_page_sources': 'MCP tools',
	'save_browser_session': 'MCP tools',
	'restore_browser_session': 'MCP tools',
	'fill_form': 'MCP tools',
	'intercept_network': 'MCP tools',
}


export type ToolApprovalType = NonNullable<(typeof approvalTypeOfBuiltinToolName)[keyof typeof approvalTypeOfBuiltinToolName]>;


export const toolApprovalTypes = new Set<ToolApprovalType>([
	...Object.values(approvalTypeOfBuiltinToolName),
	'MCP tools',
])

// A frozen shared decision on the team board — "what values are locked", the companion to
// claims' "who owns what". Ownership prevents collisions; contracts prevent divergence.
export type TeamContract = { key: string, value: string, rationale: string | null, updatedAt: string, stale: boolean }

// Subagents run in one of two honest capability profiles:
//  - 'research': read-only investigation. Enforced at execution time, not prompt advice.
//  - 'work': the parent's allowed surface — edits, terminal, MCP — behind the SAME
//    approval boundaries as the parent. Never a privilege escalation.
export type SubagentProfile = 'work' | 'research'

// Both engines (background launch_subagent and the native run_subagent runner) resolve
// capability through this module so they cannot drift apart again.

// Max delegation depth for subagents launching subagents: a root thread (depth 0) may
// launch children (depth 1), and those may launch one more level (depth 2). Depth-2
// children cannot delegate. Mirrored by the native runner's nesting machinery.
export const SUBAGENT_MAX_NESTING_DEPTH = 2

// Single source of truth for the delegation gate, so the background launcher and the
// native runner cannot disagree about how deep a chain of subagents may go. `depth` is
// the caller's own nesting depth (a root thread is 0).
export function canSubagentDelegate(depth: number): boolean {
	return depth < SUBAGENT_MAX_NESTING_DEPTH
}

// Background subagents share the live workspace with their parent, so the research
// boundary must be enforced at execution time rather than left as prompt advice. A few
// mutating/control tools intentionally carry no normal approval category (memory writes,
// planning, and agent delegation); deny those explicitly as well.
const READ_ONLY_SUBAGENT_DENIED_TOOLS = new Set<string>([
	'ask_user',
	'remember',
	'remember_editorial',
	'forget_editorial',
	'forget',
	'recover_session_anchors',
	'team_checkin',
	'team_contract',
	'index_health',
	'open_browser',
	'read_terminal_output',
	'launch_subagent',
	'run_subagent',
	'update_plan',
	// message_subagent is the PARENT's steering tool: a read-only child must not reach
	// sideways into a sibling worker, routing corrections around the parent that owns
	// the batch. (report_progress is deliberately NOT denied — a research worker
	// reporting its own milestones is exactly the observability this lane adds.)
	'message_subagent',
])

// Denied to WORK subagents even though they are otherwise full-capability:
//  - ask_user: a background thread has no visible question UI; the child must decide or report back.
//  - update_plan: the visible plan belongs to the parent conversation.
//  - open_project/close_project/reload_window: a child swapping the live workspace or reloading
//    the window would yank it out from under the parent and every sibling.
//  - recover_session_anchors: an explicit user-confirmed repair action, never a background one.
const WORK_SUBAGENT_DENIED_TOOLS = new Set<string>([
	'ask_user',
	'update_plan',
	'open_project',
	'close_project',
	'reload_window',
	'recover_session_anchors',
	// team_contract: frozen shared decisions are the FOREMAN's to set; children receive
	// them in their preamble and read them via team_board — they never rewrite them.
	'team_contract',
	// message_subagent is the PARENT's steering tool. A worker messaging its own siblings
	// would route corrections around the parent that owns the batch.
	'message_subagent',
])

/**
 * Every browser tool the runtime registers. Used to make the Multitask foreman's browser
 * surface an explicit allow-list instead of "whatever happens to lack an approval type" —
 * a new ungated browser tool must not silently widen the coordinator's powers.
 */
export const ALL_BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
	'open_browser', 'open_browser_page', 'read_page', 'screenshot_page', 'get_browser_console_logs',
	'click_element', 'type_in_page', 'navigate_page', 'hover_element', 'drag_element', 'fill_form',
	'handle_dialog', 'run_playwright_code', 'extract_page_data', 'get_computed_styles', 'watch_page',
	'save_browser_session', 'restore_browser_session', 'intercept_network', 'get_browser_network_log',
	'reconstruct_page_sources',
])

/**
 * The ONLY browser tools the read-only Multitask coordinator may hold: enough to open a page
 * and observe it (snapshot, screenshot, console) so it can verify a worker's claim with real
 * evidence — and nothing that clicks, types, navigates, or otherwise drives the page.
 */
export const MULTITASK_BROWSER_INSPECTION_TOOLS: readonly string[] = [
	'open_browser_page', 'read_page', 'screenshot_page', 'get_browser_console_logs',
]

/**
 * Restrict a tool list to the coordinator's browser policy: drop EVERY browser tool, then
 * add back exactly the four inspection tools. Non-browser tools pass through untouched.
 */
export function applyMultitaskBrowserPolicy(toolNames: readonly string[]): string[] {
	const kept = toolNames.filter(t => !ALL_BROWSER_TOOL_NAMES.has(t))
	return [...kept, ...MULTITASK_BROWSER_INSPECTION_TOOLS]
}

export function isReadOnlySubagentToolAllowed(toolName: string, isBuiltinTool: boolean): boolean {
	if (!isBuiltinTool) return false
	if (toolName in approvalTypeOfBuiltinToolName) return false
	return !READ_ONLY_SUBAGENT_DENIED_TOOLS.has(toolName)
}

/**
 * The one capability policy both subagent engines consult.
 * `canDelegate` is decided by the caller from the child's nesting depth
 * (depth < SUBAGENT_MAX_NESTING_DEPTH) — research children never delegate.
 */
export function isSubagentToolAllowed(
	profile: SubagentProfile,
	toolName: string,
	isBuiltinTool: boolean,
	opts?: { canDelegate?: boolean },
): boolean {
	if (profile === 'research') return isReadOnlySubagentToolAllowed(toolName, isBuiltinTool)
	// work profile
	if (toolName === 'launch_subagent' || toolName === 'run_subagent') return opts?.canDelegate === true
	if (!isBuiltinTool) return true // MCP tools: allowed when the parent surface includes them
	return !WORK_SUBAGENT_DENIED_TOOLS.has(toolName)
}

/**
 * Tolerant wire-format coercion for array-valued tool params. The XML tool-call
 * transport delivers EVERY param as a string (extractGrammar builds them with `+=`),
 * so a model sending kinds: ["checkpoint"] arrives as the literal text '["checkpoint"]'
 * and a strict Array.isArray guard rejects a perfectly good call. Mirrors the
 * validateOptionsList precedent: JSON string → parsed array; bare/comma-separated
 * string → wrapped; real array/undefined pass through. Returns undefined for
 * empty/null-ish values; callers still validate the element values.
 */
export function coerceRawArrayParam(value: unknown): unknown[] | undefined {
	if (value === undefined || value === null) return undefined
	if (Array.isArray(value)) return value
	if (typeof value === 'string') {
		const s = value.trim()
		if (!s || s === 'null' || s === 'undefined') return undefined
		if (s.startsWith('[')) {
			try {
				const parsed = JSON.parse(s)
				return Array.isArray(parsed) ? parsed : [parsed]
			} catch {
				// fall through: treat as comma-separated text
			}
		}
		return s.replace(/^\[|\]$/g, '').split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
	}
	return [value]
}




// PARAMS OF TOOL CALL
export type BuiltinToolCallParams = {
	'read_file': { uri: URI, startLine: number | null, endLine: number | null, pageNumber: number },
	'ls_dir': { uri: URI, pageNumber: number },
	'get_dir_tree': { uri: URI },
	'search_pathnames_only': { query: string, includePattern: string | null, pageNumber: number },
	'search_for_files': { query: string, isRegex: boolean, searchInFolder: URI | null, pageNumber: number },
	'search_in_file': { uri: URI, query: string, isRegex: boolean },
	'read_lint_errors': { uri: URI },
	// Read a V3Code agent skill's full SKILL.md by name (works for bundled skills read_file can't reach).
	'read_skill': { name: string },
	// Taint-analysis security scan of the workspace. packIds null = every built-in pack.
	'security_scan': { packIds: string[] | null, maxFiles: number | null },
	// Replace the active project by default. Additive multi-root is explicit so a
	// temporary test repo cannot silently contaminate later search and memory context.
	'open_project': { path: URI | null, mode: 'replace' | 'add' },
	'close_project': { path: URI },
	'reload_window': Record<string, never>,
	// ---
	'rewrite_file': { uri: URI, newContent: string },
	'append_file': { uri: URI, content: string },
	'edit_file': { uri: URI, searchReplaceBlocks: string },
	'create_file_or_folder': { uri: URI, isFolder: boolean },
	'delete_file_or_folder': { uri: URI, isRecursive: boolean, isFolder: boolean },
	// ---
	'run_command': { command: string; cwd: string | null, terminalId: string, timeoutSeconds: number | null },
	'open_persistent_terminal': { cwd: string | null },
	'run_persistent_command': { command: string; persistentTerminalId: string },
	'kill_persistent_terminal': { persistentTerminalId: string },
	'read_terminal_output': { persistentTerminalId: string },
	// --- User interaction ---
	'ask_user': { question: string, options: string[] },
	// Behavior sandbox — run a JS/TS snippet in an isolated node:vm.
	'run_sandbox': { code: string, timeoutMs: number | null },
	// ---
	// Context Bridge — symbol-attached notes + workspace text search.
	'remember': { filePath: string, symbolName: string, note: string },
	'remember_editorial': { topic: string, worked?: string, didntWork?: string, buildNotes?: string, miniReadme?: string, mode?: 'append' | 'replace' },
	'forget_editorial': { topic: string, section?: 'worked' | 'didnt_work' | 'build_notes' | 'mini_readme' },
	'forget': { noteId: string },
	'recover_session_anchors': { originRoot: string | null, confirmed: boolean },
	'list_notes': { filePath: string | null },
	'search_notes': { query: string, filePath: string | null, limit: number },
	// Team board — shared coordination memory for parallel agents (main + subagents + other
	// windows). Each agent checks in under a stable agent_id with what it's doing and where.
	'team_checkin': { agentId: string | null, doing: string, where: string | null, status: 'active' | 'done' },
	'team_board': Record<string, never>,
	'team_contract': { action: 'set' | 'clear', key: string, value: string | null, rationale: string | null },
	'workspace_delta': { sinceMs: number | null },
	'search_chat_memory': { query: string, kind: MemoryKind | null, role: AgentRole | null, limit: number },
	'search_memory': { query: string, scope: 'workspace' | 'session' | 'global', depth: 'recent' | 'broad' | 'deep', sessionId: string | null, before: number | null, after: number | null, kinds: MemoryIndexDocumentKind[] | null, limit: number },
	'get_memory_checkpoint': { checkpointId: string, includeEvents: boolean, eventPage: number },
	'get_chat_session': { sessionId: string },
	'get_chat_thread': { eventId: string },
	// Shadow archive (build packet "shadow memory") — break-glass deep dig + full-record fetch.
	'deep_recall': { query: string, limit: number | null },
	'get_shadow_record': { shadowId: string },
	// Self-check: the editor's live error list across the workspace (no recompile).
	'get_build_errors': { pathFilter: string | null, errorsOnly: boolean },
	// Self-check: which files have changed in the working tree (vs HEAD) this session.
	'session_diff': { pathFilter: string | null },
	// Discovery reliability: code-search index health + optional force re-scan.
	'index_health': { rebuild: boolean },
	// The user's (or your own) recent edits — so you don't re-edit what was just fixed.
	'recent_edits': { n: number | null, file: string | null },
	'get_editorial_briefing': Record<string, never>,
	'search_editorial': { query: string, crossProject: boolean },
	'find_text': { query: string, isRegex: boolean, includePattern: string | null, pageNumber: number, contextLines: number },
	// V3Code semantic index — embeddings + FTS retrieval.
	'semantic_search': { query: string, topK: number | null, includeFile: string | null, includeFiles: string[] | null, rerank: boolean },
	'symbol_lookup': { name: string, defsOnly: boolean },
	'impact_trace': { target: string, depth: number | null },
	// LSP-backed context tools (Phase B.2).
	'get_file_context': { filePath: string },
	'get_file_dependencies': { filePath: string },
	'get_symbol_context': { filePath: string, symbolName: string },
	'get_call_graph': { filePath: string, symbolName: string, direction: 'incoming' | 'outgoing', depth: number },
	'pack_context': { filePath: string, symbolName: string, task: PackContextTask, maxTokens: number },
	'get_project_briefing': { includeNotes: boolean },
	// --- Web & Git & Browser ---
	'web_search': { query: string, maxResults: number },
	'web_fetch': { url: string, pageNumber: number },
	'git_status': {},
	'repo_hygiene': { action: 'plan' | 'push' | 'remove' | 'prune', path: string | null },
	'git_stage': { paths: string[] },
	'git_commit': { message: string, paths: string[] | null },
	'git_diff': { staged: boolean, base?: string, head?: string, path?: string },
	'git_log': { count: number },
	'git_branch': {},
	'git_push': { remote: string | null, branch: string | null, setUpstream: boolean },
	'git_pull': { remote: string | null, branch: string | null },
	'git_fetch': { remote: string | null },
	'git_checkout': { branch: string, create: boolean },
	'git_stash': { action: 'push' | 'pop' | 'list', message: string | null, paths: string[] | null },
	'git_remote': {},
	'git_show': { ref: string, path: string | null, statOnly: boolean },
	'git_blame': { path: string, startLine: number | null, endLine: number | null },
	'git_merge': { branch: string | null, abort: boolean },
	'git_rebase': { action: 'start' | 'abort' | 'continue' | 'skip', branch: string | null },
	'git_cherry_pick': { commit: string | null, abort: boolean },
	'git_restore': { paths: string[], staged: boolean },
	'git_reset': { mode: 'soft' | 'mixed', ref: string },
	'open_browser': { url: string, mobile: boolean },
	// Playwright-backed browser automation (native browserView tools via resolveNativeToolId).
	'open_browser_page': { url: string, force_new: string },
	'read_page': { page_id: string },
	'click_element': { page_id: string, element: string, ref: string, selector: string, dbl_click: string, button: string },
	'type_in_page': { page_id: string, text: string, key: string, ref: string, element: string },
	'screenshot_page': { page_id: string, ref: string, element: string },
	'navigate_page': { page_id: string, type: string, url: string },
	'hover_element': { page_id: string, element: string, ref: string, selector: string, settle_ms: number, wait_for_selector: string },
	'drag_element': { page_id: string, from_element: string, to_element: string, from_ref: string, from_selector: string, to_ref: string, to_selector: string },
	'handle_dialog': { page_id: string, accept_modal: string, prompt_text: string, select_files: string },
	'run_playwright_code': { page_id: string, code: string, deferred_result_id: string, timeout_ms: number },
	'extract_page_data': { page_id: string, focus: string },
	'get_browser_console_logs': { page_id: string, max_lines: number },
	'reconstruct_page_sources': { script_url: string, output_dir: string, method: string },
	'get_computed_styles': { page_id: string, ref: string, selector: string, element: string },
	'watch_page': { page_id: string, ref: string, selector: string, text_contains: string, timeout_ms: number, interval_ms: number },
	'save_browser_session': { page_id: string, session_name: string },
	'restore_browser_session': { page_id: string, session_name: string, reload: string },
	'fill_form': { page_id: string, fields: string },
	'intercept_network': { page_id: string, url_pattern: string, include_bodies: string },
	'get_browser_network_log': { page_id: string, clear: string },
	// OS-level computer use (native computerUse tools via resolveNativeToolId).
	'computer_read_screen': { pid: number, max_depth: number, include_all: boolean },
	'computer_read_screen_changes': { pid: number, max_depth: number, include_all: boolean },
	'computer_screenshot': { display_id: number, max_long_edge: number, include_elements: boolean },
	'computer_click': { ref: string, x: number, y: number, element: string, button: string, modifiers: string[], click_count: number },
	'computer_type': { text: string },
	'computer_key': { chord: string, repeat: number },
	'computer_scroll': { direction: string, amount: number, ref: string, x: number, y: number, element: string },
	'computer_cursor': {},
	'computer_wait_for_stable': { pid: number, timeout_ms: number },
	'computer_list_apps': {},
	'computer_drag': { from_ref: string, from_x: number, from_y: number, to_ref: string, to_x: number, to_y: number, button: string, modifiers: string[], duration_ms: number, element: string },
	'computer_hover': { ref: string, x: number, y: number, settle_ms: number, element: string },
	'computer_clipboard_read': {},
	'computer_clipboard_write': { text: string },
	'computer_open_app': { app: string, wait_ms: number },
	// Generate a raster image asset from a text prompt (Grok / xAI) and save it to the workspace.
	'generate_image': { prompt: string, outputPath: string | null, model: string | null },
	// --- Background Subagent ---
	'launch_subagent': { description: string, prompt: string, profile: SubagentProfile },
	// Parent -> owned worker correction. Ownership is enforced in the thread service: a
	// thread may only message workers it launched.
	'message_subagent': { subagentThreadId: string, message: string },
	// Worker -> parent progress milestone. Bounded and rate-limited by the thread service.
	'report_progress': { milestone: string },
	// --- Native Subagent (delegates to VS Code RunSubagentTool) ---
	'run_subagent': { prompt: string, description: string, agentName?: string, model?: string, profile?: SubagentProfile },
	'rename_symbol': { symbol: string, new_name: string, file_path?: string, uri?: string, line_content: string },
	'list_code_usages': { symbol: string, file_path?: string, uri?: string, line_content: string },
	'run_tests': { files?: string, test_names?: string, mode?: string, coverage_files?: string },
	// --- Todo List ---
	'update_plan': { todos: Array<{ id: string, content: string, status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>, merge: boolean },
}

/**
 * The two texts an edit went between. The chat card renders its diff from these (Monaco's
 * differ) rather than from the `+`/`-` text sent to the model, which
 * carries no context lines or line numbers. Omitted for files too large to be worth keeping
 * in chat history — those fall back to the plain diff text.
 */
export type EditToolDiffTexts = { beforeContent?: string; afterContent?: string };

/** Combined before+after budget above which we skip shipping the texts to the UI. */
export const EDIT_TOOL_DIFF_TEXT_BUDGET = 120_000;

// RESULT OF TOOL CALL
export type BuiltinToolResultType = {
	'read_file': { fileContents: string, totalFileLen: number, totalNumLines: number, hasNextPage: boolean, returnedStartLine: number, returnedEndLine: number, isComplete: boolean },
	// children === null means "not a directory"; notFound distinguishes "nothing is there at all",
	// which the model must be told plainly instead of receiving a raw filesystem error.
	'ls_dir': { children: ShallowDirectoryItem[] | null, hasNextPage: boolean, hasPrevPage: boolean, itemsRemaining: number, notFound?: boolean },
	'get_dir_tree': { str: string, },
	'search_pathnames_only': { uris: URI[], hasNextPage: boolean },
	'search_for_files': { uris: URI[], hasNextPage: boolean },
	// totalMatches is the count BEFORE the render cap, so the stringifier can admit it truncated.
	'search_in_file': { lines: number[]; matched?: { line: number; text: string }[]; totalMatches?: number; },
	'read_lint_errors': { lintErrors: LintErrorItem[] | null },
	'read_skill': { found: boolean, name: string, content: string, filePath: string, availableNames: string[] },
	// human = plain-English findings report; memory = "since last scan" journal diff.
	'security_scan': { ran: boolean, error: string | null, human: string, memory: string, findingCount: number, filesScanned: number, filesSkipped: number, packIds: string[], workspace: string },
	'open_project': { folder: string, mode: 'replace' | 'add', changed: boolean, cancelled: boolean, workspaceFolders: string[], indexStatus: IndexStatus, rebuildStarted: boolean, anchorCarry?: 'carried' | 'no-thread-id', carryManifest?: string },
	'close_project': { folder: string, removed: boolean, workspaceFolders: string[], indexStatus: IndexStatus, rebuildStarted: boolean },
	'reload_window': { scheduled: boolean, delayMs: number },
	// ---
	'rewrite_file': Promise<{ lintErrors: LintErrorItem[] | null; diffText?: string; added?: number; removed?: number; noDiagnosticsReported?: boolean } & EditToolDiffTexts>,
	'append_file': Promise<{ lintErrors: LintErrorItem[] | null; diffText?: string; added?: number; removed?: number; noDiagnosticsReported?: boolean; appendedChars?: number } & EditToolDiffTexts>,
	'edit_file': Promise<{ lintErrors: LintErrorItem[] | null; diffText?: string; added?: number; removed?: number; searchReplaceBlocks?: string; noDiagnosticsReported?: boolean } & EditToolDiffTexts>,
	// existingIsFolder: what is ACTUALLY on disk when alreadyExists. A model that asked for a
	// folder and found a file there needs to be told, not handed a generic "already existed".
	'create_file_or_folder': { alreadyExists: boolean, existingIsFolder?: boolean },
	'delete_file_or_folder': {},
	// ---
	'run_command': { result: string; resolveReason: TerminalResolveReason; },
	'run_persistent_command': { result: string; resolveReason: TerminalResolveReason; },
	'open_persistent_terminal': { persistentTerminalId: string },
	'kill_persistent_terminal': {},
	'read_terminal_output': { output: string },
	// ask_user never executes — chatThreadService resolves it from the clicked option (answerAskUserRequest).
	'ask_user': { choice: string },
	'run_sandbox': { logs: string[], result: string | undefined, error: string | null, tsStripped: boolean, durationMs: number },
	// ---
	'remember': { note: SymbolNote },
	'remember_editorial': { topic: string, branchId: string, created: boolean, mode: 'append' | 'replace', unavailable?: boolean, error?: string, workspaceShared?: boolean },
	'forget_editorial': { topic: string, deleted: boolean, section?: string, unavailable?: boolean },
	'forget': { deleted: boolean },
	'recover_session_anchors': { imported: number, skipped: string[], missing: string[] },
	'list_notes': { notes: SymbolNote[] },
	'search_notes': { notes: SymbolNote[] },
	'team_checkin': { agentId: string, status: 'active' | 'done', overlaps?: { agentId: string, where: string | null }[] },
	'team_board': { entries: Array<{ agentId: string, doing: string, where: string | null, updatedAt: string }>, contracts: TeamContract[] },
	'team_contract': { action: 'set' | 'clear', key: string, contracts: TeamContract[] },
	'workspace_delta': {
		sinceMs: number,
		changedFiles: Array<{ path: string, status: string }>,
		recentEdits: EditEntry[],
		newNotes: SymbolNote[],
		buildErrorCount: number,
		buildHintCount: number,
		summary: string,
	},
	'search_chat_memory': { events: ChatEvent[], unavailable?: boolean },
	'search_memory': { hits: MemorySearchHit[], unavailable?: boolean },
	'get_memory_checkpoint': { evidence: MemoryCheckpointEvidence | null, unavailable?: boolean },
	'get_chat_session': { events: ChatEvent[], unavailable?: boolean },
	'get_chat_thread': { events: ChatEvent[], unavailable?: boolean },
	'deep_recall': { hits: ShadowHit[], unavailable?: boolean },
	'get_shadow_record': { record: ShadowRecord | null, unavailable?: boolean },
	'get_build_errors': { problems: BuildProblem[], total: number, truncated: boolean },
	'session_diff': { files: Array<{ path: string, status: string }>, count: number },
	'index_health': { status: IndexStatus, rebuildStarted: boolean },
	'recent_edits': { edits: EditEntry[] },
	'get_editorial_briefing': {
		projectId: string | null;
		projectName: string;
		readme: string;
		branches: EditorialBranch[];
		unavailable?: boolean;
	},
	'search_editorial': { branches: EditorialBranch[], unavailable?: boolean },
	'find_text': { matches: Array<{ uri: URI, lineNumber: number, previewText: string, isContext?: boolean }>, hasNextPage: boolean },
	'semantic_search': { hits: SemanticHit[], indexState: string, rerankStatus?: string, filesIndexed?: number, filesTotal?: number },
	// sidecarAvailable distinguishes "the beast index has no such symbol" from "this build has no
	// beast binary at all" — both yield an empty array, and conflating them made the agent treat a
	// missing sidecar as proof the symbol did not exist.
	'symbol_lookup': { tags: BeastSymbolTag[], sidecarAvailable: boolean },
	'impact_trace': { impacted: BeastImpacted[], sidecarAvailable: boolean },
	'get_file_context': FileContextOutput,
	'get_file_dependencies': FileDependenciesOutput,
	'get_symbol_context': SymbolContextOutput,
	'get_call_graph': CallGraphOutput,
	'pack_context': PackContextOutput,
	'get_project_briefing': ProjectBriefingOutput,
	// --- Web & Git & Browser ---
	'web_search': { results: Array<{ title: string, url: string, snippet: string }> },
	'web_fetch': { title: string, url: string, text: string, pageNumber: number, totalPages: number, status: number },
	'git_status': { status: string },
	'repo_hygiene': { output: string },
	'git_stage': { output: string },
	'git_commit': { output: string },
	'git_diff': { diff: string },
	'git_log': { log: string },
	'git_branch': { branch: string, branches: string },
	'git_push': { output: string },
	'git_pull': { output: string },
	'git_fetch': { output: string },
	'git_checkout': { output: string },
	'git_stash': { output: string },
	'git_remote': { output: string },
	'git_show': { output: string },
	'git_blame': { output: string },
	'git_merge': { output: string },
	'git_rebase': { output: string },
	'git_cherry_pick': { output: string },
	'git_restore': { output: string },
	'git_reset': { output: string },
	'open_browser': { url: string, opened: boolean },
	'open_browser_page': { result: string },
	'read_page': { result: string },
	'click_element': { result: string },
	'type_in_page': { result: string },
	'screenshot_page': { result: string },
	'navigate_page': { result: string },
	'hover_element': { result: string },
	'drag_element': { result: string },
	'handle_dialog': { result: string },
	'run_playwright_code': { result: string },
	'extract_page_data': { result: string },
	'get_browser_console_logs': { result: string },
	'reconstruct_page_sources': { result: string },
	'get_computed_styles': { result: string },
	'watch_page': { result: string },
	'save_browser_session': { result: string },
	'restore_browser_session': { result: string },
	'fill_form': { result: string },
	'intercept_network': { result: string },
	'get_browser_network_log': { result: string },
	// OS-level computer use.
	'computer_read_screen': { result: string },
	'computer_read_screen_changes': { result: string },
	'computer_screenshot': { result: string },
	'computer_click': { result: string },
	'computer_type': { result: string },
	'computer_key': { result: string },
	'computer_scroll': { result: string },
	'computer_cursor': { result: string },
	'computer_wait_for_stable': { result: string },
	'computer_list_apps': { result: string },
	'computer_drag': { result: string },
	'computer_hover': { result: string },
	'computer_clipboard_read': { result: string },
	'computer_clipboard_write': { result: string },
	'computer_open_app': { result: string },
	'generate_image': { uri: string, path: string, fsPath: string },
	'launch_subagent': { subagentThreadId: string, result: string, status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled' },
	'message_subagent': { delivered: boolean, error?: string },
	'report_progress': { recorded: boolean },
	'run_subagent': { result: string },
	'rename_symbol': { result: string },
	'list_code_usages': { result: string },
	'run_tests': { result: string },
	'update_plan': { todos: Array<{ id: string, content: string, status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }> },
}


export type ToolCallParams<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolCallParams[T] : RawToolParamsObj
export type ToolResult<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolResultType[T] : RawMCPToolCall

export type BuiltinToolName = keyof BuiltinToolResultType

type BuiltinToolParamNameOfTool<T extends BuiltinToolName> = keyof SnakeCaseKeys<BuiltinToolCallParams[T]>
export type BuiltinToolParamName = { [T in BuiltinToolName]: BuiltinToolParamNameOfTool<T> }[BuiltinToolName]


export type ToolName = BuiltinToolName | (string & {})
export type ToolParamName<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolParamNameOfTool<T> : string
