/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { chat_userMessageContent, isABuiltinToolName, subagentExcludedToolNames } from '../common/prompt/prompts.js';
import { assessWorkerOutcome, emptySubagentActivity, emptySubagentEvidence, formatContractsBlock, formatReconcilePrompt, isTerminalSubagentStatus as isTerminalStatus, QueueEntry, recomputeQueuePositions, recordSubagentToolCall, selectDrainableSubagents, shouldReconcileBatch, subagentAdmission, SubagentActivity as SubagentActivityT, SubagentEvidence as SubagentEvidenceT, SubagentStatus as SubagentStatusT } from '../common/subagentLifecycle.js';
import { describeCarriedContinuity } from '../common/memory/sessionAnchors.js';
import { AnthropicReasoning, getErrorMessage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions } from '../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, canSubagentDelegate, isSubagentToolAllowed, SubagentProfile, TeamContract, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { IToolsService, SubagentCompletion, SubagentLaunch } from './toolsService.js';
import { IV3NativeNoticeService } from './v3NativeNoticeService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CheckpointEntry, CodespanLocationLink, ImageAttachment, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { shouldPersistAssistantTurn } from '../common/chatMessageContent.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { VoidFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { describeImagesInChatMessages, describeSingleImageAttachment, modelSupportsVision } from './v3codeVisionDescribe.js';
import { IMemoryService, RecordInput } from './memoryService.js';
import { IMemoryCaptureService } from './memoryCaptureService.js';
import { AgentRole } from '../common/memory/memoryTypes.js';
import { ChatMode } from '../common/voidSettingsTypes.js';


// related to retrying when LLM message has error
const CHAT_RETRIES = 3
const RETRY_DELAY = 2500


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) return null

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i]

		if (s.uri.fsPath !== newSelection.uri.fsPath) continue

		if (s.type === 'File' && newSelection.type === 'File') {
			return i
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) continue
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range
			const [newStart, newEnd] = newSelection.range
			if (oldStart !== newStart || oldEnd !== newEnd) continue
			return i
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i
		}
	}
	return null
}


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/


type UserMessageType = ChatMessage & { role: 'user' }
type UserMessageState = UserMessageType['state']
const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
}

// a 'thread' means a chat message history

type WhenMounted = {
	textAreaRef: { current: HTMLTextAreaElement | null }; // the textarea that this thread has, gets set in SidebarChat
	scrollToBottom: () => void;
}



export type ThreadType = {
	id: string; // store the id here too
	createdAt: string; // ISO string
	lastModified: string; // ISO string
	isPinned?: boolean;
	isArchived?: boolean;
	// Background-subagent threads are real persisted threads (openable from the Agents
	// panel) but are hidden from the ordinary session list and tabs.
	isSubagent?: boolean;

	messages: ChatMessage[];
	filesWithUserChanges: Set<string>;

	// this doesn't need to go in a state object, but feels right
	state: {
		currCheckpointIdx: number | null; // the latest checkpoint we're at (null if not at a particular checkpoint, like if the chat is streaming, or chat just finished and we haven't clicked on a checkpt)

		stagingSelections: StagingSelectionItem[];
		focusedMessageIdx: number | undefined; // index of the user message that is being edited (undefined if none)

		linksOfMessageIdx: { // eg. link = linksOfMessageIdx[4]['RangeFunction']
			[messageIdx: number]: {
				[codespanName: string]: CodespanLocationLink
			}
		}


		mountedInfo?: {
			whenMounted: Promise<WhenMounted>
			_whenMountedResolver: (res: WhenMounted) => void
			mountedIsResolvedRef: { current: boolean };
		}


	};
}

type ChatThreads = {
	[id: string]: undefined | ThreadType;
}


export type ThreadsState = {
	allThreads: ChatThreads;
	currentThreadId: string; // intended for internal use only
}

export type IsRunningType =
	| 'LLM' // the LLM is currently streaming
	| 'tool' // whether a tool is currently running
	| 'awaiting_user' // awaiting user call
	| 'idle' // nothing is running now, but the chat should still appear like it's going (used in-between calls)
	| undefined

export type ThreadStreamState = {
	[threadId: string]: undefined | {
		isRunning: undefined;
		error?: { message: string, fullError: Error | null, };
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | { // an assistant message is being written
		isRunning: 'LLM';
		error?: undefined;
		llmInfo: {
			displayContentSoFar: string;
			reasoningSoFar: string;
			toolCallSoFar: RawToolCallObj | null;
		};
		toolInfo?: undefined;
		interrupt: Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	} | { // a tool is being run
		isRunning: 'tool';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo: {
			toolName: ToolName;
			toolParams: ToolCallParams<ToolName>;
			id: string;
			content: string;
			rawParams: RawToolParamsObj;
			mcpServerName: string | undefined;
		};
		interrupt: Promise<() => void>;
	} | {
		isRunning: 'awaiting_user';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt?: undefined;
	} | {
		isRunning: 'idle';
		error?: undefined;
		llmInfo?: undefined;
		toolInfo?: undefined;
		interrupt: 'not_needed' | Promise<() => void>; // calling this should have no effect on state - would be too confusing. it just cancels the tool
	}
}

// The subagent lifecycle vocabulary lives in common/subagentLifecycle.ts — ONE definition
// shared by this service, the Agents UI, and the tests. Re-exported (not redeclared) so
// existing importers of these names from chatThreadService keep working.
export type { SubagentStatus, SubagentEvidence, SubagentActivity } from '../common/subagentLifecycle.js'
export { isTerminalSubagentStatus } from '../common/subagentLifecycle.js'

// Subagent tracking — a background agent running on a separate thread
export type SubagentInfo = {
	subagentThreadId: string;
	parentThreadId: string;
	parentToolId: string;
	description: string;
	/** Capability profile the runtime enforces for this child. */
	profile: SubagentProfile;
	/** Nesting depth: 1 for a child of a root thread, 2 for a child of a child. */
	depth: number;
	status: SubagentStatusT;
	/** When the subagent was created (ISO timestamp). */
	createdAt: string;
	/** When the subagent started running (ISO timestamp). Undefined while queued. */
	startedAt?: string;
	/** When the subagent finished (ISO timestamp). Undefined while running. */
	finishedAt?: string;
	/** Queue position when status is 'queued'. */
	queuePosition?: number;
	/**
	 * Evidence accumulated from THIS worker's own tool calls. Always present (empty at
	 * launch) so the UI never has to branch on undefined.
	 */
	evidence: SubagentEvidenceT;
	/** Live activity snapshot — last tool, current file, milestones, recent tool log. */
	activity: SubagentActivityT;
	result?: string;
	error?: string;
}

export type SubagentState = {
	[subagentThreadId: string]: SubagentInfo;
}

const newThreadObject = () => {
	const now = new Date().toISOString()
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType
}






export interface IChatThreadService {
	readonly _serviceBrand: undefined;

	readonly state: ThreadsState;
	readonly streamState: ThreadStreamState; // not persistent
	readonly subagentState: SubagentState;

	onDidChangeCurrentThread: Event<void>;
	onDidChangeStreamState: Event<{ threadId: string }>

	getCurrentThread(): ThreadType;
	openNewThread(): void;
	switchToThread(threadId: string): void;

	// thread selector
	deleteThread(threadId: string): void;
	duplicateThread(threadId: string): void;
	pinThread(threadId: string): void;
	unpinThread(threadId: string): void;
	archiveThread(threadId: string): void;
	unarchiveThread(threadId: string): void;

	// exposed getters/setters
	// these all apply to current thread
	getCurrentMessageState: (messageIdx: number) => UserMessageState
	setCurrentMessageState: (messageIdx: number, newState: Partial<UserMessageState>) => void
	getCurrentThreadState: () => ThreadType['state']
	setCurrentThreadState: (newState: Partial<ThreadType['state']>) => void

	// you can edit multiple messages - the one you're currently editing is "focused", and we add items to that one when you press cmd+L.
	getCurrentFocusedMessageIdx(): number | undefined;
	isCurrentlyFocusingMessage(): boolean;
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined): void;

	popStagingSelections(numPops?: number): void;
	addNewStagingSelection(newSelection: StagingSelectionItem): void;

	dangerousSetState: (newState: ThreadsState) => void;
	resetState: () => void;

	// // current thread's staging selections
	// closeCurrentStagingSelectionsInMessage(opts: { messageIdx: number }): void;
	// closeCurrentStagingSelectionsInThread(): void;

	// codespan links (link to symbols in the markdown)
	getCodespanLink(opts: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined;
	addCodespanLink(opts: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }): void;
	generateCodespanLink(opts: { codespanStr: string, threadId: string }): Promise<CodespanLocationLink>;
	getRelativeStr(uri: URI): string | undefined

	// entry pts
	abortRunning(threadId: string): Promise<void>;
	dismissStreamError(threadId: string): void;

	// call to edit a message
	editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId }: { userMessage: string, messageIdx: number, threadId: string }): Promise<void>;

	// call to add a message
	addUserMessageAndStreamResponse({ userMessage, threadId, images }: { userMessage: string, threadId: string, images?: ImageAttachment[] }): Promise<void>;

	/** Run vision describe on one pending attachment (manual mode). Returns updated attachment. */
	describeImageAttachment(img: ImageAttachment): Promise<ImageAttachment>;

	/** True when active chat model is text-only and images need describe step. */
	activeChatModelNeedsImageDescribe(): boolean;

	// approve/reject
	approveLatestToolRequest(threadId: string): void;
	rejectLatestToolRequest(threadId: string): void;
	/** Resolve a pending ask_user tool_request with the option the user clicked; the choice becomes the tool result and the agent loop resumes. */
	answerAskUserRequest(threadId: string, choice: string): void;

	// jump to history
	jumpToCheckpointBeforeMessageIdx(opts: { threadId: string, messageIdx: number, jumpToUserModified: boolean }): void;

	focusCurrentChat: () => Promise<void>
	blurCurrentChat: () => Promise<void>

	// subagent
	launchSubagent(opts: { parentThreadId: string, parentToolId: string, description: string, prompt: string, profile: SubagentProfile }): SubagentLaunch;
	cancelSubagent(subagentThreadId: string): Promise<void>;
	getSubagentsForThread(threadId: string): SubagentInfo[];
	onDidChangeSubagentState: Event<{ subagentThreadId: string }>;
	/** Send a bounded correction/nudge from the owning parent thread to a running worker. */
	messageSubagent(parentThreadId: string, subagentThreadId: string, message: string): { ok: true } | { ok: false, error: string };
	/** Report a milestone/progress update from a worker back to its parent. */
	reportSubagentProgress(subagentThreadId: string, milestone: string): void;
	/** Terminate a worker stuck awaiting an approval the user never answered: blocked, with a reason. */
	blockWaitingSubagent(subagentThreadId: string, reason: string): void;
}

