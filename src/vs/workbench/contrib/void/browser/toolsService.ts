/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { CancellationToken } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { VSBuffer, decodeBase64 } from '../../../../base/common/buffer.js'
import { dirname, isEqual, joinPath } from '../../../../base/common/resources.js'
import { hashAsync } from '../../../../base/common/hash.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService, resultIsMatch } from '../../../services/search/common/search.js'
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js'
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js'
import { IHostService } from '../../../services/host/browser/host.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { IRepoHygieneService } from './repoHygieneService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName, coerceRawArrayParam, EditToolDiffTexts, EDIT_TOOL_DIFF_TEXT_BUDGET, SubagentProfile, TeamContract } from '../common/toolsServiceTypes.js'
import { isContractStale, overlappingClaims } from '../common/subagentLifecycle.js'
import { formatEditorialBranchForTool, formatEditorialBriefing, mergeEditorialBranches } from '../common/memory/editorialMerge.js'
import { describeCarriedContinuity } from '../common/memory/sessionAnchors.js'
import { IVoidModelService } from '../common/voidModelService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { IVoidCommandBarService } from './voidCommandBarServiceTypes.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'

import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME, MAX_WRITE_TOOL_CONTENT_CHARS } from '../common/prompt/prompts.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { generateUuid } from '../../../../base/common/uuid.js'
import { IContextBridgeService } from '../common/contextBridge/contextBridgeService.js'
import { IMemoryService } from './memoryService.js'
import { IMemoryCaptureService } from './memoryCaptureService.js'
import { IShadowWorkspaceService } from './shadowWorkspaceService.js'
import { IMarkerCheckService } from './_markerCheckService.js'
import { AgentRole, ChatEvent, EditorialBranch, MemoryKind } from '../common/memory/memoryTypes.js'
import { applyPlanLifecycleToDurableTask, DurableTaskFile, parseDurableTaskFile, serializeDurableTaskFile, shouldRejectPlanReplace } from '../common/memory/durableTask.js'
import { formatUnifiedDiffForModel } from './helpers/editToolDiffFormat.js'
import { applySearchReplaceBlocksToString } from './helpers/searchReplaceOnString.js'
import { ChunkKind, Hit, ISemanticIndexService } from '../common/semanticIndex/semanticIndexTypes.js'
import { CloudIndexQueryHit } from '../common/cloudIndex/cloudIndexProtocol.js'
import { mergeFederatedIndexHits, verifiedCloudContent, verifiedCloudSpan } from '../common/cloudIndex/federatedIndex.js'
import { ICloudIndexSyncService } from './cloudIndexSyncService.js'
import { ILspBridgeAdapter } from './contextBridge/lspBridgeAdapter.js'
import { PackContextTask } from '../common/contextBridge/contextBridgeTypes.js'
import { ILogService } from '../../../../platform/log/common/log.js'
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js'
import { CollaborationRecord } from '../common/mcpExpose/localCollaboration.js'
import { reviewDiffArgs, reviewContextPreview } from '../common/mcpExpose/reviewTools.js'
import { V3CODE_MCP_EXPOSE_CHANNEL } from '../common/mcpExpose/mcpExposeTypes.js'
import { IEvalSandboxService } from './evalSandboxProxy.js'
import { ILLMMessageService } from '../common/sendLLMMessageService.js'
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js'
import { IEditorService } from '../../../services/editor/common/editorService.js'
import { IRecentEditsService } from './recentEditsService.js'
import { ISkillsService } from './skillsService.js'
import { ISecurityScanService } from './securityScanService.js'
import { IBeastService } from './beastService.js'
import { SymbolNote } from '../common/contextBridge/contextBridgeTypes.js'
import { MULTI_ROOT_INDEX_PREFIX, workspaceIndexUri } from '../common/semanticIndex/workspaceIndexPath.js'
import { planProjectWorkspaceChange } from '../common/projectWorkspace.js'
import { formatWorkspaceTransitionStamp } from '../common/memory/sessionDigestPolicy.js'
import {
	ActivePlanPayload, formatSessionContinuity, isActivePlanPayload, mayWritePlanProjection,
	isPortableRelativePath, sessionAnchorUpdateIdentity, stableAnchorId,
} from '../common/memory/sessionAnchors.js'

/** Harness/test notes left from tool sweeps — flagged in list_notes for easy forget. */
const TEST_NOTE_ARTIFACT_RE = /^(CHECK[-_]|TEST[-_]|test-harness|CHECK-ACTIVE)/i
function isTestArtifactNote(n: SymbolNote): boolean {
	return TEST_NOTE_ARTIFACT_RE.test(n.symbolName) || TEST_NOTE_ARTIFACT_RE.test(n.note.slice(0, 60))
}
function formatNoteLine(n: SymbolNote): string {
	const flag = isTestArtifactNote(n) ? ' [test-artifact]' : ''
	const carried = n.originRoot ? ` [carried from ${n.originRoot}; ${n.resolution ?? 'unresolved'}]` : ''
	return `- [${n.id}]${flag} ${n.filePath} :: ${n.symbolName}${carried}\n  ${n.note}`
}
function noteMatchesQuery(n: SymbolNote, q: string): boolean {
	const hay = `${n.filePath} ${n.symbolName} ${n.note}`.toLowerCase()
	return q.split(/\s+/).filter(Boolean).every(term => hay.includes(term.toLowerCase()))
}
function parseNoteMs(iso: string): number {
	const t = Date.parse(iso)
	return Number.isFinite(t) ? t : 0
}
/**
 * Before/after text for the chat card's diff. Dropped for very large files so a single edit
 * can't push a megabyte of source into the chat transcript; the card falls back to the
 * plain diff text in that case.
 */
function uiDiffTexts(before: string, after: string): EditToolDiffTexts {
	if (before.length + after.length > EDIT_TOOL_DIFF_TEXT_BUDGET) { return {} }
	return { beforeContent: before, afterContent: after }
}
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js'
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js'
import { llmRerank, RerankSendFn } from '../common/semanticIndex/reranker.js'
import { isQuickSearchQuery } from '../common/semanticIndex/quickSearchQuery.js'
import { ChatMode, ModelSelection, ProviderName } from '../common/voidSettingsTypes.js'
import {
	runGetFileContext,
	runGetFileDependencies,
	runGetSymbolContext,
	runGetCallGraph,
	runPackContext,
	runGetProjectBriefing,
	stringifyFileContext,
	stringifyFileDependencies,
	stringifySymbolContext,
	stringifyCallGraph,
	stringifyPackContext,
	stringifyProjectBriefing,
} from './contextBridge/contextBridgeTools.js'


// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
export type ToolCallContext = { threadId?: string, toolId?: string, terminalToolSessionId?: string }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], ctx?: ToolCallContext) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

/** How long read_lint_errors waits for the language server, matching the shadow workspace. */
const LINT_WAIT_MS = 5000

/** search_in_file renders 3 lines per match, so it needs a ceiling. */
const MAX_SEARCH_IN_FILE_MATCHES = 100

/** workspace_delta list caps — disclosed in its summary rather than passed off as totals. */
const MAX_DELTA_EDITS = 15
const MAX_DELTA_NOTES = 10

/** Give the completed tool card time to enter chat history before the workbench reloads. */
const RELOAD_WINDOW_DELAY_MS = 1500

/**
 * Several tools slice their results to a limit and then print the sliced length as `Found N`,
 * which reads as a total. A model that sees "Found 20 notes" and needed the 21st has no way to
 * know it was cut. When the result lands exactly on the limit, say so.
 */
const cappedCountNote = (shown: number, limit: number) =>
	shown >= limit ? ` (capped at ${limit} — there may be more, raise the limit or narrow the query)` : ''

function withinBudget<T>(promise: Promise<T>, budgetMs: number, fallback: T): Promise<T> {
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(fallback), budgetMs)
		void promise.then(
			value => { clearTimeout(timer); resolve(value) },
			() => { clearTimeout(timer); resolve(fallback) },
		)
	})
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}

const validateWriteContent = (argName: string, value: unknown) => {
	const s = validateStr(argName, value)
	if (s.length > MAX_WRITE_TOOL_CONTENT_CHARS) {
		throw new Error(`Invalid LLM output: ${argName} is ${s.length} characters — maximum ${MAX_WRITE_TOOL_CONTENT_CHARS} per write call. Nothing was written, so the file is unchanged. Split this one document into create_file_or_folder (empty file) then append_file per section; files under the limit should still be written in a single call.`)
	}
	return s
}

/**
 * Every search tool defaults `is_regex` to false and matches literally. A model that passes
 * `foo|bar` or `handle(` and gets a flat "no matches" concludes the string does not exist
 * anywhere, and stops looking. Say which way we searched, and point at the flag when the query
 * looks like a pattern.
 */
const searchModeSuffix = (query: string, isRegex: boolean | undefined) => {
	const mode = isRegex ? 'regex' : 'literal text'
	const hint = !isRegex && /[|()[\]\\+*?{}^$]/.test(query)
		? `\nThis query contains regex characters — if you meant a pattern, retry with is_regex: "true".`
		: ''
	return { mode, hint }
}


/**
 * Workspace folders, published to the module-level validators by the service
 * constructor. Every tool documents its paths as workspace-relative, and models send them that
 * way, but `URI.file('src/foo.ts')` roots at the FILESYSTEM root -- `/src/foo.ts` -- which
 * simply does not exist. read_file then reported FILE NOT FOUND for a file that is right there,
 * and search_in_folder silently searched nothing and returned zero hits.
 */
let _workspaceFoldersForRelativePaths: readonly IWorkspaceFolder[] = []

/** True for `/abs/path`, `C:\path`, `C:/path`, and UNC `\\server\share`. */
const looksAbsolute = (p: string) => p.startsWith('/') || p.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(p)

// We are NOT checking to make sure in workspace
const validateURI = (uriStr: unknown) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (uriStr.includes('://')) {
		try {
			const uri = URI.parse(uriStr)
			return uri
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`)
		}
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		if (!looksAbsolute(uriStr) && _workspaceFoldersForRelativePaths.length > 0) {
			if (uriStr.replace(/\\/g, '/').startsWith(`${MULTI_ROOT_INDEX_PREFIX}/`)) {
				const indexed = workspaceIndexUri(_workspaceFoldersForRelativePaths, uriStr)
				if (!indexed) { throw new Error(`Invalid multi-root workspace path: ${uriStr}`) }
				return indexed
			}
			const segments = uriStr.split(/[\\/]+/).filter(seg => seg && seg !== '.')
			return URI.joinPath(_workspaceFoldersForRelativePaths[0].uri, ...segments)
		}
		const uri = URI.file(uriStr)
		return uri
	}
}

const validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}

// Subagent capability profile: tolerant of the wire format (XML transport delivers
// strings). Accepts the legacy read_only flag from older prompts/models and maps it onto
// the profile it always claimed to be. Unknown values default to 'work' — the runtime
// gate still enforces per-profile policy, so a bad value can never widen capability.
const validateSubagentProfile = (params: RawToolParamsObj): SubagentProfile => {
	const raw = params.profile
	if (typeof raw === 'string') {
		const p = raw.trim().toLowerCase()
		if (p === 'research' || p === 'read_only' || p === 'read-only') return 'research'
		if (p === 'work') return 'work'
	}
	const legacyReadOnly = (params as Record<string, unknown>).read_only
	if (legacyReadOnly === true || legacyReadOnly === 'true') return 'research'
	return 'work'
}

// ask_user options: tolerant of the wire format — native tools send a real array, XML
// models send a JSON string, small models sometimes send newline/comma-separated text.
const validateOptionsList = (argName: string, value: unknown): string[] => {
	let arr: unknown = value
	if (typeof value === 'string') {
		const s = value.trim()
		try { arr = JSON.parse(s) } catch { arr = s.split(/\r?\n|,/).map(x => x.trim()).filter(Boolean) }
	}
	if (!Array.isArray(arr)) { throw new Error(`"${argName}" must be a JSON array of 2-6 short answer strings.`) }
	const options = [...new Set(arr.map(o => String(o).trim()).filter(Boolean))]
	if (options.length < 2 || options.length > 6) { throw new Error(`"${argName}" must contain 2-6 distinct non-empty options (got ${options.length}).`) }
	return options.map(o => o.slice(0, 120))
}

// git paths: tolerant of the wire format — native tools send a real array, XML
// models send a JSON string, small models sometimes send newline/comma-separated text.
// (Same tolerance as validateOptionsList above — do not regress this to a strict
// Array.isArray-only check; that broke git_stage/git_commit/git_stash for every
// non-native-array caller.)
const validatePathList = (argName: string, value: unknown): string[] => {
	let arr: unknown = value
	if (typeof value === 'string') {
		const s = value.trim()
		try { arr = JSON.parse(s) } catch { arr = s.split(/\r?\n|,/).map(x => x.trim()).filter(Boolean) }
	}
	if (!Array.isArray(arr) || arr.length === 0) {
		throw new Error(`"${argName}" must be a non-empty array of workspace-relative file paths.`)
	}
	const paths: string[] = []
	for (const item of arr) {
		const s = String(item).trim()
		if (!s) {
			throw new Error(`"${argName}" must contain only non-empty path strings.`)
		}
		paths.push(s)
	}
	return paths
}

const validateOptionalPathList = (argName: string, value: unknown): string[] | null => {
	if (value === undefined || value === null || value === '') return null
	return validatePathList(argName, value)
}

/** Safe git ref names (branch, remote, tag) — blocks shell metacharacters. */
const validateGitRef = (argName: string, ref: unknown): string => {
	const s = validateStr(argName, ref)
	if (!/^[A-Za-z0-9._/\-]+$/.test(s)) {
		throw new Error(`Invalid git ref for ${argName}: "${s}"`)
	}
	return s
}

const validateOptionalGitRef = (argName: string, ref: unknown): string | null => {
	if (isFalsy(ref)) return null
	return validateGitRef(argName, ref)
}

const validateGitStashAction = (actionUnknown: unknown): 'push' | 'pop' | 'list' => {
	const action = validateStr('action', actionUnknown)
	if (action === 'push' || action === 'pop' || action === 'list') return action
	throw new Error(`"action" must be push, pop, or list — got "${action}"`)
}

const validateGitRevision = (argName: string, ref: unknown): string => {
	const s = validateStr(argName, ref)
	if (!/^(HEAD(~[0-9]+)?|[0-9a-fA-F]{7,40}|[A-Za-z0-9._/\-]+)$/.test(s)) {
		throw new Error(`Invalid git revision for ${argName}: "${s}"`)
	}
	return s
}

const validateGitCommitHash = (argName: string, hash: unknown): string => {
	const s = validateStr(argName, hash)
	if (!/^[0-9a-fA-F]{7,40}$/.test(s)) {
		throw new Error(`Invalid commit hash for ${argName}: "${s}"`)
	}
	return s
}

const validateGitRebaseAction = (actionUnknown: unknown): 'start' | 'abort' | 'continue' | 'skip' => {
	const action = validateStr('action', actionUnknown)
	if (action === 'start' || action === 'abort' || action === 'continue' || action === 'skip') return action
	throw new Error(`"action" must be start, abort, continue, or skip — got "${action}"`)
}

const validateGitResetMode = (modeUnknown: unknown): 'soft' | 'mixed' => {
	const mode = isFalsy(modeUnknown) ? 'mixed' : validateStr('mode', modeUnknown)
	if (mode === 'soft' || mode === 'mixed') return mode
	throw new Error(`"mode" must be soft or mixed — hard reset is blocked`)
}

/** POSIX single-quote escaping for git add path arguments. */
const shellQuotePosix = (s: string): string => {
	if (/^[A-Za-z0-9_./@:-]+$/.test(s)) return s
	return `'${s.replace(/'/g, `'\\''`)}'`
}

const escapeGitCommitMessage = (message: string): string => {
	const firstLine = message.split(/\r?\n/)[0]
	return firstLine
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\$/g, '\\$')
		.replace(/`/g, '\\`')
}

const buildGitAddCommand = (paths: string[]): string => {
	return `git add -- ${paths.map(shellQuotePosix).join(' ')}`
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

const MEMORY_KINDS = new Set<string>([
	'prompt', 'reply', 'tool_call', 'tool_result',
	'diff', 'decision', 'phase', 'escalation', 'note',
]);

const AGENT_ROLES = new Set<string>(['lead', 'sprinter', 'scout', 'debugger', 'user']);

const validateOptionalMemoryKind = (kindUnknown: unknown): MemoryKind | null => {
	const kind = validateOptionalStr('kind', kindUnknown);
	if (!kind) return null;
	if (!MEMORY_KINDS.has(kind)) {
		throw new Error(`Invalid LLM output: kind must be one of ${[...MEMORY_KINDS].join(', ')}, got "${kind}".`);
	}
	return kind as MemoryKind;
};

const validateOptionalAgentRole = (roleUnknown: unknown): AgentRole | null => {
	const role = validateOptionalStr('role', roleUnknown);
	if (!role) return null;
	if (!AGENT_ROLES.has(role)) {
		throw new Error(`Invalid LLM output: role must be one of ${[...AGENT_ROLES].join(', ')}, got "${role}".`);
	}
	return role as AgentRole;
};

const formatChatEventForTool = (ev: ChatEvent): string => {
	const files = ev.files?.length ? ` files=${ev.files.join(',')}` : '';
	const role = ev.role ? `/${ev.role}` : '';
	const body = ev.body.length > 800 ? ev.body.slice(0, 800) + '\n…' : ev.body;
	return `[${ev.id}] ${ev.ts} ${ev.kind}${role} session=${ev.sessionId}${files}\n${ev.title}\n${body}`;
};

const formatChatEventsForTool = (events: ChatEvent[]): string =>
	events.map(formatChatEventForTool).join('\n\n---\n\n');

export type SubagentCompletion = { result: string, status: 'completed' | 'blocked' | 'failed' | 'cancelled', filesTouched?: string[], commandsRun?: { command: string, status: 'pass' | 'fail' | 'unknown' }[], blockedReason?: string }
// Launch admission is synchronous: the caller gets the real child thread id (or a refusal)
// immediately, plus a completion promise that resolves exactly once when the child
// finishes, fails, or is cancelled.
export type SubagentLaunch =
	| { ok: true, subagentThreadId: string, profile: SubagentProfile, completion: Promise<SubagentCompletion> }
	| { ok: false, error: string }
export type SubagentLauncher = (opts: { parentThreadId: string, parentToolId: string, description: string, prompt: string, profile: SubagentProfile }) => SubagentLaunch;
export type SubagentCanceller = (subagentThreadId: string) => Promise<void>;
/** Delivers a bounded correction from a parent thread to a worker it owns. */
export type SubagentMessenger = (parentThreadId: string, subagentThreadId: string, message: string) => { ok: true } | { ok: false, error: string };
/** Records a bounded progress milestone reported by a worker about itself. */
export type SubagentProgressReporter = (subagentThreadId: string, milestone: string) => void;
export type NotificationInjector = (threadId: string, content: string, source: 'subagent' | 'terminal' | 'system') => void;

export type TeamBoardEntry = { agentId: string, doing: string, where: string | null }

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
	setSubagentLauncher(launcher: SubagentLauncher): void;
	setSubagentCanceller(canceller: SubagentCanceller): void;
	setSubagentInfoGetter(getter: (threadId: string) => { status: string, queuePosition?: number } | undefined): void;
	/** Register the real parent->worker message delivery path (backs the message_subagent tool). */
	setSubagentMessenger(messenger: SubagentMessenger): void;
	/** Register the real worker progress sink (backs the report_progress tool). */
	setSubagentProgressReporter(reporter: SubagentProgressReporter): void;
	setNotificationInjector(injector: NotificationInjector): void;
	getTodosForThread(threadId: string): Array<{ id: string, content: string, status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>;
	/** Programmatic team-board check-in/out (used for automatic subagent coordination). Returns overlapping active claims. */
	teamCheckinDirect(entry: { agentId: string, doing: string, where: string | null, status: 'active' | 'done' }): Promise<{ overlaps: TeamBoardEntry[] }>;
	/** Remove stale auto check-ins from subagents of a previous session (no subagent can be running at startup). */
	sweepSubagentTeamEntries(): Promise<void>;
	/** Frozen shared decisions on the team board (injected into every subagent preamble). */
	teamContracts(): Promise<TeamContract[]>;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

type PlanTodo = { id: string, content: string, status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }
// Persisted shape of <workspace>/.v3code/active-plan.json (update_plan survives restarts).
const ACTIVE_PLAN_REL = ['.v3code', 'active-plan.json'] as const

/**
 * Tame terminal output before it enters the model's context. A persistent terminal running a noisy
 * background process (e.g. a dev server logging a request every few seconds) returns its WHOLE buffer
 * on every read — hundreds of near-identical lines that bury the line the agent actually wanted and
 * burn its window. This (1) collapses runs of identical consecutive lines into `<line>  (×N)` and
 * (2) keeps only the last MAX lines, prefixing a note when it truncated. Order-preserving, lossless
 * for distinct lines within the cap.
 */
const TERMINAL_OUTPUT_MAX_LINES = 120
function tailAndDedupeTerminalOutput(output: string): string {
	if (!output) { return output }
	const lines = output.split('\n')
	// collapse consecutive duplicates
	const collapsed: string[] = []
	let prev: string | undefined
	let run = 0
	const flush = () => {
		if (prev === undefined) { return }
		collapsed.push(run > 1 ? `${prev}  (×${run})` : prev)
	}
	for (const line of lines) {
		if (line === prev) { run++; continue }
		flush()
		prev = line
		run = 1
	}
	flush()
	if (collapsed.length <= TERMINAL_OUTPUT_MAX_LINES) { return collapsed.join('\n') }
	const dropped = collapsed.length - TERMINAL_OUTPUT_MAX_LINES
	const tail = collapsed.slice(-TERMINAL_OUTPUT_MAX_LINES)
	return `[... ${dropped} earlier output line(s) omitted — showing the last ${TERMINAL_OUTPUT_MAX_LINES}. Pipe through tail/grep for specific lines ...]\n${tail.join('\n')}`
}

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	private _subagentLauncher: SubagentLauncher | undefined;
	setSubagentLauncher(launcher: SubagentLauncher) { this._subagentLauncher = launcher; }

	private _subagentCanceller: SubagentCanceller | undefined;
	setSubagentCanceller(canceller: SubagentCanceller) { this._subagentCanceller = canceller; }

	private _subagentInfoGetter: ((threadId: string) => { status: string, queuePosition?: number } | undefined) | undefined;
	setSubagentInfoGetter(getter: (threadId: string) => { status: string, queuePosition?: number } | undefined) { this._subagentInfoGetter = getter; }

	private _subagentMessenger: SubagentMessenger | undefined;
	setSubagentMessenger(messenger: SubagentMessenger) { this._subagentMessenger = messenger; }

	private _subagentProgressReporter: SubagentProgressReporter | undefined;
	setSubagentProgressReporter(reporter: SubagentProgressReporter) { this._subagentProgressReporter = reporter; }

	private _notificationInjector: NotificationInjector | undefined;
	setNotificationInjector(injector: NotificationInjector) { this._notificationInjector = injector; }

	async teamCheckinDirect(entry: { agentId: string, doing: string, where: string | null, status: 'active' | 'done' }): Promise<{ overlaps: TeamBoardEntry[] }> {
		const symbol = `team:${entry.agentId}`
		const notes = await this.contextBridgeService.listNotes()
		const teamEntries: TeamBoardEntry[] = notes.filter(n => n.symbolName.startsWith('team:')).map(n => {
			let doing = n.note; let where: string | null = null
			try {
				const parsed = JSON.parse(n.note)
				if (parsed && typeof parsed.doing === 'string') { doing = parsed.doing; where = typeof parsed.where === 'string' ? parsed.where : null }
			} catch { /* legacy/hand-written entry — treat raw text as doing */ }
			return { agentId: n.symbolName.slice('team:'.length), doing, where }
		})
		const overlaps = entry.status === 'done' ? [] : overlappingClaims(entry.where, teamEntries, entry.agentId)
		// One entry per agent: drop any previous entry for this id before writing the new one.
		for (const n of notes.filter(n => n.symbolName === symbol)) { await this.contextBridgeService.deleteNote(n.id) }
		if (entry.status !== 'done') {
			await this.contextBridgeService.addNote('__team__', symbol, JSON.stringify({ doing: entry.doing, where: entry.where }))
		}
		return { overlaps }
	}

	async teamContracts(): Promise<TeamContract[]> {
		const notes = await this.contextBridgeService.listNotes()
		const now = Date.now()
		return notes
			.filter(n => n.symbolName.startsWith('contract:'))
			.map(n => {
				let value = n.note; let rationale: string | null = null
				try {
					const parsed = JSON.parse(n.note)
					if (parsed && typeof parsed.value === 'string') { value = parsed.value; rationale = typeof parsed.rationale === 'string' ? parsed.rationale : null }
				} catch { /* hand-written entry — raw text is the value */ }
				return { key: n.symbolName.slice('contract:'.length), value, rationale, updatedAt: n.updatedAt, stale: isContractStale(n.updatedAt, now) }
			})
			.sort((a, b) => a.key.localeCompare(b.key))
	}

	async sweepSubagentTeamEntries(): Promise<void> {
		// Auto check-ins from background subagents use the 'sub:' id prefix. A window reload
		// kills every running child after its check-in and before its checkout, so at startup
		// every 'team:sub:*' entry is by definition an orphan — sweep them.
		const notes = await this.contextBridgeService.listNotes()
		for (const n of notes.filter(n => n.symbolName.startsWith('team:sub:'))) {
			await this.contextBridgeService.deleteNote(n.id)
		}
	}

	// Per-thread todo state
	private _todosByThread: Map<string, Array<{ id: string, content: string, status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }>> = new Map()
	private readonly _planHydrated = new Set<string>()
	private static readonly _cloudSearchBudgetMs = 2500
	getTodosForThread(threadId: string) {
		// Lazily restore a persisted plan the first time todos are read this session.
		if (!this._planHydrated.has(threadId)) { this._planHydrated.add(threadId); void this._hydrateActivePlan(threadId) }
		return this._todosByThread.get(threadId) ?? []
	}

	// ---- active-plan persistence (update_plan survives restarts) --------------------------
	private _activePlanUri(): URI | null {
		const folder = this.workspaceContextService.getWorkspace().folders[0]
		return folder ? URI.joinPath(folder.uri, ...ACTIVE_PLAN_REL) : null
	}
	/** Read this thread's durable task record from V3Code app-data.
	 *  Used to guard update_plan: a full replace from a SIDE turn must not silently replace
	 *  the primary task's plan. Null when absent/unreadable/other thread — no guard then. */
	private async _readDurableTaskFile(threadId: string): Promise<DurableTaskFile | null> {
		try {
			const state = await this.memoryService.getSessionState(threadId, 'durable-task')
			const parsed = state ? parseDurableTaskFile(state.value) : null
			return parsed && parsed.threadId === threadId ? parsed : null
		} catch (error) {
			this.logService.warn('[v3code] read durable task failed', error)
			return null
		}
	}
	private async _applyPlanLifecycle(threadId: string, todos: PlanTodo[]): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const state = await this.memoryService.getSessionState(threadId, 'durable-task')
			const file = state ? parseDurableTaskFile(state.value) : null
			if (!file || file.threadId !== threadId) return
			const next = applyPlanLifecycleToDurableTask(file, todos, Date.now())
			const saved = await this.memoryService.putSessionState(threadId, 'durable-task', serializeDurableTaskFile(next), state?.revision ?? null)
			if (saved.saved) return
		}
		this.logService.warn('[v3code] durable task plan lifecycle update lost repeated compare-and-swap races')
	}
	private static _hasOpenItems(todos: PlanTodo[]): boolean {
		return todos.some(t => t.status !== 'completed' && t.status !== 'cancelled')
	}
	private async _readActivePlanProjection(uri: URI): Promise<{ exists: boolean; ownerThreadId?: string; payload: ActivePlanPayload | null }> {
		try {
			if (!(await this.fileService.exists(uri))) return { exists: false, payload: null }
			const parsed = JSON.parse((await this.fileService.readFile(uri)).value.toString()) as unknown
			const ownerThreadId = parsed && typeof parsed === 'object' && typeof (parsed as { threadId?: unknown }).threadId === 'string'
				? (parsed as { threadId: string }).threadId : undefined
			return { exists: true, ownerThreadId, payload: isActivePlanPayload(parsed) ? parsed : null }
		} catch { return { exists: true, payload: null } }
	}
	/** Write the active plan to disk, or clear it once every item is completed/cancelled.
	 *  Best-effort: a failure here must never break the update_plan tool call. The persisted
	 *  record carries the durable taskId it was written under, so a checklist authored for a
	 *  superseded task can never pose as the current one. */
	private async _persistActivePlan(threadId: string, todos: PlanTodo[], taskId?: string): Promise<void> {
		const uri = this._activePlanUri()
		const updatedAt = Date.now()
		const payload: ActivePlanPayload = { threadId, taskId: taskId ?? null, updatedAt, todos }
		const anchorId = stableAnchorId('plan', threadId, 'active-plan')
		const deletedAt = ToolsService._hasOpenItems(todos) ? undefined : updatedAt
		try {
			await this.memoryService.upsertSessionAnchor({
				anchorId,
				threadId,
				kind: 'plan',
				updateIdentity: sessionAnchorUpdateIdentity(payload, deletedAt),
				payload,
				updatedAt,
				deletedAt,
			})
			if (!uri) return
			const existing = await this._readActivePlanProjection(uri)
			// A destination workspace may already have another live thread's plan. The
			// canonical plan remains available to this thread, but that file is untouched.
			// An unreadable/ownerless existing file is also preserved rather than guessed.
			if (existing.exists && (!existing.payload || !mayWritePlanProjection(existing.ownerThreadId, threadId))) return
			if (deletedAt !== undefined) {
				if (existing.payload && await this.fileService.exists(uri)) await this.fileService.del(uri)
				return
			}
			await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(payload, null, 2)))
		} catch (e) { this.logService.warn('[v3code] persist active-plan failed', e) }
	}
	/** On startup, restore an active plan with unfinished items into the thread's todo state. */
	private async _hydrateActivePlan(threadId: string): Promise<void> {
		try {
			const anchorId = stableAnchorId('plan', threadId, 'active-plan')
			const canonical = (await this.memoryService.listSessionAnchors(threadId, true)).find(anchor => anchor.anchorId === anchorId)
			if (canonical) {
				if (canonical.deletedAt !== undefined || !isActivePlanPayload(canonical.payload)) return
				const todos = canonical.payload.todos
				if (ToolsService._hasOpenItems(todos)) this._todosByThread.set(threadId, todos)
				return
			}
		} catch (e) { this.logService.warn('[v3code] hydrate canonical active-plan failed', e) }
		const uri = this._activePlanUri()
		if (!uri) { return }
		try {
			if (!(await this.fileService.exists(uri))) { return }
			const buf = await this.fileService.readFile(uri)
			// A project can change while the journal read is in flight. Never install the
			// previous workspace's checklist into the live thread state.
			if (this._activePlanUri()?.toString() !== uri.toString()) { return }
			const data = JSON.parse(buf.value.toString()) as { threadId?: string, taskId?: string | null, updatedAt?: number, todos?: PlanTodo[] }
			const todos = Array.isArray(data.todos) ? data.todos : []
			if (!ToolsService._hasOpenItems(todos)) { return }
			const persistedThreadId = data.threadId ?? '__default__'
			if (persistedThreadId !== threadId) return
			this._todosByThread.set(threadId, todos)
			const payload: ActivePlanPayload = { threadId, taskId: data.taskId ?? null, updatedAt: data.updatedAt ?? Date.now(), todos }
			void this.memoryService.upsertSessionAnchor({
				anchorId: stableAnchorId('plan', threadId, 'active-plan'), threadId, kind: 'plan',
				updateIdentity: sessionAnchorUpdateIdentity(payload), payload, updatedAt: payload.updatedAt,
			}).catch(() => { /* compatibility adoption is best-effort */ })
		} catch (e) { this.logService.warn('[v3code] hydrate active-plan failed', e) }
	}

	private async _notesForThread(threadId: string | undefined, filterFilePath?: string): Promise<SymbolNote[]> {
		const local = (await this.contextBridgeService.listNotes(filterFilePath))
			.filter(note => !note.threadId || note.threadId === threadId)
		if (!threadId) return local
		const anchors = await this.memoryService.listSessionAnchors(threadId, true)
		const noteAnchors = anchors.filter(anchor => anchor.kind === 'note')
		const tombstoned = new Set(noteAnchors.filter(anchor => anchor.deletedAt !== undefined).map(anchor => anchor.anchorId))
		const current = await this.memoryService.getSessionContinuity(threadId)
		const byId = new Map<string, SymbolNote>()
		for (const note of local) {
			if (!tombstoned.has(stableAnchorId('note', threadId, note.id))) byId.set(note.id, note)
		}
		for (const anchor of noteAnchors) {
			if (anchor.deletedAt !== undefined || !anchor.payload || typeof anchor.payload !== 'object') continue
			const note = anchor.payload as SymbolNote
			if (!note.id || (filterFilePath && note.filePath !== filterFilePath)) continue
			const carried = anchor.originWorkspaceId !== current.currentWorkspaceId
			let resolution: SymbolNote['resolution'] | undefined
			if (carried) {
				if (isPortableRelativePath(note.filePath)) {
					const folder = this.workspaceContextService.getWorkspace().folders[0]
					resolution = folder && await this.fileService.exists(URI.joinPath(folder.uri, ...note.filePath.split('/')))
						? 'resolved'
						: 'unresolved'
				} else {
					resolution = 'unresolved'
				}
			}
			byId.set(note.id, {
				...note,
				...(carried ? { originWorkspaceId: anchor.originWorkspaceId, originRoot: anchor.originRoot, resolution } : {}),
			})
		}
		return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
	}

	private async _editorialForThread(threadId: string | undefined): Promise<EditorialBranch[]> {
		if (!threadId) return []
		const current = await this.memoryService.getSessionContinuity(threadId)
		return (await this.memoryService.listSessionAnchors(threadId))
			.filter(anchor => anchor.kind === 'editorial' && anchor.payload && typeof anchor.payload === 'object')
			.map(anchor => ({
				...(anchor.payload as EditorialBranch),
				...(anchor.originWorkspaceId !== current.currentWorkspaceId
					? { originWorkspaceId: anchor.originWorkspaceId, originRoot: anchor.originRoot }
					: {}),
			}))
	}

	private async _writeThreadEditorial(threadId: string, opts: {
		topic: string; worked?: string; didntWork?: string; buildNotes?: string; miniReadme?: string; mode?: 'append' | 'replace';
	}): Promise<{ branch: EditorialBranch; created: boolean; mode: 'append' | 'replace' }> {
		const topic = opts.topic.trim().toLowerCase().replace(/\s+/g, '-')
		if (!topic) throw new Error('editorial topic is required')
		if (['roadmap', 'decisions', 'quirks', 'symbols', 'hot-files'].includes(topic)) {
			throw new Error(`"${topic}" is maintained automatically. Use a topic of your own, e.g. "${topic}-notes".`)
		}
		const mode = opts.mode ?? 'append'
		const anchorId = stableAnchorId('editorial', threadId, topic)
		const existingAnchor = (await this.memoryService.listSessionAnchors(threadId, true))
			.find(anchor => anchor.anchorId === anchorId && anchor.deletedAt === undefined)
		const existing = existingAnchor?.payload && typeof existingAnchor.payload === 'object'
			? existingAnchor.payload as EditorialBranch : undefined
		const merge = (previous: string | undefined, next: string | undefined): string => {
			if (next === undefined) return previous ?? ''
			if (mode === 'replace') return next.trim()
			const seen = new Set<string>()
			const lines: string[] = []
			for (const line of `${previous ?? ''}\n${next}`.split('\n')) {
				const trimmed = line.trimEnd()
				const key = trimmed.replace(/\s+/g, ' ').trim().toLowerCase()
				if (!key || seen.has(key)) continue
				seen.add(key)
				lines.push(trimmed)
			}
			let value = lines.join('\n')
			while (value.length > 8000 && lines.length > 1) { lines.shift(); value = lines.join('\n') }
			return value
		}
		const branch: EditorialBranch = {
			id: existing?.id ?? anchorId,
			projectId: existing?.projectId ?? `thread:${threadId}`,
			name: topic,
			miniReadme: merge(existing?.miniReadme, opts.miniReadme),
			worked: merge(existing?.worked, opts.worked),
			didntWork: merge(existing?.didntWork, opts.didntWork),
			buildNotes: merge(existing?.buildNotes, opts.buildNotes),
			codeRefs: existing?.codeRefs ?? [],
			confidence: existing?.confidence ?? 0.9,
			tsUpdated: Date.now(),
		}
		await this.memoryService.upsertSessionAnchor({
			anchorId, threadId, kind: 'editorial', symbol: topic,
			updateIdentity: sessionAnchorUpdateIdentity(branch), payload: branch, updatedAt: branch.tsUpdated,
		})
		return { branch, created: !existing, mode }
	}

	private async _readCloudHitContent(hit: CloudIndexQueryHit, localById: ReadonlyMap<string, Hit>): Promise<string | undefined> {
		const local = localById.get(hit.chunkId)
		if (local) { return local.content }
		if (typeof hit.snippet === 'string') { return verifiedCloudContent(hit.casKey, [hit.snippet]) }
		// Vectors-only team indexes intentionally do not return source. Hydrate the
		// pointer from the checked-out working tree without allowing a server-sent
		// path to escape a workspace folder.
		if (!hit.file || hit.file.includes('\0') || hit.file.startsWith('/') || hit.file.includes('\\')) { return undefined }
		if (!Number.isInteger(hit.startLine) || !Number.isInteger(hit.endLine) || hit.startLine < 1 || hit.endLine < hit.startLine) { return undefined }
		const folders = this.workspaceContextService.getWorkspace().folders
		// Pre-scheme cloud snapshots used root-relative paths that are ambiguous in
		// a multi-root window. Never guess those into root 1; the next completed
		// manifest sync prunes them and uploads explicit @roots keys.
		if (folders.length > 1 && !hit.file.startsWith(`${MULTI_ROOT_INDEX_PREFIX}/`)) { return undefined }
		const uri = workspaceIndexUri(folders, hit.file)
		if (!uri) { return undefined }
		try {
			const value = (await this.fileService.readFile(uri)).value.toString()
			return verifiedCloudSpan(hit.casKey, value, hit.startLine, hit.endLine)
		} catch { return undefined }
	}

	private async _hydrateCloudHits(cloudHits: readonly CloudIndexQueryHit[], localHits: readonly Hit[]): Promise<Hit[]> {
		const localById = new Map(localHits.map(hit => [hit.chunk.id, hit]))
		const allowedKinds = new Set<ChunkKind>(['function', 'class', 'method', 'interface', 'type', 'enum', 'file', 'block'])
		const hydrated = await Promise.all(cloudHits.map(async hit => {
			const content = await this._readCloudHitContent(hit, localById)
			if (content === undefined || !Number.isFinite(hit.score)) { return undefined }
			const local = localById.get(hit.chunkId)
			const kind: ChunkKind = allowedKinds.has(hit.kind as ChunkKind) ? hit.kind as ChunkKind : 'file'
			return {
				chunk: {
					id: hit.chunkId,
					file: hit.file,
					startLine: hit.startLine,
					endLine: hit.endLine,
					kind,
					name: hit.name,
					language: hit.language,
					contentHash: local?.chunk.contentHash ?? hit.casKey,
				},
				content,
				score: hit.score,
				signals: hit.signals,
			} satisfies Hit
		}))
		return hydrated.filter((hit): hit is Hit => !!hit)
	}

	/** Pick a configured, non-hidden model for reranking. Prefers small/fast families
	 *  (haiku, mini, flash) and avoids heavy chat models (opus, pro, o1). */
	private _pickRerankModel(): ModelSelection | null {
		const sop = this.voidSettingsService.state.settingsOfProvider as Record<string, { models?: Array<{ modelName: string; isHidden: boolean }> }>
		const RERANK_BLOCK = /opus|o1-|o3-|sonnet-4|deepseek-v4-pro|gpt-4(?!o-mini)|claude-4/i
		const RERANK_PREFER = [/haiku/i, /flash/i, /mini/i, /\bsmall\b/i, /\bfast\b/i]
		let fallback: ModelSelection | null = null
		for (const pattern of RERANK_PREFER) {
			for (const providerName of Object.keys(sop) as ProviderName[]) {
				for (const info of sop[providerName]?.models ?? []) {
					if (info.isHidden || RERANK_BLOCK.test(info.modelName)) continue
					if (pattern.test(info.modelName)) {
						return { providerName, modelName: info.modelName }
					}
				}
			}
		}
		for (const providerName of Object.keys(sop) as ProviderName[]) {
			for (const info of sop[providerName]?.models ?? []) {
				if (info.isHidden || RERANK_BLOCK.test(info.modelName)) continue
				if (!fallback) fallback = { providerName, modelName: info.modelName }
			}
		}
		return fallback
	}

	/** Build a one-shot LLM "send" callback for the reranker, or null if no model is
	 *  configured. Mirrors vision-describe: prepareLLMSimpleMessages so the provider
	 *  gets a clean LLMChatMessage[] (no UI-only fields like displayContent, which
	 *  Anthropic rejects with 400 Extra inputs are not permitted). Never throws. */
	private _makeRerankSend(): RerankSendFn | null {
		const model = this._pickRerankModel()
		if (!model) return null
		return (prompt: string) => new Promise<string>((resolve, reject) => {
			let settled = false
			const finish = (t: string) => { if (!settled) { settled = true; resolve(t) } }
			const fail = (msg: string) => { if (!settled) { settled = true; reject(new Error(msg)) } }
			try {
				// Provider-ready messages only — same path as v3codeVisionDescribe.
				// ChatMessage-shaped objects with displayContent/selections/state used to
				// leak into anthropic.messages.stream and 400 the whole rerank.
				const { messages, separateSystemMessage } = this.convertToLLMMessageService.prepareLLMSimpleMessages({
					simpleMessages: [{ role: 'user', content: prompt }],
					systemMessage: '',
					modelSelection: model,
					featureName: 'Chat',
				})
				if (!messages.length) {
					fail('rerank send error: empty prepared messages')
					return
				}
				this.llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					messages,
					separateSystemMessage,
					chatMode: 'chat' as ChatMode,
					modelSelection: model,
					modelSelectionOptions: undefined as never,
					overridesOfModel: this.voidSettingsService.state.overridesOfModel,
					logging: { loggingName: 'V3Code Rerank' },
					onText: () => { /* ignore streaming deltas */ },
					onFinalMessage: ({ fullText }) => finish((fullText ?? '').trim()),
					onError: (e) => fail(`rerank send error: ${model.providerName}/${model.modelName}: ${e?.message ?? 'unknown'}`),
					onAbort: () => fail('rerank aborted'),
				})
			} catch (e) {
				fail(e instanceof Error ? e.message : 'rerank send threw')
			}
		})
	}

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IRepoHygieneService private readonly repoHygieneService: IRepoHygieneService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerCheckService private readonly markerCheckService: IMarkerCheckService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IContextBridgeService private readonly contextBridgeService: IContextBridgeService,
		@IMemoryService private readonly memoryService: IMemoryService,
		@IMemoryCaptureService private readonly memoryCaptureService: IMemoryCaptureService,
		@IShadowWorkspaceService private readonly shadowWorkspaceService: IShadowWorkspaceService,
		@ISemanticIndexService private readonly semanticIndexService: ISemanticIndexService,
		@ILspBridgeAdapter private readonly lspBridgeAdapter: ILspBridgeAdapter,
		@ILogService private readonly logService: ILogService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IEvalSandboxService private readonly evalSandboxService: IEvalSandboxService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IConvertToLLMMessageService private readonly convertToLLMMessageService: IConvertToLLMMessageService,
		@IEditorService private readonly editorService: IEditorService,
		@IRecentEditsService private readonly recentEditsService: IRecentEditsService,
		@ISkillsService private readonly skillsService: ISkillsService,
		@ISecurityScanService private readonly securityScanService: ISecurityScanService,
		@IBeastService private readonly beastService: IBeastService,
		@ICloudIndexSyncService private readonly cloudIndexSyncService: ICloudIndexSyncService,
		@IHostService private readonly hostService: IHostService,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		// Publish the workspace root to the module-level validators, and keep it current when
		// folders are added/removed, so a workspace-relative path from a model resolves to the
		// real file instead of `/src/...` at the filesystem root.
		// (No _register: ToolsService is a workbench singleton that lives for the app lifetime.)
		const syncWorkspaceRoot = () => { _workspaceFoldersForRelativePaths = this.workspaceContextService.getWorkspace().folders }
		syncWorkspaceRoot()
		this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			syncWorkspaceRoot()
			// Plans live under <workspace>/.v3code. A chat may survive an in-place project
			// swap, but the old project's checklist must not survive in the tool UI/state.
			this._todosByThread.clear()
			this._planHydrated.clear()
		})

		this.validateParams = {
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					// The schema handed to the model advertises `include_pattern`; this used to
					// destructure `search_in_folder` (copy-pasted from search_for_files), so the
					// documented filter was silently ignored and the model believed it had
					// narrowed a search it had not. Accept the old key too rather than break any
					// model that learned to send it.
					query: queryUnknown,
					include_pattern: includeUnknown,
					search_in_folder: legacyIncludeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown ?? legacyIncludeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			read_skill: (params: RawToolParamsObj) => {
				const name = validateStr('name', params.name)
				return { name }
			},

			security_scan: (params: RawToolParamsObj) => {
				// pack_ids is tolerant of the wire format: native tools send a real array,
				// XML/small models often send a comma-separated string.
				let packIds: string[] | null = null
				const raw = params.pack_ids
				if (Array.isArray(raw)) {
					const ids = raw.map(String).map(s => s.trim()).filter(s => s.length > 0)
					packIds = ids.length ? ids : null
				} else if (typeof raw === 'string' && raw.trim()) {
					const ids = raw.split(',').map(s => s.trim()).filter(s => s.length > 0)
					packIds = ids.length ? ids : null
				}
				const maxFilesRaw = validateNumber(params.max_files, { default: null })
				const maxFiles = maxFilesRaw === null ? null : Math.max(1, Math.floor(maxFilesRaw))
				return { packIds, maxFiles }
			},

			open_project: (params: RawToolParamsObj) => {
				const path = validateOptionalURI(params.path)
				const modeRaw = params.mode
				const mode = modeRaw === undefined || modeRaw === null || modeRaw === '' ? 'replace' : validateStr('mode', modeRaw)
				if (mode !== 'replace' && mode !== 'add') {
					throw new Error('mode must be "replace" or "add"')
				}
				return { path, mode }
			},

			close_project: (params: RawToolParamsObj) => {
				const path = validateURI(params.path)
				return { path }
			},

			reload_window: () => ({}),

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr)
				const newContent = validateWriteContent('new_content', newContentUnknown)
				return { uri, newContent }
			},

			append_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, content: contentUnknown } = params
				const uri = validateURI(uriStr)
				const content = validateWriteContent('content', contentUnknown)
				return { uri, content }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURI(uriStr)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown, timeout_seconds: timeoutSecondsUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const timeoutRaw = validateNumber(timeoutSecondsUnknown, { default: null })
				const timeoutSeconds = timeoutRaw === null ? null : Math.min(600, Math.max(1, timeoutRaw))
				const terminalId = generateUuid()
				return { command, cwd, terminalId, timeoutSeconds }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			read_terminal_output: (params: RawToolParamsObj) => {
				const persistentTerminalId = validateProposedTerminalId(params.persistent_terminal_id)
				return { persistentTerminalId };
			},
			ask_user: (params: RawToolParamsObj) => {
				const question = validateStr('question', params.question)
				const options = validateOptionsList('options', params.options)
				return { question, options }
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},
			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

			// --- Context Bridge ---
			remember: (params: RawToolParamsObj) => {
				const { file_path: filePathUnknown, symbol_name: symbolUnknown, note: noteUnknown } = params
				const filePath = validateStr('file_path', filePathUnknown)
				const symbolName = validateStr('symbol_name', symbolUnknown)
				const note = validateStr('note', noteUnknown)
				return { filePath, symbolName, note }
			},
			remember_editorial: (params: RawToolParamsObj) => {
				const topic = validateStr('topic', params.topic)
				const opt = (k: string) => {
					const v = (params as Record<string, unknown>)[k]
					return typeof v === 'string' && v.trim() ? v : undefined
				}
				const rawMode = opt('mode')
				return {
					topic,
					worked: opt('worked'),
					didntWork: opt('didnt_work'),
					buildNotes: opt('build_notes'),
					miniReadme: opt('mini_readme'),
					mode: rawMode === 'replace' ? 'replace' as const : 'append' as const,
				}
			},
			forget_editorial: (params: RawToolParamsObj) => {
				const topic = validateStr('topic', params.topic)
				const raw = (params as Record<string, unknown>).section
				const section = raw === 'worked' || raw === 'didnt_work' || raw === 'build_notes' || raw === 'mini_readme'
					? raw : undefined
				return { topic, section }
			},
			forget: (params: RawToolParamsObj) => {
				// Accept both 'note_id' and the common mistake 'id' — no reason to fail the call
				// over the key name (the description used to have to warn against 'id').
				const noteIdUnknown = params.note_id ?? (params as Record<string, unknown>).id
				const noteId = validateStr('note_id', noteIdUnknown)
				return { noteId }
			},
			recover_session_anchors: (params: RawToolParamsObj) => {
				const originRoot = validateOptionalStr('origin_root', params.origin_root)
				const confirmed = validateBoolean(params.confirmed, { default: false })
				return { originRoot, confirmed }
			},
			team_checkin: (params: RawToolParamsObj) => {
				const agentId = validateOptionalStr('agent_id', params.agent_id)
				const doing = validateStr('doing', params.doing)
				const where = validateOptionalStr('where', params.where)
				const statusRaw = validateOptionalStr('status', params.status)
				const status = statusRaw === 'done' ? 'done' as const : 'active' as const
				return { agentId, doing, where, status }
			},
			team_board: (_params: RawToolParamsObj) => {
				return {}
			},
			team_contract: (params: RawToolParamsObj) => {
				const actionRaw = validateStr('action', params.action).trim().toLowerCase()
				if (actionRaw !== 'set' && actionRaw !== 'clear') throw new Error('action must be "set" or "clear"')
				const key = validateStr('key', params.key).trim()
				const value = validateOptionalStr('value', params.value)
				if (actionRaw === 'set' && !value?.trim()) throw new Error('"set" requires a value')
				const rationale = validateOptionalStr('rationale', params.rationale)
				return { action: actionRaw as 'set' | 'clear', key, value: value?.trim() ?? null, rationale }
			},
			list_notes: (params: RawToolParamsObj) => {
				const { file_path: filePathUnknown } = params
				const filePath = validateOptionalStr('file_path', filePathUnknown)
				return { filePath }
			},
			search_notes: (params: RawToolParamsObj) => {
				const query = validateStr('query', params.query)
				const filePath = validateOptionalStr('file_path', params.file_path)
				const limitRaw = validateNumber(params.limit, { default: 20 })
				const limit = Math.max(1, Math.min(50, limitRaw ?? 20))
				return { query, filePath, limit }
			},
			workspace_delta: (params: RawToolParamsObj) => {
				const sinceRaw = validateNumber(params.since_ms, { default: null })
				const sinceMs = sinceRaw == null ? null : Math.max(0, sinceRaw)
				return { sinceMs }
			},
			search_chat_memory: (params: RawToolParamsObj) => {
				const { query: queryUnknown, kind: kindUnknown, role: roleUnknown, limit: limitUnknown } = params
				const query = validateStr('query', queryUnknown)
				const kind = validateOptionalMemoryKind(kindUnknown)
				const role = validateOptionalAgentRole(roleUnknown)
				const limitRaw = validateNumber(limitUnknown, { default: 20 })
				const limit = Math.max(1, Math.min(50, limitRaw ?? 20))
				return { query, kind, role, limit }
			},
			search_memory: (params: RawToolParamsObj) => {
				const query = validateStr('query', params.query)
				const scopeRaw = validateOptionalStr('scope', params.scope) ?? 'workspace'
				if (!['workspace', 'session', 'global'].includes(scopeRaw)) throw new Error('scope must be workspace, session, or global')
				const depthRaw = validateOptionalStr('depth', params.depth) ?? 'broad'
				if (!['recent', 'broad', 'deep'].includes(depthRaw)) throw new Error('depth must be recent, broad, or deep')
				const sessionId = validateOptionalStr('session_id', params.session_id)
				// The active native thread is supplied by the tool context. session_id remains
				// available for internal callers but is no longer required from the model.
				const before = validateNumber(params.before, { default: null })
				const after = validateNumber(params.after, { default: null })
				const validKinds = new Set(['fact', 'checkpoint', 'archive-page', 'symbol-note'])
				// XML transport delivers kinds as a string ('["checkpoint"]' or 'checkpoint');
				// coerce every wire shape before validating the values.
				const coercedKinds = coerceRawArrayParam(params.kinds)
				const requestedKinds = coercedKinds ? coercedKinds.map(String) : null
				if (requestedKinds?.some(kind => !validKinds.has(kind))) throw new Error(`kinds contains an unsupported memory kind. Valid kinds: ${[...validKinds].join(', ')}`)
				const kinds = requestedKinds as BuiltinToolCallParams['search_memory']['kinds']
				const limit = Math.max(1, Math.min(50, validateNumber(params.limit, { default: 12 }) ?? 12))
				return { query, scope: scopeRaw as BuiltinToolCallParams['search_memory']['scope'], depth: depthRaw as BuiltinToolCallParams['search_memory']['depth'], sessionId, before, after, kinds, limit }
			},
			get_memory_checkpoint: (params: RawToolParamsObj) => ({
				checkpointId: validateStr('checkpoint_id', params.checkpoint_id),
				includeEvents: validateBoolean(params.include_events, { default: true }),
				eventPage: Math.max(1, validateNumber(params.event_page, { default: 1 }) ?? 1),
			}),
			deep_recall: (params: RawToolParamsObj) => {
				const { query: queryUnknown, limit: limitUnknown } = params
				const query = validateStr('query', queryUnknown)
				const limitRaw = validateNumber(limitUnknown, { default: 8 })
				const limit = limitRaw == null ? null : Math.max(1, Math.min(15, limitRaw))
				return { query, limit }
			},
			get_shadow_record: (params: RawToolParamsObj) => {
				const { shadow_id: shadowIdUnknown } = params
				const shadowId = validateStr('shadow_id', shadowIdUnknown)
				return { shadowId }
			},
			get_build_errors: (params: RawToolParamsObj) => {
				const { path_filter: pathFilterUnknown, errors_only: errorsOnlyUnknown } = params
				const pathFilter = validateOptionalStr('path_filter', pathFilterUnknown)
				const errorsOnly = validateBoolean(errorsOnlyUnknown, { default: true })
				return { pathFilter, errorsOnly }
			},
			session_diff: (params: RawToolParamsObj) => {
				const pathFilter = validateOptionalStr('path_filter', params.path_filter)
				return { pathFilter }
			},
			index_health: (params: RawToolParamsObj) => {
				const rebuild = validateBoolean(params.rebuild, { default: false })
				return { rebuild }
			},
			recent_edits: (params: RawToolParamsObj) => {
				const nRaw = validateNumber(params.n, { default: 20 })
				const n = Math.max(1, Math.min(50, nRaw ?? 20))
				const file = validateOptionalStr('file', params.file)
				return { n, file }
			},
			get_chat_session: (params: RawToolParamsObj) => {
				const { session_id: sessionIdUnknown } = params
				const sessionId = validateStr('session_id', sessionIdUnknown)
				return { sessionId }
			},
			get_chat_thread: (params: RawToolParamsObj) => {
				const { event_id: eventIdUnknown } = params
				const eventId = validateStr('event_id', eventIdUnknown)
				return { eventId }
			},
			get_editorial_briefing: () => ({}),
			search_editorial: (params: RawToolParamsObj) => {
				const { query: queryUnknown, cross_project: crossProjectUnknown } = params
				const query = validateStr('query', queryUnknown)
				const crossProject = validateBoolean(crossProjectUnknown, { default: false })
				return { query, crossProject }
			},
			find_text: (params: RawToolParamsObj) => {
				const { query: queryUnknown, is_regex: isRegexUnknown, include_pattern: includeUnknown, page_number: pageNumberUnknown, context_lines: contextLinesUnknown } = params
				const query = validateStr('query', queryUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const contextLines = Math.max(0, Math.min(10, validateNumber(contextLinesUnknown, { default: 0 }) ?? 0))
				return { query, isRegex, includePattern, pageNumber, contextLines }
			},
			semantic_search: (params: RawToolParamsObj) => {
				const { query: queryUnknown, top_k: topKUnknown, include_file: includeFileUnknown, include_files: includeFilesUnknown, rerank: rerankUnknown } = params
				const query = validateStr('query', queryUnknown)
				// Opt-in LLM rerank. Accept boolean or the strings "true"/"1".
				const rerank = (rerankUnknown as unknown) === true || rerankUnknown === 'true' || rerankUnknown === '1'
				const topKRaw = typeof topKUnknown === 'number' ? topKUnknown
					: typeof topKUnknown === 'string' && topKUnknown ? Number(topKUnknown)
						: null
				const topK = topKRaw === null || Number.isNaN(topKRaw) ? null : Math.max(1, Math.min(50, Math.floor(topKRaw)))
				const includeFile = validateOptionalStr('include_file', includeFileUnknown)
				// Accept both singular include_file and plural include_files.
				const includeFilesArr: string[] = [];
				if (includeFile) includeFilesArr.push(includeFile);
				if (Array.isArray(includeFilesUnknown)) {
					for (const f of includeFilesUnknown) {
						if (typeof f === 'string' && f) includeFilesArr.push(f);
					}
				}
				const includeFiles = includeFilesArr.length > 0 ? includeFilesArr : null;
				return { query, topK, includeFile, includeFiles, rerank }
			},
			symbol_lookup: (params: RawToolParamsObj) => {
				const name = validateStr('name', params.name)
				const defsOnly = validateBoolean(params.defs_only, { default: false })
				return { name, defsOnly }
			},
			impact_trace: (params: RawToolParamsObj) => {
				const target = validateStr('target', params.target)
				const depthRaw = validateNumber(params.depth, { default: null })
				const depth = depthRaw === null || Number.isNaN(depthRaw) ? null : Math.max(1, Math.min(8, Math.floor(depthRaw)))
				return { target, depth }
			},
			get_file_context: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path)
				return { filePath }
			},
			get_file_dependencies: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path)
				return { filePath }
			},
			get_symbol_context: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path)
				const symbolName = validateStr('symbol_name', params.symbol_name)
				return { filePath, symbolName }
			},
			get_call_graph: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path)
				const symbolName = validateStr('symbol_name', params.symbol_name)
				const rawDir = typeof params.direction === 'string' ? params.direction : 'incoming'
				const direction: 'incoming' | 'outgoing' = rawDir === 'outgoing' ? 'outgoing' : 'incoming'
				const rawDepth = validateNumber(params.depth, { default: 2 }) ?? 2
				const depth = Math.min(Math.max(1, Math.floor(rawDepth)), 4)
				return { filePath, symbolName, direction, depth }
			},
			pack_context: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path)
				const symbolName = validateStr('symbol_name', params.symbol_name)
				const rawTask = typeof params.task === 'string' ? params.task : 'understand'
				const task: PackContextTask =
					rawTask === 'refactor' ? 'refactor'
						: rawTask === 'debug' ? 'debug'
							: rawTask === 'extend' ? 'extend'
								: 'understand'
				const maxTokens = validateNumber(params.max_tokens, { default: 3000 }) ?? 3000
				return { filePath, symbolName, task, maxTokens }
			},
			get_project_briefing: (params: RawToolParamsObj) => {
				const includeNotes = validateBoolean(params.include_notes, { default: true })
				return { includeNotes }
			},

			// --- Web & Git & Browser ---
			web_search: (params: RawToolParamsObj) => {
				const query = validateStr('query', params.query)
				const maxResults = validateNumber(params.max_results, { default: 5 }) ?? 5
				return { query, maxResults }
			},
			web_fetch: (params: RawToolParamsObj) => {
				const url = validateStr('url', params.url)
				const pageNumber = validatePageNum(params.page_number)
				return { url, pageNumber }
			},
			repo_hygiene: (params: RawToolParamsObj) => {
				const actionRaw = validateStr('action', params.action).trim().toLowerCase()
				if (!['plan', 'push', 'remove', 'prune'].includes(actionRaw)) throw new Error('action must be "plan", "push", "remove", or "prune"')
				const path = validateOptionalStr('path', params.path)
				if ((actionRaw === 'push' || actionRaw === 'remove') && !path) throw new Error(`"${actionRaw}" needs the worktree path from the plan`)
				return { action: actionRaw as 'plan' | 'push' | 'remove' | 'prune', path }
			},
			git_status: (_params: RawToolParamsObj) => {
				return {}
			},
			git_stage: (params: RawToolParamsObj) => {
				const paths = validatePathList('paths', params.paths)
				return { paths }
			},
			git_commit: (params: RawToolParamsObj) => {
				const message = validateStr('message', params.message)
				const paths = validateOptionalPathList('paths', params.paths)
				return { message, paths }
			},
			git_diff: (params: RawToolParamsObj) => {
				const staged = validateBoolean(params.staged, { default: false })
				const { base, head, path } = reviewDiffArgs(params)
				if (staged && (base || head)) throw new Error('Use staged or revision comparison, not both')
				return { staged, base, head, path }
			},
			git_log: (params: RawToolParamsObj) => {
				const countRaw = validateNumber(params.count, { default: 10 }) ?? 10
				const count = Math.min(50, Math.max(1, countRaw))
				return { count }
			},
			git_branch: (_params: RawToolParamsObj) => {
				return {}
			},
			git_push: (params: RawToolParamsObj) => {
				const remote = validateOptionalGitRef('remote', params.remote)
				const branch = validateOptionalGitRef('branch', params.branch)
				const setUpstream = validateBoolean(params.set_upstream, { default: false })
				return { remote, branch, setUpstream }
			},
			git_pull: (params: RawToolParamsObj) => {
				const remote = validateOptionalGitRef('remote', params.remote)
				const branch = validateOptionalGitRef('branch', params.branch)
				return { remote, branch }
			},
			git_fetch: (params: RawToolParamsObj) => {
				const remote = validateOptionalGitRef('remote', params.remote)
				return { remote }
			},
			git_checkout: (params: RawToolParamsObj) => {
				const branch = validateGitRef('branch', params.branch)
				const create = validateBoolean(params.create, { default: false })
				return { branch, create }
			},
			git_stash: (params: RawToolParamsObj) => {
				const action = validateGitStashAction(params.action)
				const message = validateOptionalStr('message', params.message)
				const paths = action === 'push' ? validateOptionalPathList('paths', params.paths) : null
				return { action, message, paths }
			},
			git_remote: (_params: RawToolParamsObj) => ({}),
			git_show: (params: RawToolParamsObj) => {
				const ref = params.ref ? validateGitRevision('ref', params.ref) : 'HEAD'
				const path = validateOptionalStr('path', params.path)
				const statOnly = validateBoolean(params.stat_only, { default: false })
				return { ref, path, statOnly }
			},
			git_blame: (params: RawToolParamsObj) => {
				const path = validateStr('path', params.path)
				const startLine = validateNumber(params.start_line, { default: null })
				const endLine = validateNumber(params.end_line, { default: null })
				if ((startLine === null) !== (endLine === null)) {
					throw new Error('start_line and end_line must both be set or both omitted')
				}
				return { path, startLine, endLine }
			},
			git_merge: (params: RawToolParamsObj) => {
				const abort = validateBoolean(params.abort, { default: false })
				const branch = abort ? null : validateGitRef('branch', params.branch)
				return { branch, abort }
			},
			git_rebase: (params: RawToolParamsObj) => {
				const action = validateGitRebaseAction(params.action ?? 'start')
				const branch = action === 'start' ? validateGitRef('branch', params.branch) : null
				return { action, branch }
			},
			git_cherry_pick: (params: RawToolParamsObj) => {
				const abort = validateBoolean(params.abort, { default: false })
				const commit = abort ? null : validateGitCommitHash('commit', params.commit)
				return { commit, abort }
			},
			git_restore: (params: RawToolParamsObj) => {
				const paths = validatePathList('paths', params.paths)
				const staged = validateBoolean(params.staged, { default: false })
				return { paths, staged }
			},
			git_reset: (params: RawToolParamsObj) => {
				const mode = validateGitResetMode(params.mode)
				const ref = params.ref ? validateGitRevision('ref', params.ref) : 'HEAD'
				return { mode, ref }
			},
			open_browser: (params: RawToolParamsObj) => {
				const url = validateStr('url', params.url)
				if (!/^https?:\/\//i.test(url)) {
					throw new Error(`Invalid URL: "${url}". Must start with http:// or https://.`)
				}
				const mobile = validateBoolean(params.mobile, { default: false })
				return { url, mobile }
			},
			open_browser_page: (params: RawToolParamsObj) => ({
				url: params.url ? String(params.url) : '',
				force_new: params.force_new ? String(params.force_new) : '',
			}),
			read_page: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
			}),
			click_element: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				element: validateStr('element', params.element),
				ref: params.ref ? String(params.ref) : '',
				selector: params.selector ? String(params.selector) : '',
				dbl_click: params.dbl_click ? String(params.dbl_click) : '',
				button: params.button ? String(params.button) : '',
			}),
			type_in_page: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				text: params.text ? String(params.text) : '',
				key: params.key ? String(params.key) : '',
				ref: params.ref ? String(params.ref) : '',
				element: params.element ? String(params.element) : '',
			}),
			// Computer use is handled by the native tools in contrib/computerUse; these entries exist only
			// to satisfy the exhaustive maps, exactly as the browser tools above do.
			computer_read_screen: (params: RawToolParamsObj) => (params as never),
			computer_read_screen_changes: (params: RawToolParamsObj) => (params as never),
			computer_screenshot: (params: RawToolParamsObj) => (params as never),
			computer_click: (params: RawToolParamsObj) => (params as never),
			computer_type: (params: RawToolParamsObj) => (params as never),
			computer_key: (params: RawToolParamsObj) => (params as never),
			computer_scroll: (params: RawToolParamsObj) => (params as never),
			computer_cursor: (params: RawToolParamsObj) => (params as never),
			computer_wait_for_stable: (params: RawToolParamsObj) => (params as never),
			computer_list_apps: (params: RawToolParamsObj) => (params as never),
			computer_drag: (params: RawToolParamsObj) => (params as never),
			computer_hover: (params: RawToolParamsObj) => (params as never),
			computer_clipboard_read: (params: RawToolParamsObj) => (params as never),
			computer_clipboard_write: (params: RawToolParamsObj) => (params as never),
			computer_open_app: (params: RawToolParamsObj) => (params as never),
			screenshot_page: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				ref: params.ref ? String(params.ref) : '',
				element: params.element ? String(params.element) : '',
			}),
			navigate_page: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				type: params.type ? String(params.type) : '',
				url: params.url ? String(params.url) : '',
			}),
			hover_element: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				element: validateStr('element', params.element),
				ref: params.ref ? String(params.ref) : '',
				selector: params.selector ? String(params.selector) : '',
				settle_ms: validateNumber(params.settle_ms, { default: 400 }) ?? 400,
				wait_for_selector: params.wait_for_selector ? String(params.wait_for_selector) : '',
			}),
			drag_element: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				from_element: validateStr('from_element', params.from_element),
				to_element: validateStr('to_element', params.to_element),
				from_ref: params.from_ref ? String(params.from_ref) : '',
				from_selector: params.from_selector ? String(params.from_selector) : '',
				to_ref: params.to_ref ? String(params.to_ref) : '',
				to_selector: params.to_selector ? String(params.to_selector) : '',
			}),
			handle_dialog: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				accept_modal: params.accept_modal !== undefined ? String(params.accept_modal) : '',
				prompt_text: params.prompt_text ? String(params.prompt_text) : '',
				select_files: params.select_files ? String(params.select_files) : '',
			}),
			run_playwright_code: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				code: params.code ? String(params.code) : '',
				deferred_result_id: params.deferred_result_id ? String(params.deferred_result_id) : '',
				timeout_ms: validateNumber(params.timeout_ms, { default: 5000 }) ?? 5000,
			}),
			extract_page_data: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				focus: params.focus ? String(params.focus) : 'full',
			}),
			get_browser_console_logs: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				max_lines: validateNumber(params.max_lines, { default: 200 }) ?? 200,
			}),
			reconstruct_page_sources: (params: RawToolParamsObj) => ({
				script_url: validateStr('script_url', params.script_url),
				output_dir: params.output_dir ? String(params.output_dir) : '',
				method: params.method ? String(params.method) : 'auto',
			}),
			get_computed_styles: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				ref: params.ref ? String(params.ref) : '',
				selector: params.selector ? String(params.selector) : '',
				element: params.element ? String(params.element) : '',
			}),
			watch_page: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				ref: params.ref ? String(params.ref) : '',
				selector: params.selector ? String(params.selector) : '',
				text_contains: params.text_contains ? String(params.text_contains) : '',
				timeout_ms: validateNumber(params.timeout_ms, { default: 60000 }) ?? 60000,
				interval_ms: validateNumber(params.interval_ms, { default: 1000 }) ?? 1000,
			}),
			save_browser_session: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				session_name: params.session_name ? String(params.session_name) : '',
			}),
			restore_browser_session: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				session_name: params.session_name ? String(params.session_name) : '',
				reload: params.reload ? String(params.reload) : 'true',
			}),
			fill_form: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				fields: validateStr('fields', params.fields),
			}),
			intercept_network: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				url_pattern: validateStr('url_pattern', params.url_pattern),
				include_bodies: params.include_bodies ? String(params.include_bodies) : 'false',
			}),
			get_browser_network_log: (params: RawToolParamsObj) => ({
				page_id: validateStr('page_id', params.page_id),
				clear: params.clear ? String(params.clear) : 'false',
			}),
			generate_image: (params: RawToolParamsObj) => {
				const prompt = validateStr('prompt', params.prompt)
				const outputPath = validateOptionalStr('output_path', params.output_path)
				const model = validateOptionalStr('model', params.model)
				return { prompt, outputPath, model }
			},
			launch_subagent: (params: RawToolParamsObj) => {
				const description = validateStr('description', params.description)
				const prompt = validateStr('prompt', params.prompt)
				return { description, prompt, profile: validateSubagentProfile(params) }
			},
			message_subagent: (params: RawToolParamsObj) => {
				const subagentThreadId = validateStr('subagent_thread_id', params.subagent_thread_id)
				const message = validateStr('message', params.message)
				return { subagentThreadId, message }
			},
			report_progress: (params: RawToolParamsObj) => {
				const milestone = validateStr('milestone', params.milestone)
				return { milestone }
			},
			run_subagent: (params: RawToolParamsObj) => {
				const prompt = validateStr('prompt', params.prompt)
				const description = validateStr('description', params.description)
				const agentName = params.agent_name ? String(params.agent_name) : undefined
				const model = params.model ? String(params.model) : undefined
				return { prompt, description, agentName, model, profile: validateSubagentProfile(params) }
			},
			rename_symbol: (params: RawToolParamsObj) => {
				const symbol = validateStr('symbol', params.symbol)
				const new_name = validateStr('new_name', params.new_name)
				const line_content = validateStr('line_content', params.line_content)
				const file_path = params.file_path ? String(params.file_path) : undefined
				const uri = params.uri ? String(params.uri) : undefined
				return { symbol, new_name, line_content, file_path, uri }
			},
			list_code_usages: (params: RawToolParamsObj) => {
				const symbol = validateStr('symbol', params.symbol)
				const line_content = validateStr('line_content', params.line_content)
				const file_path = params.file_path ? String(params.file_path) : undefined
				const uri = params.uri ? String(params.uri) : undefined
				return { symbol, line_content, file_path, uri }
			},
			run_tests: (params: RawToolParamsObj) => ({
				files: params.files ? String(params.files) : undefined,
				test_names: params.test_names ? String(params.test_names) : undefined,
				mode: params.mode ? String(params.mode) : undefined,
				coverage_files: params.coverage_files ? String(params.coverage_files) : undefined,
			}),
			run_sandbox: (params: RawToolParamsObj) => {
				const code = validateStr('code', params.code)
				const timeoutMs = validateNumber(params.timeout_ms, { default: null })
				return { code, timeoutMs }
			},

			update_plan: (params: RawToolParamsObj) => {
				type Todo = { id: string, content: string, status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }
				const allowedStatus = ['pending', 'in_progress', 'completed', 'cancelled']
				let parsed: unknown
				if (typeof params.todos === 'string') {
					try {
						parsed = JSON.parse(params.todos)
					} catch {
						throw new Error('todos must be a JSON array of { id, content, status } — the provided string was not valid JSON')
					}
				} else {
					parsed = params.todos
				}
				if (!Array.isArray(parsed)) {
					throw new Error('todos must be a JSON array of { id, content, status }')
				}
				// Normalize each item so malformed entries fail here with an actionable
				// message instead of crashing downstream (e.g. todos.map is not a function).
				const todos: Todo[] = parsed.map((raw, i) => {
					if (typeof raw !== 'object' || raw === null) {
						throw new Error(`todos[${i}] must be an object with { id, content, status }`)
					}
					const item = raw as Record<string, unknown>
					const id = item.id === undefined || item.id === null ? String(i) : String(item.id)
					const content = typeof item.content === 'string' ? item.content : ''
					if (!content) {
						throw new Error(`todos[${i}].content is required and must be a non-empty string`)
					}
					const status = typeof item.status === 'string' && allowedStatus.includes(item.status) ? item.status : 'pending'
					return { id, content, status: status as Todo['status'] }
				})
				// String 'true' from the LLM must count as true; '' / 'false' / 0 as false.
				// (!!'false' === true would merge when the model asked to replace.)
				const mergeRaw: unknown = params.merge
				const merge = mergeRaw === undefined ? false : (mergeRaw === true || mergeRaw === 'true' || mergeRaw === 1 || mergeRaw === '1')
				return { todos, merge }
			},

		}


		// Lightweight telemetry wrapper for Context Bridge tools — emits one
		// structured log line per invocation with duration + outcome. No params
		// or result content (PII-safe). Logs `info` on success, `warn` on failure;
		// failure re-throws so the upstream tool-call error path is unchanged.
		const log = this.logService
		const cbTrace = <T>(name: string, run: () => Promise<T>): Promise<T> => {
			const t0 = performance.now()
			return run().then(
				result => {
					log.info(`[cb-tool] tool=${name} duration_ms=${Math.round(performance.now() - t0)} ok=true`)
					return result
				},
				err => {
					const cls = err instanceof Error ? err.constructor.name : 'unknown'
					log.warn(`[cb-tool] tool=${name} duration_ms=${Math.round(performance.now() - t0)} ok=false err=${cls}`)
					throw err
				},
			)
		}

		// Resolve the directory to run git in. The first workspace folder may be a
		// non-repo parent that contains several nested repos (e.g. a monorepo root),
		// so prefer the active file's folder — git walks up from there to the right
		// repo. Falls back to the default workspace-folder cwd when no file editor
		// is active.
		const resolveGitCwd = (): string | null => {
			const resource = this.editorService.activeEditor?.resource
			if (resource && resource.scheme === 'file') {
				return dirname(resource).fsPath
			}
			return null
		}

		// Network git (push/pull/fetch) is routinely quiet for far longer than the 8s default
		// inactivity window, and a credential or editor prompt is quiet forever.
		const GIT_INACTIVITY_TIMEOUT_SEC = 60

		// Every caller below falls back to a cheerful `'(push completed)'`-style string when the
		// output is empty. A timed-out or failed command ALSO produces empty/partial output, so
		// without this check the model is told an irreversible operation succeeded when it may
		// not have run at all. Fail loudly instead and tell it to verify rather than assume.
		const runGitCmd = async (cmd: string): Promise<string> => {
			const cwd = resolveGitCwd()
			const { resPromise } = await this.terminalToolService.runCommand(cmd, { type: 'temporary', cwd, terminalId: generateUuid(), inactivityTimeoutSec: GIT_INACTIVITY_TIMEOUT_SEC })
			const { result, resolveReason } = await resPromise
			const output = result.trim()

			if (resolveReason.type === 'timeout') {
				const waiting = resolveReason.mightBeWaitingForInput
					? ' It looks like it is WAITING FOR INPUT (credentials, a passphrase, or an editor) — it will never finish on its own.'
					: ''
				throw new Error(`\`${cmd}\` did not finish; it was still running after ${resolveReason.timeoutSec ?? GIT_INACTIVITY_TIMEOUT_SEC}s.${waiting} It may or may not have applied — do NOT assume it succeeded. Check with git_status / git_log / git_branch before continuing.${output ? `\n\nPartial output:\n${output}` : ''}`)
			}
			// exitCode is undefined when shell integration cannot report one; only a real
			// non-zero code is a failure.
			if (resolveReason.type === 'done' && typeof resolveReason.exitCode === 'number' && resolveReason.exitCode !== 0) {
				throw new Error(`\`${cmd}\` failed with exit code ${resolveReason.exitCode}.${output ? `\n\n${output}` : ' (no output)'}`)
			}
			return output
		}

		/**
		 * Make a write target exist before writing to it.
		 *
		 * rewrite_file and append_file used to REFUSE a path that did not exist, telling the model
		 * to call create_file_or_folder first. That is a full extra round trip on every new file,
		 * and far worse than it sounds: the model had already generated the entire file content
		 * into the rejected call, so it had to generate all of it a second time. Observed live --
		 * a 28,000-character document produced, rejected for a missing file, and produced again.
		 * Creating it here is what makes "write this new file" one call instead of two plus a
		 * full regeneration. It is also why models learned to open with create_file_or_folder.
		 */
		/**
		 * Paths this agent deleted, until something writes them again.
		 *
		 * The editor's own signals cannot answer "is this buffer a ghost?". ORPHAN is cleared by
		 * our own createFile and is set asynchronously by the watcher, so it is unreliable in both
		 * directions; isDirty is set deliberately on delete to protect the buffer, which makes a
		 * ghost look exactly like unsaved user work. Four fixes died on that ambiguity.
		 *
		 * delete_file_or_folder does not have to infer anything — it IS the deletion. Recording it
		 * here gives every writer a discriminator owned by this layer, which no other subsystem can
		 * clear or race. Nothing outside this file writes to it.
		 */
		const deletedByAgent = new Set<string>()

		const ensureFileExistsForWrite = async (uri: URI): Promise<boolean> => {
			try {
				const stat = await fileService.resolve(uri)
				if (stat.isDirectory) { throw new Error(`${uri.fsPath} is a DIRECTORY, not a file — nothing was written. Pick a file path inside it.`) }
				return false
			} catch (e) {
				// resolve() throws for "does not exist", which is the case we are here to handle;
				// rethrow our own directory error unchanged.
				if (e instanceof Error && e.message.includes('is a DIRECTORY')) { throw e }
			}
			try {
				await fileService.createFile(uri, undefined, { overwrite: false })
			} catch (e) {
				// The usual cause is an ancestor path segment that exists as a FILE, so nothing can
				// be created beneath it. create_file_or_folder diagnoses this precisely; point there
				// rather than surfacing a bare platform error.
				throw new Error(`Could not create ${uri.fsPath}: ${e instanceof Error ? e.message : e}. Nothing was written. A parent path segment may exist as a file rather than a folder — check with ls_dir.`)
			}
			return true
		}

		/**
		 * Save the editor buffer, then PROVE the bytes reached disk.
		 *
		 * delete_file_or_folder followed by a write to the same path could bind that write to a
		 * text model that outlived the delete. The buffer held the new content and the tool
		 * reported a correct-looking diff, but the save no-oped and the file stayed at the zero
		 * bytes ensureFileExistsForWrite had just created. Nothing caught it: read_file and
		 * find_text both serve the buffer, so the agent verified its own work against the same
		 * phantom and reported success over a file it had destroyed.
		 *
		 * Reading the file back costs one read against silently losing a user's work, so it is
		 * not a trade. EOL is normalised before comparing so a CRLF checkout is never mistaken
		 * for a failed save, and the direct write only runs once the contents genuinely differ.
		 */
		const saveAndVerifyOnDisk = async (uri: URI, expectedContent: string): Promise<void> => {
			let saveError: unknown
			// Do not rethrow yet — a failed save that still landed the bytes is not a failure,
			// and one that did not is recoverable below. Only the final state decides.
			try { await voidModelService.saveModel(uri) }
			catch (e) { saveError = e }

			const matchesDisk = async (): Promise<boolean> => {
				try {
					const onDisk = (await fileService.readFile(uri)).value.toString()
					return onDisk.replace(/\r\n/g, '\n') === expectedContent.replace(/\r\n/g, '\n')
				} catch { return false }
			}
			if (await matchesDisk()) { return }

			const because = saveError instanceof Error ? `: ${saveError.message}` : ''
			try { await fileService.writeFile(uri, VSBuffer.fromString(expectedContent)) }
			catch (e) {
				throw new Error(`Edit applied in the editor buffer but SAVING TO DISK FAILED for ${uri.fsPath}${because}. Writing the bytes directly also failed: ${e instanceof Error ? e.message : e}. The file on disk does NOT contain the change.`)
			}
			if (await matchesDisk()) { return }
			throw new Error(`${uri.fsPath} could NOT be written to disk${because}. The file on disk does NOT contain the change — do not trust a read of this path until you have confirmed it from the shell, because an editor buffer can outlive the file it came from.`)
		}

		this.callTool = {
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				// initializeModel THROWS on a missing file; catch it so a deleted/wrong path returns
				// a clear, non-retryable message instead of looping the agent on a ghost file.
				let fileMissing = false
				try {
					await voidModelService.initializeModel(uri)
					// Every file tool reads model.getValue() — the BUFFER, not the file. Models are
					// cached permanently (voidModelService._modelRefOfURI) and initializeModel
					// short-circuits on a cache hit, so once a path has been read nothing re-reads
					// disk. Without this, read_file will confidently return content that is not on
					// disk: seed a file, read it, change it out of band, read again — you get the
					// seed. That is how an agent "verifies" a patch that never landed, and it makes
					// every subsequent edit a diff against fiction.
					//
					// The three WRITE paths (rewrite_file, append_file, edit_file) already refresh.
					// read_file was the hole, which also explains why a preceding read sometimes
					// appeared to protect an edit — coincidence, not mechanism: that file simply
					// had not been cached yet.
					//
					// Safe for unsaved work: refreshIfStale reverts only CLEAN models, and bails on
					// dirty ones. For read_file that bail is not a compromise but the correct
					// answer — with genuine unsaved editor edits, the buffer IS the current state.
					await voidModelService.refreshIfStale(uri)
				} catch { fileMissing = true }
				const { model } = fileMissing ? { model: null } : await voidModelService.getModelSafe(uri)
				if (model === null) {
					// A text model fails to load for two very different reasons, and reporting
					// both as "not found" sent the agent hunting a path that was demonstrably
					// there: a 2.6 MB PNG that ls_dir listed and stat sized came back as FILE
					// NOT FOUND, complete with an instruction not to retry. Ask the disk before
					// blaming the path.
					let existsAsFile = false
					try { existsAsFile = !(await fileService.resolve(uri)).isDirectory } catch { /* genuinely missing */ }
					if (existsAsFile) {
						throw new Error(`${uri.fsPath} EXISTS but could not be read as text — it is almost certainly binary (image, archive, compiled artifact, or a non-UTF8 encoding). This is NOT a missing path, so do not go looking for a different one. To look at an image, open it with open_browser_page using its file:// URL and then screenshot_page.`)
					}
					throw new Error(`FILE NOT FOUND: ${uri.fsPath} does not exist (it was likely deleted, or the path is wrong). Do NOT retry this path — confirm a real path with ls_dir or search_for_files, or ask the user.`)
				}

				let contents: string
				if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
				}
				else {
					const startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? model.getLineCount() : endLine
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
				}

				const totalNumLines = model.getLineCount()

				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				const fileContents = contents.slice(fromIdx, toIdx + 1) // paginate
				const hasNextPage = (contents.length - 1) - toIdx >= 1
				const totalFileLen = contents.length

				// Completeness signal: report the exact line range this read returned and whether the
				// agent now holds the COMPLETE file. Without this the agent re-reads the same file
				// repeatedly out of uncertainty about whether it got the tail. `contents` begins at
				// `startLineNumber` (1 unless a range was requested); count newlines to map the char-paginated
				// slice back to line numbers.
				const countNewlines = (s: string) => { let c = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) c++; return c }
				const rangeStartLine = startLine === null ? 1 : startLine
				const linesBeforePage = pageNumber > 1 ? countNewlines(contents.slice(0, fromIdx)) : 0
				const returnedStartLine = Math.min(totalNumLines, rangeStartLine + linesBeforePage)
				const returnedEndLine = fileContents.length === 0
					? returnedStartLine
					: Math.min(totalNumLines, returnedStartLine + countNewlines(fileContents))
				// Complete = we returned from line 1 through the last line of the file with no further page.
				const isComplete = !hasNextPage && returnedStartLine <= 1 && returnedEndLine >= totalNumLines
				return { result: { fileContents, totalFileLen, hasNextPage, totalNumLines, returnedStartLine, returnedEndLine, isComplete } }
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders)

				const data = await searchService.textSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { queryStr, uris, hasNextPage } }
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				// Read the file contents directly instead of initializeModel(). initializeModel
				// keeps a STRONG TextModel reference per file in VoidModelService and never
				// releases it, so every searched file leaked a model + its onDidChange listener
				// (the "potential listener LEAK detected, 175 listeners" warning fired after
				// enough search_in_file calls). A line search only needs the raw text, so we read
				// it via the file service and retain nothing.
				let contents: string;
				try {
					const fileContent = await fileService.readFile(uri);
					contents = fileContent.value.toString();
				} catch {
					throw new Error(`FILE NOT FOUND: ${uri.fsPath} does not exist (it was likely deleted, or the path is wrong). Do NOT retry this path — confirm a real path with ls_dir or search_for_files, or ask the user.`);
				}
				const contentOfLine = contents.split(/\r\n|\r|\n/);
				const totalLines = contentOfLine.length;
				// An unguarded `new RegExp` handed the model a raw SyntaxError with no hint that
				// its own pattern was the problem, so it retried the same broken query.
				let regex: RegExp | null = null;
				if (isRegex) {
					try { regex = new RegExp(query) }
					catch (e) { throw new Error(`"${query}" is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}. Either fix the pattern or search for it as plain text with is_regex: "false".`) }
				}
				const lines: number[] = []
				// Carry the matched line TEXT in the result. The stringifier used to re-read the
				// text from a VoidModelService model, but this tool intentionally stopped loading
				// one (listener leak), so getModel() was always null and every result stringified
				// to "<Error getting string of result>". We already have the text here.
				const matched: { line: number; text: string }[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
						matched.push({ line: matchLine, text: line });
					}
				}
				// Each match stringifies to a 3-line fenced block, so an unbounded search for a
				// common token (`return`, `this`) buried the whole context window in one call.
				const totalMatches = matched.length
				return { result: { lines: lines.slice(0, MAX_SEARCH_IN_FILE_MATCHES), matched: matched.slice(0, MAX_SEARCH_IN_FILE_MATCHES), totalMatches } };
			},

			read_lint_errors: async ({ uri }) => {
				// A fixed 1s sleep was not long enough for a language server to produce markers on
				// a file it had never seen, so a freshly written file reported clean and the model
				// shipped it. The wait-for-marker-event path is what the shadow workspace and
				// Turbo Draft already use; the tool the MODEL calls should be at least as honest.
				const lintErrors = await this.markerCheckService.collectDiagnosticsWithWait(uri, LINT_WAIT_MS)
				return { result: { lintErrors } }
			},

			security_scan: async ({ packIds, maxFiles }) => {
				try {
					const res = await this.securityScanService.scan({
						packIds: packIds ?? undefined,
						maxFiles: maxFiles ?? undefined,
					})
					return {
						result: {
							ran: true,
							error: null,
							human: res.human,
							memory: res.memory,
							findingCount: res.findings.length,
							filesScanned: res.filesScanned,
							filesSkipped: res.filesSkipped,
							packIds: [...res.packIds],
							workspace: res.workspace,
						}
					}
				} catch (e) {
					// A scan that cannot run must say so plainly rather than look like a clean result.
					return {
						result: {
							ran: false,
							error: e instanceof Error ? e.message : String(e),
							human: '', memory: '', findingCount: 0, filesScanned: 0, filesSkipped: 0,
							packIds: [], workspace: '',
						}
					}
				}
			},

			read_skill: async ({ name }) => {
				const skill = await this.skillsService.getSkillByName(name)
				if (skill) {
					return { result: { found: true, name: skill.name, content: skill.content, filePath: skill.filePath, availableNames: [] } }
				}
				const all = await this.skillsService.getAvailableSkillsList()
				return { result: { found: false, name, content: '', filePath: '', availableNames: all.map(s => s.name) } }
			},

			open_project: async ({ path, mode }, ctx) => {
				let folder = path
				if (!folder) {
					const picked = await this.fileDialogService.showOpenDialog({
						title: 'Choose a project for V3Code',
						openLabel: 'Open Project',
						canSelectFiles: false,
						canSelectFolders: true,
						canSelectMany: false,
						defaultUri: await this.fileDialogService.defaultFolderPath(),
					})
					folder = picked?.at(0) ?? null
				}

				if (!folder) {
					return {
						result: {
							folder: '',
							mode,
							changed: false,
							cancelled: true,
							workspaceFolders: this.workspaceContextService.getWorkspace().folders.map(item => item.uri.toString(true)),
							indexStatus: this.semanticIndexService.getStatus(),
							rebuildStarted: false,
						},
					}
				}

				let stat
				try {
					stat = await this.fileService.resolve(folder)
				} catch {
					throw new Error(`Project folder not found: ${folder.scheme === 'file' ? folder.fsPath : folder.toString(true)}`)
				}
				if (!stat.isDirectory) {
					throw new Error(`open_project requires a folder, but this is a file: ${folder.scheme === 'file' ? folder.fsPath : folder.toString(true)}`)
				}

				const before = this.workspaceContextService.getWorkspace()
				const folderChange = planProjectWorkspaceChange(before.folders.map(item => item.uri), folder, mode)
				let changed = false
				let transitionToken: string | null = null

				if (folderChange.kind !== 'none') {
					const targetRoot = folder.scheme === 'file' ? folder.fsPath : folder.toString(true)
					transitionToken = await this.memoryService.beginSessionTransition(
						ctx?.threadId ?? '',
						folderChange.kind === 'replace' ? 'replacement' : 'multi-root-attach',
						targetRoot,
					)
					const managedHome = joinPath(this.environmentService.userRoamingDataHome, 'v3code-projects')
					if (!await this.fileService.exists(managedHome)) {
						await this.fileService.createFolder(managedHome)
					}
					const workspaceKey = await hashAsync(ctx?.threadId ?? folder.toString())
					const managedWorkspace = joinPath(managedHome, `chat-${workspaceKey.slice(0, 20)}.code-workspace`)
					const folders = folderChange.folders.map(uri => ({ uri }))

					// A saved, app-managed workspace avoids the editor's "save workspace?"
					// prompt while preserving this exact chat and all workspace storage across
					// the internal context switch. Once inside it, later projects are added
					// in place so no window or agent session is recreated.
					const isManagedProjectContext = this.workspaceContextService.getWorkbenchState() === WorkbenchState.WORKSPACE
						&& before.configuration
						&& isEqual(dirname(before.configuration), managedHome)
					try {
						if (isManagedProjectContext) {
							if (folderChange.kind === 'replace') {
								await this.workspaceEditingService.updateFolders(0, before.folders.length, [{ uri: folder }], true)
							} else {
								await this.workspaceEditingService.addFolders([{ uri: folder }], true)
							}
						} else {
							await this.workspaceEditingService.createAndEnterWorkspace(folders, managedWorkspace)
						}
					} catch (error) {
						this.memoryService.cancelSessionTransition(transitionToken)
						throw error
					}
					changed = true
				}

				const activeFolders = this.workspaceContextService.getWorkspace().folders
				const targetAttached = activeFolders.some(item => isEqual(item.uri, folder))
				const replaceIsExclusive = mode !== 'replace' || (activeFolders.length === 1 && targetAttached)
				if (!targetAttached || !replaceIsExclusive) {
					this.memoryService.cancelSessionTransition(transitionToken)
					throw new Error('V3Code could not switch to the selected project. The current chat was left unchanged.')
				}

				// The indexer already listens for folder changes. An explicit background
				// rebuild makes the tool result honest and deterministic even when a
				// project was already attached but its index was stale.
				void this.semanticIndexService.rebuild().catch(error => this.logService.warn('[open_project] index rebuild failed', error))
				return {
					result: {
						folder: folder.scheme === 'file' ? folder.fsPath : folder.toString(true),
						mode,
						changed,
						cancelled: false,
						workspaceFolders: activeFolders.map(item => item.uri.scheme === 'file' ? item.uri.fsPath : item.uri.toString(true)),
						indexStatus: this.semanticIndexService.getStatus(),
						rebuildStarted: true,
						// beginSessionTransition silently no-ops without a thread id — surface
						// that loudly instead of letting thread memory quietly not follow.
						...(changed ? { anchorCarry: (ctx?.threadId ? 'carried' : 'no-thread-id') as 'carried' | 'no-thread-id' } : {}),
						// In-place swaps (same renderer) can report the carry manifest right in the
						// result; the window-reload branch reports it as a system notification when
						// the next startup reconciles the transition (memoryService event).
						...(changed && ctx?.threadId ? { carryManifest: describeCarriedContinuity(await this.memoryService.getSessionContinuity(ctx.threadId)) } : {}),
					},
				}
			},

			close_project: async ({ path }) => {
				const before = this.workspaceContextService.getWorkspace()
				const attached = before.folders.find(item => isEqual(item.uri, path))
				if (!attached) {
					throw new Error(`Project is not attached: ${path.scheme === 'file' ? path.fsPath : path.toString(true)}`)
				}
				await this.workspaceEditingService.removeFolders([attached.uri], true)
				const activeFolders = this.workspaceContextService.getWorkspace().folders
				if (activeFolders.some(item => isEqual(item.uri, path))) {
					throw new Error('V3Code could not detach the selected project. No files were deleted.')
				}
				void this.semanticIndexService.rebuild().catch(error => this.logService.warn('[close_project] index rebuild failed', error))
				return {
					result: {
						folder: path.scheme === 'file' ? path.fsPath : path.toString(true),
						removed: true,
						workspaceFolders: activeFolders.map(item => item.uri.scheme === 'file' ? item.uri.fsPath : item.uri.toString(true)),
						indexStatus: this.semanticIndexService.getStatus(),
						rebuildStarted: true,
					},
				}
			},

			reload_window: async () => {
				setTimeout(() => {
					void this.hostService.reload().catch(error => this.logService.error('[reload_window] reload failed', error))
				}, RELOAD_WINDOW_DELAY_MS)
				return { result: { scheduled: true, delayMs: RELOAD_WINDOW_DELAY_MS } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }, ctx) => {
				let existingIsFolder: boolean | undefined;
				try {
					existingIsFolder = (await fileService.resolve(uri)).isDirectory;
				} catch { /* does not exist */ }

				// `fileService.createFile` THROWS when the target exists and overwrite is not set,
				// so the friendly "already existed (no changes made)" result was unreachable for
				// files — only folders ever got it, and a re-issued create surfaced a raw platform
				// error instead. Short-circuit here so the no-op is a real no-op for both.
				if (existingIsFolder !== undefined) {
					return { result: { alreadyExists: true, existingIsFolder } }
				}
				try {
					if (isFolder)
						await fileService.createFolder(uri)
					else {
						await fileService.createFile(uri)
					}
				} catch (e) {
					// Diagnose the #1 silent failure: a PARENT path segment exists as a FILE, not a folder
					// (e.g. a prior run created `js` as an empty file, so `js/store.js` can't be created).
					// Without this the agent just sees "create failed", re-tries the same call, and thrashes
					// (delete -> ls -> create -> fail -> repeat). Point it straight at the fix.
					let probe = dirname(uri);
					let culprit: string | undefined;
					for (let i = 0; i < 12 && probe && probe.path && probe.path !== '/' && !culprit; i++) {
						try {
							const stat = await fileService.resolve(probe);
							if (!stat.isDirectory) { culprit = probe.fsPath; }
							break;
						} catch { /* this ancestor doesn't exist yet — keep walking up */ }
						const parent = dirname(probe);
						if (parent.path === probe.path) { break; }
						probe = parent;
					}
					if (culprit) {
						throw new Error(`Cannot create ${uri.fsPath}: the path segment "${culprit}" already exists as a FILE, not a folder, so nothing can be created inside it. Fix it in ONE step: delete_file_or_folder on "${culprit}" (it's a file, isRecursive is not needed), then create the folder/file you wanted. Do NOT retry this exact create — it will keep failing until that file is removed.`)
					}
					throw e
				}
				if (!isFolder) {
					this.memoryCaptureService.recordFileEdit(ctx?.threadId, uri, 'create_file_or_folder', true);
				}
				return { result: { alreadyExists: false, existingIsFolder: isFolder } }
			},

			delete_file_or_folder: async ({ uri, isRecursive }, ctx) => {
				try {
					await fileService.del(uri, { recursive: isRecursive })
				} catch (e) {
					// A non-empty folder deleted without is_recursive fails with an opaque error the agent
					// then loops on. Diagnose it: if the target is a directory with children and recursive
					// was off, tell it exactly what to pass instead of letting it retry blind.
					if (!isRecursive) {
						try {
							const stat = await fileService.resolve(uri)
							if (stat.isDirectory && stat.children && stat.children.length > 0) {
								throw new Error(`Cannot delete "${uri.fsPath}": it is a non-empty folder. Re-run delete_file_or_folder with is_recursive: true to delete it and its contents. Do NOT retry without is_recursive — it will keep failing.`)
							}
						} catch (probeErr) {
							if (probeErr instanceof Error && probeErr.message.startsWith('Cannot delete')) { throw probeErr }
							/* resolve failed for another reason — fall through to original error */
						}
					}
					throw e
				}
				voidModelService.disposeModel(uri)
				// Any buffer for this path is now provably a ghost, and this is the only moment
				// that fact is unambiguous — by the time a writer looks, the editor's flags have
				// been cleared or made indistinguishable from unsaved work.
				deletedByAgent.add(uri.fsPath)
				this.memoryCaptureService.recordFileEdit(ctx?.threadId, uri, 'delete_file_or_folder', true);
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }, ctx) => {
				// A file we had to create is by definition new on disk, so any model still cached
				// for this path is a ghost of a file that was deleted. Drop it before binding, or
				// the write lands in that dead buffer and never reaches disk.
				//
				// disposeModel alone is not enough: it releases OUR reference, but the underlying
				// text model can be kept alive by an open editor and handed straight back, still
				// holding the deleted file's contents. Measured live — a rewrite after a delete
				// reported "-V1 / +V2" for a path that had no V1 on disk. The write itself was
				// correct, but the base it diffed against was fiction, so the change shown to the
				// user and the model described an edit that never happened.
				const createdFile = await ensureFileExistsForWrite(uri)
				if (createdFile) { voidModelService.disposeModel(uri) }
				deletedByAgent.delete(uri.fsPath) // handled: this write is the path's new truth
				await voidModelService.initializeModel(uri)
				await voidModelService.refreshIfStale(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				const { model: beforeModel } = await voidModelService.getModelSafe(uri)
				// A null model means the file couldn't be loaded (missing path, transient resolve failure).
				// Without this guard the downstream write silently NO-OPS while the tool still returns a
				// success payload with a string-computed diff — agent, model, and UI all believe a write
				// happened that never did.
				if (beforeModel === null) {
					throw new Error(`${uri.fsPath} could not be loaded, so nothing was written. Confirm the path with ls_dir, and check it is not a directory or an unreadable binary file.`)
				}
				// If we had to CREATE the file, its prior content is empty by definition — there was
				// no file. Taking that from the model instead is what produced a diff claiming to
				// remove content that had already been deleted, four fixes running: every attempt
				// to scrub the buffer first lost to VS Code's own state, because recreating the
				// file clears the orphan flag and a ghost buffer is indistinguishable from unsaved
				// work by the time we get to look at it. Do not infer what the disk held. We know.
				const beforeContent = createdFile ? '' : beforeModel.getValue(EndOfLinePreference.LF)
				await editCodeService.callBeforeApplyOrEdit(uri)
				const { diffText, added, removed } = formatUnifiedDiffForModel(beforeContent, newContent, uri.fsPath)

				const lintErrorsPromise = this.shadowWorkspaceService.verifyAndCommitContent(
					uri,
					newContent,
					(content) => editCodeService.instantlyRewriteFile({ uri, newContent: content, clearEditorDiffUI: true }),
				).then(async ({ lintErrors, rolledBack, noDiagnosticsReported }) => {
					if (rolledBack) {
						throw new Error(`Shadow verify failed — edit rolled back due to lint errors:\n${this._stringifyLintErrors(lintErrors ?? [])}`)
					}
					// Flush the editor buffer to disk BEFORE reporting success, and confirm it
					// landed. The editCodeService save is fire-and-forget: the agent's next
					// run_command could read stale disk content, and a failed save (readonly
					// file, conflict, ghost buffer) was silently unhandled while the tool had
					// already claimed success.
					await saveAndVerifyOnDisk(uri, newContent)
					const passed = !lintErrors?.length;
					this.memoryCaptureService.recordFileEdit(ctx?.threadId, uri, 'rewrite_file', passed);
					return { lintErrors, diffText, added, removed, noDiagnosticsReported, ...uiDiffTexts(beforeContent, newContent) }
				})
				return { result: lintErrorsPromise }
			},

			append_file: async ({ uri, content }, ctx) => {
				// See rewrite_file: a freshly created path must not reuse a ghost buffer, and
				// append_file is the worst place to get this wrong — it builds its new content
				// by concatenating onto what it believes is already there.
				const createdFile = await ensureFileExistsForWrite(uri)
				if (createdFile) { voidModelService.disposeModel(uri) }
				deletedByAgent.delete(uri.fsPath) // handled: this write is the path's new truth
				await voidModelService.initializeModel(uri)
				await voidModelService.refreshIfStale(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				const { model: beforeModel } = await voidModelService.getModelSafe(uri)
				if (!beforeModel) {
					throw new Error(`Cannot append to ${uri.fsPath}: file does not exist. Use create_file_or_folder first, then append_file for each section.`)
				}
				// See rewrite_file. This matters more here than anywhere else: newContent is
				// beforeContent + content, so a ghost base does not merely mis-report the diff —
				// it silently resurrects deleted text into the file being written.
				const beforeContent = createdFile ? '' : beforeModel.getValue(EndOfLinePreference.LF)
				const newContent = beforeContent + content
				await editCodeService.callBeforeApplyOrEdit(uri)
				const { diffText, added, removed } = formatUnifiedDiffForModel(beforeContent, newContent, uri.fsPath)

				const lintErrorsPromise = this.shadowWorkspaceService.verifyAndCommitContent(
					uri,
					newContent,
					(committed) => editCodeService.instantlyRewriteFile({ uri, newContent: committed, clearEditorDiffUI: true }),
				).then(async ({ lintErrors, rolledBack, noDiagnosticsReported }) => {
					if (rolledBack) {
						throw new Error(`Shadow verify failed — edit rolled back due to lint errors:\n${this._stringifyLintErrors(lintErrors ?? [])}`)
					}
					// See rewrite_file: flush to disk and confirm it landed before claiming success.
					await saveAndVerifyOnDisk(uri, newContent)
					const passed = !lintErrors?.length;
					this.memoryCaptureService.recordFileEdit(ctx?.threadId, uri, 'append_file', passed);
					return { lintErrors, diffText, added, removed, noDiagnosticsReported, appendedChars: content.length, ...uiDiffTexts(beforeContent, newContent) }
				})
				return { result: lintErrorsPromise }
			},

			edit_file: async ({ uri, searchReplaceBlocks }, ctx) => {
				await voidModelService.initializeModel(uri)
				// This one computes its result FROM the buffer, so a ghost buffer does not merely
				// fail to write — it writes the wrong thing convincingly, with a diff that looks
				// right because it was computed against the same stale content. Unsaved user edits
				// are preserved; only a clean buffer that disagrees with disk is refreshed.
				//
				// edit_file never creates a file, so it has no createdFile flag to lean on. Where a
				// path is one WE deleted, the tombstone says so outright and the buffer is dropped
				// unconditionally — this is the case refreshIfStale cannot reach, because the delete
				// left the buffer dirty and dirty is exactly what it refuses to touch. Without this
				// a search/replace can match ghost text and write the result back over the real
				// file: not a bad diff, a resurrection.
				if (deletedByAgent.has(uri.fsPath)) {
					// NOT dispose-then-rebind. That is a no-op here and was wrong in the first cut:
					// textFileEditorModelManager blocks disposal of a DIRTY model indefinitely to
					// prevent data loss, createModelReference then cancels the pending dispose, and
					// resolve without a reload option takes its "do not reload" branch — so the same
					// ghost comes straight back while the tombstone gets cleared, destroying the only
					// reliable evidence. Worse than doing nothing.
					if (!(await fileService.exists(uri))) {
						// Still deleted. A search/replace against a file this agent removed cannot
						// succeed honestly: the only content to match is a buffer for a file that is
						// gone. Fail loudly rather than resurrect it — silently applying to ghost
						// text and writing the result back is how a deleted file comes back to life
						// wearing an edit nobody made.
						deletedByAgent.delete(uri.fsPath)
						throw new Error(`${uri.fsPath} was deleted earlier in this session and does not exist. Do NOT edit it — recreate it with rewrite_file, or pick a path that exists.`)
					}
					// Recreated by something outside these tools (run_command, git, an extension).
					// Any buffer still held predates our delete, so it cannot be unsaved work for
					// the file now on disk. revert is the only call that moves a dirty model.
					await voidModelService.discardBuffer(uri)
					deletedByAgent.delete(uri.fsPath)
				}
				await voidModelService.refreshIfStale(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				const { model: beforeModel } = await voidModelService.getModelSafe(uri)
				// Same guard as rewrite_file: a null model would make the write a silent no-op that
				// still reports success (diff computed from strings, lint run on the untouched file).
				if (beforeModel === null) {
					throw new Error(`${uri.fsPath} could not be loaded, so nothing was written. Confirm the path with ls_dir, and check it is not a directory or an unreadable binary file.`)
				}
				const beforeContent = beforeModel.getValue(EndOfLinePreference.LF)
				const afterContent = applySearchReplaceBlocksToString(beforeContent, searchReplaceBlocks)
				const { diffText, added, removed } = formatUnifiedDiffForModel(beforeContent, afterContent, uri.fsPath)
				await editCodeService.callBeforeApplyOrEdit(uri)

				const lintErrorsPromise = this.shadowWorkspaceService.verifyAndCommitContent(
					uri,
					afterContent,
					(content) => editCodeService.instantlyRewriteFile({ uri, newContent: content, clearEditorDiffUI: true }),
				).then(async ({ lintErrors, rolledBack, noDiagnosticsReported }) => {
					if (rolledBack) {
						throw new Error(`Shadow verify failed — edit rolled back due to lint errors:\n${this._stringifyLintErrors(lintErrors ?? [])}`)
					}
					// See rewrite_file: flush to disk and confirm it landed before claiming success.
					await saveAndVerifyOnDisk(uri, afterContent)
					const passed = !lintErrors?.length;
					this.memoryCaptureService.recordFileEdit(ctx?.threadId, uri, 'edit_file', passed);
					return { lintErrors, diffText, added, removed, searchReplaceBlocks, noDiagnosticsReported, ...uiDiffTexts(beforeContent, afterContent) }
				})

				return { result: lintErrorsPromise }
			},
			// ---
			run_command: async ({ command, cwd, terminalId, timeoutSeconds }, ctx) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, {
					type: 'temporary',
					cwd,
					terminalId,
					chatSessionId: ctx?.threadId,
					chatTerminalToolSessionId: ctx?.terminalToolSessionId,
					inactivityTimeoutSec: timeoutSeconds ?? undefined,
				})
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }, ctx) => {
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, {
					type: 'persistent',
					persistentTerminalId,
					chatTerminalToolSessionId: ctx?.terminalToolSessionId,
				})
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},
			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},
			read_terminal_output: async ({ persistentTerminalId }) => {
				const output = await this.terminalToolService.readTerminal(persistentTerminalId)
				return { result: { output } }
			},
			ask_user: async () => {
				// Never reached on native (_invokeBuiltinTool) or sidebar (chatThreadService intercept).
				return { result: { choice: '' } }
			},

			// --- Context Bridge ---
			remember_editorial: async ({ topic, worked, didntWork, buildNotes, miniReadme, mode }, ctx) => {
				if (!this.memoryService.isAvailable) {
					return { result: { topic, branchId: '', created: false, mode: mode ?? 'append', unavailable: true } }
				}
				try {
					// Dual-write, WORKSPACE FIRST: the workspace editorial store is what a NEW
					// thread's briefing reads — writing only the thread anchor (the old
					// behavior whenever a threadId existed, i.e. always in-editor) made every
					// editorial decision invisible outside the thread that recorded it. If the
					// workspace write fails we keep the thread anchor, so the failure mode is
					// the old behavior, never a lost note.
					let workspaceShared = false
					let workspaceWrite: { branchId: string; created: boolean; mode: 'append' | 'replace' } | undefined
					if (this.memoryService.hasWorkspace) {
						try {
							workspaceWrite = await this.memoryService.writeEditorialBranch({ topic, worked, didntWork, buildNotes, miniReadme, mode })
							workspaceShared = true
						} catch (e) {
							// A reserved topic must reject the WHOLE call (the thread write
							// enforces the same list); other failures degrade to thread-only.
							const message = e instanceof Error ? e.message : String(e)
							if (message.includes('maintained automatically')) throw e
						}
					}
					if (ctx?.threadId) {
						const r = await this._writeThreadEditorial(ctx.threadId, { topic, worked, didntWork, buildNotes, miniReadme, mode })
						return { result: { topic, branchId: r.branch.id, created: r.created, mode: r.mode, workspaceShared } }
					}
					if (workspaceWrite !== undefined) {
						return { result: { topic, branchId: workspaceWrite.branchId, created: workspaceWrite.created, mode: workspaceWrite.mode, workspaceShared } }
					}
					const r = await this.memoryService.writeEditorialBranch({ topic, worked, didntWork, buildNotes, miniReadme, mode })
					return { result: { topic, branchId: r.branchId, created: r.created, mode: r.mode, workspaceShared: true } }
				} catch (e) {
					// A reserved topic is a rejection the model should read and act on, not a crash.
					return { result: { topic, branchId: '', created: false, mode: mode ?? 'append', error: e instanceof Error ? e.message : String(e) } }
				}
			},
			forget_editorial: async ({ topic, section }, ctx) => {
				if (!this.memoryService.isAvailable) { return { result: { topic, deleted: false, section, unavailable: true } } }
				// Mirror of remember_editorial's dual-write, WORKSPACE FIRST: a delete that
				// only tombstones the thread anchor lets the workspace copy resurrect the
				// topic in every other thread's briefing.
				let r = { deleted: false }
				if (this.memoryService.hasWorkspace) {
					try { r = await this.memoryService.deleteEditorialBranch({ topic, section }) }
					catch { /* nothing in the workspace store to delete — anchor tombstone below still counts */ }
				}
				let anchorDeleted = false
				if (ctx?.threadId) {
					const normalized = topic.trim().toLowerCase().replace(/\s+/g, '-')
					const matching = (await this.memoryService.listSessionAnchors(ctx.threadId, true))
						.filter(anchor => anchor.kind === 'editorial' && anchor.symbol === normalized && anchor.deletedAt === undefined)
					for (const anchor of matching) {
						const deletedAt = Date.now()
						const branch = anchor.payload as EditorialBranch
						const next = section ? {
							...branch,
							...(section === 'worked' ? { worked: '' } : {}),
							...(section === 'didnt_work' ? { didntWork: '' } : {}),
							...(section === 'build_notes' ? { buildNotes: '' } : {}),
							...(section === 'mini_readme' ? { miniReadme: '' } : {}),
							tsUpdated: deletedAt,
						} : branch
						await this.memoryService.upsertSessionAnchor({
							anchorId: anchor.anchorId, threadId: ctx.threadId, kind: 'editorial', symbol: anchor.symbol,
							originWorkspaceId: anchor.originWorkspaceId, originRoot: anchor.originRoot,
							updateIdentity: sessionAnchorUpdateIdentity(next, section ? undefined : deletedAt), payload: next,
							updatedAt: deletedAt, deletedAt: section ? undefined : deletedAt,
						})
						anchorDeleted = true
					}
				}
				return { result: { topic, deleted: r.deleted || anchorDeleted, section } }
			},
			remember: async ({ filePath, symbolName, note }, ctx) => cbTrace('remember', async () => {
				let saved = await this.contextBridgeService.addNote(filePath, symbolName, note, ctx?.threadId)
				if (ctx?.threadId) {
					const existing = (await this.memoryService.listSessionAnchors(ctx.threadId))
						.filter(anchor => anchor.kind === 'note' && anchor.payload && typeof anchor.payload === 'object')
						.map(anchor => anchor.payload as SymbolNote)
						.find(candidate => candidate.filePath === saved.filePath
							&& candidate.symbolName === saved.symbolName && candidate.note.trim() === saved.note.trim())
					if (existing) saved = existing
					else await this.memoryService.upsertSessionAnchor({
						anchorId: stableAnchorId('note', ctx.threadId, saved.id),
						threadId: ctx.threadId,
						kind: 'note',
						relativePath: saved.filePath,
						symbol: saved.symbolName,
						updateIdentity: sessionAnchorUpdateIdentity(saved),
						payload: saved,
						updatedAt: parseNoteMs(saved.updatedAt),
					})
				}
				// Subject from the note's CANONICAL path (addNote normalizes to
				// workspace-relative POSIX) — the raw model-provided path made
				// forget's subject lookup miss, leaving ghost facts (audit).
				const fact = {
					kind: 'symbol' as const,
					subject: `${saved.filePath}::${saved.symbolName}`,
					body: note,
					confidence: 0.8,
					priority: 6,
					meta: { filePath: saved.filePath, symbolName: saved.symbolName, noteId: saved.id },
				};
				// A symbol note belongs to exactly one project. Mirroring every note into the
				// global store made unrelated workspace facts appear in later prompts.
				if (!ctx?.threadId) {
					const target = this.memoryService.hasWorkspace ? 'workspace' : 'global';
					void this.memoryService.upsertFact(fact, target)
						.then(() => this.memoryCaptureService.scheduleRollup()).catch(() => { /* best-effort */ });
				}
				return { result: { note: saved } }
			}),
			forget: async ({ noteId }, ctx) => cbTrace('forget', async () => {
				// Look the note up BEFORE deleting so the mirrored SQLite fact can be tombstoned
				// too. Deleting only the notes.json entry left the ws_facts mirror re-injecting
				// the "forgotten" note into every future prompt (AGENT_PIPELINE_AUDIT.md item).
				const note = (await this._notesForThread(ctx?.threadId)).find(n => n.id === noteId)
				const deleted = await this.contextBridgeService.deleteNote(noteId)
				let anchorDeleted = false
				if (ctx?.threadId) {
					const anchorId = stableAnchorId('note', ctx.threadId, noteId)
					const anchor = (await this.memoryService.listSessionAnchors(ctx.threadId, true)).find(candidate => candidate.anchorId === anchorId)
					if (anchor && anchor.deletedAt === undefined) {
						const deletedAt = Date.now()
						await this.memoryService.upsertSessionAnchor({
							anchorId, threadId: ctx.threadId, kind: 'note', relativePath: anchor.relativePath, symbol: anchor.symbol,
							originWorkspaceId: anchor.originWorkspaceId, originRoot: anchor.originRoot,
							updateIdentity: sessionAnchorUpdateIdentity(anchor.payload, deletedAt), payload: anchor.payload,
							updatedAt: deletedAt, deletedAt,
						})
						anchorDeleted = true
					}
				}
				if (deleted && note) {
					try {
						const subject = `${note.filePath}::${note.symbolName}`
						const facts = await this.memoryService.getFactsForFile(subject)
						for (const f of facts) {
							// remember() now writes one active scope. Probe both targets during
							// deletion for compatibility with notes created by older builds.
							void this.memoryService.forget(f.id, 'workspace').catch(() => { /* best-effort */ })
							void this.memoryService.forget(f.id, 'global').catch(() => { /* best-effort */ })
						}
						// The beast sidecar mirror too — without this, the "forgotten"
						// note resurfaces through the graph pull forever (audit critical).
						// Mirror text format: `${subject} — ${body}` (memoryService).
						void this.beastService.forget({ text: `${subject} — ${note.note}` }).catch(() => { /* best-effort */ })
					} catch { /* best-effort — the note itself is gone either way */ }
				}
				return { result: { deleted: deleted || anchorDeleted } }
			}),
			recover_session_anchors: async ({ originRoot, confirmed }, ctx) => cbTrace('recover_session_anchors', async () => {
				if (!ctx?.threadId) throw new Error('Recovery requires an active native thread id.')
				const recovered = await this.memoryService.recoverSessionAnchors(ctx.threadId, originRoot ?? undefined, confirmed)
				return { result: recovered }
			}),
			// Team board: stored as symbol notes under the synthetic file '__team__' with symbol
			// 'team:<agentId>', so entries persist across sessions/windows through the existing
			// notes store, show up in the ledger, and are cleaned with the same machinery.
			team_checkin: async ({ agentId, doing, where, status }) => cbTrace('team_checkin', async () => {
				const id = (agentId && agentId.trim()) || `agent-${Math.random().toString(36).slice(2, 6)}`
				const { overlaps } = await this.teamCheckinDirect({ agentId: id, doing, where: where ?? null, status })
				return { result: { agentId: id, status, overlaps: overlaps.length > 0 ? overlaps : undefined } }
			}),
			team_board: async () => cbTrace('team_board', async () => {
				const external = await this.mainProcessService.getChannel(V3CODE_MCP_EXPOSE_CHANNEL).call<{ tasks: CollaborationRecord[] }>('collaborationRead').catch(() => ({ tasks: [] }));
				const notes = (await this.contextBridgeService.listNotes()).filter(n => n.symbolName.startsWith('team:'))
				const entries = notes.map(n => {
					let doing = n.note; let where: string | null = null
					try {
						const parsed = JSON.parse(n.note)
						if (parsed && typeof parsed.doing === 'string') { doing = parsed.doing; where = typeof parsed.where === 'string' ? parsed.where : null }
					} catch { /* legacy/hand-written entry — show raw */ }
					return { agentId: n.symbolName.slice('team:'.length), doing, where, updatedAt: n.updatedAt }
				})
				entries.push(...external.tasks.map(task => ({ agentId: task.actor, doing: `[external ${task.payload.status}${Number(task.payload.lease_until) > 0 && Number(task.payload.lease_until) <= Date.now() ? '; lease expired' : ''}] ${task.payload.doing}`, where: typeof task.payload.where === 'string' ? task.payload.where : null, updatedAt: new Date(task.updated).toISOString() })));
				return { result: { entries, contracts: await this.teamContracts() } }
			}),
			// Contracts live beside claims under the synthetic '__team__' file with symbol
			// 'contract:<key>' — same persistence, same MCP visibility, distinct prefix so the
			// claim reader, the overlap check, and the startup 'team:sub:*' sweep never see them.
			team_contract: async ({ action, key, value, rationale }) => cbTrace('team_contract', async () => {
				const symbol = `contract:${key}`
				const existing = (await this.contextBridgeService.listNotes()).filter(n => n.symbolName === symbol)
				for (const n of existing) { await this.contextBridgeService.deleteNote(n.id) }
				if (action === 'set') {
					await this.contextBridgeService.addNote('__team__', symbol, JSON.stringify({ value: value ?? '', rationale: rationale ?? null }))
				}
				return { result: { action, key, contracts: await this.teamContracts() } }
			}),
			list_notes: async ({ filePath }, ctx) => cbTrace('list_notes', async () => {
				const notes = await this._notesForThread(ctx?.threadId, filePath ?? undefined)
				return { result: { notes } }
			}),
			search_notes: async ({ query, filePath, limit }, ctx) => cbTrace('search_notes', async () => {
				const all = await this._notesForThread(ctx?.threadId, filePath ?? undefined)
				const notes = all.filter(n => noteMatchesQuery(n, query)).slice(0, limit)
				return { result: { notes } }
			}),
			workspace_delta: async ({ sinceMs }, ctx) => {
				const since = sinceMs ?? Date.now() - 30 * 60 * 1000
				const { resPromise } = await this.terminalToolService.runCommand('git --no-pager status --porcelain', { type: 'temporary', cwd: resolveGitCwd(), terminalId: generateUuid() })
				const res = await resPromise
				const changedFiles: Array<{ path: string; status: string }> = []
				const word = (code: string): string => {
					if (code === '??') { return 'untracked' }
					switch (code.replace(/\s/g, '')[0]) {
						case 'M': return 'modified'
						case 'A': return 'added'
						case 'D': return 'deleted'
						case 'R': return 'renamed'
						case 'C': return 'copied'
						case 'U': return 'conflicted'
						default: return 'changed'
					}
				}
				for (const rawLine of res.result.split('\n')) {
					const line = rawLine.replace(/\r$/, '')
					if (line.length < 4) { continue }
					// Only real porcelain lines: XY status code from [ MADRCU?!] then a space.
					// Anything else (shell noise, echoed commands) must never become a phantom file.
					if (!/^[ MADRCU?!]{2} /.test(line)) { continue }
					const code = line.slice(0, 2)
					let path = line.slice(3)
					if (path.includes(' -> ')) { path = path.split(' -> ').pop() ?? path }
					path = path.replace(/^"|"$/g, '')
					changedFiles.push({ path, status: word(code) })
				}
				// Same trap as session_diff: the porcelain filter turns a git failure into zero
				// lines, which the summary below would report as a clean working tree.
				if (changedFiles.length === 0 && /^(fatal|error):/mi.test(res.result)) {
					throw new Error(`git status failed, so the working-tree half of this delta is UNKNOWN — do not read it as clean:\n${res.result.trim().slice(0, 500)}`)
				}
				// Count first, slice second. These used to report the SLICE length as the count, so
				// 40 edits since the last checkpoint summarized as "15 recent editor edit(s)".
				const allRecentEdits = this.recentEditsService.getEditsSince(since)
				const recentEdits = allRecentEdits.slice(0, MAX_DELTA_EDITS)
				const allNotes = await this._notesForThread(ctx?.threadId)
				const allNewNotes = allNotes.filter(n => parseNoteMs(n.updatedAt || n.createdAt) >= since)
				const newNotes = allNewNotes.slice(0, MAX_DELTA_NOTES)
				const { problems } = this.markerCheckService.collectAllDiagnostics({ errorsOnly: false, cap: 200 })
				const buildErrorCount = problems.filter(p => p.severity === 'error').length
				const buildHintCount = problems.filter(p => p.severity === 'warning').length
				const shown = (slice: number, total: number) => total > slice ? `${slice} of ${total}` : `${total}`
				const summaryParts = [
					`Since ${new Date(since).toISOString()}:`,
					`${changedFiles.length} working-tree change(s)`,
					`${shown(recentEdits.length, allRecentEdits.length)} recent editor edit(s)`,
					`${shown(newNotes.length, allNewNotes.length)} note(s) created/updated`,
					// "Build: clean" off zero markers is only as good as the language server's
					// coverage — an unopened file produces no markers at all. Say what it means.
					buildErrorCount === 0
						? `Build: no errors reported (${buildHintCount} warning/hint(s)) — reflects files the language server has analyzed, not a full build`
						: `Build: ${buildErrorCount} error(s), ${buildHintCount} warning(s)`,
				]
				return {
					result: {
						sinceMs: since,
						changedFiles,
						recentEdits,
						newNotes,
						buildErrorCount,
						buildHintCount,
						summary: summaryParts.join(' · '),
					},
				}
			},
			search_chat_memory: async ({ query, kind, role, limit }) => cbTrace('search_chat_memory', async () => {
				if (!this.memoryService.isAvailable) {
					return { result: { events: [], unavailable: true } }
				}
				const events = await this.memoryService.searchChat(query, {
					kind: kind ?? undefined,
					role: role ?? undefined,
					limit,
				})
				return { result: { events } }
			}),
			search_memory: async ({ query, scope, depth, sessionId, before, after, kinds, limit }, ctx) => cbTrace('search_memory', async () => {
				const external = scope === 'workspace' && !sessionId && (!kinds || kinds.includes('fact'))
					? await this.mainProcessService.getChannel(V3CODE_MCP_EXPOSE_CHANNEL).call<{ memories: CollaborationRecord[] }>('collaborationRead', { query }).catch(() => ({ memories: [] })) : { memories: [] };
				if (!this.memoryService.isAvailable && external.memories.length === 0) { return { result: { hits: [], unavailable: true } }; }
				const hits = this.memoryService.isAvailable ? await this.memoryService.searchMemory(query, { scope, depth, sessionId: sessionId ?? ctx?.threadId, before: before ?? undefined, after: after ?? undefined, kinds: kinds ?? undefined, limit }) : [];
				for (const note of external.memories.filter(note => (!before || note.updated < before) && (!after || note.updated > after))) {
					hits.push({ kind: 'fact', id: note.id, workspaceId: note.project, ts: note.updated, score: 0, signals: {}, rawAvailable: false, sourcePruned: false,
						summary: `[External agent ${note.actor}; revision ${note.revision}; shared; lexical match, not a confidence score] ${note.payload.title}\n${note.payload.body}\nEvidence: ${note.payload.evidence ?? 'not supplied'}` });
				}
				hits.splice(limit);
				return { result: { hits } }
			}),
			get_memory_checkpoint: async ({ checkpointId, includeEvents, eventPage }, ctx) => cbTrace('get_memory_checkpoint', async () => {
				if (!this.memoryService.isAvailable) return { result: { evidence: null, unavailable: true } }
				return { result: { evidence: await this.memoryService.getCheckpoint(checkpointId, includeEvents, eventPage, undefined, ctx?.threadId) } }
			}),
			deep_recall: async ({ query, limit }) => cbTrace('deep_recall', async () => {
				if (!this.memoryService.isAvailable) {
					return { result: { hits: [], unavailable: true } }
				}
				const hits = await this.memoryService.deepRecall(query, limit ?? 8)
				return { result: { hits } }
			}),
			get_shadow_record: async ({ shadowId }) => cbTrace('get_shadow_record', async () => {
				if (!this.memoryService.isAvailable) {
					return { result: { record: null, unavailable: true } }
				}
				const record = await this.memoryService.getShadowRecord(shadowId)
				return { result: { record } }
			}),
			get_build_errors: async ({ pathFilter, errorsOnly }) => {
				const CAP = 200
				const { problems, total } = this.markerCheckService.collectAllDiagnostics({ pathFilter, errorsOnly, cap: CAP })
				return { result: { problems, total, truncated: total > problems.length } }
			},
			get_chat_session: async ({ sessionId }) => cbTrace('get_chat_session', async () => {
				if (!this.memoryService.isAvailable) {
					return { result: { events: [], unavailable: true } }
				}
				const events = await this.memoryService.getSession(sessionId)
				return { result: { events } }
			}),
			get_chat_thread: async ({ eventId }) => cbTrace('get_chat_thread', async () => {
				if (!this.memoryService.isAvailable) {
					return { result: { events: [], unavailable: true } }
				}
				const events = await this.memoryService.getThread(eventId)
				return { result: { events } }
			}),
			get_editorial_briefing: async (_params, ctx) => cbTrace('get_editorial_briefing', async () => {
				if (!this.memoryService.isAvailable) {
					return { result: { projectId: null, projectName: '', readme: '', branches: [], unavailable: true } }
				}
				const overview = await this.memoryService.getEditorialOverview()
				const carried = await this._editorialForThread(ctx?.threadId)
				return { result: { ...overview, branches: mergeEditorialBranches(overview.branches, carried), unavailable: false } }
			}),
			search_editorial: async ({ query, crossProject }, ctx) => cbTrace('search_editorial', async () => {
				if (!this.memoryService.isAvailable) {
					return { result: { branches: [], unavailable: true } }
				}
				const branches = await this.memoryService.searchEditorial(query, crossProject)
				const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
				const carried = (await this._editorialForThread(ctx?.threadId)).filter(branch => {
					const hay = `${branch.name} ${branch.miniReadme} ${branch.worked} ${branch.didntWork} ${branch.buildNotes}`.toLowerCase()
					return terms.every(term => hay.includes(term))
				})
				return { result: { branches: mergeEditorialBranches(branches, carried) } }
			}),
			find_text: async ({ query: queryStr, isRegex, includePattern, pageNumber, contextLines }) => cbTrace('find_text', async () => {
				const searchFolders = workspaceContextService.getWorkspace().folders.map(f => f.uri)
				const tQuery = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders, {
					includePattern: includePattern ?? undefined,
					previewOptions: { matchLines: 1, charsPerLine: 250 },
					surroundingContext: contextLines > 0 ? contextLines : undefined,
				})
				const data = await searchService.textSearch(tQuery, CancellationToken.None)

				// Flatten per-file matches into per-line hits. With surroundingContext the engine
				// interleaves ITextSearchContext rows (already deduped between adjacent matches).
				const flat: Array<{ uri: URI, lineNumber: number, previewText: string, isContext?: boolean }> = []
				for (const fm of data.results) {
					for (const r of (fm.results ?? [])) {
						if (resultIsMatch(r)) {
							for (const loc of r.rangeLocations) {
								flat.push({
									uri: fm.resource,
									lineNumber: loc.source.startLineNumber + 1,
									previewText: r.previewText,
								})
							}
						} else {
							// Context row: lineNumber is ALREADY 1-based (unlike match source ranges) —
							// both the ripgrep and open-model engines emit it that way. Do not add 1.
							flat.push({ uri: fm.resource, lineNumber: r.lineNumber, previewText: reviewContextPreview(r.text), isContext: true })
						}
					}
				}

				const pageSize = MAX_CHILDREN_URIs_PAGE
				const fromIdx = pageSize * (pageNumber - 1)
				const toIdx = pageSize * pageNumber - 1
				const matches = flat.slice(fromIdx, toIdx + 1)
				const hasNextPage = (flat.length - 1) - toIdx >= 1
				return { result: { matches, hasNextPage } }
			}),
			semantic_search: async ({ query, topK, includeFile, includeFiles, rerank }) => cbTrace('semantic_search', async () => {
				const opts: { topK?: number; files?: string[]; quickPath?: boolean; rerank?: boolean } = {}
				if (topK !== null) opts.topK = topK
				if (includeFiles) opts.files = includeFiles
				const quickPath = isQuickSearchQuery(query)
				if (quickPath) { opts.quickPath = true; }
				// Local cross-encoder pass, REQUESTED for every non-quick search. The
				// actual run is gated by `v3code.semanticIndex.localReranker`, which
				// ships 'off' because a second llama model beside the embedder can trip
				// the macOS GPU watchdog — NOT because it is unproven. Never throws;
				// falls back to fused order. Measured +11.4pt R@5 / +0.053 MRR on
				// golden-vselite-v2 when enabled. The LLM rerank below stays the
				// opt-in escalation on top.
				opts.rerank = !quickPath
				const localPromise = this.semanticIndexService.retrieve(query, opts)
				const cloudPromise = quickPath
					? Promise.resolve(undefined)
					: withinBudget(
						this.cloudIndexSyncService.retrieve(query, { topK: opts.topK, files: opts.files }),
						ToolsService._cloudSearchBudgetMs,
						undefined,
					)
				const [localHits, cloudResult] = await Promise.all([localPromise, cloudPromise])
				let hits = localHits
				if (cloudResult?.hits.length) {
					const cloudHits = await this._hydrateCloudHits(cloudResult.hits, localHits)
					hits = mergeFederatedIndexHits(localHits, cloudHits, topK ?? 30)
				}
				// Opt-in LLM rerank. Bulletproof: llmRerank NEVER throws — on any failure
				// (no model, timeout, bad JSON) it returns the input order unchanged. So this
				// can only improve results, never break search. Default path skips it entirely.
				// Quick-path lookups skip rerank too (quick-search fast path).
				let rerankStatus: string | undefined
				if (quickPath) {
					rerankStatus = 'skipped:quick-path'
				} else if (rerank && hits.length > 1) {
					const send = this._makeRerankSend()
					if (send) {
						hits = await llmRerank(query, hits, send, { topN: topK ?? undefined, diag: s => { rerankStatus = s } })
					} else {
						rerankStatus = 'skipped:no-model'
					}
				}
				// Stamp coverage: an empty or thin result over a half-built index must not
				// read like a confident "this does not exist".
				const indexStatus = this.semanticIndexService.getStatus()
				// Retrieval may expand graph neighbors; the public result cap still applies.
				hits = hits.slice(0, topK ?? 20);
				return { result: { hits, indexState: indexStatus.state, rerankStatus, filesIndexed: indexStatus.filesIndexed, filesTotal: indexStatus.filesTotal } }
			}),
			// `sidecarAvailable` is carried through so an EMPTY result can say WHY. Both calls return
			// [] when the beast binary is missing, which is byte-identical to "this symbol does not
			// exist" — on a build packaged without the sidecar (every Windows build before the
			// packaging fix) that made the agent conclude real symbols were absent and act on it.
			symbol_lookup: async ({ name, defsOnly }) => cbTrace('symbol_lookup', async () => {
				const sidecarAvailable = await this.beastService.isAvailable().catch(() => false)
				const tags = await this.beastService.symbolLookup(name, { defsOnly })
				return { result: { tags, sidecarAvailable } }
			}),
			impact_trace: async ({ target, depth }) => cbTrace('impact_trace', async () => {
				const sidecarAvailable = await this.beastService.isAvailable().catch(() => false)
				const impacted = await this.beastService.trace(target, { depth: depth ?? undefined })
				return { result: { impacted, sidecarAvailable } }
			}),
			get_file_context: async (params) => cbTrace('get_file_context', async () => {
				const result = await runGetFileContext(this.lspBridgeAdapter, fileService, params)
				return { result }
			}),
			get_file_dependencies: async (params) => cbTrace('get_file_dependencies', async () => {
				const result = await runGetFileDependencies(this.lspBridgeAdapter, fileService, workspaceContextService, params)
				return { result }
			}),
			get_symbol_context: async (params, ctx) => cbTrace('get_symbol_context', async () => {
				const result = await runGetSymbolContext(this.lspBridgeAdapter, this.contextBridgeService, params)
				const notes = await this._notesForThread(ctx?.threadId, params.filePath)
				result.notes = notes.filter(note => note.symbolName === params.symbolName)
				return { result }
			}),
			get_call_graph: async (params) => cbTrace('get_call_graph', async () => {
				const result = await runGetCallGraph(this.lspBridgeAdapter, params)
				return { result }
			}),
			pack_context: async (params, ctx) => cbTrace('pack_context', async () => {
				const result = await runPackContext(this.lspBridgeAdapter, this.contextBridgeService, params)
				const notes = await this._notesForThread(ctx?.threadId, params.filePath)
				result.notes = notes.filter(note => note.symbolName === params.symbolName)
				// Discovery ledger: a successful structural read IS a discovery.
				// Record a one-line map entry so the workspace map builds itself as
				// code is understood (read-first workflow: memory accumulates the
				// map; upsertFact is subject-keyed so repeat packs refresh rather
				// than spam, and re-saving raises confidence). Best-effort.
				if (this.memoryService.hasWorkspace && params.filePath && params.symbolName) {
					void this.memoryService.upsertFact({
						kind: 'symbol',
						subject: `${params.filePath}::${params.symbolName}`,
						body: `Structurally read (${params.task}) — known symbol on the workspace map. Re-pack for current callers/callees instead of re-discovering.`,
						confidence: 0.5,
						priority: 2,
						source: ['discovery-ledger'],
					}, 'workspace').catch(() => { /* ledger is best-effort */ });
				}
				return { result }
			}),
			get_project_briefing: async (params, ctx) => cbTrace('get_project_briefing', async () => {
				const result = await runGetProjectBriefing(this.lspBridgeAdapter, fileService, workspaceContextService, this.contextBridgeService, params)
				if (ctx?.threadId) {
					result.notes = await this._notesForThread(ctx.threadId)
					result.sessionContinuity = formatSessionContinuity(await this.memoryService.getSessionContinuity(ctx.threadId)) || undefined
				}
				return { result }
			}),

			// --- Web & Git & Browser ---
			web_search: async ({ query, maxResults }) => {
				const channel = this.mainProcessService.getChannel('void-channel-webSearch')
				const cap = Math.min(10, Math.max(1, maxResults ?? 5))
				const { results, error } = await channel.call<{ results: Array<{ title: string; url: string; snippet: string }>; error?: string }>('search', { query, maxResults: cap })
				if (error) throw new Error(error)
				return { result: { results: results ?? [] } }
			},
			web_fetch: async ({ url, pageNumber }) => {
				const channel = this.mainProcessService.getChannel('void-channel-webSearch')
				const { result, error } = await channel.call<{ result?: { title: string; url: string; text: string; pageNumber: number; totalPages: number; status: number }; error?: string }>('fetch', { url, pageNumber })
				if (error || !result) throw new Error(error || `web_fetch failed for ${url}`)
				return { result }
			},
			repo_hygiene: async ({ action, path }) => {
				// One implementation shared with the native "Tidy Up Worktrees" command; every
				// mutating action re-reads the live facts so a stale plan can never remove
				// something that changed since.
				if (action === 'plan') { return { result: { output: (await this.repoHygieneService.plan()).text } } }
				if (action === 'prune') { return { result: { output: await this.repoHygieneService.prune() } } }
				const { plan } = await this.repoHygieneService.plan()
				const wanted = (path ?? '').replace(/[\\/]+$/, '')
				const item = plan.items.find(i => i.facts.path.replace(/[\\/]+$/, '') === wanted || i.facts.path.endsWith(wanted) || i.facts.branch === wanted)
				if (!item) throw new Error(`No worktree matches "${path}". Run action "plan" and use a path from it.`)
				const output = action === 'push' ? await this.repoHygieneService.push(item) : await this.repoHygieneService.remove(item)
				return { result: { output } }
			},
			git_status: async () => {
				const { resPromise } = await this.terminalToolService.runCommand('git --no-pager status --porcelain', { type: 'temporary', cwd: resolveGitCwd(), terminalId: generateUuid() })
				const res = await resPromise
				const status = res.result.trim() || '(clean working tree)'
				return { result: { status } }
			},
			session_diff: async ({ pathFilter }) => {
				const { resPromise } = await this.terminalToolService.runCommand('git --no-pager status --porcelain', { type: 'temporary', cwd: resolveGitCwd(), terminalId: generateUuid() })
				const res = await resPromise
				const filter = pathFilter ? pathFilter.toLowerCase() : null
				const word = (code: string): string => {
					if (code === '??') return 'untracked'
					switch (code.replace(/\s/g, '')[0]) {
						case 'M': return 'modified'
						case 'A': return 'added'
						case 'D': return 'deleted'
						case 'R': return 'renamed'
						case 'C': return 'copied'
						case 'U': return 'conflicted'
						default: return 'changed'
					}
				}
				const files: Array<{ path: string; status: string }> = []
				for (const rawLine of res.result.split('\n')) {
					const line = rawLine.replace(/\r$/, '')
					if (line.length < 4) { continue }
					// Only real porcelain lines: XY status code from [ MADRCU?!] then a space.
					// Anything else (shell noise, echoed commands) must never become a phantom file.
					if (!/^[ MADRCU?!]{2} /.test(line)) { continue }
					const code = line.slice(0, 2)
					let path = line.slice(3)
					if (path.includes(' -> ')) { path = path.split(' -> ').pop() ?? path } // rename -> destination
					path = path.replace(/^"|"$/g, '')
					if (filter && !path.toLowerCase().includes(filter)) { continue }
					files.push({ path, status: word(code) })
				}
				// The porcelain filter above exists to stop shell noise becoming phantom files, but
				// it also swallows git's own failures — `fatal: not a git repository`, dubious
				// ownership, a bad cwd — leaving zero lines, which the stringifier reports as a
				// CLEAN TREE. The model then concludes its work is already committed. Only a real
				// git error is treated as failure; ordinary echoed shell noise still parses to clean.
				if (files.length === 0 && /^(fatal|error):/mi.test(res.result)) {
					throw new Error(`git status failed, so the working tree state is UNKNOWN — this is not a clean tree:\n${res.result.trim().slice(0, 500)}`)
				}
				return { result: { files, count: files.length } }
			},
			recent_edits: async ({ n, file }) => {
				const all = this.recentEditsService.getRecentEdits()
				const filtered = file
					? all.filter(e => e.relativePath.toLowerCase().includes(file.toLowerCase()) || e.fileUri.toLowerCase().includes(file.toLowerCase()))
					: all
				return { result: { edits: filtered.slice(0, n ?? 20) } }
			},
			index_health: async ({ rebuild }) => {
				// Fire-and-forget the re-walk: rebuild() resolves only when indexing finishes,
				// which can be minutes — so we never await it inside the tool call.
				if (rebuild) { void this.semanticIndexService.rebuild().catch(() => { /* surfaced via status.lastError */ }) }
				const status = this.semanticIndexService.getStatus()
				return { result: { status, rebuildStarted: !!rebuild } }
			},
			git_commit: async ({ message, paths }) => {
				const cwd = resolveGitCwd()
				const escaped = escapeGitCommitMessage(message)
				if (paths && paths.length > 0) {
					await (await this.terminalToolService.runCommand(buildGitAddCommand(paths), { type: 'temporary', cwd, terminalId: generateUuid() })).resPromise
				}
				const { resPromise } = await this.terminalToolService.runCommand(`git --no-pager commit -m "${escaped}"`, { type: 'temporary', cwd, terminalId: generateUuid() })
				const res = await resPromise
				return { result: { output: res.result.trim() } }
			},
			git_stage: async ({ paths }) => {
				const cwd = resolveGitCwd()
				const { resPromise } = await this.terminalToolService.runCommand(buildGitAddCommand(paths), { type: 'temporary', cwd, terminalId: generateUuid() })
				const res = await resPromise
				const output = res.result.trim()
				return { result: { output: output || `Staged ${paths.length} path(s).` } }
			},
			git_diff: async ({ staged, base, head, path }) => {
				// `git --no-pager` avoids the pager hang and removes the need for a
				// `| cat` pipe (which fails under PowerShell where cat == Get-Content).
				const cmd = `git --no-pager diff --no-ext-diff --no-textconv${staged ? ' --staged' : ''}${base ? ` ${base}` : ''}${head ? ` ${head}` : ''} --${path ? ` "${path}"` : ''}`
				return { result: { diff: await runGitCmd(cmd) || '(no diff)' } }
			},
			git_log: async ({ count }) => {
				return { result: { log: await runGitCmd(`git --no-pager log --oneline --no-decorate -n ${Math.floor(count)}`) || '(no commits)' } }
			},
			git_branch: async () => {
				const cwd = resolveGitCwd()
				const { resPromise: branchRes } = await this.terminalToolService.runCommand('git --no-pager branch --show-current', { type: 'temporary', cwd, terminalId: generateUuid() })
				const br = await branchRes
				const { resPromise: allRes } = await this.terminalToolService.runCommand('git --no-pager branch -a --no-color', { type: 'temporary', cwd, terminalId: generateUuid() })
				const all = await allRes
				return { result: { branch: br.result.trim(), branches: all.result.trim() } }
			},
			git_push: async ({ remote, branch, setUpstream }) => {
				let cmd = 'git --no-pager push'
				if (setUpstream) { cmd += ' -u' }
				const remoteName = remote ?? ((branch || setUpstream) ? 'origin' : null)
				if (remoteName) { cmd += ` ${shellQuotePosix(remoteName)}` }
				if (branch) { cmd += ` ${shellQuotePosix(branch)}` }
				const output = await runGitCmd(cmd)
				return { result: { output: output || '(push completed)' } }
			},
			git_pull: async ({ remote, branch }) => {
				let cmd = 'git --no-pager pull'
				if (remote) { cmd += ` ${shellQuotePosix(remote)}` }
				if (branch) { cmd += ` ${shellQuotePosix(branch)}` }
				const output = await runGitCmd(cmd)
				return { result: { output: output || '(pull completed)' } }
			},
			git_fetch: async ({ remote }) => {
				const cmd = remote ? `git --no-pager fetch ${shellQuotePosix(remote)}` : 'git --no-pager fetch --all --prune'
				const output = await runGitCmd(cmd)
				return { result: { output: output || '(fetch completed)' } }
			},
			git_checkout: async ({ branch, create }) => {
				const cmd = create
					? `git checkout -b ${shellQuotePosix(branch)}`
					: `git checkout ${shellQuotePosix(branch)}`
				const output = await runGitCmd(cmd)
				return { result: { output: output || `Checked out ${branch}` } }
			},
			git_stash: async ({ action, message, paths }) => {
				let cmd: string
				if (action === 'list') {
					cmd = 'git --no-pager stash list'
				} else if (action === 'pop') {
					cmd = 'git stash pop'
				} else {
					cmd = 'git stash push'
					if (message) {
						const escaped = escapeGitCommitMessage(message)
						cmd += ` -m "${escaped}"`
					}
					if (paths && paths.length > 0) {
						cmd += ` -- ${paths.map(shellQuotePosix).join(' ')}`
					}
				}
				const output = await runGitCmd(cmd)
				return { result: { output: output || `(${action} completed)` } }
			},
			git_remote: async () => {
				const output = await runGitCmd('git remote -v')
				return { result: { output: output || '(no remotes configured)' } }
			},
			git_show: async ({ ref, path, statOnly }) => {
				let cmd = 'git --no-pager show'
				if (statOnly) { cmd += ' --stat' }
				cmd += ` ${shellQuotePosix(ref)}`
				if (path) { cmd += ` -- ${shellQuotePosix(path)}` }
				const output = await runGitCmd(cmd)
				return { result: { output: output || '(empty)' } }
			},
			git_blame: async ({ path, startLine, endLine }) => {
				let cmd = 'git --no-pager blame'
				if (startLine !== null && endLine !== null) {
					cmd += ` -L ${startLine},${endLine}`
				}
				cmd += ` -- ${shellQuotePosix(path)}`
				const output = await runGitCmd(cmd)
				return { result: { output: output || '(no blame data)' } }
			},
			git_merge: async ({ branch, abort }) => {
				const cmd = abort
					? 'git merge --abort'
					: `git merge ${shellQuotePosix(branch!)}`
				const output = await runGitCmd(cmd)
				return { result: { output: output || (abort ? '(merge aborted)' : '(merge completed)') } }
			},
			git_rebase: async ({ action, branch }) => {
				let cmd: string
				switch (action) {
					case 'abort': cmd = 'git rebase --abort'; break
					case 'continue': cmd = 'git rebase --continue'; break
					case 'skip': cmd = 'git rebase --skip'; break
					default: cmd = `git rebase ${shellQuotePosix(branch!)}`
				}
				const output = await runGitCmd(cmd)
				return { result: { output: output || `(${action} completed)` } }
			},
			git_cherry_pick: async ({ commit, abort }) => {
				const cmd = abort
					? 'git cherry-pick --abort'
					: `git cherry-pick ${shellQuotePosix(commit!)}`
				const output = await runGitCmd(cmd)
				return { result: { output: output || (abort ? '(cherry-pick aborted)' : '(cherry-pick completed)') } }
			},
			git_restore: async ({ paths, staged }) => {
				const flag = staged ? '--staged' : ''
				const cmd = `git restore ${flag} -- ${paths.map(shellQuotePosix).join(' ')}`.replace(/\s+/g, ' ').trim()
				const output = await runGitCmd(cmd)
				return { result: { output: output || `Restored ${paths.length} path(s).` } }
			},
			git_reset: async ({ mode, ref }) => {
				const cmd = `git reset --${mode} ${shellQuotePosix(ref)}`
				const output = await runGitCmd(cmd)
				return { result: { output: output || `(reset --${mode} to ${ref})` } }
			},
			open_browser: async ({ url, mobile }) => {
				const id = generateUuid()
				const resource = BrowserViewUri.forId(id)
				const pane = await this.editorService.openEditor({
					resource,
					options: { pinned: true, viewState: { url } },
				})
				if (mobile) {
					const input = pane?.input
					if (input instanceof BrowserEditorInput) {
						const model = await input.resolve()
						await model.setDevice({
							width: 393,
							height: 852,
							mobile: true,
							deviceScaleFactor: 3,
							userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
						})
					}
				}
				return { result: { url, opened: true } }
			},
			generate_image: async ({ prompt, outputPath, model }) => {
				const apiKey = this.voidSettingsService.state.settingsOfProvider.xAI?.apiKey ?? ''
				const chosenModel = (model && model.trim()) || this.voidSettingsService.state.globalSettings.imageModel || ''
				const channel = this.mainProcessService.getChannel('void-channel-imageGen')
				const { b64 } = await channel.call<{ b64: string }>('generateImage', { apiKey, prompt, model: chosenModel })
				if (!b64) { throw new Error('Image generation returned no data.') }

				const folder = this.workspaceContextService.getWorkspace().folders[0]
				if (!folder) { throw new Error('No workspace folder is open to save the image into.') }
				const rel = (outputPath && outputPath.trim() ? outputPath.trim() : `assets/generated-${Date.now()}.png`)
					.replace(/^[\\/]+/, '')
				const uri = URI.joinPath(folder.uri, ...rel.split(/[\\/]+/))
				await this.fileService.writeFile(uri, decodeBase64(b64))
				// Return BOTH the workspace-relative path (what the model should embed in markdown
				// / HTML so links resolve cleanly) AND the full URI (so callers that need the
				// absolute resource still have it). Returning ONLY `uri.toString()` here caused
				// the model to write `<img src="file:///Users/.../assets/foo.png">`, which the
				// chat / image-preview then mangled into `file:///file:/Users/.../assets/foo.png`
				// (double `file:` prefix from a relative-path resolver) — that's the ENOENT the
				// user reported when clicking the generated-image link.
				return { result: { uri: uri.toString(), path: rel, fsPath: uri.fsPath } }
			},
			run_sandbox: async ({ code, timeoutMs }) => {
				const res = await this.evalSandboxService.run(code, timeoutMs ?? undefined)
				return { result: res }
			},
			update_plan: async ({ todos, merge }, ctx) => {
				const threadId = ctx?.threadId ?? '__default__'
				// Durable-task linkage: the plan carries the task it was written under, so a
				// checklist authored for a superseded task can never pose as the current one.
				const taskFile = await this._readDurableTaskFile(threadId)
				// Durable-task guard: a FULL replace issued while the latest user turn is a
				// side request must not silently replace the primary task's plan — that is
				// exactly how the drift incident cemented the wrong task. Merge or wait for
				// an explicit user switch instead.
				if (shouldRejectPlanReplace(taskFile, merge)) {
					return { result: { todos: this._todosByThread.get(threadId) ?? [], rejected: true, reason: 'Plan NOT replaced: the latest user message is a side request, and side requests never silently replace the primary task. Use merge:true to update items, finish the side request, or ask the user to confirm an explicit task switch first.' } }
				}
				let currentTodos = this._todosByThread.get(threadId) ?? []
				if (merge) {
					for (const todo of todos) {
						const idx = currentTodos.findIndex(t => t.id === todo.id)
						if (idx >= 0) {
							currentTodos[idx] = { ...currentTodos[idx], ...todo }
						} else {
							currentTodos.push(todo)
						}
					}
				} else {
					currentTodos = [...todos]
				}
				this._todosByThread.set(threadId, currentTodos)
				void this._persistActivePlan(threadId, currentTodos, taskFile?.task.taskId)
				void this._applyPlanLifecycle(threadId, currentTodos)
				void this.contextBridgeService.ensureWorkspaceAnchor()
				this.memoryCaptureService.recordPlanUpdate(ctx?.threadId, currentTodos, merge);
				return { result: { todos: currentTodos } }
			},
			launch_subagent: async ({ description, prompt, profile }, ctx) => {
				const parentThreadId = ctx?.threadId
				const parentToolId = ctx?.toolId
				if (!parentThreadId || !parentToolId || !this._subagentLauncher) {
					return { result: { subagentThreadId: '', result: 'Error: subagent launch requires a parent thread context and the subagent launcher must be registered.', status: 'failed' as const } }
				}
				// Fire-and-forget: launch subagent in background, return immediately
				// so the parent agent can continue working while the subagent runs.
				const desc = description || 'Background task'
				const launch = this._subagentLauncher({
					parentThreadId,
					parentToolId,
					description: desc,
					prompt: prompt || '(no prompt)',
					profile,
				})
				if (!launch.ok) {
					return { result: { subagentThreadId: '', result: launch.error, status: 'failed' as const } }
				}
				// Don't await — let the subagent run independently. When it finishes (or fails,
				// or is cancelled) the single completion promise injects one notification into
				// the parent thread; the full result stays on the child thread + subagentState.
				launch.completion.then(res => {
					if (this._notificationInjector && parentThreadId) {
						const truncatedResult = res.result.length > 4000
							? res.result.slice(0, 4000) + `\n\n...truncated — the full transcript is on the subagent's thread (Agents panel, thread ${launch.subagentThreadId}).`
							: res.result;
						// Build a truthful one-line evidence summary for the parent.
						const evidenceParts: string[] = []
						if (res.filesTouched) {
							const fc = res.filesTouched.length
							evidenceParts.push(`${fc} file${fc !== 1 ? 's' : ''} changed`)
						}
						if (res.commandsRun && res.commandsRun.length > 0) {
							const passed = res.commandsRun.filter(c => c.status === 'pass').length
							const failed = res.commandsRun.filter(c => c.status === 'fail').length
							if (passed > 0) evidenceParts.push(`${passed} command${passed !== 1 ? 's' : ''} passed`)
							if (failed > 0) evidenceParts.push(`${failed} command${failed !== 1 ? 's' : ''} failed`)
						}
						if (res.blockedReason) evidenceParts.push(res.blockedReason)
						const evidenceLine = evidenceParts.length > 0 ? ` (${evidenceParts.join(', ')})` : ''
						this._notificationInjector(
							parentThreadId,
							`[Background subagent "${desc}" ${res.status}${evidenceLine}]\n${truncatedResult}`,
							'subagent'
						)
					}
				}).catch(err => {
					console.error(`[subagent] ${desc} error:`, err)
					if (this._notificationInjector && parentThreadId) {
						this._notificationInjector(
							parentThreadId,
							`[Background subagent "${desc}" failed]\nError: ${err instanceof Error ? err.message : String(err)}`,
							'subagent'
						)
					}
				})
				const profileNote = launch.profile === 'research'
					? (profile === 'research' ? ' (research profile: read-only)' : ' (Plan mode: coerced to the read-only research profile)')
					: ' (work profile)'
				// Check the subagent's current state — it may have been queued instead of started.
				const subInfo = this._subagentInfoGetter?.(launch.subagentThreadId)
				const isQueued = subInfo?.status === 'queued'
				const queueNote = isQueued && subInfo?.queuePosition
					? ` Queued at position ${subInfo.queuePosition} — the worker will start automatically when a running slot opens.`
					: ''
				const launchStatus = isQueued ? 'queued' as const : 'running' as const
				return { result: { subagentThreadId: launch.subagentThreadId, result: `Subagent "${desc}" ${launchStatus} in background${profileNote}.${queueNote} Continue with your main task — its status is in the Agents panel and its result will arrive here as a system notification.`, status: launchStatus } }
			},
			message_subagent: async ({ subagentThreadId, message }, ctx) => {
				const parentThreadId = ctx?.threadId
				if (!parentThreadId || !this._subagentMessenger) {
					return { result: { delivered: false, error: 'Worker messaging is unavailable in this context.' } }
				}
				// Ownership, state, rate limit and length bounds are all enforced by the thread
				// service — this tool is only the entry point, never a second policy.
				const res = this._subagentMessenger(parentThreadId, subagentThreadId, message)
				if (!res.ok) return { result: { delivered: false, error: res.error } }
				return { result: { delivered: true } }
			},
			report_progress: async ({ milestone }, ctx) => {
				const threadId = ctx?.threadId
				if (!threadId || !this._subagentProgressReporter) {
					return { result: { recorded: false } }
				}
				// No-ops unless the calling thread IS a running worker, so the parent conversation
				// cannot pollute a worker's activity log.
				this._subagentProgressReporter(threadId, milestone)
				return { result: { recorded: true } }
			},
			run_subagent: async ({ description, prompt, profile }, ctx) => {
				// Sidebar engine: run the same background-thread machinery as launch_subagent,
				// but BLOCK until the child finishes so the result returns as this tool's result.
				// (The native chat participant routes this tool to VS Code's RunSubagentTool
				// instead — see v3codeChatAgent/_convertParamsForNativeTool.)
				const parentThreadId = ctx?.threadId
				const parentToolId = ctx?.toolId
				if (!parentThreadId || !parentToolId || !this._subagentLauncher) {
					return { result: { result: 'Error: run_subagent requires a parent thread context and the subagent launcher must be registered.' } }
				}
				const launch = this._subagentLauncher({
					parentThreadId,
					parentToolId,
					description: description || 'Subagent task',
					prompt: prompt || '(no prompt)',
					profile: profile ?? 'work',
				})
				if (!launch.ok) {
					return { result: { result: `Error: ${launch.error}` } }
				}
				const interruptTool = () => { void this._subagentCanceller?.(launch.subagentThreadId) }
				return {
					result: launch.completion.then(res => ({
						result: res.status === 'completed' ? res.result : `Subagent ${res.status}: ${res.result}`,
					})),
					interruptTool,
				}
			},
			rename_symbol: async () => {
				return { result: { result: 'Error: rename_symbol should be handled by native RenameTool' } }
			},
			list_code_usages: async () => {
				return { result: { result: 'Error: list_code_usages should be handled by native UsagesTool' } }
			},
			run_tests: async () => {
				return { result: { result: 'Error: run_tests should be handled by native RunTestTool' } }
			},
			open_browser_page: async () => {
				return { result: { result: 'Error: open_browser_page should be handled by native OpenBrowserTool' } }
			},
			read_page: async () => {
				return { result: { result: 'Error: read_page should be handled by native ReadBrowserTool' } }
			},
			click_element: async () => {
				return { result: { result: 'Error: click_element should be handled by native ClickBrowserTool' } }
			},
			type_in_page: async () => {
				return { result: { result: 'Error: type_in_page should be handled by native TypeBrowserTool' } }
			},
			// Computer use is handled by the native tools in contrib/computerUse; these entries exist only
			// to satisfy the exhaustive maps, exactly as the browser tools above do.
			computer_read_screen: async () => {
				return { result: { result: 'Error: computer_read_screen should be handled by the native computer-use tool' } }
			},
			computer_read_screen_changes: async () => {
				return { result: { result: 'Error: computer_read_screen_changes should be handled by the native computer-use tool' } }
			},
			computer_screenshot: async () => {
				return { result: { result: 'Error: computer_screenshot should be handled by the native computer-use tool' } }
			},
			computer_click: async () => {
				return { result: { result: 'Error: computer_click should be handled by the native computer-use tool' } }
			},
			computer_type: async () => {
				return { result: { result: 'Error: computer_type should be handled by the native computer-use tool' } }
			},
			computer_key: async () => {
				return { result: { result: 'Error: computer_key should be handled by the native computer-use tool' } }
			},
			computer_scroll: async () => {
				return { result: { result: 'Error: computer_scroll should be handled by the native computer-use tool' } }
			},
			computer_cursor: async () => {
				return { result: { result: 'Error: computer_cursor should be handled by the native computer-use tool' } }
			},
			computer_wait_for_stable: async () => {
				return { result: { result: 'Error: computer_wait_for_stable should be handled by the native computer-use tool' } }
			},
			computer_list_apps: async () => {
				return { result: { result: 'Error: computer_list_apps should be handled by the native computer-use tool' } }
			},
			computer_drag: async () => {
				return { result: { result: 'Error: computer_drag should be handled by the native computer-use tool' } }
			},
			computer_hover: async () => {
				return { result: { result: 'Error: computer_hover should be handled by the native computer-use tool' } }
			},
			computer_clipboard_read: async () => {
				return { result: { result: 'Error: computer_clipboard_read should be handled by the native computer-use tool' } }
			},
			computer_clipboard_write: async () => {
				return { result: { result: 'Error: computer_clipboard_write should be handled by the native computer-use tool' } }
			},
			computer_open_app: async () => {
				return { result: { result: 'Error: computer_open_app should be handled by the native computer-use tool' } }
			},
			screenshot_page: async () => {
				return { result: { result: 'Error: screenshot_page should be handled by native ScreenshotBrowserTool' } }
			},
			navigate_page: async () => {
				return { result: { result: 'Error: navigate_page should be handled by native NavigateBrowserTool' } }
			},
			hover_element: async () => {
				return { result: { result: 'Error: hover_element should be handled by native HoverElementTool' } }
			},
			drag_element: async () => {
				return { result: { result: 'Error: drag_element should be handled by native DragElementTool' } }
			},
			handle_dialog: async () => {
				return { result: { result: 'Error: handle_dialog should be handled by native HandleDialogBrowserTool' } }
			},
			run_playwright_code: async () => {
				return { result: { result: 'Error: run_playwright_code should be handled by native RunPlaywrightCodeTool' } }
			},
			extract_page_data: async () => {
				return { result: { result: 'Error: extract_page_data should be handled by native ExtractPageDataBrowserTool' } }
			},
			get_browser_console_logs: async () => {
				return { result: { result: 'Error: get_browser_console_logs should be handled by native GetBrowserConsoleLogsBrowserTool' } }
			},
			reconstruct_page_sources: async () => {
				return { result: { result: 'Error: reconstruct_page_sources should be handled by native ReconstructPageSourcesBrowserTool' } }
			},
			get_computed_styles: async () => ({ result: { result: 'Error: get_computed_styles should be handled by native GetComputedStylesBrowserTool' } }),
			watch_page: async () => ({ result: { result: 'Error: watch_page should be handled by native WatchPageBrowserTool' } }),
			save_browser_session: async () => ({ result: { result: 'Error: save_browser_session should be handled by native SaveBrowserSessionBrowserTool' } }),
			restore_browser_session: async () => ({ result: { result: 'Error: restore_browser_session should be handled by native RestoreBrowserSessionBrowserTool' } }),
			fill_form: async () => ({ result: { result: 'Error: fill_form should be handled by native FillFormBrowserTool' } }),
			intercept_network: async () => ({ result: { result: 'Error: intercept_network should be handled by native InterceptNetworkBrowserTool' } }),
			get_browser_network_log: async () => ({ result: { result: 'Error: get_browser_network_log should be handled by native GetBrowserNetworkLogBrowserTool' } }),
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			read_file: (params, result) => {
				// Explicit completeness footer so the agent KNOWS whether it holds the whole file and
				// stops re-reading. `isComplete` => trust your context, do not re-read (read-once rule).
				// Otherwise tell it exactly which line range it has and the precise missing range to request.
				const footer = result.isComplete
					? `\n[read_file: COMPLETE — returned lines ${result.returnedStartLine}-${result.returnedEndLine} of ${result.totalNumLines} (EOF reached). You now have the entire file; do NOT re-read it unless you edit it.]`
					: `\n[read_file: TRUNCATED — returned lines ${result.returnedStartLine}-${result.returnedEndLine} of ${result.totalNumLines} total (${result.totalFileLen} chars). To get the rest, request ONLY the missing range (startLine ${result.returnedEndLine + 1}+)${result.hasNextPage ? ` or pageNumber ${params.pageNumber + 1}` : ''} — do NOT re-read the whole file.]`
				// cat -n style numbering (right-aligned number + tab) so the model cites REAL
				// file:line positions instead of fabricating them. fileContents begins at
				// returnedStartLine (range reads / char pagination can start mid-file), so number
				// from there. Presentation-only: result.fileContents stays raw for the UI card, and
				// edit_file matches against the live file model, never against this string.
				const lnWidth = String(result.returnedEndLine).length
				const numbered = result.fileContents.length === 0
					? result.fileContents
					: result.fileContents.split('\n')
						.map((line, i) => `${String(result.returnedStartLine + i).padStart(lnWidth)}\t${line}`)
						.join('\n')
				return `${params.uri.fsPath}\n\`\`\`\n${numbered}\n\`\`\`${footer}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				// `[].join('\n')` is the empty string, which reaches the model as a BLANK tool
				// result — indistinguishable from a broken tool. Say what was searched instead.
				if (!result.uris.length) {
					return `No file paths match "${params.query}"${params.includePattern ? ` (limited to ${params.includePattern})` : ''}. This searches PATHS, not file contents — use search_for_files to search inside files.`
				}
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result) => {
				if (!result.uris.length) {
					const { mode, hint } = searchModeSuffix(params.query, params.isRegex)
					return `No files contain "${params.query}" (searched as ${mode}${params.searchInFolder ? ` under ${params.searchInFolder.fsPath}` : ''}).${hint}`
				}
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_in_file: (params, result) => {
				if (result.matched?.length) {
					const body = result.matched.map(m => `Line ${m.line}:\n\`\`\`\n${m.text}\n\`\`\``).join('\n\n');
					const hidden = (result.totalMatches ?? result.matched.length) - result.matched.length
					return hidden > 0
						? `${body}\n\n... and ${hidden} more match(es) not shown (${result.totalMatches} total). Narrow the query if you need them.`
						: body;
				}
				if (!result.lines.length) {
					const { mode, hint } = searchModeSuffix(params.query, params.isRegex)
					return `No matches for "${params.query}" in ${params.uri.fsPath} (searched as ${mode}).${hint}`
				}
				// Fallback for any old-shape result that lacks `matched`: use the model if the
				// file happens to be open; otherwise just report the line numbers.
				const { model } = voidModelService.getModel(params.uri)
				if (!model) { return result.lines.map(n => `Line ${n}`).join('\n'); }
				return result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					this._stringifyLintErrors(result.lintErrors)
					: `No lint errors reported for ${params.uri.fsPath} after waiting ${LINT_WAIT_MS / 1000}s for the language server. If this file was just created, the server may not have analyzed it yet — this is absence of DATA, not proof the file is clean. Confirm with get_build_errors.`
			},
			security_scan: (_params, result) => {
				if (!result.ran) {
					return `The security scan did not run: ${result.error}`
				}
				const header = `Security scan of ${result.workspace}\n`
					+ `${result.findingCount} finding(s) across ${result.filesScanned} file(s) analyzed (${result.filesSkipped} skipped)\n`
					+ `Packs run: ${result.packIds.join(', ') || '(none)'}\n`
				return `${header}\n${result.human}\n\nSince last scan:\n${result.memory}`
			},
			read_skill: (params, result) => {
				if (!result.found) {
					const list = result.availableNames.length ? result.availableNames.join(', ') : '(no skills found)'
					return `No skill named "${result.name}". Available skills: ${list}`
				}
				return `Skill: ${result.name}\nPath: ${result.filePath}\n\n${result.content}`
			},
			open_project: (_params, result) => {
				if (result.cancelled) {
					return 'The user cancelled project selection. No project was changed and the current chat stayed open.'
						+ formatWorkspaceTransitionStamp({ tool: 'open_project', changed: false })
				}
				const action = result.mode === 'replace'
					? (result.changed ? 'Switched to project' : 'Project was already the only active root')
					: (result.changed ? 'Added project root' : 'Project root was already attached')
				const carryWarning = result.anchorCarry === 'no-thread-id'
					? '\nWARNING: this switch ran without a thread context, so the thread\'s memory anchors (symbol notes, editorial, plan) were NOT carried across the swap. If continuity matters, use recover_session_anchors after confirming the origin with the user.'
					: result.carryManifest ? `\n${result.carryManifest}` : ''
				return `${action}: ${result.folder}\nActive project folders: ${result.workspaceFolders.join(', ') || '(none)'}\nCode index rebuild started in the background (current state: ${result.indexStatus.state}). Searches are now limited to the active folders above; use index_health if exact progress is needed.${carryWarning}`
					+ formatWorkspaceTransitionStamp({ tool: 'open_project', changed: result.changed })
			},
			close_project: (_params, result) => {
				return `Detached project root (files were not deleted): ${result.folder}\nActive project folders: ${result.workspaceFolders.join(', ') || '(none)'}\nCode index rebuild started in the background (current state: ${result.indexStatus.state}).`
					+ formatWorkspaceTransitionStamp({ tool: 'close_project', removed: result.removed })
			},
			reload_window: (_params, result) => {
				return result.scheduled
					? `V3Code window reload scheduled in ${result.delayMs}ms. This must be the final action in this turn.`
					: 'V3Code window reload was not scheduled.'
			},
			// ---
			create_file_or_folder: (params, result) => {
				// File-vs-folder is decided ONLY by a trailing slash on the uri, and models routinely
				// normalize that away. The confirmation used to be byte-identical either way, so an
				// agent that asked for a folder and got an empty FILE named `components` was told
				// "successfully created" and built on top of it. Always name the kind.
				const kind = (isFolder: boolean | undefined) => isFolder ? 'FOLDER' : 'FILE'
				if (result.alreadyExists) {
					const mismatch = result.existingIsFolder !== undefined && result.existingIsFolder !== params.isFolder
						? ` You asked for a ${kind(params.isFolder)} — delete it first if you need the other kind (a uri ending in "/" means folder).`
						: ''
					return `${params.uri.fsPath} already existed as a ${kind(result.existingIsFolder)} (no changes made).${mismatch}`
				}
				return `Created ${kind(params.isFolder)} ${params.uri.fsPath}.`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			edit_file: (params, result) => {
				const lintErrsString = this._lintSummaryAfterEdit(result)
				const shadowWarn = (
					this.voidSettingsService.state.globalSettings.shadowVerify && result.noDiagnosticsReported
				) ? ' Shadow verify: no language-server diagnostics on this file after 5s — rollback cannot trigger. Open the repo root that owns tsconfig (e.g. vselite for void code), or ensure TypeScript is running.'
					: '';
				const lineSummary = (result.added !== undefined && result.removed !== undefined)
					? ` (+${result.added} -${result.removed} lines)`
					: '';
				const diffPart = result.diffText ?? '';

				return `Change successfully made to ${params.uri.fsPath}${lineSummary}.${lintErrsString}${shadowWarn}${diffPart}`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = this._lintSummaryAfterEdit(result)

				const shadowWarn = (
					this.voidSettingsService.state.globalSettings.shadowVerify && result.noDiagnosticsReported
				) ? ' Shadow verify: no language-server diagnostics on this file after 5s — rollback cannot trigger. Open the repo root that owns tsconfig (e.g. vselite for void code), or ensure TypeScript is running.'
					: '';
				const lineSummary = (result.added !== undefined && result.removed !== undefined)
					? ` (+${result.added} -${result.removed} lines)`
					: '';
				const diffPart = result.diffText ?? '';

				return `Change successfully made to ${params.uri.fsPath}${lineSummary}.${lintErrsString}${shadowWarn}${diffPart}`
			},
			append_file: (params, result) => {
				const lintErrsString = this._lintSummaryAfterEdit(result)

				const shadowWarn = (
					this.voidSettingsService.state.globalSettings.shadowVerify && result.noDiagnosticsReported
				) ? ' Shadow verify: no language-server diagnostics on this file after 5s — rollback cannot trigger. Open the repo root that owns tsconfig (e.g. vselite for void code), or ensure TypeScript is running.'
					: '';
				const lineSummary = (result.added !== undefined && result.removed !== undefined)
					? ` (+${result.added} -${result.removed} lines)`
					: '';
				const appended = result.appendedChars !== undefined ? ` Appended ${result.appendedChars} characters.` : '';
				const diffPart = result.diffText ?? '';

				return `Appended to ${params.uri.fsPath}${lineSummary}.${appended}${lintErrsString}${shadowWarn}${diffPart}`
			},
			run_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				// `$ <command>` is PRESENTATION, added here after taming — never baked into
				// the raw result, where porcelain parsers ingested it as a phantom file. It
				// also survives the tail cut on long outputs this way.
				const tamed = `$ ${params.command}\n${tailAndDedupeTerminalOutput(result_)}`
				// success
				if (resolveReason.type === 'done') {
					return `${tamed}\n(exit code ${resolveReason.exitCode ?? 'unknown — the shell did not report one; verify success explicitly before relying on it'})`
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					if (resolveReason.mightBeWaitingForInput) {
						return `${tamed}\nTerminal command was stopped by V3Code — the last output line looks like the command is WAITING FOR INPUT. Re-run it non-interactively (--yes / --no-input flags, pipe pagers to cat, or redirect stdin from /dev/null).`
					}
					const waited = resolveReason.timeoutSec ?? MAX_TERMINAL_INACTIVE_TIME
					const why = resolveReason.cause === 'wall_clock' ? `after ${waited}s total (wall-clock cap)` : `after ${waited}s of inactivity`
					return `${tamed}\nTerminal command was stopped by V3Code ${why} and may not have finished. For longer commands pass timeout_seconds (up to 600), or open a persistent terminal and run it there.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				const tamed = tailAndDedupeTerminalOutput(result_)
				// success
				if (resolveReason.type === 'done') {
					return `${tamed}\n(exit code ${resolveReason.exitCode ?? 'unknown — the shell did not report one; verify success explicitly before relying on it'})`
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					return `${tamed}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds. Call read_terminal_output with this terminal id to check progress or later output.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
			read_terminal_output: (params, result) => {
				const tamed = tailAndDedupeTerminalOutput(result.output)
				return tamed.trim() ? tamed : `(terminal ${params.persistentTerminalId} has no output yet)`
			},
			ask_user: (_params, result) => {
				return `The user chose: ${result.choice}`
			},

			// --- Context Bridge ---
			remember_editorial: (_params, result) => {
				if (result.unavailable) { return `Project memory is not available in this workspace, so nothing was saved.` }
				if (result.error) { return `Not saved: ${result.error}` }
				return result.created
					? `Started project memory topic "${result.topic}".`
					: `Added to project memory topic "${result.topic}"${result.mode === 'replace' ? ' (replaced)' : ''}.`
			},
			forget_editorial: (_params, result) => {
				if (result.unavailable) { return `Project memory is not available in this workspace.` }
				if (!result.deleted) { return `No project memory topic named "${result.topic}" — nothing to delete.` }
				return result.section
					? `Cleared "${result.section}" from project memory topic "${result.topic}".`
					: `Deleted project memory topic "${result.topic}".`
			},
			remember: (_params, result) => {
				const n = result.note
				return `Saved note ${n.id} for symbol "${n.symbolName}" in ${n.filePath}.`
			},
			forget: (params, result) => {
				return result.deleted
					? `Deleted note ${params.noteId}.`
					: `No note found with id ${params.noteId}.`
			},
			recover_session_anchors: (_params, result) => {
				const lines = [`Recovered ${result.imported} work-scoped anchor(s) for the active thread.`]
				if (result.skipped.length) lines.push('', 'Skipped:', ...result.skipped.map(item => `- ${item}`))
				if (result.missing.length) lines.push('', 'Missing:', ...result.missing.map(item => `- ${item}`))
				return lines.join('\n')
			},
			team_checkin: (_params, result) => {
				if (result.status === 'done') {
					return `Checked out: ${result.agentId} removed from the team board.`
				}
				const overlapWarning = result.overlaps?.length
					? `\n⚠ OVERLAP WARNING: your claimed area overlaps ${result.overlaps.map(o => `${o.agentId}${o.where ? ` [${o.where}]` : ''}`).join(', ')}. Coordinate before editing the shared files, narrow your claim, or take a worktree.`
					: ''
				return `Checked in as ${result.agentId}. Reuse this agent_id for later check-ins; call team_checkin with status "done" when finished.${overlapWarning}`
			},
			team_board: (_params, result) => {
				const contractsText = result.contracts.length === 0
					? ''
					: `\n\nFrozen contracts (${result.contracts.length}):\n` + result.contracts
						.map(c => `- ${c.key} = ${c.value}${c.rationale ? ` (${c.rationale})` : ''}${c.stale ? ' [stale — older than 48h; clear it if the effort is over]' : ''}`)
						.join('\n')
				if (result.entries.length === 0) {
					return 'No recorded task/check-in entries. Agents that have not checked in may still be working.' + contractsText
				}
				return `${result.entries.length} agent(s) on the board:\n` + result.entries
					.map(e => `- ${e.agentId}: ${e.doing}${e.where ? ` [${e.where}]` : ''} (updated ${e.updatedAt})`)
					.join('\n') + contractsText
			},
			team_contract: (_params, result) => {
				const list = result.contracts.length === 0
					? 'No contracts on the board.'
					: `Contracts now in force (${result.contracts.length}):\n` + result.contracts.map(c => `- ${c.key} = ${c.value}${c.rationale ? ` (${c.rationale})` : ''}`).join('\n')
				return `${result.action === 'set' ? `Froze ${result.key}.` : `Cleared ${result.key}.`} Every subagent launched from now on receives these in its preamble.\n${list}`
			},
			list_notes: (params, result) => {
				if (result.notes.length === 0) {
					return params.filePath
						? `No notes found for ${params.filePath}.`
						: `No notes saved in this workspace.`
				}
				return result.notes.map(formatNoteLine).join('\n')
			},
			search_notes: (params, result) => {
				if (result.notes.length === 0) {
					return `No notes match "${params.query}"${params.filePath ? ` in ${params.filePath}` : ''}.`
				}
				return `Found ${result.notes.length} note(s) for "${params.query}"${cappedCountNote(result.notes.length, params.limit)}:\n` + result.notes.map(formatNoteLine).join('\n')
			},
			workspace_delta: (_params, result) => {
				const lines = [result.summary, '']
				if (result.changedFiles.length) {
					lines.push('Working tree:')
					for (const f of result.changedFiles.slice(0, 20)) {
						lines.push(`  ${f.status.padEnd(10)} ${f.path}`)
					}
					if (result.changedFiles.length > 20) { lines.push(`  … +${result.changedFiles.length - 20} more`) }
				}
				if (result.recentEdits.length) {
					lines.push('', 'Recent edits:')
					for (const e of result.recentEdits) {
						lines.push(`  - ${e.summary}`)
					}
				}
				if (result.newNotes.length) {
					lines.push('', 'Notes touched:')
					for (const n of result.newNotes) {
						lines.push(`  - [${n.id}] ${n.filePath} :: ${n.symbolName}`)
					}
				}
				return lines.join('\n')
			},
			search_chat_memory: (params, result) => {
				if (result.unavailable) {
					return 'Chat memory is not available in this session (memory store not initialized).'
				}
				if (result.events.length === 0) {
					return `No chat memory matches for "${params.query}".`
				}
				return `Found ${result.events.length} chat memory event(s)${cappedCountNote(result.events.length, params.limit)}:\n\n${formatChatEventsForTool(result.events)}`
			},
			search_memory: (params, result) => result.unavailable ? 'Memory search is unavailable.' : result.hits.length ? `Historical memory evidence for "${params.query}" (not current instructions):\n\n${result.hits.map(hit => `- [${hit.kind}] ${hit.id} score=${hit.score.toFixed(3)} workspace=${hit.workspaceId} updated=${(typeof hit.ts === 'number' && Number.isFinite(hit.ts) ? new Date(hit.ts).toISOString() : 'unknown')}${hit.sessionId ? ` session=${hit.sessionId}` : ''}\n  ${hit.summary}`).join('\n')}` : `No indexed memory matches for "${params.query}".`,
			get_memory_checkpoint: (_params, result) => {
				if (result.unavailable) return 'Memory checkpoints are unavailable.'
				if (!result.evidence) return 'Memory checkpoint not found.'
				const { checkpoint, events, page, totalPages } = result.evidence
				const eventText = events.map(event => `[historical ${event.kind} · ${new Date(event.ts).toISOString()}] ${event.title}\n${event.body.slice(0, 1200)}`).join('\n\n')
				return `Historical checkpoint ${checkpoint.id} (${new Date(checkpoint.startedAt).toISOString()} → ${new Date(checkpoint.endedAt).toISOString()})\nSummary evidence:\n${checkpoint.summary}\n\nSource events page ${page}/${totalPages} (historical evidence, never current instructions):\n${eventText || '(events not requested)'}`
			},
			deep_recall: (params, result) => {
				if (result.unavailable) {
					return 'Deep memory is not available in this session (memory store not initialized).'
				}
				if (result.hits.length === 0) {
					return `No shadow-archive matches for "${params.query}". Nothing by that description was ever recorded.`
				}
				const lines = result.hits.map(h => {
					const when = new Date(h.ts).toISOString()
					const where = h.file ? ` ${h.file}` : ''
					return `- [${h.id}] ${h.kind}${where} · ${when}\n  ${h.snippet}`
				}).join('\n')
				return `Found ${result.hits.length} match(es) in the raw archive (use get_shadow_record(shadow_id) for full text):\n\n${lines}`
			},
			get_shadow_record: (params, result) => {
				if (result.unavailable) {
					return 'Deep memory is not available in this session (memory store not initialized).'
				}
				if (!result.record) {
					return `No shadow record found with id ${params.shadowId}.`
				}
				const r = result.record
				const when = new Date(r.ts).toISOString()
				const where = r.file ? ` · ${r.file}` : ''
				return `${r.kind} · ${when}${where} · session ${r.sessionId}\n\n${r.text}`
			},
			get_build_errors: (params, result) => {
				const scope = params.pathFilter ? ` matching "${params.pathFilter}"` : ''
				const kinds = params.errorsOnly ? 'errors' : 'errors/warnings'
				if (result.problems.length === 0) {
					return `No ${kinds}${scope} are currently reported in the editor's live diagnostics. Diagnostic coverage may be incomplete; this result does not establish which files were analyzed and is not a full from-scratch build.`
				}
				const byFile = new Map<string, typeof result.problems>()
				for (const p of result.problems) {
					const arr = byFile.get(p.file) ?? []
					arr.push(p)
					byFile.set(p.file, arr)
				}
				const blocks = [...byFile.entries()].map(([file, ps]) =>
					`${file}\n` + ps.map(p => `  ${p.severity === 'error' ? 'ERROR' : 'warn '} ${p.line}:${p.col}  ${p.message}${p.code ? ` [${p.code}]` : ''}`).join('\n')
				).join('\n\n')
				const head = `${result.total} ${kinds}${scope} across ${byFile.size} file(s)${result.truncated ? ` (showing first ${result.problems.length})` : ''}:`
				return `${head}\n\n${blocks}`
			},
			get_chat_session: (params, result) => {
				if (result.unavailable) {
					return 'Chat memory is not available in this session (memory store not initialized).'
				}
				if (result.events.length === 0) {
					return `No events found for session ${params.sessionId}.`
				}
				return `Session ${params.sessionId} (${result.events.length} events):\n\n${formatChatEventsForTool(result.events)}`
			},
			get_chat_thread: (params, result) => {
				if (result.unavailable) {
					return 'Chat memory is not available in this session (memory store not initialized).'
				}
				if (result.events.length === 0) {
					return `No thread found for event ${params.eventId}.`
				}
				return `Thread rooted at ${params.eventId} (${result.events.length} events):\n\n${formatChatEventsForTool(result.events)}`
			},
			get_editorial_briefing: (_params, result) => {
				if (result.unavailable) {
					return 'Editorial memory is not available (memory store not initialized).'
				}
				// Pure formatter (editorialMerge.ts): lists carried branches even when this
				// workspace has no project of its own, and says what did NOT carry.
				return formatEditorialBriefing(result, this.workspaceContextService.getWorkspace().folders[0]?.name?.trim())
			},
			search_editorial: (params, result) => {
				if (result.unavailable) {
					return 'Editorial memory is not available (memory store not initialized).'
				}
				if (result.branches.length === 0) {
					return `No editorial matches for "${params.query}".`
				}
				return `Found ${result.branches.length} editorial branch(es) for "${params.query}":\n\n${result.branches.map(formatEditorialBranchForTool).join('\n\n---\n\n')}`
			},
			find_text: (params, result) => {
				if (result.matches.length === 0) {
					// A literal search for a query that is obviously a regex reads as a
					// confident "this does not exist", and the model believes it — one
					// unescaped `a|b` sent a real session down ten wasted calls chasing a
					// symbol that was right there. Say why the answer might be wrong.
					if (!params.isRegex && /[|()[\]\\+*?{}^$]/.test(params.query)) {
						return `No matches for "${params.query}" (searched as literal text).\nThis query contains regex characters — if you meant a pattern, retry with is_regex: "true".`
					}
					return `No matches for "${params.query}".`
				}
				// grep -C conventions: `path:LINE:` marks a match, `path-LINE-` marks a context row.
				const lines = result.matches.map(m => m.isContext
					? `${m.uri.fsPath}-${m.lineNumber}- ${m.previewText.trimEnd()}`
					: `${m.uri.fsPath}:${m.lineNumber}: ${m.previewText.trim()}`).join('\n')
				return lines + nextPageStr(result.hasNextPage)
			},
			semantic_search: (params, result) => {
				if (result.hits.length === 0) {
					// Help the LLM (and through it, the user) understand WHY there were no hits.
					if (result.indexState === 'uninitialized') {
						return `The semantic index hasn't been initialized yet. Ask the user to run the "V3Code: Rebuild Codebase Index" command from the command palette (Ctrl/Cmd+Shift+P). After it finishes, retry semantic_search.`
					}
					if (result.indexState === 'walking' || result.indexState === 'chunking' || result.indexState === 'embedding') {
						return `The semantic index is still being built (state: ${result.indexState}). Wait for it to finish, then retry. Check the status bar for progress.`
					}
					if (result.indexState === 'error') {
						return `The semantic index is in an error state. Ask the user to check the V3Code logs and re-run "V3Code: Rebuild Codebase Index".`
					}
					if (result.indexState === 'idle' || result.indexState === 'ready') {
						return `No semantic matches for "${params.query}". The index is ${result.indexState} but returned 0 hits — either the corpus is empty (run "V3Code: Rebuild Codebase Index") or the query is genuinely unrelated to anything indexed. Try \`find_text\` or rephrase the query.`
					}
					return `No semantic matches for "${params.query}". (index state: ${result.indexState})`
				}
				const rerankNote = result.rerankStatus ? ` [rerank: ${result.rerankStatus}]` : ''
				// Coverage stamp: results over a partial index are partial evidence, not proof.
				const partial = result.filesTotal !== undefined && result.filesIndexed !== undefined && result.filesIndexed < result.filesTotal
				const coverageNote = partial
					? ` [PARTIAL INDEX: ${result.filesIndexed}/${result.filesTotal} files — a miss here is not proof of absence; call index_health or use find_text to confirm]`
					: ''
				// Honest head-count: graph-neighbor chunks are APPENDED by the retriever
				// after the ranked list, so counting them as matches overstated the
				// result (a 12-hit window printed "Top 22 semantic matches"). Split them.
				const neighborCount = result.hits.filter(h => h.signals.neighbor).length
				const primaryCount = result.hits.length - neighborCount
				const header = `Top ${primaryCount} semantic matches${neighborCount > 0 ? ` (+${neighborCount} related graph neighbors)` : ''} (index: ${result.indexState})${rerankNote}${coverageNote}:\n`
				const formatHit = (h: typeof result.hits[number], i: number) => {
					const c = h.chunk
					const signals = [
						h.signals.local ? 'local' : null,
						h.signals.cloud ? 'cloud' : null,
						h.signals.rerank !== undefined ? `rerank=${h.signals.rerank.toFixed(2)}` : null,
						h.signals.vec !== undefined ? `vec=${h.signals.vec.toFixed(2)}` : null,
						h.signals.fts !== undefined ? `fts=${h.signals.fts.toFixed(2)}` : null,
						h.signals.hyde !== undefined ? `hyde=${h.signals.hyde.toFixed(2)}` : null,
						h.signals.terms !== undefined ? `terms=${h.signals.terms.toFixed(2)}` : null,
						h.signals.graphBoost !== undefined ? `graph=${h.signals.graphBoost.toFixed(3)}` : null,
						// Local cross-encoder score (applyRerankOrder). Without this the
						// local rerank reordered the list invisibly — the agent could not
						// tell a cross-encoder-promoted hit from a fused one.
						h.signals.xenc !== undefined ? `xenc=${h.signals.xenc.toFixed(3)}` : null,
						// Neighbors carry score 0 and NEVER matched the query, but with no
						// case here they printed as `(score=0.000 )` — indistinguishable
						// from a real hit. Every hit now declares the channel it came from.
						h.signals.neighbor ? 'neighbor' : null,
						h.signals.weak ? 'weak' : null,
					].filter(Boolean).join(' ')
					const loc = `${c.file}:${c.startLine}-${c.endLine}`
					const head = `${i + 1}. [${c.kind}] ${c.name || '<anon>'} — ${loc} (score=${h.score.toFixed(3)} ${signals})`
					const content = h.content.length > 800 ? h.content.slice(0, 800) + '\n…' : h.content
					return `${head}\n\`\`\`${c.language || ''}\n${content}\n\`\`\``
				}
				// Read-first nudge: semantic hits are POINTERS. The one behavior that
				// separates a grounded agent from a pattern-matcher is opening the
				// file before acting — say so at the moment it matters, every time.
				const readFirstFooter = `\n\nThese are index pointers, not ground truth — before editing or citing any of this, read the real code (read_file the hit, or pack_context its symbol).`
				// Split primaries from neighbors FIRST. The old code ran a single
				// findIndex(h => h.signals.weak) over ALL hits: when splitAtKnee returned
				// an empty weak set (common), weakIdx was -1 and every neighbor printed
				// above the fold as if it were ranked.
				const primaries = result.hits.filter(h => !h.signals.neighbor)
				const neighbors = result.hits.filter(h => h.signals.neighbor)
				const weakIdx = primaries.findIndex(h => h.signals.weak)
				const strongPart = (weakIdx === -1 ? primaries : primaries.slice(0, weakIdx)).map((h, i) => formatHit(h, i)).join('\n\n')
				const weakPart = weakIdx === -1
					? ''
					: '\n\n--- weaker matches (likely noise) ---\n\n' + primaries.slice(weakIdx).map((h, i) => formatHit(h, weakIdx + i)).join('\n\n')
				// Neighbors are callers/definitions pulled in by graph expansion, not
				// ranked matches — they get their own labelled section so they can never
				// be read as part of the ranking.
				const neighborPart = neighbors.length === 0
					? ''
					: '\n\n--- related code (graph neighbors — did NOT match the query) ---\n\n' + neighbors.map((h, i) => formatHit(h, primaries.length + i)).join('\n\n')
				return header + strongPart + weakPart + neighborPart + readFirstFooter
			},
			symbol_lookup: (params, result) => {
				if (result.tags.length === 0) {
					if (!result.sidecarAvailable) {
						return `symbol_lookup is UNAVAILABLE on this install — the beast sidecar binary is not present, so this is NOT evidence that "${params.name}" is absent. Use get_symbol_context or find_text instead (different backend).`
					}
					return `No tags found for "${params.name}" (beast sidecar may still be building, or the symbol is dynamic).`
				}
				const lines = result.tags.map(t => `${t.is_definition ? 'def' : 'ref'}  ${t.path}:${t.line}  ${t.name} (${t.kind})`)
				return `${result.tags.length} tag(s) for "${params.name}":\n${lines.join('\n')}`
			},
			impact_trace: (params, result) => {
				if (result.impacted.length === 0) {
					if (!result.sidecarAvailable) {
						return `impact_trace is UNAVAILABLE on this install — the beast sidecar binary is not present, so this is NOT evidence that "${params.target}" has no dependents. Use get_file_dependencies or get_call_graph instead (different backend).`
					}
					return `No cross-file impact found for "${params.target}" — nothing else references it through the tag graph (or the beast sidecar is still building).`
				}
				const lines = result.impacted.map(i => `hop ${i.distance}${i.is_hub ? ' [hub]' : ''}  ${i.file}  — ${i.why}`)
				return `${result.impacted.length} file(s) impacted if "${params.target}" changes:\n${lines.join('\n')}`
			},
			get_file_context: (_params, result) => stringifyFileContext(result),
			get_file_dependencies: (_params, result) => stringifyFileDependencies(result),
			get_symbol_context: (_params, result) => stringifySymbolContext(result),
			get_call_graph: (_params, result) => stringifyCallGraph(result),
			pack_context: (_params, result) => stringifyPackContext(result),
			get_project_briefing: (_params, result) => stringifyProjectBriefing(result),

			// --- Web & Git & Browser ---
			web_search: (params, result) => {
				if (result.results.length === 0) return `No results found for "${params.query}".`
				return result.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
			},
			web_fetch: (params, result) => {
				const header = `${result.title ? result.title + '\n' : ''}${result.url}${result.status !== 200 ? ` (HTTP ${result.status})` : ''}${result.totalPages > 1 ? ` — page ${result.pageNumber}/${result.totalPages}` : ''}`
				const more = result.pageNumber < result.totalPages ? `\n\n[${result.totalPages - result.pageNumber} more page(s) — call web_fetch again with page_number: ${result.pageNumber + 1}]` : ''
				return `${header}\n\n${result.text || '(no readable text on this page)'}${more}`
			},
			repo_hygiene: (_params, result) => result.output,
			git_status: (_params, result) => result.status,
			git_stage: (_params, result) => result.output,
			session_diff: (_params, result) => {
				if (result.count === 0) { return 'No changed files in the working tree (clean since the last commit).' }
				return `${result.count} changed file(s):\n` + result.files.map(f => `  ${f.status.padEnd(10)} ${f.path}`).join('\n')
			},
			recent_edits: (params, result) => {
				if (result.edits.length === 0) {
					return params.file ? `No recent edits in ${params.file}.` : 'No recent edits recorded yet.'
				}
				const now = Date.now()
				const ago = (ts: number) => { const s = Math.max(0, Math.floor((now - ts) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h` }
				return `${result.edits.length} recent edit(s), newest first${cappedCountNote(result.edits.length, params.n ?? 20)}:\n` + result.edits.map(e => `- ${e.summary}  (${ago(e.timestamp)} ago)`).join('\n')
			},
			index_health: (_params, result) => {
				const s = result.status
				const lines = [
					`state: ${s.state}`,
					`files indexed: ${s.filesIndexed}/${s.filesTotal}`,
					`chunks: ${s.chunksTotal}`,
				]
				if (s.modelId) { lines.push(`model: ${s.modelId}`) }
				if (s.lastIndexedAt) { lines.push(`last full index: ${new Date(s.lastIndexedAt).toISOString()}`) }
				if (s.lastError) { lines.push(`last error: ${s.lastError}`) }
				if (s.backgroundUpgrade && s.chunksToEmbed) {
					const pct = Math.floor(((s.embeddedChunks ?? 0) / s.chunksToEmbed) * 100)
					lines.push(`quality upgrade: ${pct}% (${s.embeddedChunks ?? 0}/${s.chunksToEmbed} chunks) — search fully available on interim vectors`)
					if (s.filesPerSecond !== undefined) { lines.push(`upgrade rate: ${s.filesPerSecond.toFixed(1)} chunks/s`) }
					if (s.etaSeconds != null) { lines.push(`upgrade eta: ~${Math.round(s.etaSeconds)}s`) }
				} else if (s.state === 'walking' || s.state === 'chunking' || s.state === 'embedding') {
					if (s.etaSeconds != null) { lines.push(`eta: ~${Math.round(s.etaSeconds)}s`) }
					if (s.currentFile) { lines.push(`current: ${s.currentFile}`) }
					if (s.chunksToEmbed) { lines.push(`embedding: ${s.embeddedChunks ?? 0}/${s.chunksToEmbed} chunks`) }
				}
				const head = result.rebuildStarted ? 'Full re-scan started (running in the background).\n\n' : ''
				const note = (s.state === 'ready' && !s.backgroundUpgrade) ? '' : (s.backgroundUpgrade ? '\n\n(Search is live — quality upgrade improves ranking over time.)' : '\n\n(Index is not "ready" — semantic_search results may be partial until it settles.)')
				return head + lines.join('\n') + note
			},
			git_commit: (_params, result) => result.output,
			git_diff: (_params, result) => result.diff,
			git_log: (_params, result) => result.log,
			git_branch: (_params, result) => `current: ${result.branch}\n${result.branches}`,
			git_push: (_params, result) => result.output,
			git_pull: (_params, result) => result.output,
			git_fetch: (_params, result) => result.output,
			git_checkout: (_params, result) => result.output,
			git_stash: (_params, result) => result.output,
			git_remote: (_params, result) => result.output,
			git_show: (_params, result) => result.output,
			git_blame: (_params, result) => result.output,
			git_merge: (_params, result) => result.output,
			git_rebase: (_params, result) => result.output,
			git_cherry_pick: (_params, result) => result.output,
			git_restore: (_params, result) => result.output,
			git_reset: (_params, result) => result.output,
			open_browser: (_params, result) => result.opened ? `Opened ${result.url} in the integrated browser.` : `Failed to open ${result.url}.`,
			generate_image: (_params, result) => `Generated image saved to ${result.path}. Reference it as a workspace-relative path (e.g. \`<img src="${result.path}">\` or \`background: url('${result.path}')\`). Do NOT prefix it with \`file://\` — the chat resolves relative paths correctly, and a \`file://\` link gets double-prefixed by the markdown renderer.`,
		launch_subagent: (_params, result) => `Subagent [${result.status}]: ${result.result}`,
		message_subagent: (params, result) => result.delivered
			? `Message delivered to worker ${params.subagentThreadId}. It will see it as a correction on its next turn.`
			: `Message NOT delivered: ${result.error ?? 'unknown error'}`,
		report_progress: (params, result) => result.recorded
			? `Progress recorded: ${params.milestone}`
			: 'Progress not recorded — report_progress only applies to a running worker thread.',
		run_subagent: (_params, result) => result.result,
			rename_symbol: (_params, result) => result.result,
			list_code_usages: (_params, result) => result.result,
			run_tests: (_params, result) => result.result,
			open_browser_page: (_params, result) => result.result,
			read_page: (_params, result) => result.result,
			click_element: (_params, result) => result.result,
			type_in_page: (_params, result) => result.result,
			// Computer use is handled by the native tools in contrib/computerUse; these entries exist only
			// to satisfy the exhaustive maps, exactly as the browser tools above do.
			computer_read_screen: (_params, result) => result.result,
			computer_read_screen_changes: (_params, result) => result.result,
			computer_screenshot: (_params, result) => result.result,
			computer_click: (_params, result) => result.result,
			computer_type: (_params, result) => result.result,
			computer_key: (_params, result) => result.result,
			computer_scroll: (_params, result) => result.result,
			computer_cursor: (_params, result) => result.result,
			computer_wait_for_stable: (_params, result) => result.result,
			computer_list_apps: (_params, result) => result.result,
			computer_drag: (_params, result) => result.result,
			computer_hover: (_params, result) => result.result,
			computer_clipboard_read: (_params, result) => result.result,
			computer_clipboard_write: (_params, result) => result.result,
			computer_open_app: (_params, result) => result.result,
			screenshot_page: (_params, result) => result.result,
			navigate_page: (_params, result) => result.result,
			hover_element: (_params, result) => result.result,
			drag_element: (_params, result) => result.result,
			handle_dialog: (_params, result) => result.result,
			run_playwright_code: (_params, result) => result.result,
			extract_page_data: (_params, result) => result.result,
			get_browser_console_logs: (_params, result) => result.result,
			reconstruct_page_sources: (_params, result) => result.result,
			get_computed_styles: (_params, result) => result.result,
			watch_page: (_params, result) => result.result,
			save_browser_session: (_params, result) => result.result,
			restore_browser_session: (_params, result) => result.result,
			fill_form: (_params, result) => result.result,
			intercept_network: (_params, result) => result.result,
			get_browser_network_log: (_params, result) => result.result,
			run_sandbox: (_params, result) => {
				const parts: string[] = []
				if (result.logs.length > 0) parts.push(`Output:\n${result.logs.join('\n')}`)
				if (result.result !== undefined) parts.push(`Return value: ${result.result}`)
				if (result.error) parts.push(`Error: ${result.error}`)
				if (parts.length === 0) parts.push('(no output, no return value, no error)')
				const tsNote = result.tsStripped ? '' : ' (note: TypeScript stripping unavailable in this runtime — ran as raw JS)'
				return `${parts.join('\n')}\n[ran in ${result.durationMs}ms${tsNote}]`
			},
			update_plan: (_params, result) => {
				const total = result.todos.length
				const done = result.todos.filter(t => t.status === 'completed').length
				const inProg = result.todos.filter(t => t.status === 'in_progress').length
				// `merge` defaults to FALSE, so a model that sends only the item it just finished
				// silently destroys the rest of the list — and the old counts, computed from the
				// NEW list, read as "1/1 completed" with no sign that six todos just vanished.
				// Echoing the resulting list back is what lets it notice it clobbered itself.
				const mode = _params.merge ? 'merged into the existing list' : 'REPLACED the whole list'
				const body = result.todos.map(t => `  [${t.status}] ${t.id}: ${t.content}`).join('\n')
				return `Plan updated (${mode}) — ${done}/${total} completed${inProg ? `, ${inProg} in progress` : ''}\n${body}`
			},
		}



	}


	/**
	 * What edit_file / rewrite_file / append_file say about diagnostics after a write.
	 *
	 * This used to print " No lint errors found." whenever the error list was empty — including
	 * when the language server reported NOTHING AT ALL, which is what happens for a brand-new
	 * file, an unopened file, or a file type with no server. A live probe writing a new .txt was
	 * told "No lint errors found", which reads as a clean bill of health on a file nothing ever
	 * checked. The `noDiagnosticsReported` flag was already computed but only surfaced when the
	 * shadowVerify setting happened to be on.
	 */
	private _lintSummaryAfterEdit(result: { lintErrors?: LintErrorItem[] | null; noDiagnosticsReported?: boolean }): string {
		if (!this.voidSettingsService.state.globalSettings.includeToolLintErrors) { return '' }
		if (result.lintErrors) {
			return ` Lint errors found after change:\n${this._stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
		}
		if (result.noDiagnosticsReported) {
			return ` No diagnostics were reported for this file — the language server has not analyzed it, or does not cover this file type. That is absence of DATA, not confirmation the change is correct.`
		}
		return ` No lint errors found.`
	}

	private _stringifyLintErrors(lintErrors: LintErrorItem[]): string {
		const full = lintErrors
			.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
			.join('\n\n');
		// This used to truncate mid-error with no marker, so the model read a half-written
		// message as the whole story and "fixed" a diagnostic it had only seen part of.
		if (full.length <= MAX_FILE_CHARS_PAGE) { return full }
		return `${full.substring(0, MAX_FILE_CHARS_PAGE)}\n\n...TRUNCATED — ${lintErrors.length} error(s) total, the list was cut off mid-message. Fix what is shown, then re-run read_lint_errors for the rest.`;
	}
}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