export const IChatThreadService = createDecorator<IChatThreadService>('voidChatThreadService');
class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	private readonly _onDidChangeSubagentState = new Emitter<{ subagentThreadId: string }>();
	readonly onDidChangeSubagentState: Event<{ subagentThreadId: string }> = this._onDidChangeSubagentState.event;

	readonly streamState: ThreadStreamState = {}
	readonly subagentState: SubagentState = {}
	state: ThreadsState // allThreads is persisted, currentThread is not

	/** User sent a follow-up while the agent is still running — finish current step, then continue with new context. */
	private readonly _steerMessageCount = new Map<string, number>()

	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)



	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IMemoryService private readonly _memoryService: IMemoryService,
		@IMemoryCaptureService private readonly _memoryCaptureService: IMemoryCaptureService,
		@IV3NativeNoticeService private readonly _nativeNoticeService: IV3NativeNoticeService,
	) {
		super()
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // default state

		const readThreads = this._readAllThreads() || {}

		const allThreads = readThreads
		this.state = {
			allThreads: allThreads,
			currentThreadId: null as unknown as string, // gets set in startNewThread()
		}

		// always be in a thread
		this.openNewThread()

		// Wire subagent launcher into ToolsService (avoids circular DI)
		this._toolsService.setSubagentLauncher((opts) => this.launchSubagent(opts))
		this._toolsService.setSubagentCanceller((subagentThreadId) => this.cancelSubagent(subagentThreadId))
		this._toolsService.setSubagentInfoGetter((threadId) => {
			const info = this.subagentState[threadId]
			return info ? { status: info.status, queuePosition: info.queuePosition } : undefined
		})
		// Back the message_subagent / report_progress TOOLS with the real implementations, so
		// steering and progress are callable capabilities rather than prompt-only claims.
		this._toolsService.setSubagentMessenger((parentThreadId, subagentThreadId, message) =>
			this.messageSubagent(parentThreadId, subagentThreadId, message))
		this._toolsService.setSubagentProgressReporter((subagentThreadId, milestone) =>
			this.reportSubagentProgress(subagentThreadId, milestone))

		// A window reload kills any running subagent after its automatic team-board check-in
		// and before its checkout — sweep those orphaned claims at startup (best-effort).
		void this._toolsService.sweepSubagentTeamEntries().catch(() => { })

		// Wire notification injector — allows background processes to inject system_notification messages
		this._toolsService.setNotificationInjector((threadId, content, source) => {
			this._injectSystemNotification(threadId, content, source)
		})

		// A workspace swap that reloaded the window completes its memory transition at the
		// NEXT startup; tell the thread what carried and what stayed behind, so a partial
		// carry is announced rather than discovered.
		this._register(this._memoryService.onDidCompleteSessionTransition(({ threadId, summary }) => {
			if (!this.state.allThreads[threadId]) return
			this._injectSystemNotification(threadId, `[Workspace swap completed → ${summary.currentRoot || summary.currentWorkspaceId}] ${describeCarriedContinuity(summary)}`, 'system')
		}))

		// keep track of user-modified files
		// const disposablesOfModelId: { [modelId: string]: IDisposable[] } = {}
		// this._register(
		// 	this._modelService.onModelAdded(e => {
		// 		if (!(e.id in disposablesOfModelId)) disposablesOfModelId[e.id] = []
		// 		disposablesOfModelId[e.id].push(
		// 			e.onDidChangeContent(() => { this._userModifiedFilesToCheckInCheckpoints.set(e.uri.fsPath, null) })
		// 		)
		// 	})
		// )
		// this._register(this._modelService.onModelRemoved(e => {
		// 	if (!(e.id in disposablesOfModelId)) return
		// 	disposablesOfModelId[e.id].forEach(d => d.dispose())
		// }))

	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus()
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const s = await thread.state.mountedInfo?.whenMounted
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur()
		}
	}



	dangerousSetState = (newState: ThreadsState) => {
		this.state = newState
		this._onDidChangeCurrentThread.fire()
	}
	resetState = () => {
		this.state = { allThreads: {}, currentThreadId: null as unknown as string } // see constructor
		this.openNewThread()
		this._onDidChangeCurrentThread.fire()
	}

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.from(value); // TODO URI.revive instead of this?
			}
			return value;
		});
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null
		}
		const threads = this._convertThreadDataFromStorage(threadsStr);

		return threads
	}

	private _storeAllThreads(threads: ChatThreads) {
		const serializedThreads = JSON.stringify(threads);
		this._storageService.store(
			THREAD_STORAGE_KEY,
			serializedThreads,
			StorageScope.APPLICATION,
			StorageTarget.USER
		);
	}


	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		const newState = {
			...this.state,
			...state
		}

		this.state = newState

		this._onDidChangeCurrentThread.fire()


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages
			const lastMessage = messages && messages[messages.length - 1]
			// if awaiting user but stream state doesn't indicate it (happens if restart Void)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request')
				this._setStreamState(threadId, { isRunning: 'awaiting_user', })

			// if running now but stream state doesn't indicate it (happens if restart Void), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName })
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) return

		let whenMountedResolver: (w: WhenMounted) => void
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res)

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w)
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo
					if (mountInfo) mountInfo.mountedIsResolvedRef.current = true
				},
			}
		}, true) // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		this.streamState[threadId] = state
		this._onDidChangeStreamState.fire({ threadId })
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat'
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined
		return { modelSelection, modelSelectionOptions }
	}



	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages
		if (!messages) return false
		const lastMsg = messages[messages.length - 1]
		if (!lastMsg) return false

		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			this._editMessageInThread(threadId, messages.length - 1, tool)
			return true
		}
		return false
	}
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool)
		if (swapped) return
		this._addMessageToThread(threadId, tool)
	}

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) return // should never happen
		// ask_user's option buttons ARE its approval UI — generic approve must not run it.
		if (lastMsg.name === 'ask_user') return

		// Transition subagent back from waiting-approval to running.
		const sub = this.subagentState[threadId]
		if (sub && sub.status === 'waiting-approval') {
			this._setSubagentState(threadId, { ...sub, status: 'running' })
		}

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps() })
			, threadId
		)
	}

	answerAskUserRequest(threadId: string, choice: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastMsg = thread.messages[thread.messages.length - 1]
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request' && lastMsg.name === 'ask_user')) return

		const { params, id, rawParams, mcpServerName } = lastMsg
		// The clicked option IS the tool result — nothing executes. Record success, then
		// resume the agent loop exactly like approve does, minus callThisToolFirst.
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', name: 'ask_user', params: params as ToolCallParams<'ask_user'>, content: choice, result: { choice }, id, rawParams, mcpServerName })
		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps() })
			, threadId
		)
	}
	rejectLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1]

		let params: ToolCallParams<ToolName>
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params
		}
		else return

		const { name, id, rawParams, mcpServerName } = lastMsg

		const errorMessage = this.toolErrMsgs.rejected
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName })
		this._setStreamState(threadId, undefined)

		// A subagent thread has no user typing the next message. A REJECTED approval is a
		// denial, not a green light: the worker is stamped 'blocked' with the reason and is
		// NEVER silently returned to 'running'. It is finalized here rather than resumed,
		// so the parent is told plainly that the work was denied instead of receiving a
		// half-finished transcript labelled 'completed'.
		const sub = this.subagentState[threadId]
		if (sub && (sub.status === 'running' || sub.status === 'waiting-approval')) {
			const reason = `Approval denied for tool "${name}". The worker could not complete the requested action.`
			this._finalizeSubagent(threadId, 'blocked', reason, { ...sub.evidence, blockedReason: reason })
		}
	}

	/**
	 * A worker paused on approval that the user never answers (window closed, notification
	 * dismissed) must not sit in 'waiting-approval' forever. Public so a UI dismiss action
	 * and the approval-timeout path resolve to the SAME terminal state: blocked, with a
	 * reason — never a silent return to running.
	 */
	blockWaitingSubagent(subagentThreadId: string, reason: string): void {
		const sub = this.subagentState[subagentThreadId]
		if (!sub || sub.status !== 'waiting-approval') return
		this._finalizeSubagent(subagentThreadId, 'blocked', reason, { ...sub.evidence, blockedReason: reason })
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName
	}

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		// Stopping a RUNNING subagent thread must stamp 'cancelled' BEFORE anything else:
		// the awaiting_user branch below rejects the pending tool, and the reject-resume
		// guard re-launches a child's loop whenever its status still reads 'running' — a
		// zombie loop making model calls on a thread being stopped. (cancelSubagent stamps
		// before calling here, so this fires only for a direct stop of the child thread.)
		const stoppedSubagent = this.subagentState[threadId]
		if (stoppedSubagent && (stoppedSubagent.status === 'running' || stoppedSubagent.status === 'waiting-approval')) {
			this._setSubagentState(threadId, { ...stoppedSubagent, status: 'cancelled' })
		}

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
			if (shouldPersistAssistantTurn(displayContentSoFar, reasoningSoFar)) {
				this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
			}
			if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo
			const content = content_ || this.toolErrMsgs.interrupted
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName })
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId)
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		this._addUserCheckpoint({ threadId })

		// interrupt any effects
		const interrupt = await this.streamState[threadId]?.interrupt
		if (typeof interrupt === 'function')
			interrupt()


		this._setStreamState(threadId, undefined)

		// Stopping a thread stops its whole delegation tree: orphaned background children
		// editing the shared workspace after their parent was told to stop is never what
		// the user meant. cancelSubagent recurses through each child's own abortRunning.
		for (const child of this.getSubagentsForThread(threadId)) {
			if (child.status === 'running') void this.cancelSubagent(child.subagentThreadId)
		}

		// Stopping a subagent thread is a cancellation, not a completion — finalize it as
		// such so the parent isn't handed a half-finished transcript as a result. The
		// terminal status was stamped at the top of this method (or by cancelSubagent);
		// _finalizeSubagent resolves the completion exactly once either way.
		if (this.subagentState[threadId]?.status === 'cancelled') {
			this._finalizeSubagent(threadId, 'cancelled', '(stopped by the user before completion)')
		}
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: any) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	}


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	// returns true when the tool call is waiting for user approval
	private _memoryTitle(text: string): string {
		const t = text.trim().replace(/\s+/g, ' ');
		return t.length <= 80 ? t : t.slice(0, 77) + '...';
	}

	private _memoryRole(chatMode: ChatMode): AgentRole {
		if (chatMode === 'plan') return 'scout';
		if (chatMode === 'read') return 'scout';
		return 'lead';
	}

	private _recordMemory(input: RecordInput): void {
		if (!this._memoryService.isAvailable) return;
		void this._memoryService.record(input).catch(() => { /* best-effort */ });
	}

	private _runToolCall = async (
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		opts: { preapproved: true, unvalidatedToolParams: RawToolParamsObj, validatedParams: ToolCallParams<ToolName> } | { preapproved: false, unvalidatedToolParams: RawToolParamsObj },
	): Promise<{ awaitingUserApproval?: boolean, interrupted?: boolean }> => {

		// compute these below
		let toolParams: ToolCallParams<ToolName>
		let toolResult: ToolResult<ToolName>
		let toolResultStr: string

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName)
		// Defense-in-depth: the child's advertised toolset is already filtered to its
		// capability profile, but a model can still hallucinate a denied call.
		const subagentInfo = this.subagentState[threadId]
		if (subagentInfo && !isSubagentToolAllowed(subagentInfo.profile, toolName, isBuiltInTool, { canDelegate: subagentInfo.profile === 'work' && canSubagentDelegate(subagentInfo.depth) })) {
			const errorMessage = subagentInfo.profile === 'research'
				? `Research subagents are read-only. Tool ${toolName} is not available in this subagent thread.`
				: `Tool ${toolName} is not available in a subagent thread (reserved for the parent conversation).`
			const params = (opts.preapproved ? opts.validatedParams : opts.unvalidatedToolParams) as ToolCallParams<ToolName>
			this._addMessageToThread(threadId, { role: 'tool', type: 'tool_error', params, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}


		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					const params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams)
					toolParams = params
				}
				else {
					toolParams = opts.unvalidatedToolParams
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error)
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName })
				return {}
			}
			// once validated, add checkpoint for edit
			if (toolName === 'edit_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['edit_file']).uri }) }
			if (toolName === 'rewrite_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['rewrite_file']).uri }) }

			// 2a. ask_user pauses for an ANSWER, not permission: the option buttons in the
			// sidebar are its approval UI, and the clicked option becomes the tool result
			// (answerAskUserRequest). The tool itself never executes.
			if (toolName === 'ask_user') {
				if (this._settingsService.state.globalSettings.enableAskUserTool === false) {
					// Belt-and-braces: the tool is stripped from the advertised surface when
					// disabled, but a model may still hallucinate the call.
					const disabledMsg = 'The ask_user tool is disabled in this editor\'s settings. Decide yourself, or ask the user in plain text at the end of your reply.'
					this._addMessageToThread(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: disabledMsg, name: toolName, content: disabledMsg, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
					return {}
				}
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Waiting for your answer...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				return { awaitingUserApproval: true }
			}

			// 2. if tool requires approval, break from the loop, awaiting approval

			const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools'
			if (approvalType) {
				const autoApprove = this._settingsService.state.globalSettings.autoApprove[approvalType]
				// add a tool_request because we use it for UI if a tool is loading (this should be improved in the future)
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				if (!autoApprove) {
					return { awaitingUserApproval: true }
				}
			}
		}
		else {
			toolParams = opts.validatedParams
		}






		// ask_user must pause for a button click on every path (including preapproved) — callTool must not run.
		if (toolName === 'ask_user') {
			if (this._settingsService.state.globalSettings.enableAskUserTool === false) {
				const disabledMsg = 'The ask_user tool is disabled in this editor\'s settings. Decide yourself, or ask the user in plain text at the end of your reply.'
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: disabledMsg, name: toolName, content: disabledMsg, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
				return {}
			}
			this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Waiting for your answer...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return { awaitingUserApproval: true }
		}

		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const
		this._updateLatestTool(threadId, runningTool)

		const { chatMode } = this._settingsService.state.globalSettings;
		this._recordMemory({
			sessionId: threadId,
			kind: 'tool_call',
			role: this._memoryRole(chatMode),
			title: this._memoryTitle(toolName),
			body: JSON.stringify(opts.unvalidatedToolParams ?? {}),
			meta: { tool: toolName, toolCallId: toolId },
		});


		let interrupted = false
		let resolveInterruptor: (r: () => void) => void = () => { }
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res })
		try {

			// set stream state
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName } })

			if (isBuiltInTool) {
				const { result, interruptTool } = await this._toolsService.callTool[toolName](toolParams as any, { threadId, toolId })
				const interruptor = () => { interrupted = true; interruptTool?.() }
				resolveInterruptor(interruptor)

				toolResult = await result
			}
			else {
				const mcpTools = this._mcpService.getMCPTools()
				const mcpTool = mcpTools?.find(t => t.name === toolName)
				if (!mcpTool) { throw new Error(`MCP tool ${toolName} not found`) }

				resolveInterruptor(() => { })

				toolResult = (await this._mcpService.callMCPTool({
					serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
					toolName: toolName,
					params: toolParams
				})).result
			}

			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }) // resolve for the sake of it
			if (interrupted) { return { interrupted: true } } // the tool result is added where we interrupt, not here

			const errorMessage = getErrorMessage(error)
			// Errored calls update ACTIVITY (what the worker was doing) but never count as
			// evidence — a failed edit_file must not appear in filesTouched.
			this._recordSubagentToolCall(threadId, { tool: toolName, file: this._fileOfToolParams(toolName, toolParams), succeeded: false })
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = this._toolsService.stringOfResult[toolName](toolParams as any, toolResult as any)
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall)
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error)
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
			return {}
		}

		// 5. add to history and keep going
		// Evidence attribution: this call SUCCEEDED, so it counts. Only mutation tools
		// contribute filesTouched; only terminal tools contribute commandsRun.
		this._recordSubagentToolCall(threadId, {
			tool: toolName,
			file: this._fileOfToolParams(toolName, toolParams),
			command: (toolParams as { command?: string })?.command,
			commandStatus: this._commandOutcomeOfToolResult(toolName, toolResult),
			succeeded: true,
		})
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: toolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName })
		this._recordMemory({
			sessionId: threadId,
			kind: 'tool_result',
			role: this._memoryRole(this._settingsService.state.globalSettings.chatMode),
			title: this._memoryTitle(`${toolName} result`),
			body: toolResultStr,
			meta: { tool: toolName, toolCallId: toolId },
		});
		return {};
	};




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
	}: {
		threadId: string,
		modelSelection: ModelSelection | null,
		modelSelectionOptions: ModelSelectionOptions | undefined,

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' }
	}) {


		let interruptedWhenIdle = false
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true })
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		// Subagent threads derive their mode from their capability profile, NOT the global
		// setting — deriving here (rather than at the launch site) means approve/reject
		// re-entries can never accidentally revert a child to the parent's global mode.
		// Work children run in agent mode; research children run in read mode (no MCP).
		// The exclusion list keeps the child's ADVERTISED toolset identical to what the
		// runtime gate in _runToolCall enforces.
		const subagentInfo = this.subagentState[threadId]
		const chatMode = subagentInfo
			? (subagentInfo.profile === 'work' ? 'agent' : 'read')
			: this._settingsService.state.globalSettings.chatMode // should not change as we loop even if user changes it, so it goes here
		const subagentExclusions = subagentInfo
			? subagentExcludedToolNames(subagentInfo.profile, this._mcpService.getMCPTools(), { canDelegate: subagentInfo.profile === 'work' && canSubagentDelegate(subagentInfo.depth) })
			: undefined
		const { overridesOfModel } = this._settingsService.state

		// Early guard: without a configured model provider, the LLM send loop silently retries 3x and
		// commits an empty assistant message ("fake line"). Surface a clear error in the chat instead.
		if (modelSelection === null) {
			this._setStreamState(threadId, {
				isRunning: undefined,
				error: {
					message: `No model provider is configured for Chat. Open V3Code Settings (gear icon) and add an API key for a Chat provider (e.g. OpenAI, Anthropic, DeepSeek), then try again.`,
					fullError: null,
				},
			})
			this._addUserCheckpoint({ threadId })
			return
		}

		let nMessagesSent = 0
		let shouldSendAnotherMessage = true
		let isRunningWhenEnd: IsRunningType = undefined

		// before enter loop, call tool
		if (callThisToolFirst) {
			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params })
			if (interrupted) {
				this._setStreamState(threadId, undefined)
				this._addUserCheckpoint({ threadId })

			}
		}
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' })  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			// false by default each iteration
			shouldSendAnotherMessage = false
			isRunningWhenEnd = undefined
			nMessagesSent += 1

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })

			this._clearUserMessageQueuedFlags(threadId)

			const chatMessages = this.state.allThreads[threadId]?.messages ?? []
			// Non-vision models: describe images via a configured vision model (sidebar chat path).
			const describeResult = await describeImagesInChatMessages(
				chatMessages,
				modelSelection,
				this._settingsService,
				this._llmMessageService,
				this._convertToLLMMessagesService,
				CancellationToken.None,
			)
			if (describeResult === 'cancelled') {
				this._setStreamState(threadId, undefined)
				return
			}
			const { messages, separateSystemMessage, coreToolsOnly, excludeTools } = await this._convertToLLMMessagesService.prepareLLMChatMessages({
				chatMessages,
				modelSelection,
				chatMode,
				sessionId: threadId,
				excludeTools: subagentExclusions,
			})

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined)
				return
			}

			let shouldRetryLLM = true
			let nAttempts = 0
			while (shouldRetryLLM) {
				shouldRetryLLM = false
				nAttempts += 1

				type ResTypes =
					| { type: 'llmDone', toolCall?: RawToolCallObj, info: { fullText: string, fullReasoning: string, anthropicReasoning: AnthropicReasoning[] | null } }
					| { type: 'llmError', error?: { message: string; fullError: Error | null; } }
					| { type: 'llmAborted' }

				let resMessageIsDonePromise: (res: ResTypes) => void // resolves when user approves this tool use (or if tool doesn't require approval)
				const messageIsDonePromise = new Promise<ResTypes>((res, rej) => { resMessageIsDonePromise = res })

				const llmCancelToken = this._llmMessageService.sendLLMMessage({
					messagesType: 'chatMessages',
					chatMode,
					coreToolsOnly,
					excludeTools,
					messages: messages,
					modelSelection,
					modelSelectionOptions,
					overridesOfModel,
					logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
					separateSystemMessage: separateSystemMessage,
					onText: ({ fullText, fullReasoning, toolCall }) => {
						this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCall ?? null }, interrupt: Promise.resolve(() => { if (llmCancelToken) this._llmMessageService.abort(llmCancelToken) }) })
					},
					onFinalMessage: async ({ fullText, fullReasoning, toolCall, anthropicReasoning, }) => {
						resMessageIsDonePromise({ type: 'llmDone', toolCall, info: { fullText, fullReasoning, anthropicReasoning } }) // resolve with tool calls
					},
					onError: async (error) => {
						resMessageIsDonePromise({ type: 'llmError', error: error })
					},
					onAbort: () => {
						// stop the loop to free up the promise, but don't modify state (already handled by whatever stopped it)
						resMessageIsDonePromise({ type: 'llmAborted' })
						this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode })
					},
				})

				// mark as streaming
				if (!llmCancelToken) {
					this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } })
					break
				}

				this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(() => this._llmMessageService.abort(llmCancelToken)) })
				const llmRes = await messageIsDonePromise // wait for message to complete

				// llm res aborted (check before isRunning guard — steer clears stream state early)
				if (llmRes.type === 'llmAborted') {
					if (this._consumeSteerIfAny(threadId)) {
						shouldSendAnotherMessage = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						break
					}
					this._setStreamState(threadId, undefined)
					return
				}

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					return
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					// Terminal errors (quota exhausted, sign-in/upgrade required, dead session) can
					// only fail identically on retry — and on the hosted lane each retry is another
					// billable request. Surface them immediately instead of the 3× blanket retry.
					const isTerminalError = !!(llmRes.error as { terminal?: boolean } | undefined)?.terminal
					// error, should retry
					if (nAttempts < CHAT_RETRIES && !isTerminalError) {
						shouldRetryLLM = true
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor })
						await timeout(RETRY_DELAY)
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined)
							return
						}
						else
							continue // retry
					}
					// error, but too many attempts
					else {
						const { error } = llmRes
						const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo
						// Only commit an assistant message when we actually have something to show.
						// Otherwise we add an empty bubble ("fake line") on top of the streamState.error toast.
						if (shouldPersistAssistantTurn(displayContentSoFar, reasoningSoFar)) {
							this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null })
						}
						if (toolCallSoFar) this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) })

						this._setStreamState(threadId, { isRunning: undefined, error })
						this._addUserCheckpoint({ threadId })
						return
					}
				}

				// llm res success
				const { toolCall, info } = llmRes

				if (shouldPersistAssistantTurn(info.fullText, info.fullReasoning)) {
					this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning })
				}

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative for clarity

				// call tool if there is one
				if (toolCall) {
					const mcpTools = this._mcpService.getMCPTools()
					const mcpTool = mcpTools?.find(t => t.name === toolCall.name)

					const { awaitingUserApproval, interrupted } = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, { preapproved: false, unvalidatedToolParams: toolCall.rawParams })
					if (interrupted) {
						if (this._consumeSteerIfAny(threadId)) {
							shouldSendAnotherMessage = true
						} else {
							this._setStreamState(threadId, undefined)
							return
						}
					}
					else if (awaitingUserApproval) { isRunningWhenEnd = 'awaiting_user' }
					else { shouldSendAnotherMessage = true }

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }) // just decorative, for clarity
				}
				else if (this._consumeSteerIfAny(threadId)) {
					shouldSendAnotherMessage = true
				}
				else if (!toolCall && shouldPersistAssistantTurn(info.fullText, info.fullReasoning)) {
					this._recordMemory({
						sessionId: threadId,
						kind: 'reply',
						role: this._memoryRole(chatMode),
						title: this._memoryTitle(info.fullText),
						body: info.fullText,
					});
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd })

		// add checkpoint before the next user message
		if (!isRunningWhenEnd) this._addUserCheckpoint({ threadId })

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode })
		this._memoryCaptureService.scheduleRollup();
	}


	private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
		this._addMessageToThread(threadId, checkpoint)
		// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voidFileSnapshot = checkpointMessage.voidFileSnapshotOfURI ? checkpointMessage.voidFileSnapshotOfURI[fsPath] ?? null : null
		if (!opts.includeUserModifiedChanges) { return { voidFileSnapshot, } }

		const userModifiedVoidFileSnapshot = fsPath in checkpointMessage.userModifications.voidFileSnapshotOfURI ? checkpointMessage.userModifications.voidFileSnapshotOfURI[fsPath] ?? null : null
		return { voidFileSnapshot: userModifiedVoidFileSnapshot ?? voidFileSnapshot, }
	}

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1
		if (lastCheckpointIdx === -1) return

		const voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } = {}

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {}
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._voidModelService.getModelFromFsPath(fsPath)
			if (!model) continue
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null
			if (!checkpoint2) continue
			if (checkpoint2.role !== 'checkpoint') continue
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false })
			if (!res) continue
			const { voidFileSnapshot: oldVoidFileSnapshot } = res

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voidFileSnapshot = this._editCodeService.getVoidFileSnapshot(URI.file(fsPath))
			if (oldVoidFileSnapshot === voidFileSnapshot) continue
			voidFileSnapshotOfURI[fsPath] = voidFileSnapshot
		}

		// // add a change for all user-edited files (that aren't in the history)
		// for (const fsPath of this._userModifiedFilesToCheckInCheckpoints.keys()) {
		// 	if (fsPath in lastIdxOfURI) continue // if already visisted, don't visit again
		// 	const { model } = this._voidModelService.getModelFromFsPath(fsPath)
		// 	if (!model) continue
		// 	currStrOfFsPath[fsPath] = model.getValue(EndOfLinePreference.LF)
		// }

		return { voidFileSnapshotOfURI }
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {},
			userModifications: { voidFileSnapshotOfURI: {}, },
		})
	}
	// call this right after LLM edits a file
	private _addToolEditCheckpoint({ threadId, uri, }: { threadId: string, uri: URI }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		const { model } = this._voidModelService.getModel(uri)
		if (!model) return // should never happen
		const diffAreasSnapshot = this._editCodeService.getVoidFileSnapshot(uri)
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'tool_edit',
			voidFileSnapshotOfURI: { [uri.fsPath]: diffAreasSnapshot },
			userModifications: { voidFileSnapshotOfURI: {} },
		})
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string, messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i]
			if (message.role === 'checkpoint') {
				return [message, i]
			}
		}
		return undefined
	}

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string, loIdx: number, hiIdx: number }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return { lastIdxOfURI: {} } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {}
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i]
			if (message?.role !== 'checkpoint') continue
			for (const fsPath in message.voidFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i
			}
		}
		return { lastIdxOfURI }
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		const { currCheckpointIdx } = thread.state
		if (currCheckpointIdx === null) return

		const checkpoint = thread.messages[currCheckpointIdx]
		if (!checkpoint) return
		if (checkpoint.role !== 'checkpoint') return
		return [checkpoint, currCheckpointIdx]
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {}
		const res = this._readCurrentCheckpoint(threadId)
		if (!res) return
		const [checkpoint, checkpointIdx] = res
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {}, },
		})
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1]
			if (lastMsg?.role !== 'checkpoint')
				this._addUserCheckpoint({ threadId })
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 })
		}
	}

	jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string, messageIdx: number, jumpToUserModified: boolean }) {

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId })

		const thread = this.state.allThreads[threadId]
		if (!thread) return
		if (this.streamState[threadId]?.isRunning) return

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx })
		if (c === undefined) return // should never happen

		const fromIdx = thread.state.currCheckpointIdx
		if (fromIdx === null) return // should never happen

		const [_, toIdx] = c
		if (toIdx === fromIdx) return

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId })

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
	  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx })

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k
				}
			}

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
  x x x x x   x     x
  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
	  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx })
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k]
					if (message.role !== 'checkpoint') continue
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified })
					if (!res) continue
					const { voidFileSnapshot } = res
					if (!voidFileSnapshot) continue
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot)
					break
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx })
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId]
			if (!thread) return
			const userMsg = findLast(thread.messages, m => m.role === 'user')
			if (!userMsg) return
			if (userMsg.role !== 'user') return
			const messageContent = truncate(userMsg.displayContent, 50, '...')

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? `Error: ${error} ` : `A new Chat result is ready.`,
				source: messageContent,
				sticky: true,
				actions: {
					primary: [{
						id: 'void.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId)
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom()
							})
						}
					}]
				},
			})
		}

		// Subagent threads report through subagentState + the parent-thread notification,
		// not workbench toasts — a background child finishing is not "a new Chat result".
		const isSubagentThread = () => !!this.subagentState[threadId]

		p.then(() => {
			if (threadId !== this.state.currentThreadId && !isSubagentThread()) notify({ error: null })
		}).catch((e) => {
			// Any unexpected exception in the agent loop lands here. ALWAYS settle the stream
			// state: leaving `isRunning` set wedges the thread forever (spinner, blocked input)
			// with no message — including in the normal case where the user is looking at the
			// thread. Keep the raw error in the console; show a clean, actionable sentence.
			console.error('V3Code chat agent loop failed:', e)
			this._setStreamState(threadId, {
				isRunning: undefined,
				error: {
					message: localize('void.chat.agentLoopFailed', "Chat stopped because of an unexpected error. Your conversation is intact — send your message again to continue. Details were logged to the developer console (Help > Toggle Developer Tools)."),
					fullError: e instanceof Error ? e : null,
				},
			})
			if (threadId !== this.state.currentThreadId && !isSubagentThread()) notify({ error: getErrorMessage(e) })
		}).finally(() => {
			// Approve/reject re-entries drive a subagent thread's loop through this wrapper;
			// when such a run ends, check whether the child is now genuinely finished.
			if (isSubagentThread()) this._maybeFinalizeSubagent(threadId)
		})
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined)
	}


	private async _interruptCurrentStep(threadId: string) {
		const st = this.streamState[threadId]
		if (!st?.isRunning) return
		const interrupt = st.interrupt
		if (!interrupt || interrupt === 'not_needed') return
		try {
			const fn = typeof interrupt === 'function' ? interrupt : await interrupt
			if (typeof fn === 'function') fn()
		} catch { /* ignore */ }
	}

	private _queueSteer(threadId: string) {
		this._steerMessageCount.set(threadId, (this._steerMessageCount.get(threadId) ?? 0) + 1)
	}

	private _clearUserMessageQueuedFlags(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return
		let changed = false
		const messages = thread.messages.map(m => {
			if (m.role === 'user' && m.state.isQueued) {
				changed = true
				return { ...m, state: { ...m.state, isQueued: false } }
			}
			return m
		})
		if (!changed) return
		const newThreads = {
			...this.state.allThreads,
			[threadId]: { ...thread, messages },
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}

	private _consumeSteerIfAny(threadId: string): boolean {
		const n = this._steerMessageCount.get(threadId) ?? 0
		if (n <= 0) return false
		this._steerMessageCount.set(threadId, n - 1)
		return true
	}

	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, images }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string, images?: ImageAttachment[] }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		const wasRunning = !!this.streamState[threadId]?.isRunning

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			this._addUserCheckpoint({ threadId })
		}


		// add user's message to chat history
		const instructions = userMessage
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }) // user message + names of files (NOT content)
		const userHistoryElt: ChatMessage = {
			role: 'user',
			content: userMessageContent,
			displayContent: instructions,
			selections: currSelns,
			state: { ...defaultMessageState, ...(wasRunning ? { isQueued: true } : {}) },
			...(images && images.length > 0 ? { images } : {}),
		}
		this._addMessageToThread(threadId, userHistoryElt)

		this._recordMemory({
			sessionId: threadId,
			kind: 'prompt',
			role: 'user',
			title: this._memoryTitle(instructions),
			body: userMessageContent,
		});

		this._setThreadState(threadId, { currCheckpointIdx: null }) // no longer at a checkpoint because started streaming

		if (wasRunning) {
			// Steer: queue follow-up (VS Code / Continue style) — do not tear down the whole agent run
			this._queueSteer(threadId)
			await this._interruptCurrentStep(threadId)
		} else {
			this._wrapRunAgentToNotify(
				this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), }),
				threadId,
			)
		}

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom()
		})
	}


	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, images }: { userMessage: string, _chatSelections?: StagingSelectionItem[], threadId: string, images?: ImageAttachment[] }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) return

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}

		// Now call the original method to add the user message and stream the response
		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, threadId, images });

	}

	activeChatModelNeedsImageDescribe(): boolean {
		const { modelSelection } = this._currentModelSelectionProps();
		if (!modelSelection) {
			return false;
		}
		return !modelSupportsVision(
			modelSelection.providerName,
			modelSelection.modelName,
			this._settingsService.state.overridesOfModel,
		);
	}

	describeImageAttachment: IChatThreadService['describeImageAttachment'] = async (img) => {
		const { modelSelection } = this._currentModelSelectionProps();
		if (!modelSelection) {
			return { ...img, describeError: 'No chat model selected.' };
		}
		const result = await describeSingleImageAttachment(
			img,
			modelSelection,
			this._settingsService,
			this._llmMessageService,
			this._convertToLLMMessagesService,
			CancellationToken.None,
		);
		if (result.description) {
			return { ...img, description: result.description, describeError: undefined };
		}
		return { ...img, describeError: result.error ?? 'Describe failed.' };
	};

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this.state.allThreads[threadId]
		if (!thread) return // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`)
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || [] // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx)
		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		})

		// re-add the message and stream it.
		// RETURN the promise: the thread was already truncated synchronously above, so if this
		// rejects (a selected folder deleted since, for instance) an un-returned promise means the
		// caller's try/catch in SidebarChat never sees it — the user's edited message and every
		// message after it just disappear with no error and the edit box already closed. The
		// public addUserMessageAndStreamResponse awaits it for exactly this reason.
		return this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId })
	}

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return []

		const fsPathsSet = new Set<string>()
		const uris: URI[] = []
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) uris.push(uri)
			fsPathsSet.add(uri.fsPath)
			uris.push(uri)
		}

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					addURI(sel.uri)
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file']
				addURI(params.uri)
			}
		}
		return uris
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri)
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath))
			if (f) { return uri.fsPath.replace(f.uri.fsPath, '') }
			else { return undefined }
		}
		else {
			return undefined
		}
	}


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class'
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder'
			target = _codespanStr

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class'
			target = _codespanStr

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern)
			if (match && match[1]) {

				codespanType = 'function-or-class'
				target = match[1]

			}
			else { return null }
		}
		else {
			return null
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse()

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target)

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}

					return { uri, displayText }
				}
			}

			// else search codebase for `target`
			let uris: URI[] = []
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 })
				const { uris: uris_ } = await result
				uris = uris_
			} catch (e) {
				return null
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath)
					const shortenedUriStrs = shorten(prevUriStrs)
					let displayText = shortenedUriStrs[idx]
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2)
					}


					return { uri, displayText }
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._voidModelService.getModelSafe(uri)
				const { model } = modelRef
				if (!model) continue

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) continue;

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null

	}

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string, messageIdx: number, threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId]
		if (!thread) return undefined;

		const links = thread.state.linksOfMessageIdx?.[messageIdx]
		if (!links) return undefined;

		const link = links[codespanStr]

		return link
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string, newLinkLocation: CodespanLocationLink, messageIdx: number, threadId: string }) {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({

			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		})
	}


	getCurrentThread(): ThreadType {
		const state = this.state
		const thread = state.allThreads[state.currentThreadId]
		if (!thread) throw new Error(`Current thread should never be undefined`)
		return thread
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread()

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx
		if (focusedMessageIdx === undefined) return;

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx]
		if (focusedMessage.role !== 'user') return;
		if (!focusedMessage.state) return;

		return focusedMessageIdx
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined
	}

	switchToThread(threadId: string) {
		this._setState({ currentThreadId: threadId })
	}


	openNewThread() {
		// if the CURRENT thread is empty, stay on it (no-op)
		const { allThreads: currentThreads, currentThreadId } = this.state
		if (currentThreadId && currentThreads[currentThreadId]?.messages.length === 0) {
			return
		}
		// otherwise, start a new thread
		const newThread = newThreadObject()

		// update state
		const newThreads: ChatThreads = {
			...currentThreads,
			[newThread.id]: newThread
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id })
	}


	deleteThread(threadId: string): void {
		const { allThreads: currentThreads } = this.state

		// delete the thread
		const newThreads = { ...currentThreads };
		delete newThreads[threadId];

		// store the updated threads
		this._storeAllThreads(newThreads);
		this._setState({ ...this.state, allThreads: newThreads })
	}

	duplicateThread(threadId: string) {
		const { allThreads: currentThreads } = this.state
		const threadToDuplicate = currentThreads[threadId]
		if (!threadToDuplicate) return
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		}
		const newThreads = {
			...currentThreads,
			[newThread.id]: newThread,
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}

	pinThread(threadId: string): void {
		this._updateThreadMeta(threadId, { isPinned: true })
	}
	unpinThread(threadId: string): void {
		this._updateThreadMeta(threadId, { isPinned: false })
	}
	archiveThread(threadId: string): void {
		this._updateThreadMeta(threadId, { isArchived: true })
	}
	unarchiveThread(threadId: string): void {
		this._updateThreadMeta(threadId, { isArchived: false })
	}

	private _updateThreadMeta(threadId: string, update: Partial<Pick<ThreadType, 'isPinned' | 'isArchived'>>) {
		const { allThreads } = this.state
		const thread = allThreads[threadId]
		if (!thread) return
		const newThreads = { ...allThreads, [threadId]: { ...thread, ...update } }
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const { allThreads } = this.state
		const oldThread = allThreads[threadId]
		if (!oldThread) return // should never happen
		// update state and store it
		const newThreads = {
			...allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					message
				],
			}
		}
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads }) // the current thread just changed (it had a message added to it)
	}

	private _injectSystemNotification(threadId: string, content: string, source: 'subagent' | 'terminal' | 'system') {
		// A native chat parent (IChatService session, keyed by its sessionResource URI) has no
		// thread in this store. Its subagent results, team-board overlaps and reconcile prompts
		// wait at the native notice board instead of being dropped; the native agent drains
		// them mid-turn and at its next turn start.
		if (!this.state.allThreads[threadId]) {
			this._nativeNoticeService.push(threadId, content, source)
			return
		}
		this._addMessageToThread(threadId, {
			role: 'system_notification',
			content,
			source,
			timestamp: Date.now(),
		})
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		})

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection)
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			])
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection])
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx()

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = []
		let setSelections = (s: StagingSelectionItem[]) => { }

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s })
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s })
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		])

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		})

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this.state.allThreads[threadId]
		if (!thread) return

		this._setState({
			allThreads: {
				...this.state.allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo)

	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread()
		return currentThread.state
	}
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState)
	}

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return defaultMessageState
		return currMessage.state
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx]
		if (!currMessage || currMessage.role !== 'user') return
		this._setCurrentMessageState(newState, messageIdx)
	}


	// -- Subagent (background agent) support --

	getSubagentsForThread(threadId: string): SubagentInfo[] {
		return Object.values(this.subagentState).filter(s => s.parentThreadId === threadId)
	}

	private _setSubagentState(subagentThreadId: string, info: SubagentInfo) {
		this.subagentState[subagentThreadId] = info
		this._onDidChangeSubagentState.fire({ subagentThreadId })
	}

	/**
	 * Attribute ONE tool call to the worker that made it. Called from _runToolCall for every
	 * tool a subagent thread executes, so filesTouched/commandsRun/toolsRun and the live
	 * activity snapshot come from this worker's own actions — never from a repo-wide diff,
	 * which would credit sibling workers' and the user's edits to whoever finished last.
	 * No-ops on the parent thread (not a subagent) and on terminal workers.
	 */
	private _recordSubagentToolCall(threadId: string, call: { tool: string, file?: string, command?: string, commandStatus?: 'pass' | 'fail' | 'unknown', succeeded: boolean }) {
		const sub = this.subagentState[threadId]
		if (!sub || isTerminalStatus(sub.status)) return
		const next = recordSubagentToolCall(
			{ activity: sub.activity, evidence: sub.evidence },
			{ ...call, at: Date.now() },
		)
		this._setSubagentState(threadId, { ...sub, activity: next.activity, evidence: next.evidence })
	}

	/**
	 * Honest pass/fail for a terminal tool result. A nonzero exit code is a real failure; a
	 * timeout, a handoff, or a missing exit code is 'unknown' rather than an optimistic pass
	 * — reporting an unfinished command as green is exactly the false success we guard against.
	 */
	private _commandOutcomeOfToolResult(toolName: string, result: unknown): 'pass' | 'fail' | 'unknown' | undefined {
		if (toolName !== 'run_command' && toolName !== 'run_persistent_command') return undefined
		const reason = (result as { resolveReason?: { type?: string, exitCode?: number } } | undefined)?.resolveReason
		if (!reason || reason.type !== 'done') return 'unknown'
		if (typeof reason.exitCode !== 'number') return 'unknown'
		return reason.exitCode === 0 ? 'pass' : 'fail'
	}

	/**
	 * Best-effort human-readable path for the file a tool call targets. Only the tools whose
	 * params actually name a file produce a value; everything else returns undefined so we
	 * never invent a currentFile the worker did not touch.
	 */
	private _fileOfToolParams(toolName: string, params: unknown): string | undefined {
		const p = params as { uri?: URI } | undefined
		if (!p || typeof p !== 'object') return undefined
		const uri = p.uri
		if (!uri) return undefined
		try {
			// Prefer the workspace-relative path; fall back to fsPath for out-of-workspace files.
			const folders = this._workspaceContextService.getWorkspace().folders
			const full = uri.fsPath
			for (const f of folders) {
				const root = f.uri.fsPath
				if (full === root) return full
				if (full.startsWith(root.endsWith('/') ? root : root + '/')) {
					return full.slice(root.length + (root.endsWith('/') ? 0 : 1))
				}
			}
			return full
		} catch {
			return undefined
		}
	}

	/** Resolves exactly once per child, when it completes, errors, or is cancelled. */
	private readonly _subagentCompletion = new Map<string, { promise: Promise<SubagentCompletion>, resolve: (r: SubagentCompletion) => void }>()

	/** Per-parent batch accounting for the reconcile prompt: how many children of the
	 *  current fan-out reached a terminal state, and how many actually completed. */
	private readonly _subagentBatch = new Map<string, { terminal: number, completed: number }>()

	private _subagentTeamAgentId(subThreadId: string): string {
		return `sub:${subThreadId.slice(0, 8)}`
	}

	/**
	 * GLOBAL FIFO queue of workers waiting for a running slot, oldest first. Deliberately
	 * one window-wide queue rather than per-parent: a slot freed by ANY parent must be
	 * offered to the oldest globally-eligible worker, or workers under a second parent stay
	 * stuck forever when the first parent's children free the global slots.
	 */
	private readonly _subagentQueue: QueueEntry[] = []

	/** Pending launch details for queued subagents, keyed by thread ID. */
	private readonly _queuedLaunchDetails = new Map<string, {
		profile: SubagentProfile,
		description: string,
		planCoerced: boolean,
		preamble: string,
		prompt: string,
	}>()

	launchSubagent({ parentThreadId, parentToolId, description, prompt, profile: requestedProfile }: {
		parentThreadId: string,
		parentToolId: string,
		description: string,
		prompt: string,
		profile: SubagentProfile,
	}): SubagentLaunch {
		// Plan and Debug modes delegate research only — coerce rather than reject, and say so
		// in the launch result so the model is never silently downgraded.
		const parentMode = this._settingsService.state.globalSettings.chatMode
		const planCoerced = (parentMode === 'plan' || parentMode === 'debug') && requestedProfile !== 'research'
		const profile = planCoerced ? 'research' : requestedProfile

		const parentInfo = this.subagentState[parentThreadId]
		if (parentInfo && parentInfo.profile === 'research') {
			return { ok: false, error: 'Research subagents cannot delegate. Do the remaining investigation yourself and report back.' }
		}
		const depth = (parentInfo?.depth ?? 0) + 1
		const parentSubagents = this.getSubagentsForThread(parentThreadId)
		const admission = subagentAdmission({
			depth,
			runningForParent: parentSubagents.filter(s => s.status === 'running').length,
			runningTotal: Object.values(this.subagentState).filter(s => s.status === 'running').length,
			queuedForParent: parentSubagents.filter(s => s.status === 'queued').length,
			activeTotal: Object.values(this.subagentState).filter(s => s.status === 'running' || s.status === 'queued').length,
		})
		if (!admission.ok) {
			return { ok: false, error: admission.reason }
		}

		const subThread = { ...newThreadObject(), isSubagent: true }
		const subThreadId = subThread.id
		const now = new Date().toISOString()

		// Add subagent thread to allThreads (but don't switch to it). It is a real persisted
		// thread: the Agents panel links to it, and it holds the full child transcript.
		const newThreads = { ...this.state.allThreads, [subThreadId]: subThread }
		this._storeAllThreads(newThreads)
		this._setState({ allThreads: newThreads })

		let resolveCompletion!: (r: SubagentCompletion) => void
		const completionPromise = new Promise<SubagentCompletion>(res => { resolveCompletion = res })
		this._subagentCompletion.set(subThreadId, { promise: completionPromise, resolve: resolveCompletion })

		const teamAgentId = this._subagentTeamAgentId(subThreadId)
		const preamble = profile === 'work'
			? `You are a background WORK subagent: a real worker with the parent agent's enabled tools. You can read, edit files, run terminal commands and tests, and use enabled MCP tools; approval-gated actions still wait for the user's approval. You are checked into the shared team board as "${teamAgentId}" — read team_board before editing if others may be active, use team_checkin (with your id "${teamAgentId}") to update your claim if your scope shifts, and stay inside the area your task describes. Do the task below, verify your work where possible, and end with a concise report of what you did and found.

Task: ${prompt}`
			: `You are a background RESEARCH subagent performing a focused read-only investigation. The read-only boundary is enforced by the runtime, not only by these instructions: you can read, search, and use code intelligence, but not edit files, run terminal commands, or use MCP tools. Complete the task below and end with a concise, well-organized report of your findings.

Task: ${prompt}`

		if (admission.queued) {
			// Admitted but must wait for a slot. Track as queued, defer drive.
			this._setSubagentState(subThreadId, {
				subagentThreadId: subThreadId,
				parentThreadId,
				parentToolId,
				description,
				profile,
				depth,
				status: 'queued',
				createdAt: now,
				queuePosition: admission.queuePosition,
				activity: emptySubagentActivity(),
				evidence: emptySubagentEvidence(),
			})
			this._subagentQueue.push({ subagentThreadId: subThreadId, parentThreadId })
			this._queuedLaunchDetails.set(subThreadId, { profile, description, planCoerced, preamble, prompt })

			return { ok: true, subagentThreadId: subThreadId, profile, completion: completionPromise }
		}

		// Register subagent tracking — can start immediately.
		this._setSubagentState(subThreadId, {
			subagentThreadId: subThreadId,
			parentThreadId,
			parentToolId,
			description,
			profile,
			depth,
			status: 'running',
			createdAt: now,
			startedAt: now,
			activity: emptySubagentActivity(),
			evidence: emptySubagentEvidence(),
		})

		// Drive the agent loop without awaiting it — completion is detected event-style by
		// _maybeFinalizeSubagent (the loop legitimately returns early while a tool approval
		// waits for the user, and resumes via approve/reject re-entry). The preamble is
		// added there, after the (async) frozen-contracts read is prepended to it.
		void this._driveSubagent(subThreadId, profile, description, planCoerced, preamble, prompt)

		return { ok: true, subagentThreadId: subThreadId, profile, completion: completionPromise }
	}

	private async _driveSubagent(subThreadId: string, profile: SubagentProfile, description: string, planCoerced: boolean, preamble: string, prompt: string) {
		// Automatic team-board check-in for work children (research children are read-only
		// and claim nothing). Overlap warnings go to the parent thread, not silently to a log.
		if (profile === 'work') {
			try {
				const { overlaps } = await this._toolsService.teamCheckinDirect({
					agentId: this._subagentTeamAgentId(subThreadId),
					doing: description,
					where: null, // claim text comes from the task description until the child narrows it
					status: 'active',
				})
				if (overlaps.length > 0) {
					const parentThreadId = this.subagentState[subThreadId]?.parentThreadId
					if (parentThreadId && this.state.allThreads[parentThreadId]) {
						this._injectSystemNotification(parentThreadId, `[Team board] Subagent "${description}" may overlap active claims: ${overlaps.map(o => `${o.agentId}${o.where ? ` [${o.where}]` : ''}`).join(', ')}. Consider narrowing its area or sequencing the work.`, 'subagent')
					}
				}
			} catch { /* team board is best-effort coordination, never a launch blocker */ }
		}
		// Frozen team contracts go in FRONT of the task for every child, both profiles:
		// ownership stops collisions, contracts stop divergence. Best-effort read.
		let contractsBlock = ''
		try { contractsBlock = formatContractsBlock(await this._toolsService.teamContracts()) } catch { /* board unavailable — task still runs */ }
		// A cancel can land during the awaits above (check-in, contracts read). Never start
		// a model loop on a thread that is already terminal — same zombie class as the
		// abort/reject race, one window earlier.
		if (this.subagentState[subThreadId]?.status !== 'running') return
		this._addMessageToThread(subThreadId, {
			role: 'user',
			content: contractsBlock + preamble,
			displayContent: prompt,
			selections: null,
			state: { stagingSelections: [], isBeingEdited: false },
		})
		if (planCoerced) {
			this._injectSystemNotification(subThreadId, '[Launched from Plan mode — this subagent runs in the read-only research profile.]', 'system')
		}
		try {
			await this._runChatAgent({
				threadId: subThreadId,
				...this._currentModelSelectionProps(),
			})
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err)
			this._finalizeSubagent(subThreadId, 'failed', `Subagent error: ${errorMsg}`)
			return
		}
		this._maybeFinalizeSubagent(subThreadId)
	}

	/**
	 * Called after every agent-loop run on a subagent thread (initial drive AND
	 * approve/reject re-entries). Finalizes only when the loop has genuinely ended —
	 * a child paused on a tool approval stays 'running' until the user decides.
	 */
	private _maybeFinalizeSubagent(threadId: string) {
		const sub = this.subagentState[threadId]
		if (!sub || sub.status !== 'running') return
		const streamState = this.streamState[threadId]
		if (streamState?.isRunning === 'awaiting_user') {
			// Transition to waiting-approval so the Agents panel shows the real state.
			this._setSubagentState(threadId, { ...sub, status: 'waiting-approval' })
			return
		}
		if (streamState?.isRunning) return // still mid-loop (an approve re-entry is running)

		const subMessages = this.state.allThreads[threadId]?.messages ?? []
		const assistantMessages = subMessages.filter(m => m.role === 'assistant')
		const lastAssistant = assistantMessages[assistantMessages.length - 1]
		const result = lastAssistant && 'displayContent' in lastAssistant
			? (lastAssistant.displayContent || '(subagent completed with no text output)')
			: '(subagent completed with no text output)'

		// FALSE-SUCCESS GUARD: a work worker that reports edits none of its own tool calls
		// made is reported as blocked, not completed, so the parent never integrates a claim
		// no evidence supports. Evidence comes from this worker's tool calls only.
		const firstUser = subMessages.find(m => m.role === 'user')
		const task = firstUser && 'displayContent' in firstUser ? (firstUser.displayContent ?? '') : sub.description
		const assessment = assessWorkerOutcome({
			profile: sub.profile,
			task: task || sub.description,
			report: result,
			evidence: sub.evidence,
		})
		if (assessment.status === 'blocked') {
			this._finalizeSubagent(threadId, 'blocked', result, { ...sub.evidence, blockedReason: assessment.reason })
			return
		}
		this._finalizeSubagent(threadId, 'completed', result)
	}

	/** The ONE place a subagent reaches a terminal state: sets status, checks the team
	 *  board out, resolves the completion promise — exactly once — and drains the queue. */
	private _finalizeSubagent(threadId: string, status: 'completed' | 'blocked' | 'failed' | 'cancelled', result: string, evidence?: SubagentEvidenceT) {
		const sub = this.subagentState[threadId]
		if (!sub || isTerminalStatus(sub.status)) return
		if (sub.status === 'cancelled' && status !== 'cancelled') return // cancel won the race; keep it
		const now = new Date().toISOString()
		this._setSubagentState(threadId, {
			...sub,
			status,
			finishedAt: now,
			evidence: evidence ?? sub.evidence,
			...(status === 'failed' ? { error: result } : { result }),
		})
		if (sub.profile === 'work') {
			void this._toolsService.teamCheckinDirect({
				agentId: this._subagentTeamAgentId(threadId),
				doing: sub.description,
				where: null,
				status: 'done',
			}).catch(() => { })
		}
		const completion = this._subagentCompletion.get(threadId)
		this._subagentCompletion.delete(threadId)
		const finalEvidence = this.subagentState[threadId]?.evidence
		completion?.resolve({
			result,
			status,
			filesTouched: finalEvidence?.filesTouched,
			commandsRun: finalEvidence?.commandsRun,
			blockedReason: finalEvidence?.blockedReason,
		})

		// Reconcile trigger: when the last worker of a parallel batch lands, tell the parent
		// to cross-check the outputs against each other and the contracts. Deferred with
		// setTimeout(0) so it lands AFTER the last child's own result notification (which is
		// injected from a microtask on the completion promise above).
		const batch = this._subagentBatch.get(sub.parentThreadId) ?? { terminal: 0, completed: 0 }
		batch.terminal += 1
		if (status === 'completed') batch.completed += 1
		this._subagentBatch.set(sub.parentThreadId, batch)
		const running = this.getSubagentsForThread(sub.parentThreadId).filter(s => s.status === 'running').length
		if (running === 0) {
			this._subagentBatch.delete(sub.parentThreadId)
			if (shouldReconcileBatch({ running, terminal: batch.terminal, completed: batch.completed }) && this.state.allThreads[sub.parentThreadId]) {
				const parentThreadId = sub.parentThreadId
				const terminal = batch.terminal
				setTimeout(() => {
					void this._toolsService.teamContracts().catch(() => [] as TeamContract[]).then(contracts => {
						if (!this.state.allThreads[parentThreadId]) return
						this._injectSystemNotification(parentThreadId, formatReconcilePrompt(terminal, contracts), 'subagent')
					})
				}, 0)
			}
		}

		// Queue drain: this worker just freed a running slot. Offer it to the oldest
		// globally-eligible queued worker, regardless of which parent owns it.
		this._drainQueue()
	}

	/**
	 * Start queued workers when running slots free up — GLOBALLY, not per-parent. Whenever
	 * ANY worker leaves the running state (finished, cancelled, blocked) the freed slot is
	 * offered to the oldest globally-eligible queued worker, whichever parent it belongs to.
	 * Takes no parent argument on purpose: a parent-scoped drain is exactly the bug where a
	 * worker under parent B stays queued forever because only parent A's children finish.
	 */
	private _drainQueue() {
		const isStillQueued = (id: string) => this.subagentState[id]?.status === 'queued'
		const runningByParent: Record<string, number> = {}
		let runningTotal = 0
		for (const s of Object.values(this.subagentState)) {
			if (s.status !== 'running') continue
			runningTotal++
			runningByParent[s.parentThreadId] = (runningByParent[s.parentThreadId] ?? 0) + 1
		}

		const toStart = selectDrainableSubagents({
			queue: this._subagentQueue,
			runningByParent,
			runningTotal,
			isStillQueued,
		})

		for (const nextId of toStart) {
			const idx = this._subagentQueue.findIndex(e => e.subagentThreadId === nextId)
			if (idx !== -1) this._subagentQueue.splice(idx, 1)
			const details = this._queuedLaunchDetails.get(nextId)
			this._queuedLaunchDetails.delete(nextId)
			const sub = this.subagentState[nextId]
			// A worker cancelled between selection and start must never be revived.
			if (!sub || !details || sub.status !== 'queued') continue

			const now = new Date().toISOString()
			this._setSubagentState(nextId, { ...sub, status: 'running', startedAt: now, queuePosition: undefined })
			void this._driveSubagent(nextId, details.profile, details.description, details.planCoerced, details.preamble, details.prompt)
		}

		// Drop entries whose worker is no longer queued (cancelled/started) so the queue does
		// not accumulate tombstones, then restate 1-based positions per parent.
		for (let i = this._subagentQueue.length - 1; i >= 0; i--) {
			if (!isStillQueued(this._subagentQueue[i].subagentThreadId)) this._subagentQueue.splice(i, 1)
		}
		const positions = recomputeQueuePositions(this._subagentQueue, isStillQueued)
		for (const [id, pos] of positions) {
			const info = this.subagentState[id]
			if (info && info.queuePosition !== pos) this._setSubagentState(id, { ...info, queuePosition: pos })
		}
	}

	async cancelSubagent(subagentThreadId: string): Promise<void> {
		const sub = this.subagentState[subagentThreadId]
		if (!sub) return
		// Queued workers can be cancelled without aborting a running loop.
		if (sub.status === 'queued') {
			const idx = this._subagentQueue.findIndex(e => e.subagentThreadId === subagentThreadId)
			if (idx !== -1) this._subagentQueue.splice(idx, 1)
			this._queuedLaunchDetails.delete(subagentThreadId)
			// Finalize drains the queue, which also restates the positions of everyone behind
			// this worker — a cancelled entry must not leave a hole in the queue numbering.
			this._finalizeSubagent(subagentThreadId, 'cancelled', '(cancelled before launch)')
			return
		}
		if (sub.status !== 'running' && sub.status !== 'waiting-approval') return
		// Stamp the terminal status BEFORE aborting: abort resolves the driving loop, whose
		// finalize pass must see 'cancelled' and not race it into a bogus 'completed'.
		this._setSubagentState(subagentThreadId, { ...sub, status: 'cancelled' })
		await this.abortRunning(subagentThreadId)
		this._finalizeSubagent(subagentThreadId, 'cancelled', '(cancelled before completion)')
	}

	// -- Parent-to-worker messaging --

	/** Max length of a parent-to-worker message. */
	private static readonly MAX_PARENT_MESSAGE_LENGTH = 2000

	/** Max messages a parent can send to one worker. */
	private static readonly MAX_MESSAGES_PER_WORKER = 10

	/** Count of messages sent per worker, for rate limiting. */
	private readonly _parentMessageCount = new Map<string, number>()

	messageSubagent(parentThreadId: string, subagentThreadId: string, message: string): { ok: true } | { ok: false, error: string } {
		const sub = this.subagentState[subagentThreadId]
		if (!sub) return { ok: false, error: 'Unknown worker.' }
		// Enforce parent ownership.
		if (sub.parentThreadId !== parentThreadId) {
			return { ok: false, error: 'Only the owning parent thread can message a worker.' }
		}
		// Only running or waiting-approval workers can receive messages.
		if (sub.status !== 'running' && sub.status !== 'waiting-approval') {
			return { ok: false, error: `Cannot message a worker in state "${sub.status}".` }
		}
		// Rate limit.
		const count = this._parentMessageCount.get(subagentThreadId) ?? 0
		if (count >= ChatThreadService.MAX_MESSAGES_PER_WORKER) {
			return { ok: false, error: `At most ${ChatThreadService.MAX_MESSAGES_PER_WORKER} messages can be sent to one worker.` }
		}
		// Bound message length.
		const bounded = message.slice(0, ChatThreadService.MAX_PARENT_MESSAGE_LENGTH)
		// Inject as a system notification into the child thread.
		this._injectSystemNotification(subagentThreadId, `[Parent correction] ${bounded}`, 'system')
		this._parentMessageCount.set(subagentThreadId, count + 1)
		// Notify the parent that delivery succeeded.
		this._onDidChangeSubagentState.fire({ subagentThreadId })
		return { ok: true }
	}

	// -- Worker progress reporting --

	/** Max milestones per worker (bounded log). */
	private static readonly MAX_MILESTONES_PER_WORKER = 20

	reportSubagentProgress(subagentThreadId: string, milestone: string): void {
		const sub = this.subagentState[subagentThreadId]
		if (!sub || sub.status !== 'running') return
		const bounded = milestone.slice(0, 500)
		const milestones = [...sub.activity.milestones, bounded].slice(-ChatThreadService.MAX_MILESTONES_PER_WORKER)
		this._setSubagentState(subagentThreadId, {
			...sub,
			activity: { ...sub.activity, milestones },
		})
	}

}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
