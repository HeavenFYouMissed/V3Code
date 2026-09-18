/*--------------------------------------------------------------------------------------

 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.

 *  Licensed under the Apache License, Version 2.0.

 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */



/**

 * V3CodeChatAgent — registers V3Code as the native default chat agent.

 *

 * Bridges native IChatAgentService to V3Code's full pipeline:

 * prepareLLMChatMessages (rules, skills, auto-context), ILLMMessageService,

 * ILanguageModelToolsService (native tool cards + approvals).

 */



import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';

import { timeout } from '../../../../base/common/async.js';
import { LRUCache } from '../../../../base/common/map.js';
import { hash } from '../../../../base/common/hash.js';

import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';

import { MarkdownString } from '../../../../base/common/htmlContent.js';

import { Disposable } from '../../../../base/common/lifecycle.js';

import { isLocation, Location } from '../../../../editor/common/languages.js';

import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { v3AgentDevilUri } from './v3BrandAssets.js';

import { IFileService } from '../../../../platform/files/common/files.js';

import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../platform/log/common/log.js';

import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

import {

	IChatAgentData,

	IChatAgentHistoryEntry,

	IChatAgentImplementation,

	IChatAgentRequest,

	IChatAgentResult,

	IChatAgentService,

} from '../../chat/common/participants/chatAgents.js';

import { IChatRequestVariableEntry, isImageVariableEntry, isPasteVariableEntry, isPromptTextVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';

import { coerceImageBuffer } from '../../chat/common/chatImageExtraction.js';

import { IChatFollowup, IChatProgress } from '../../chat/common/chatService/chatService.js';

import { IChatService } from '../../chat/common/chatService/chatService.js';

import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';

import {

	CountTokensCallback,

	ILanguageModelToolsService,

	IToolInvocation,

} from '../../chat/common/tools/languageModelToolsService.js';

import { AnthropicReasoning } from '../common/sendLLMMessageTypes.js';

import { ILLMMessageService } from '../common/sendLLMMessageService.js';

import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';

import { IVoidSettingsService } from '../common/voidSettingsService.js';

import { ChatMessage, ImageAttachment } from '../common/chatThreadServiceTypes.js';

import { ChatMode, displayInfoOfProviderName, ModelSelection, ProviderName } from '../common/voidSettingsTypes.js';

import { VOID_OPEN_SETTINGS_ACTION_ID } from './voidSettingsPane.js';


import { describeImagesForNonVisionModel, describeToolScreenshots, modelSupportsVision, VisionDescribeUserMessage } from './v3codeVisionDescribe.js';

import { RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';

import { IMCPService } from '../common/mcpService.js';

import { IMemoryService, RecordInput } from './memoryService.js';
import { serializeThreadForCompaction, buildCompactSystemPrompt, extractCompactSummary } from '../common/memory/compaction.js';
import { ITokenUsageService } from '../common/tokenUsageService.js';
import { IV3CodeAccountService } from '../common/v3codeAccountService.js';
import { IMemoryCaptureService } from './memoryCaptureService.js';
import { IMarkerCheckService } from './_markerCheckService.js';
import { AgentRole } from '../common/memory/memoryTypes.js';
import { boundaryNoteApplicable, workspaceMutationResultFromToolContent } from '../common/memory/sessionDigestPolicy.js';
import { isGreenfieldWorkspace } from '../common/memory/workspaceScope.js';
import { planWebSearchBlockedMessage, shouldBlockPlanWebSearch } from '../common/memory/planResearchBudget.js';
import { isReadOnlyCall as isReadOnlyCallPure, isInspectionCall as isInspectionCallPure, isExternalObservationTool, normalizedInspectionSignature, MAX_WORKSPACE_INSPECTIONS } from '../common/memory/loopGuards.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { explicitlyRequestsCurrentResearch } from '../common/prompt/researchPreflight.js';

import { ToolName, approvalTypeOfBuiltinToolName, BuiltinToolName, SubagentProfile } from '../common/toolsServiceTypes.js';

import { resolveNativeToolId, modelToolNameFromNativeId, modelToolNamesDisabledBySelection, modelToolNamesMissingNativeRegistration, subagentNativeToolSelection } from './v3codeToolIds.js';
import { IV3NativeNoticeService } from './v3NativeNoticeService.js';
import { resolveV3BuiltinModeName } from '../common/v3DebugMode.js';
import { formatNativeNotices } from '../common/nativeNoticeQueue.js';
import { IChatThreadService } from './chatThreadService.js';
import { providerHasPromptCacheWindow, publishV3CacheClockEvent } from '../common/v3CacheClock.js';

import { V3_MODEL_TIERS, tierLanguageModelId, clampRouterRung, routerRungForAutoRouter } from '../common/modelTiers.js';
import { routerCandidatesForOrigin, selectAutoRouterCandidate } from '../common/router/modelCandidates.js';
import { OPUS_HYBRID_MODEL_NAME } from '../common/modelCapabilities.js';

import { LlmStreamWatchdog, llmStreamStallMs } from './v3codeLlmStreamWatchdog.js';
import { isLocalAgentProvider, shouldSuppressLocalAskUser, V3CodeLocalAgentRuntime } from '../common/localAgentRuntime.js';
import { LOCAL_AGENT_TRANSCRIPT_METADATA_KEY, LocalAgentTranscriptRecorder, reconstructLocalAgentTranscript } from '../common/localAgentHistory.js';
import { parseV3VoiceFinalResult, publishV3VoiceAgentEvent, type V3VoicePlanTodo } from './v3codeVoiceAgentEvents.js';



const AGENT_ID = 'v3code.agent';

const CHAT_RETRIES = 3;

// Backoff before retrying a retryable LLM error (429/529/5xx/network). Mirrors chatThreadService's
// RETRY_DELAY so an overloaded Anthropic endpoint isn't hammered with 3 instant retries in <1s.
const RETRY_DELAY_MS = 2500;

// Per-tool wall-clock budgets. A tool that ignores its cancellation token (hung subprocess, dead
// socket) would otherwise block the step loop forever after the LLM already returned. On expiry we
// cancel the tool and return a "timed out" string so the loop continues instead of wedging.
const TOOL_TIMEOUT_READ_MS = 60_000;
const TOOL_TIMEOUT_WRITE_MS = 180_000;
// Extra window for approval-gated tools: the user deciding on an approval card is not a
// wedged tool. 15 min keeps a hard backstop while no longer auto-denying a coffee break.
const TOOL_APPROVAL_GRACE_MS = 15 * 60_000;
// A blocking run_subagent is a full nested agent run (its own model calls, tools, and
// possibly user approvals) — give it a real working window, not a single-tool budget.
const SUBAGENT_TOOL_TIMEOUT_MS = 30 * 60_000;

function parseVoiceArray(raw: unknown): unknown[] {
	if (Array.isArray(raw)) {
		return raw;
	}
	if (typeof raw !== 'string') {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return raw.split(/\r?\n|\s*\|\s*/).map(value => value.trim()).filter(Boolean);
	}
}

function voicePlanFromRawParams(params: RawToolParamsObj | undefined): { todos: V3VoicePlanTodo[]; merge: boolean } | undefined {
	const allowedStatuses = new Set<V3VoicePlanTodo['status']>(['pending', 'in_progress', 'completed', 'cancelled']);
	const todos = parseVoiceArray(params?.todos).flatMap((raw, index): V3VoicePlanTodo[] => {
		if (!raw || typeof raw !== 'object') {
			return [];
		}
		const todo = raw as Record<string, unknown>;
		const content = typeof todo.content === 'string' ? todo.content.trim() : '';
		if (!content) {
			return [];
		}
		const status = typeof todo.status === 'string' && allowedStatuses.has(todo.status as V3VoicePlanTodo['status'])
			? todo.status as V3VoicePlanTodo['status']
			: 'pending';
		return [{ id: String(todo.id ?? index), content: content.slice(0, 500), status }];
	});
	if (!todos.length) {
		return undefined;
	}
	const rawMerge: unknown = params?.merge;
	return { todos, merge: rawMerge === true || rawMerge === 'true' || rawMerge === 1 || rawMerge === '1' };
}

function voiceQuestionFromRawParams(params: RawToolParamsObj | undefined): { question: string; options: string[] } | undefined {
	const question = typeof params?.question === 'string' ? params.question.trim().slice(0, 1000) : '';
	if (!question) {
		return undefined;
	}
	const options = parseVoiceArray(params?.options)
		.filter((option): option is string => typeof option === 'string')
		.map(option => option.trim().slice(0, 300))
		.filter(Boolean)
		.slice(0, 2);
	return { question, options };
}

/**
 * Identify an image's mime type from its leading magic bytes. Returns undefined when unknown,
 * so callers can fall back to a default. Prevents mislabeling (e.g. a JPEG sent as image/png,
 * which Anthropic 400-rejects). Covers the formats the chat accepts.
 */
function sniffImageMimeType(buf: Uint8Array): string | undefined {
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) { return 'image/jpeg'; }
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) { return 'image/png'; }
	if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) { return 'image/gif'; }
	// WEBP: "RIFF"...."WEBP"
	if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
		&& buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) { return 'image/webp'; }
	return undefined;
}

type ToolImagePayload = { data: string; mimeType: string };

type ToolExecutionResult = { text: string; images?: ToolImagePayload[] };

/** Pull image `kind:'data'` parts out of a native tool result for vision-model tool_result blocks. */
function extractToolImagesFromContent(content: ReadonlyArray<{ kind: string; value?: unknown }>): ToolImagePayload[] {
	const images: ToolImagePayload[] = [];
	for (const part of content) {
		if (part.kind !== 'data' || !part.value || typeof part.value !== 'object') {
			continue;
		}
		const val = part.value as { mimeType?: string; data?: Uint8Array | VSBuffer };
		const raw = val.data;
		let buf: Uint8Array | undefined;
		if (raw instanceof Uint8Array) {
			buf = raw;
		} else if (raw && typeof (raw as VSBuffer).buffer !== 'undefined') {
			buf = (raw as VSBuffer).buffer;
		}
		if (!buf || buf.byteLength === 0) {
			continue;
		}
		const sniffed = sniffImageMimeType(buf);
		const declared = typeof val.mimeType === 'string' && val.mimeType.startsWith('image/') ? val.mimeType : undefined;
		const mimeType = sniffed ?? declared;
		if (!mimeType) {
			continue;
		}
		images.push({ data: encodeBase64(VSBuffer.wrap(buf)), mimeType });
	}
	return images;
}

const V3CODE_VENDOR = 'v3code';



type AgentSimpleMessage = {

	role: 'user';

	content: string;

	images?: Array<{ data: string; mimeType: string }>;

} | {

	role: 'assistant';

	content: string;

	anthropicReasoning: AnthropicReasoning[] | null;
	geminiParts?: import('../common/sendLLMMessageTypes.js').GeminiResponsePart[];
	geminiCallIds?: string[];

	reasoning: string | null;

} | {

	role: 'tool';

	content: string;

	id: string;

	name: ToolName;

	rawParams: Record<string, unknown>;

	images?: Array<{ data: string; mimeType: string }>;

};



type LLMCallResult =

	| { kind: 'final'; text: string; reasoning: string | null; anthropicReasoning: AnthropicReasoning[] | null; geminiParts?: import('../common/sendLLMMessageTypes.js').GeminiResponsePart[]; toolCall?: RawToolCallObj; toolCalls?: RawToolCallObj[]; promptTokens?: number; completionTokens?: number; promptCacheHitTokens?: number; promptCacheWriteTokens?: number }

	| { kind: 'error'; message: string; retryable?: boolean }

	| { kind: 'abort' };



/**
 * Classify a provider error message as retryable. Deterministic 4xx (esp. 400 bad-request) is a
 * client/payload error that will fail identically on retry, so surface it immediately. Overload /
 * rate-limit / transient server / network errors are worth backing off and retrying. We only have
 * the message string from the provider channel, so match on the common signals.
 */
function isRetryableErrorMessage(message: string): boolean {
	const m = message.toLowerCase();
	// Non-retryable deterministic client errors. Includes API-key/auth failures whose
	// provider text carries no status code (e.g. "Invalid OpenAI API key.") — retrying a
	// bad key just wastes the backoff chain and mislabels a permanent auth error as "transient".
	if (/\b400\b|\b401\b|\b403\b|\b404\b|\b422\b/.test(m) || m.includes('bad request') || m.includes('invalid_request') || m.includes('unauthorized') || m.includes('not found')
		|| m.includes('api key') || m.includes('api_key') || m.includes('apikey') || m.includes('invalid key') || m.includes('incorrect api key') || m.includes('no api key')) {
		return false;
	}
	// Retryable transient errors.
	if (/\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|\b529\b/.test(m)
		|| m.includes('overloaded') || m.includes('rate limit') || m.includes('rate_limit')
		|| m.includes('timed out') || m.includes('timeout') || m.includes('econnreset')
		|| m.includes('etimedout') || m.includes('socket hang up') || m.includes('network')
		|| m.includes('temporarily')) {
		return true;
	}
	// Unknown: retry once (cheap given the bounded CHAT_RETRIES + backoff), better than dying on a
	// transient blip we didn't enumerate.
	return true;
}

/**
 * Pick a backoff delay tuned to the actual error class. Anthropic 529 ("overloaded") clears in a
 * couple seconds; 429 (rate-limit) needs longer. If the message carries an explicit Retry-After
 * value (as `retry after Ns` / `retry-after: N`) we honor it. The default follows the prior
 * exponential-with-base-2.5s schedule so existing tuning is preserved when no signal is available.
 */
function backoffMsForError(message: string, attempt: number, baseMs: number): { delayMs: number; reason: string } {
	const m = message.toLowerCase();
	const retryAfterMatch = m.match(/retry[\s-]?after[:\s]*(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms)?/);
	if (retryAfterMatch) {
		const value = parseFloat(retryAfterMatch[1]);
		const unit = retryAfterMatch[2] ?? 's';
		const ms = unit === 'ms' ? value : value * 1000;
		// Clamp to sane bounds (1s..30s) — providers occasionally suggest very long retries.
		const clamped = Math.max(1000, Math.min(30_000, ms));
		return { delayMs: clamped, reason: `provider asked us to wait ${Math.round(clamped / 100) / 10}s` };
	}
	// 529 / "overloaded": Anthropic recovers fast, so a short fixed backoff is far better than the
	// long exponential chain that compounded the original drop-and-hang RCA.
	if (/\b529\b/.test(m) || m.includes('overloaded')) {
		return { delayMs: Math.min(2000 * attempt, 6_000), reason: 'provider overloaded' };
	}
	// 429 / rate-limit: needs more space; respect exponential growth.
	if (/\b429\b/.test(m) || m.includes('rate limit') || m.includes('rate_limit')) {
		return { delayMs: baseMs * attempt * 2, reason: 'rate limited' };
	}
	// Network / 5xx: standard exponential.
	return { delayMs: baseMs * attempt, reason: 'transient error' };
}

/** One short, transient status for retries; the final error remains the only permanent line. */
function retryStatusForError(message: string): string {
	const overloaded = message.match(/^(.+?) is overloaded\b/i)
	if (overloaded) { return `${overloaded[1]} is overloaded. Retrying…` }
	const rateLimited = message.match(/^(.+?) rate limit reached\b/i)
	if (rateLimited) { return `${rateLimited[1]} rate limit reached. Retrying…` }
	const unavailable = message.match(/^(.+?) is temporarily unavailable\b/i)
	if (unavailable) { return `${unavailable[1]} is temporarily unavailable. Retrying…` }
	return 'The provider hit a temporary problem. Retrying…'
}



class V3CodeChatAgent extends Disposable implements IWorkbenchContribution {



	static readonly ID = 'workbench.contrib.v3codeChatAgent';



	constructor(

		@IChatAgentService private readonly chatAgentService: IChatAgentService,

		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,

		@IConvertToLLMMessageService private readonly convertService: IConvertToLLMMessageService,

		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,

		@IMCPService private readonly mcpService: IMCPService,

		@IChatService private readonly chatService: IChatService,

		@IFileService private readonly fileService: IFileService,

		@ILanguageModelToolsService private readonly nativeToolsService: ILanguageModelToolsService,

		@IDialogService private readonly dialogService: IDialogService,

		@ILogService private readonly logService: ILogService,

		@ICommandService private readonly commandService: ICommandService,

		@IMemoryService private readonly memoryService: IMemoryService,

		@IMemoryCaptureService private readonly memoryCaptureService: IMemoryCaptureService,

		@IMarkerCheckService private readonly markerCheckService: IMarkerCheckService,

		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,

		@IConfigurationService private readonly configurationService: IConfigurationService,

		@ITokenUsageService private readonly tokenUsageService: ITokenUsageService,

		@IV3CodeAccountService private readonly v3codeAccountService: IV3CodeAccountService,
		@IV3NativeNoticeService private readonly nativeNoticeService: IV3NativeNoticeService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,

	) {

		super();

		this._registerAgent();

		// Chat lifecycle → usage-meter lifecycle: when a chat session is cleared/disposed, drop
		// its live per-session totals (they key on the same sessionResource URI the agent bills
		// requests to). All-time totals are unaffected — this only stops dead sessions from
		// accumulating in memory and keeps getSessionUsage() honest for reused session ids.
		this._register(this.chatService.onDidDisposeSession(({ sessionResources }) => {
			for (const uri of sessionResources) {
				this.tokenUsageService.resetSession(uri.toString());
			}
		}));

	}



	private _registerAgent(): void {

		const agentData: IChatAgentData = {

			id: AGENT_ID,

			name: 'V',

			fullName: 'V',

			description: 'V3Code coding agent powered by your own providers',

			extensionId: new ExtensionIdentifier('v3code.v3code'),

			extensionVersion: '1.0.0',

			extensionPublisherId: 'v3code',

			publisherDisplayName: 'V3Code',

			extensionDisplayName: 'V3Code',

			isDefault: true,

			isDynamic: true,

			isCore: true,

			metadata: {

				icon: v3AgentDevilUri(),

				iconDark: v3AgentDevilUri(),

			},

			slashCommands: [],

			locations: [

				ChatAgentLocation.Chat,

				ChatAgentLocation.EditorInline,

				ChatAgentLocation.Terminal,

				ChatAgentLocation.Notebook,

			],

			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Plan, ChatModeKind.Edit],

			disambiguation: [],

			capabilities: {

				supportsFileAttachments: true,

				supportsToolAttachments: true,

			},

		};



		const agentImpl: IChatAgentImplementation = {

			invoke: (request, progress, history, token) => this._invoke(request, progress, history, token),

			provideFollowups: (request, _result, _history, _token) => this._provideFollowups(request),

			provideChatTitle: (history, _token) => this._provideChatTitle(history),

		};



		this._register(this.chatAgentService.registerDynamicAgent(agentData, agentImpl));

	}



	private _resolveModelSelection(request: IChatAgentRequest): ModelSelection | null {

		const s = this.settingsService.state;

		let modelSelection = s.modelSelectionOfFeature['Chat'] ?? null;



		const selectedId = request.userSelectedModelId;

		// Tier ids ('v3code/tier/…') are handled by the tier branch below — parsing
		// them here persisted garbage like {providerName:'tier'} as a BYOK selection.
		if (selectedId?.startsWith(`${V3CODE_VENDOR}/`) && !selectedId.startsWith(`${V3CODE_VENDOR}/tier/`)) {

			const parts = selectedId.split('/');

			if (parts.length >= 3) {

				modelSelection = {

					providerName: parts[1] as ProviderName,

					modelName: parts.slice(2).join('/'),

				};

				void this.settingsService.setModelSelectionOfFeature('Chat', modelSelection);

			}

		}



		// Branded tier ids from picker (v3code/tier/V3Fast etc.)

		if (selectedId?.startsWith(`${V3CODE_VENDOR}/tier/`)) {

			const tierId = selectedId.split('/').pop();

			const tier = V3_MODEL_TIERS.find(t => t.id === tierId);

			if (tier) {

				modelSelection = tier.selection;

				void this.settingsService.setModelSelectionOfFeature('Chat', modelSelection);
				if (tier.options) {
					void this.settingsService.setOptionsOfModelSelection('Chat', modelSelection.providerName, modelSelection.modelName, tier.options);
				}

			}

		}



		// Auto resolves through the provider-aware candidate boundary. The slider is
		// a budget ceiling, not a hard-coded model ladder: BYOK uses actual catalog
		// prices, while plans/local/free use model power. It never crosses keys or plans.
		const autoRouter = !!this.configurationService.getValue<boolean>('v3code.agent.autoRouter');
		const routerRung = clampRouterRung(Number(this.configurationService.getValue<number>('v3code.agent.routerRung') ?? 0));
		const routerBudget = routerRungForAutoRouter(autoRouter, routerRung);
		const paidUnlocked = !!this.configurationService.getValue<boolean>('v3code.agent.routerPaidUnlocked') || this.v3codeAccountService.state.isPaid;
		const availableSelections = [
			...s._modelOptions.map(option => option.selection),
			...(paidUnlocked ? V3_MODEL_TIERS.filter(tier => !!tier.selection.hostedTierId).map(tier => tier.selection) : []),
		];
		if (routerBudget > 0 && modelSelection) {
			const candidates = routerCandidatesForOrigin(availableSelections, modelSelection);
			const choice = selectAutoRouterCandidate(candidates, request.message, routerBudget, this.settingsService.state.overridesOfModel);
			if (choice) {
				modelSelection = choice.selection;
				void this.settingsService.setModelSelectionOfFeature('Chat', modelSelection);
				if (modelSelection.modelName === OPUS_HYBRID_MODEL_NAME) {
					void this.settingsService.setOptionsOfModelSelection('Chat', modelSelection.providerName, modelSelection.modelName, {
						advisorEffort: choice.estimatedComplexity >= 0.84 ? 'hard' : 'easy',
					});
				}
			}
		}



		return modelSelection;

	}



	// Returns a user-facing explanation when the selected model cannot be used at all, or null
	// when it is fine to send. Deliberately conservative: it only reports a model that no
	// provider currently offers, so a model that is merely filtered out of one feature's list
	// (chat mode filters) is never treated as broken.
	private _describeUnavailableModel(modelSelection: ModelSelection): { markdown: MarkdownString; plain: string } | null {

		// Hosted tier picks run on the hub's keys, not on the BYOK option list, and the account
		// service raises its own sign-in error for them.
		if (modelSelection.hostedTierId) { return null; }

		const s = this.settingsService.state;

		const isOffered = s._modelOptions.some(o => o.selection.providerName === modelSelection.providerName && o.selection.modelName === modelSelection.modelName);
		if (isOffered) { return null; }

		const providerTitle = displayInfoOfProviderName(modelSelection.providerName).title;
		const providerSettings = s.settingsOfProvider[modelSelection.providerName];
		const isHiddenModel = !!providerSettings?.models.some(m => m.modelName === modelSelection.modelName && m.isHidden);

		let reason: string;
		if (!providerSettings) {
			reason = `${providerTitle} is not a configured provider`;
		}
		else if (!providerSettings._didFillInProviderSettings) {
			reason = `${providerTitle} is not set up yet — its API key or endpoint is missing`;
		}
		else if (isHiddenModel) {
			reason = `${modelSelection.modelName} is switched off in the ${providerTitle} model list`;
		}
		else {
			reason = `${providerTitle} no longer lists ${modelSelection.modelName}`;
		}

		const shown = s._modelOptions.slice(0, 4).map(o => o.name);
		const alternatives = shown.length === 0
			? 'No other model is available yet — add a provider key in Settings to get one.'
			: `Available right now: ${shown.join(', ')}${s._modelOptions.length > shown.length ? `, and ${s._modelOptions.length - shown.length} more` : ''}.`;

		const plain = `${modelSelection.modelName} (${providerTitle}) is not available: ${reason}. Nothing was sent. Pick a different model in the picker, or set up ${providerTitle} in Settings. ${alternatives}`;

		const markdown = new MarkdownString(
			`**Cannot run ${modelSelection.modelName} (${providerTitle}).**\n\n`
			+ `${reason}.\n\n`
			+ `Nothing was sent, and V3Code did not quietly swap in a different model — so no other provider key was spent and no local model answered in its place.\n\n`
			+ `- Pick a different model in the model picker under the chat input, or\n`
			+ `- [Open V3Code Settings](command:${VOID_OPEN_SETTINGS_ACTION_ID}) to set up ${providerTitle}.\n\n`
			+ alternatives,
			{ isTrusted: { enabledCommands: [VOID_OPEN_SETTINGS_ACTION_ID] } },
		);

		return { markdown, plain };

	}



	private _resolveChatMode(request: IChatAgentRequest): ChatMode {

		// Subagent invocations use a tool-call id as requestId which won't match
		// any chat request. Treat them as agent mode so they can run tools.
		if (request.subAgentInvocationId) {
			return 'agent';
		}

		const session = this.chatService.getSession(request.sessionResource);

		const chatRequest = session?.getRequests().find(r => r.id === request.requestId);

		// Multitask and Debug have their own stable built-in picker ids, but intentionally travel
		// over the existing Agent wire shape so persisted request/edit schemas do not need a new
		// enum. Matching the persisted name keeps saved chats (and chats from the earlier
		// custom-agent Multitask implementation) reopening in the mode they were written in.
		const v3Builtin = resolveV3BuiltinModeName(chatRequest?.modeInfo?.modeName);
		if (v3Builtin) {
			return v3Builtin;
		}

		const modeKind = chatRequest?.modeInfo?.kind;



		switch (modeKind) {

			case ChatModeKind.Agent:

				return 'agent';

			case ChatModeKind.Plan:

				return 'plan';

			case ChatModeKind.Edit:

				return 'read';

			case ChatModeKind.Ask:

			default:

				return 'chat';

		}

	}



	private _getModelSelectionOptions(modelSelection: ModelSelection | null): unknown {

		if (!modelSelection) {

			return undefined;

		}

		const stored = (this.settingsService.state.optionsOfModelSelection as Record<string, Record<string, Record<string, unknown>>>)['Chat']?.[modelSelection.providerName]?.[modelSelection.modelName];

		// Reasoning policy lives in getIsReasoningEnabledState: cloud Chat is quality-first/on;
		// turn-off-capable local models default to direct mode and retain the model-picker switch.
		// Pass stored per-model options through so that choice and any effort/budget are honored.
		return stored;

	}



	private _appendModeInstructions(systemMessage: string | undefined, request: IChatAgentRequest): string | undefined {

		const extra = request.modeInstructions?.content?.trim();

		if (!extra) {

			return systemMessage;

		}

		const block = `\n\n## Mode instructions (${request.modeInstructions?.name ?? 'mode'})\n${extra}`;

		return systemMessage ? systemMessage + block : block.trimStart();

	}



	/** Per-session compaction boundary set by `/compact`: on later turns, history entries before
	 *  `boundaryCount` are dropped from the wire and replaced by `summary` (see docs/V3CODE-COMPACT-DESIGN.md).
	 *  In-memory for the session; the native store keeps every turn, so the UI scrollback is untouched
	 *  and the summarized turns stay recoverable. Also recorded to memory for audit. */
	private readonly _compactionBySession = new Map<string, { boundaryCount: number; summary: string; focus?: string }>();

	/** Sessions already checked for a persisted compaction note — gates the restore to ONE memory
	 *  query per session per window, so ordinary sessions (no /compact ever) pay nothing per turn. */
	private readonly _compactionRestoreChecked = new Set<string>();

	/** Reload-durable /compact: the in-memory boundary Map dies with a window reload, but
	 *  _handleCompactCommand also wrote the summary to memory (title 'Compaction', meta.boundaryCount).
	 *  Re-apply the newest note's boundary here so a reload doesn't silently re-expand the compacted
	 *  turns back onto the wire. Best-effort — on any failure automatic context curation is the safety net. */
	private async _restoreCompactionBoundary(sessionId: string): Promise<void> {
		if (this._compactionBySession.has(sessionId) || this._compactionRestoreChecked.has(sessionId)) { return; }
		if (!this.memoryService.isAvailable) { return; }
		try {
			const events = await this.memoryService.searchChat('Compaction', { kind: 'note', sessionId, limit: 20 });
			// Newest-first; the session filter now runs inside the SQL query, so a busy
			// workspace can never push this session's note out of the limit window.
			const note = events.find(e => e.meta?.['compaction'] === true);
			if (!note) {
				this._compactionRestoreChecked.add(sessionId);
				return;
			}
			// Checkpoint-verified restore: a boundary note without its complete checkpoint is
			// an aborted write (legacy orphan from before atomic boundary writes, or anything
			// marked aborted). It must never be applied — only the atomic pair is a boundary.
			const hasCheckpoint = await this.memoryService.hasCheckpointForEndEvent(note.id);
			this._compactionRestoreChecked.add(sessionId);
			if (!boundaryNoteApplicable({ aborted: note.meta?.['aborted'] === true, hasCheckpoint })) { return; }
			const rawBoundary = note.meta?.['boundaryCount'];
			const boundaryCount = typeof rawBoundary === 'number' && Number.isFinite(rawBoundary) ? Math.max(0, Math.floor(rawBoundary)) : 0;
			const summary = (note.body ?? '').trim();
			if (boundaryCount > 0 && summary) {
				const rawFocus = note.meta?.['focus'];
				const focus = typeof rawFocus === 'string' && rawFocus.trim() ? rawFocus.trim() : undefined;
				this._compactionBySession.set(sessionId, { boundaryCount, summary, ...(focus ? { focus } : {}) });
			}
		} catch {
			// Do not poison the one-shot gate on a transient database/scope failure. The next
			// turn retries the restore instead of silently expanding the conversation forever.
		}
	}

	private _memorySessionId(request: IChatAgentRequest): string {
		return request.sessionResource.toString();
	}

	private _memoryRole(chatMode: ChatMode): AgentRole {
		if (chatMode === 'plan') return 'scout';
		if (chatMode === 'read') return 'scout';
		return 'lead';
	}

	private _memoryTitle(text: string): string {
		const t = text.trim().replace(/\s+/g, ' ');
		return t.length <= 80 ? t : t.slice(0, 77) + '...';
	}

	private _recordMemory(input: RecordInput): void {
		if (!this.memoryService.isAvailable) return;
		void this.memoryService.record(input).catch(() => { /* best-effort */ });
	}

	/** Lift the file a tool acted on out of its raw params, so the memory rung shows
	 *  "read prompts.ts" instead of a bare "read". File tools use `uri`; MCP/code tools
	 *  use `filePath`/`path`/`file`/`files`. Returns undefined when no file is involved. */
	private _toolFiles(rawParams: unknown): string[] | undefined {
		if (!rawParams || typeof rawParams !== 'object') { return undefined; }
		const p = rawParams as Record<string, unknown>;
		let cand = p['uri'] ?? p['filePath'] ?? p['path'] ?? p['file'];
		if (cand === undefined && Array.isArray(p['files']) && p['files'].length) { cand = p['files'][0]; }
		if (typeof cand !== 'string') { return undefined; }
		let s = cand.trim();
		if (!s) { return undefined; }
		// normalize a file:// URI string down to a plain path for display
		if (s.startsWith('file://')) { s = decodeURIComponent(s.replace(/^file:\/+/, '').replace(/^([a-zA-Z]:)/, '$1')); }
		return [s.replace(/\\/g, '/')];
	}

	/** Handle `/compact [focus]`: summarize the conversation with the MAIN model and set a per-session
	 *  boundary so the next turn's wire starts fresh from the summary. Emits a confirmation into the
	 *  chat; the native scrollback and shadow archive are untouched. */
	private async _handleCompactCommand(
		request: IChatAgentRequest,
		history: IChatAgentHistoryEntry[],
		focus: string | undefined,
		modelSelection: ModelSelection,
		modelSelectionOptions: unknown,
		chatMode: ChatMode,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<IChatAgentResult> {
		const sessionId = this._memorySessionId(request);
		const realTurns = history.filter(e => !/^\/compact\b/i.test((e.request.message ?? '').trim()));
		if (realTurns.length < 4) {
			progress([{ kind: 'markdownContent', content: new MarkdownString('Not enough conversation to compact yet.') }]);
			return {};
		}

		progress([{ kind: 'markdownContent', content: new MarkdownString('Compacting conversation…') }]);

		// Serialize the full native history (no boundary applied) for the summary model.
		const simple = await this._buildHistoryMessages(history, '', undefined, undefined);
		const chatMessages = this._simpleMessagesToChatMessages(simple.slice(0, -1)); // drop the trailing empty user we appended
		const payload = serializeThreadForCompaction(chatMessages);
		const system = buildCompactSystemPrompt(focus);

		let summary = '';
		try {
			summary = extractCompactSummary(await this._runOneShotSummary(payload, system, modelSelection, modelSelectionOptions, token));
		} catch {
			summary = '';
		}

		if (!summary) {
			progress([{ kind: 'markdownContent', content: new MarkdownString('Compaction failed — the conversation is unchanged.') }]);
			return {};
		}

		const boundaryCount = history.length;
		// One authoritative write: the summary note and its checkpoint land together or not
		// at all (single DB transaction in electron-main). A checkpoint-less note can never
		// exist, so it can never become a restorable boundary — and on failure the message
		// below is TRUE, because the transaction rolled everything back.
		let boundary: Awaited<ReturnType<typeof this.memoryService.recordCompactionBoundary>> = null;
		let boundaryError: string | undefined;
		try {
			boundary = await this.memoryService.recordCompactionBoundary(
				{ sessionId, kind: 'note', role: this._memoryRole(chatMode), title: 'Compaction', body: summary, meta: { compaction: true, boundaryCount, ...(focus ? { focus } : {}) } },
				{ trigger: 'explicit-compact', summary, meta: { boundaryCount, ...(focus ? { focus } : {}) } },
			);
		} catch (error) {
			boundaryError = error instanceof Error ? error.message : String(error);
		}
		if (!boundary) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(`Compaction could not be saved (${boundaryError ?? 'memory unavailable'}) — nothing was written; the conversation is unchanged. You can retry /compact.`) }]);
			return {};
		}
		this._compactionBySession.set(sessionId, { boundaryCount, summary, ...(focus ? { focus } : {}) });

		const turnWord = boundaryCount === 1 ? 'turn' : 'turns';
		progress([{ kind: 'markdownContent', content: new MarkdownString(`**Compacted ${boundaryCount} earlier ${turnWord}** into a summary. The model's context now starts fresh from here — your full history stays visible above and is recoverable.${focus ? `\n\n*Focus: ${focus}*` : ''}`) }]);
		return {};
	}

	/** One-shot summary call on the MAIN model for `/compact`. Text only (no tools); resolves '' on
	 *  error/timeout/cancel so the caller leaves the conversation unchanged. */
	private _runOneShotSummary(
		payload: string,
		system: string,
		modelSelection: ModelSelection,
		modelSelectionOptions: unknown,
		token: CancellationToken,
	): Promise<string> {
		return new Promise<string>((resolve) => {
			let settled = false;
			let requestId: string | null = null;
			const finish = (s: string) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				cancelSub.dispose();
				resolve(s);
			};
			const timer = setTimeout(() => { if (requestId) { this.llmMessageService.abort(requestId); } finish(''); }, 120_000);
			const cancelSub = token.onCancellationRequested(() => { if (requestId) { this.llmMessageService.abort(requestId); } finish(''); });
			requestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: payload }] as never,
				separateSystemMessage: system,
				chatMode: 'chat',
				modelSelection,
				modelSelectionOptions: modelSelectionOptions as never,
				overridesOfModel: this.settingsService.state.overridesOfModel,
				logging: { loggingName: 'V3Code Compact Summary' },
				onText: () => { /* ignore stream */ },
				onFinalMessage: ({ fullText }) => finish((fullText ?? '').trim()),
				onError: () => finish(''),
				onAbort: () => finish(''),
			});
			if (!requestId) { finish(''); }
		});
	}

	private async _invoke(

		request: IChatAgentRequest,

		progress: (parts: IChatProgress[]) => void,

		history: IChatAgentHistoryEntry[],

		token: CancellationToken,

	): Promise<IChatAgentResult> {



		const modelSelection = this._resolveModelSelection(request);

		const chatMode = this._resolveChatMode(request);

		const modelSelectionOptions = this._getModelSelectionOptions(modelSelection);



		if (!modelSelection) {

			progress([{ kind: 'markdownContent', content: new MarkdownString('No model configured. Open V3Code settings and add a provider key.') }]);

			return { errorDetails: { message: 'No model configured' } };

		}

		// An unavailable pick is now KEPT rather than silently re-pointed at another provider's
		// model (see _validatedModelState), so this is the only place the user can find out that
		// their selection cannot run. Say which model, why, and how to get moving again.
		const unusable = this._describeUnavailableModel(modelSelection);

		if (unusable) {

			progress([{ kind: 'markdownContent', content: unusable.markdown }]);

			return { errorDetails: { message: unusable.plain } };

		}



		const { content, images } = await this._processAttachments(request.message, request.variables?.variables ?? []);

		// `/compact [focus]` — summarize the conversation and set a boundary so the next turn's wire
		// starts fresh from the summary. A native /compact is NOT a registered slash command, so it
		// arrives here as plain agent text; handling it before _recordMemory also keeps the literal
		// "/compact" out of memory.
		const compactMatch = content.trim().match(/^\/compact\b[ \t]*([\s\S]*)$/i);
		if (compactMatch) {
			const focus = compactMatch[1]?.trim() || undefined;
			return this._handleCompactCommand(request, history, focus, modelSelection, modelSelectionOptions, chatMode, progress, token);
		}

		this._recordMemory({
			sessionId: this._memorySessionId(request),
			kind: 'prompt',
			role: 'user',
			title: this._memoryTitle(content),
			body: content,
		});

		// Reload-durable /compact (Caveat 1): if the window reloaded since the user compacted,
		// restore the boundary from its persisted memory note before building the wire.
		await this._restoreCompactionBoundary(this._memorySessionId(request));

		const messages = await this._buildHistoryMessages(history, content, images, this._memorySessionId(request));



		// Prompt-cache clock: the composer's countdown clears the moment a prompt is sent and
		// re-arms when the reply ends (every exit path, including throws and Stop). Only for
		// providers with a real ~5-minute cache window; a local model gets no countdown.
		const cacheClockKey = request.sessionResource.toString();
		const cacheClockOn = providerHasPromptCacheWindow(modelSelection.providerName);
		if (cacheClockOn) { publishV3CacheClockEvent({ kind: 'turn-start', sessionKey: cacheClockKey, at: Date.now() }); }
		try {
			return await this._runAgentLoop(messages, modelSelection, modelSelectionOptions, chatMode, request, progress, token);
		} finally {
			if (cacheClockOn) { publishV3CacheClockEvent({ kind: 'turn-end', sessionKey: cacheClockKey, at: Date.now() }); }
		}

	}



	private async _processAttachments(

		message: string,

		variables: readonly IChatRequestVariableEntry[],

	): Promise<{ content: string; images?: Array<{ data: string; mimeType: string }> }> {

		if (!variables.length) {

			return { content: message };

		}



		const parts: string[] = [message];

		const images: Array<{ data: string; mimeType: string }> = [];



		for (const variable of variables) {

			if (isImageVariableEntry(variable)) {

				const buffer = coerceImageBuffer(variable.value);

				if (buffer) {

					// Derive the mime type from the BYTES, not a default. Defaulting a missing type to
					// 'image/png' put a wrong label on JPEG browser screenshots, which Anthropic rejects
					// with a 400 that kills the whole turn. Sniff magic bytes so every attachment source
					// (browser, drag-drop, paste, future tools) is immune to this class of bug.
					const mimeType = variable.mimeType ?? sniffImageMimeType(buffer) ?? 'image/png';

					images.push({

						data: encodeBase64(VSBuffer.wrap(buffer)),

						mimeType,

					});

					continue;

				}

			}



			if (variable.kind === 'file' && variable.value instanceof URI) {

				try {

					const fileContent = await this.fileService.readFile(variable.value);

					const text = fileContent.value.toString();

					parts.push(`\n---\nATTACHED FILE: ${variable.name}\n\`\`\`\n${text}\n\`\`\`\n---`);

				} catch {

					parts.push(`\n---\nATTACHED FILE: ${variable.name} (${variable.value.fsPath})\n---`);

				}

				continue;

			}



			if ((variable.kind === 'file' || variable.kind === 'implicit') && isLocation(variable.value)) {

				const loc = variable.value as Location;

				try {

					const fileContent = await this.fileService.readFile(loc.uri);

					const lines = fileContent.value.toString().split('\n');

					const start = Math.max(0, loc.range.startLineNumber - 1);

					const end = Math.min(lines.length, loc.range.endLineNumber);

					const snippet = lines.slice(start, end).join('\n');

					parts.push(`\n---\nSELECTION: ${variable.name}\n\`\`\`\n${snippet}\n\`\`\`\n---`);

				} catch {

					parts.push(`\n---\nSELECTION: ${variable.name}\n---`);

				}

				continue;

			}



			if (variable.kind === 'directory' && variable.value instanceof URI) {

				parts.push(`\n---\nATTACHED DIRECTORY: ${variable.name} (${variable.value.fsPath})\n---`);

				continue;

			}



			if (isPasteVariableEntry(variable) && variable.code) {

				parts.push(`\n---\nPASTED CODE: ${variable.name}\n\`\`\`\n${variable.code}\n\`\`\`\n---`);

				continue;

			}



			if (isPromptTextVariableEntry(variable) && typeof variable.value === 'string') {
				// VS Code's ComputeAutomaticInstructions builds a Copilot customization catalog
				// (extension skills from extensions/copilot/, filtered by keyword relevance).
				// V3Code uses void skillsService instead (<skills_index> + <active_skills>).
				if (variable.id === 'vscode.customizations.index') {
					continue;
				}

				parts.push(`\n---\n${variable.name}\n${variable.value}\n---`);

				continue;

			}



			if (variable.kind === 'string' && typeof variable.value === 'string') {

				parts.push(`\n---\n${variable.name}\n${variable.value}\n---`);

			}

		}



		return {

			content: parts.join('\n'),

			images: images.length > 0 ? images : undefined,

		};

	}



	private _extractToolResultText(part: { kind: string }): string {

		if (part.kind === 'toolInvocationSerialized') {

			const serialized = part as { resultDetails?: Array<{ kind?: string; value?: string }>; pastTenseMessage?: { value?: string } };

			const fromDetails = serialized.resultDetails?.map(d => d.value ?? '').filter(Boolean).join('\n');

			if (fromDetails) {

				return fromDetails;

			}

			if (serialized.pastTenseMessage && typeof serialized.pastTenseMessage === 'object' && 'value' in serialized.pastTenseMessage) {

				return serialized.pastTenseMessage.value ?? '';

			}

		}

		if (part.kind === 'toolInvocation') {

			const inv = part as { resultDetails?: Array<{ kind?: string; value?: string }>; pastTenseMessage?: { value?: string } };

			const fromDetails = inv.resultDetails?.map(d => d.value ?? '').filter(Boolean).join('\n');

			if (fromDetails) {

				return fromDetails;

			}

		}

		return '';

	}



	private async _buildHistoryMessages(

		history: IChatAgentHistoryEntry[],

		userMessage: string,

		images?: Array<{ data: string; mimeType: string }>,

		sessionId?: string,

	): Promise<AgentSimpleMessage[]> {

		const messages: AgentSimpleMessage[] = [];



		// Apply a `/compact` boundary: drop the summarized head from the wire and inject the summary
		// as the first (authoritative) user message. The native store still holds every turn.
		const compaction = sessionId ? this._compactionBySession.get(sessionId) : undefined;

		const startIdx = compaction ? Math.min(compaction.boundaryCount, history.length) : 0;

		if (compaction && startIdx > 0) {

			messages.push({ role: 'user', content: `<conversation_summary>\nAuthoritative summary of this conversation's earlier turns, which were compacted to free the model's context. Continue the work from here; the raw turns remain recoverable via deep_recall / get_shadow_record.\n${compaction.summary}\n</conversation_summary>` });

		}

		for (let i = startIdx; i < history.length; i++) {

			const entry = history[i];

			// Skip prior /compact command turns — they're control actions, not conversation.
			if (/^\/compact\b/i.test((entry.request.message ?? '').trim())) { continue; }

			messages.push({ role: 'user', content: entry.request.message });

			// Native chat intentionally removes toolInvocation parts from history. Local turns persist
			// their exact bounded assistant/tool/control wire in result metadata, so prefer it whenever
			// present instead of flattening visible markdown and silently losing reads, edits, errors,
			// or the option the user clicked in ask_user.
			const localTranscript = reconstructLocalAgentTranscript(entry.result.metadata);
			if (localTranscript) {
				for (const message of localTranscript) {
					if (message.role === 'assistant') {
						messages.push({
							role: 'assistant',
							content: message.content,
							anthropicReasoning: null,
							geminiParts: message.geminiParts,
							geminiCallIds: message.geminiCallIds,
							reasoning: null,
						});
					} else if (message.role === 'tool') {
						messages.push({
							role: 'tool',
							content: message.content,
							id: message.id,
							name: message.name as ToolName,
							rawParams: message.rawParams,
						});
					} else {
						messages.push(message);
					}
				}
				continue;
			}

			let segmentText = '';

			let segmentHadThinking = false;

			const flushAssistant = () => {

				if (segmentText || segmentHadThinking) {

					messages.push({

						role: 'assistant',

						content: segmentText,

						anthropicReasoning: null,

						reasoning: null,

					});

					segmentText = '';

					segmentHadThinking = false;

				}

			};

			const ensureAssistantBeforeTool = () => {

				flushAssistant();

				const last = messages[messages.length - 1];

				if (!last || last.role !== 'assistant') {

					messages.push({ role: 'assistant', content: '', anthropicReasoning: null, reasoning: null });

				}

			};

			for (const p of entry.response) {

				if (p.kind === 'markdownContent') {

					segmentText += (p as { content?: { value?: string } }).content?.value ?? '';

				} else if (p.kind === 'thinking') {

					segmentHadThinking = true;

				} else if ((p.kind as string) === 'toolInvocation' || (p.kind as string) === 'toolInvocationSerialized') {

					const toolPart = p as { toolId?: string; toolCallId?: string; parameters?: Record<string, unknown> };

					const modelName = toolPart.toolId ? modelToolNameFromNativeId(toolPart.toolId) : undefined;

					if (modelName) {

						ensureAssistantBeforeTool();

						const resultText = this._extractToolResultText(p);

						messages.push({

							role: 'tool',

							content: resultText || '(no output)',

							id: toolPart.toolCallId ?? toolPart.toolId ?? modelName,

							name: modelName as ToolName,

							rawParams: toolPart.parameters ?? {},

						});

					}

				}

			}

			flushAssistant();

		}



		messages.push({

			role: 'user',

			content: userMessage,

			...(images && images.length > 0 ? { images } : {}),

		});



		return messages;

	}



	private _simpleMessagesToChatMessages(simpleMessages: AgentSimpleMessage[]): ChatMessage[] {

		const chatMessages: ChatMessage[] = [];



		for (const m of simpleMessages) {

			if (m.role === 'user') {

				const images: ImageAttachment[] | undefined = m.images?.map(img => ({

					data: img.data,

					mimeType: img.mimeType as ImageAttachment['mimeType'],

				}));

				chatMessages.push({

					role: 'user',

					content: m.content,

					displayContent: m.content,

					selections: null,

					state: { stagingSelections: [], isBeingEdited: false },

					...(images && images.length > 0 ? { images } : {}),

				});

			} else if (m.role === 'assistant') {

				chatMessages.push({

					role: 'assistant',

					displayContent: m.content,

					reasoning: m.reasoning ?? '',

					anthropicReasoning: m.anthropicReasoning,
					geminiParts: m.geminiParts,
					geminiCallIds: m.geminiCallIds,

				});

			} else if (m.role === 'tool') {

				const images: ImageAttachment[] | undefined = m.images?.map(img => ({

					data: img.data,

					mimeType: img.mimeType as ImageAttachment['mimeType'],

				}));

				// Preserve the real open_project/close_project outcome on the tool message:
				// the workspace-mutation boundary detector reads result.changed/result.removed,
				// and stamping null here silently killed it. The wire content is the tool's
				// structured result serialized as JSON (open_project: {mode, changed, ...}).
				const workspaceMutationResult = workspaceMutationResultFromToolContent(m.name, m.content) as never;

				chatMessages.push({

					role: 'tool',

					content: m.content,

					id: m.id,

					name: m.name,

					rawParams: m.rawParams as RawToolParamsObj,

					type: 'success',

					result: workspaceMutationResult,

					params: m.rawParams as never,

					mcpServerName: this._resolveMcpServerName(m.name),

					...(images && images.length > 0 ? { images } : {}),

				});

			}

		}



		return chatMessages;

	}



	/**
	 * Best-effort per-category token breakdown for the context-usage widget's hover
	 * detail (the "what's filling the window" list). Buckets, by role:
	 *   Context      → System prompt, Tool definitions
	 *   Conversation → Tool results, Messages
	 * Splitting "Tool results" out of conversation matters most: tool output (file
	 * reads, terminal dumps, search hits) is the biggest TRANSIENT spike, and seeing
	 * it as its own line is how the user understands a turn that suddenly balloons.
	 * Each bucket is estimated (~chars/4) then normalized against the REAL API-reported
	 * promptTokens; the unaccounted remainder (tool schemas + request framing the model
	 * counts but we don't estimate) becomes "Tool definitions". If our estimate overshoots
	 * the real total (prompt caching / chars-4 drift), the known buckets are scaled to fit
	 * so the list sums to ~100%. Returns undefined when there's no usable total.
	 */
	private _estimatePromptBreakdown(
		systemMessage: string | undefined,
		messages: unknown[],
		totalPromptTokens: number,
	): Array<{ category: string; label: string; percentageOfPrompt: number }> | undefined {
		if (!totalPromptTokens || totalPromptTokens <= 0) {
			return undefined;
		}
		const est = (s: string) => Math.max(0, Math.ceil(s.length / 4));
		const systemTokens = est(systemMessage ?? '');
		let convTokens = 0;
		let toolResultTokens = 0;
		for (const m of (messages as Array<{ role?: string; content?: unknown }>)) {
			const c = m?.content;
			const t = est(typeof c === 'string' ? c : JSON.stringify(c ?? ''));
			if (m?.role === 'tool') { toolResultTokens += t; } else { convTokens += t; }
		}
		let sysT = systemTokens;
		let convT = convTokens;
		let toolResT = toolResultTokens;
		let toolDefT: number;
		const accounted = systemTokens + convTokens + toolResultTokens;
		if (accounted > totalPromptTokens) {
			const scale = totalPromptTokens / accounted;
			sysT *= scale;
			convT *= scale;
			toolResT *= scale;
			toolDefT = 0;
		} else {
			toolDefT = totalPromptTokens - accounted;
		}
		const pct = (n: number) => Math.max(0, Math.min(100, (n / totalPromptTokens) * 100));
		const details = [
			{ category: 'Context', label: 'System prompt', percentageOfPrompt: pct(sysT) },
			{ category: 'Context', label: 'Tool definitions', percentageOfPrompt: pct(toolDefT) },
			{ category: 'Conversation', label: 'Tool results', percentageOfPrompt: pct(toolResT) },
			{ category: 'Conversation', label: 'Messages', percentageOfPrompt: pct(convT) },
		].filter(d => d.percentageOfPrompt >= 0.05);
		return details.length > 0 ? details : undefined;
	}

	private async _runAgentLoop(

		simpleMessages: AgentSimpleMessage[],

		modelSelection: ModelSelection,

		modelSelectionOptions: unknown,

		chatMode: ChatMode,

		request: IChatAgentRequest,

		progress: (parts: IChatProgress[]) => void,

		token: CancellationToken,

	): Promise<IChatAgentResult> {



		// Local models use a Cline-style finite runtime policy. The native V3Code loop remains
		// the host so prompts, tool cards, approvals, MCP and cancellation still have one owner.
		const localRuntime = isLocalAgentProvider(modelSelection.providerName)
			? new V3CodeLocalAgentRuntime(modelSelection.modelName)
			: undefined;
		const localTranscript = localRuntime || modelSelection.providerName === 'gemini' ? new LocalAgentTranscriptRecorder() : undefined;
		const latestUserText = [...simpleMessages].reverse().find(m => m.role === 'user')?.content ?? '';
		// V Voice is transport metadata, not prose. A text sniff silently stopped
		// relaying events whenever the latest visible message omitted the old marker.
		const voiceMode = request.isV3VoiceRelay === true;
		let voiceFinalPublished = false;
		const publishVoiceFinal = (text: string, outcome: 'completed' | 'blocked' | 'question'): void => {
			if (!voiceMode || voiceFinalPublished) {
				return;
			}
			const clean = text.replace(/\s+/g, ' ').trim().slice(-4000);
			if (!clean) {
				return;
			}
			voiceFinalPublished = true;
			publishV3VoiceAgentEvent({ kind: 'final', sessionResource: request.sessionResource.toString(), text: clean, outcome });
		};
		const finish = (result: IChatAgentResult = {}): IChatAgentResult => {
			if (!token.isCancellationRequested && result.errorDetails?.message) {
				publishVoiceFinal(result.errorDetails.message, 'blocked');
			}
			const transcript = localTranscript?.metadataValue();
			return {
				...result,
				metadata: {
					...result.metadata,
					usedProvider: modelSelection.providerName,
					usedModel: modelSelection.modelName,
					...(transcript ? { [LOCAL_AGENT_TRANSCRIPT_METADATA_KEY]: transcript } : {}),
				},
			};
		};
		const MAX_TOOL_STEPS = localRuntime?.limits.maxIterations ?? 200;
		// Soft-continuation guard: openai-style models (DeepSeek/Grok) sometimes narrate a next
		// action in prose but emit NO tool_call ("narrates then stops"). Nudge them to actually
		// call the tool and continue — hard-capped per turn so it can never loop forever.
		//
		// Two regimes (see the soft-continuation block ~1480 below):
		//   - HARD pattern  (zero tool calls anywhere this turn yet, narration ended the step):
		//     this is the "I'll read the file" → stop loop the user reads as the agent stalling.
		//     Force action on the FIRST occurrence — cap effectively 1 — and use a stronger
		//     reminder. Polite repeat-rounds rewarded that exact pattern.
		//   - SOFT pattern  (tool calls already happened this turn, then a narrated next step):
		//     legitimate mid-stream "now I'll …" — keep the larger cap so the agent can recover.
		// Two mid-turn nudges are enough to recover a model that narrated its next tool call.
		// A third often turns a clean stopping point into the "too strong" continue loop users feel.
		const MAX_SOFT_CONTINUES = 2;
		const MAX_SOFT_CONTINUES_HARD_NARRATION = 1;
		let softContinueCount = 0;
		let toolCallsThisTurn = 0;
		// Fix 4: count read/run/inspect tool calls so the claim-verification gate can tell
		// whether the assistant ACTUALLY consulted reality this turn. If the model asserts
		// concrete file contents or command output without ever firing a verifying tool, we
		// queue a private reminder for the NEXT turn (see _pendingVerificationReminder).
		const VERIFYING_TOOLS = new Set<string>([
			'read_file', 'run_command', 'ls_dir', 'get_dir_tree', 'find_text',
			'search_in_file', 'search_pathnames_only', 'search_for_files', 'semantic_search',
			'read_lint_errors', 'list_code_usages', 'get_file_context', 'get_file_dependencies',
			'get_symbol_context', 'web_search', 'web_fetch',
		]);
		let verifyingToolCallsThisTurn = 0;
		// Two defects made this both MISS real stalls and FIRE on finished answers:
		//   1. Apostrophes: `i'?ll` accepted only the ASCII '. Models overwhelmingly emit the curly
		//      U+2019 form, so a curly "I'll read the file" — the most common way a model announces
		//      a next step — never matched unless the sentence also happened to contain "now i".
		//   2. Verb stems had no closing boundary, so `open` matched inside "openAI" ("right now I'm
		//      openAI/gpt-5.6-sol" tripped it), `add` inside "address", `fix` inside "fixture". That
		//      nudged already-complete answers and produced the duplicate "no action needed" replies.
		// Stems now end on \b with genuine verb suffixes allowed, so "investigating"/"verified"/
		// "running"/"written" still match while in-word substrings do not.
		const INTENT_TO_ACT_RE = /\b(?:let me|i['\u2019]?ll|i will|now i|next i|i['\u2019]?m going to|let['\u2019]?s)\b[^.?!\n]{0,80}\b(?:search|look|read|check|find|grep|scan|inspect|edit|fix|open|add|implement|refactor|trace|gather|pull|fetch|run|execut|investigat|explor|examin|writ|creat|updat|modif|chang|verif|locat|wir)(?:e|es|ed|ing|ion|ions|s|y|ies|ied|ying|ning|ten)?\b/i;
		// Unfinished work stated WITHOUT a first-person announcement. INTENT_TO_ACT_RE only fires on
		// "let me / I'll / now I …", so a model that closes with imperative or declarative plan prose
		// slipped through entirely: the loop exited mid-task with softContinues=0 (no nudge ever fired)
		// and the user read it as the agent quitting on them. Real observed tails that must match:
		//   "Proceed with the production pairing smoke test and wire the Remote-button QR to this WEB_URL."
		//   "So: hosting is finished; full product integration still needs that final QR wiring and end-to-end test."
		// Kept deliberately narrow (explicit next-step / remaining-work markers only) and evaluated
		// against the CLOSING of the reply so it does not fire on prose that merely mentions work.
		const PENDING_WORK_RE = /\b(?:proceed with|next step|next up|next,|then run|remaining(?: work|:)?|still (?:needs?|requires?|left|outstanding)|yet to be|not yet (?:done|wired|tested|verified|implemented|applied|run)|needs? to be (?:wired|run|tested|verified|implemented|applied|added|done)|to-?do:)\b/i;
		// Do not nudge when the model is clearly waiting on the user (questions, "say the word", etc.)
		// Accepts both apostrophe forms for the same reason as INTENT_TO_ACT_RE above — with ASCII-only
		// apostrophes, a curly "when you're ready" failed to suppress and the model got nudged while
		// it was legitimately waiting on Daniel.
		const AWAITING_USER_DECISION_RE = /(?:\?\s*$|(?:\b(?:let me know|say the word|your call|when you(?:['\u2019]re| are) ready|want me to|shall i|should i|would you like|do you want|if you(?:['\u2019]d like| prefer)|awaiting your|ready when you are|tell me (?:if|whether)|up to you)\b)[^.!?\n]{0,160}\.?\s*$)/i;

		let retries = 0;

		// Event-driven plan nudge: if the agent quietly edits several files without ever
		// tracking a plan, fire ONE reminder (appended to a tool result, so it costs zero
		// static prompt weight and only appears when actually warranted). This mirrors how
		// the strong agents stay disciplined without a bloated system prompt.
		const MUTATING_TOOLS = new Set<string>(['create_file_or_folder', 'rewrite_file', 'append_file', 'edit_file', 'delete_file_or_folder']);
		// Tools with no side effects — safe to dispatch concurrently when a turn returns several.
		// Anything not listed (edits, terminal, MCP/unknown tools) is treated as mutating and runs serially.
		const READONLY_TOOLS = new Set<string>([
			'read_file', 'ls_dir', 'get_dir_tree', 'search_pathnames_only', 'search_for_files',
			'search_in_file', 'read_lint_errors', 'find_text', 'semantic_search', 'get_file_context',
			'get_file_dependencies', 'get_symbol_context', 'get_call_graph', 'pack_context',
			'get_project_briefing', 'list_notes', 'search_notes', 'workspace_delta', 'search_chat_memory', 'search_memory', 'get_memory_checkpoint', 'get_chat_session', 'get_chat_thread',
			'get_editorial_briefing', 'search_editorial',
			'list_code_usages', 'web_search', 'web_fetch',
		]);
		// Slow / network-heavy tools: run first when batched so they aren't queued behind a read storm.
		const ISOLATED_SLOW_TOOLS = new Set<string>(['generate_image', 'run_tests']);
		const MAX_PARALLEL_READONLY = 6;
		// HEAVY memory-replay tools: each returns a whole chat session / raw shadow record verbatim, which
		// can be huge. Firing several in one turn (the observed bug: two get_chat_session in parallel)
		// dumps so much text that the response overflows the token budget and the harness cuts the turn
		// off mid-stream. Allow at most ONE per turn and never batch them in parallel — use the compact
		// search_chat_memory / list_notes to FIND the right session first, then replay one at a time.
			const HEAVY_MEMORY_TOOLS = new Set<string>(['get_chat_session', 'get_memory_checkpoint', 'deep_recall', 'get_shadow_record', 'get_chat_thread']);
		const MAX_HEAVY_MEMORY_PER_TURN = 1;
		let heavyMemoryCallsThisTurn = 0;
		// If the LIVE user request explicitly asks for current/web research, do not let a
		// confident model silently substitute stale priors and start writing. This is narrow
		// by design: ordinary edits stay fast, while phrases such as "research current state",
		// "search the web", "look this up", or "as of today" create a real evidence gate.
		const explicitResearchRequested = explicitlyRequestsCurrentResearch(latestUserText);
		let explicitResearchSatisfied = false;
		/** The research gate bounces a mutating call at most ONCE per turn (warn-once-then-allow). */
		let researchGateWarned = false;
		const RESEARCH_PREFLIGHT_TOOLS = new Set<string>(['web_search', 'web_fetch']);
		const RESEARCH_GATE_EXEMPT_TOOLS = new Set<string>(['update_plan', 'read_skill', 'run_subagent', 'launch_subagent', 'ask_user']);
		const explicitUserPaths = new Set<string>();
		const pathRe = /(?:^|[\s`"'])((?:[A-Za-z]:\\)?[\w.-]+(?:[\\/][\w.@$+() -]+)+\.[A-Za-z0-9]{1,10}|[\w.@$+() -]+\.(?:ts|tsx|js|jsx|json|md|css|scss|py|go|rs|java|cs|cpp|c|h|html|svelte))(?:$|[\s`"',;:])/g;
		for (const m of latestUserText.matchAll(pathRe)) {
			const p = m[1]?.replace(/\\/g, '/').toLowerCase();
			if (p) {
				explicitUserPaths.add(p);
				const base = p.split('/').pop();
				if (base) { explicitUserPaths.add(base); }
			}
		}
		const userAllowsTaskSwitch = /\b(resume|continue|switch\s+to|go\s+back\s+to|pick\s+up|previous\s+task|old\s+task|handoff)\b/i.test(latestUserText);
		// Warn-once-then-allow: hard-blocking every off-named-file mutation broke ordinary
		// multi-file work ("fix the bug in auth.ts" blocked the necessary companion edit to
		// logger.ts). First off-target write per file gets a warning; the model re-issuing the
		// SAME call is treated as confirmation the edit serves the current task. Real drift
		// (memory-driven task switching) doesn't survive an explicit "are you sure" bounce.
		const driftWarnedTargets = new Set<string>();
		const isPathDrift = (tc: RawToolCallObj): string | undefined => {
			if (userAllowsTaskSwitch || explicitUserPaths.size === 0 || !MUTATING_TOOLS.has(tc.name)) { return undefined; }
			const rawUri = tc.rawParams?.uri;
			if (typeof rawUri !== 'string' || !rawUri) { return undefined; }
			const target = rawUri.replace(/\\/g, '/').toLowerCase();
			const targetBase = target.split('/').pop() ?? target;
			for (const p of explicitUserPaths) {
				if (target.includes(p) || p.includes(targetBase) || targetBase === p) { return undefined; }
			}
			return rawUri;
		};
		let fileMutations = 0;
		const hasTrackedPlan = simpleMessages.some(message => typeof message.content === 'string' && message.content.includes('<active_plan>'));
		let planUsed = hasTrackedPlan;
		let planNudgeSent = false;
		let mutationsSincePlanUpdate = 0;
		// Keep long autonomous runs honest without interrupting normal implementation
		// rhythm. Three mutations was noisy enough to steer the model away from the
		// work; eight still catches a stale checklist during a genuinely large build.
		const PLAN_PROGRESS_NUDGE_INTERVAL = 8;
		let planFinalReconcileSent = false;

		// Spiral guard: cap consecutive read-only-only steps so a "let me read everything" loop
		// can't run forever, and remember exact tool+param signatures so an identical repeated call
		// gets told to stop (the per-path failure gate below misses this when the agent reads MANY
		// different ghost/real paths, none hitting the same-path threshold).
		// Raised from 8: a genuine cross-subsystem trace (find the call site, read it, follow the
		// import, read that, check the test, check the config) legitimately runs 10+ read-only steps
		// while every step returns NEW information. At 8 the agent was told to "STOP INVESTIGATING"
		// mid-trace and answer from partial evidence, which is the opposite of the read-before-write
		// rule it is also required to follow. The repeat guard already catches the actual spiral
		// (the SAME call twice); this cap only needs to stop unbounded reading.
		const MAX_READONLY_STREAK = 14;
		let readOnlyStreak = 0;
		const toolCallSignatures = new Map<string, number>();
		/**
		 * Tools whose result depends on WORKSPACE state, so an identical repeat is legitimate once a
		 * file has changed. The repeat guard's premise ("the result will not change") is false for
		 * these the moment an edit lands, and it was firing on exactly the verify-fix-verify loop the
		 * agent is required to run: edit -> compile -> fix -> compile. The second compile is the point.
		 * Signatures for these are cleared on every mutation rather than exempted outright, so a true
		 * spiral (the same command twice with NO edit between) is still caught.
		 */
		const clearRepeatSignaturesOnMutation = () => {
			for (const key of [...toolCallSignatures.keys()]) {
				if (/^(?:run_command|run_persistent_command|run_tests|get_build_errors|read_file|read_lint_errors|git_diff|git_status|session_diff):/.test(key)) {
					toolCallSignatures.delete(key);
				}
			}
			// Inspection targets are workspace state too: after a create/edit/delete, re-listing a
			// directory genuinely returns something new, so the exact-repeat refusal must not fire on
			// the list -> edit -> list-again confirmation loop. Only the repeat set is cleared;
			// budgetedInspectionTargets is never cleared, so a mutation cannot hand back unlimited
			// exploration by resetting the DISTINCT-target budget.
			inspectionTargets.clear();
		};

		// Read-only TERMINAL classification (Phase 3 loop-breakers) — pure predicates live in
		// common/memory/loopGuards.ts (headless-tested). The streak/inspection guards used to see only
		// the READONLY_TOOLS set, so `ls -la` via run_command counted as "work" and reset the streak —
		// the agent alternated ls_dir with `ls -la` forever. Classifying shell commands fixes that.
		const terminalCommandOf = (tc: RawToolCallObj): string => {
			const raw = tc.rawParams as { command?: unknown } | undefined;
			return typeof raw?.command === 'string' ? raw.command.trim() : '';
		};
		const isReadOnlyCall = (tc: RawToolCallObj): boolean => isReadOnlyCallPure(tc.name, READONLY_TOOLS.has(tc.name), terminalCommandOf(tc));
		const isInspectionCall = (tc: RawToolCallObj): boolean => isInspectionCallPure(tc.name, terminalCommandOf(tc));
		const normalizedSignature = (tc: RawToolCallObj): string => normalizedInspectionSignature(tc.name, terminalCommandOf(tc), JSON.stringify(tc.rawParams ?? {}));
		let inspectionBlocked = false;
		/**
		 * Inspection targets seen since the last MUTATION. Cleared by clearRepeatSignaturesOnMutation
		 * so the list -> edit -> list-again confirmation loop is not refused as a repeat.
		 */
		const inspectionTargets = new Set<string>();
		/**
		 * DISTINCT inspection targets for the WHOLE turn — this is what the budget counts, and it is
		 * never cleared. Keeping it separate from inspectionTargets means a mutation forgives an exact
		 * repeat without also handing back unlimited fresh exploration.
		 */
		const budgetedInspectionTargets = new Set<string>();

		// Failure gate (DeepSeek's "death spiral"): count CONSECUTIVE failures per target
		// (file uri, else tool name). At 3, inject a one-shot hard checkpoint forcing the
		// agent to gather new info (re-read / web_search / ask) before a 4th blind attempt.
		const failuresByKey = new Map<string, number>();
		const failureGateSent = new Set<string>();

		let planWebSearchCount = 0;
		let planGreenfield = false;
		if (chatMode === 'plan') {
			try {
				const directoryStr = await this.directoryStrService.getAllDirectoriesStr({
					cutOffMessage: '(tree truncated)',
				});
				planGreenfield = isGreenfieldWorkspace(directoryStr);
			} catch {
				planGreenfield = true;
			}
		}

		// Non-vision models: optional vision describe (Settings → imageDescribeMode).
		const describeResult = await describeImagesForNonVisionModel(
			// Only user messages carry images; the util skips non-user/no-image
			// entries, so passing the wider agent message union is safe.
			simpleMessages as unknown as VisionDescribeUserMessage[],
			modelSelection,
			this.settingsService,
			this.llmMessageService,
			this.convertService,
			token,
			{
				onDescribeStart: ({ imageCount, visionModel }) => {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`Describing ${imageCount} image(s) with **${visionModel.modelName}**…`),
					}]);
				},
				onDescribeError: ({ message, visionModel }) => {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`Image describe failed (${visionModel.modelName}): ${message}`),
					}]);
				},
				promptManualDescribe: async ({ imageCount, visionModel, activeModel }) => {
					if (!visionModel) {
						return 'skip';
					}
					const { result } = await this.dialogService.prompt<'describe' | 'skip'>({
						type: 'question',
						message: `Describe ${imageCount} image(s) before sending to ${activeModel.modelName}?`,
						detail: `Uses ${visionModel.modelName} to transcribe images into text for your text-only model.`,
						buttons: [
							{ label: 'Describe & send', run: () => 'describe' as const },
							{ label: 'Send without describing', run: () => 'skip' as const },
						],
						cancelButton: true,
					});
					if (result === 'describe' || result === 'skip') {
						return result;
					}
					return 'cancel';
				},
			},
		);
		if (describeResult === 'cancelled') {
			return finish({ errorDetails: { message: 'Cancelled' } });
		}

		// Fix 4 (consume): if the previous turn for this session asserted concrete file/command
		// facts WITHOUT calling a verifying tool, a reminder was queued at end-of-turn. Prepend
		// it as a private AUTOMATED-SYSTEM-NOTICE so the model verifies before re-asserting.
		const verificationSessionId = this._memorySessionId(request);
		const pendingVerification = this._pendingVerificationReminder.get(verificationSessionId);
		if (pendingVerification) {
			this._pendingVerificationReminder.delete(verificationSessionId);
			simpleMessages.push({ role: 'user', content: pendingVerification });
		}

		// Background notices (launch_subagent results, team-board overlaps, Multitask reconcile)
		// addressed to this native session are parked at the native notice board because this
		// session has no thread in the legacy store. Deliver what arrived while the user was
		// idle before the model plans this turn.
		const noticeKey = request.sessionResource.toString();
		const idleNotices = this.nativeNoticeService.drain(noticeKey);
		if (idleNotices.length > 0) {
			simpleMessages.push({ role: 'user', content: formatNativeNotices(idleNotices) });
		}
		// Stop on a native parent cascades to its background workers, mirroring the legacy
		// engine's abortRunning. One-shot: the listener disposes itself after firing.
		const cancelChildren = token.onCancellationRequested(() => {
			cancelChildren.dispose();
			for (const child of this.chatThreadService.getSubagentsForThread(noticeKey)) {
				if (child.status === 'running') { void this.chatThreadService.cancelSubagent(child.subagentThreadId); }
			}
		});


		// Per-turn token accounting. Summed ACROSS steps on purpose: every step re-sends the
		// growing prompt as a fresh API call, so the sum is what the turn actually cost/billed.
		// Attached to the reply memory event (meta.tokens) so per-session/task/event totals are
		// derivable later, and surfaced live via the token tracker service.
		let turnPromptTokens = 0;
		let turnCompletionTokens = 0;

		for (let step = 0; step < MAX_TOOL_STEPS; step++) {

			if (token.isCancellationRequested) {

				return finish();

			}



			// Per-step "busy" narration. A progressMessage auto-hides the moment real
			// content (assistant text or a tool card) follows it (see
			// ChatProgressContentPart.isHidden), so these never pile up — each only fills
			// the latency gap before the step produces output, giving a live
			// "working" feel instead of dead air between tool calls. The label rotates per
			// step so a multi-step turn never shows the same flat "Reviewing results…" twice.
			progress([{
				kind: 'progressMessage',
				content: new MarkdownString(this._stepNarration(step)),
				shimmer: true,
			}]);



			const chatMessages = this._simpleMessagesToChatMessages(simpleMessages);

			// `.agent.md` tools and Configure Tools are exposed as native tool ids. Translate
			// disabled entries before prompt assembly so excluded schemas never reach the model;
			// execution-time checking below remains a defense-in-depth guard.
			const selectedToolExclusions = modelToolNamesDisabledBySelection(request.userSelectedTools, this.mcpService.getMCPTools());
			for (const unavailableTool of modelToolNamesMissingNativeRegistration(nativeId => !!this.nativeToolsService.getTool(nativeId))) {
				if (!selectedToolExclusions.includes(unavailableTool)) {
					selectedToolExclusions.push(unavailableTool);
				}
			}
			if (localRuntime && shouldSuppressLocalAskUser(latestUserText) && !selectedToolExclusions.includes('ask_user')) {
				selectedToolExclusions.push('ask_user');
			}

			let { messages, separateSystemMessage, coreToolsOnly, excludeTools } = await this.convertService.prepareLLMChatMessages({

				chatMessages,

				chatMode,

				modelSelection,

				sessionId: this._memorySessionId(request),

				excludeTools: selectedToolExclusions,

			});

			separateSystemMessage = this._appendModeInstructions(separateSystemMessage, request);



			const result = await this._callLLM(messages, separateSystemMessage, modelSelection, modelSelectionOptions, chatMode, coreToolsOnly, excludeTools, this._memorySessionId(request), progress, token);



			if (result.kind === 'abort') {

				return finish();

			}



			if (result.kind === 'error') {

				const retryable = result.retryable ?? isRetryableErrorMessage(result.message);

				// Deterministic client errors (400/401/...) fail identically on retry — surface now.
				if (!retryable) {
					return finish({ errorDetails: { message: result.message } });

				}

				retries++;

				if (retries >= CHAT_RETRIES) {
					return finish({ errorDetails: { message: result.message } });

				}

				// Exponential backoff before retrying a transient error, so an overloaded endpoint
				// isn't hammered with instant back-to-back retries (the no-backoff storm from the RCA).
				if (token.isCancellationRequested) {

					return finish();

				}



				const backoff = backoffMsForError(result.message, retries, RETRY_DELAY_MS);

				// Surface exactly one human line while waiting. It auto-hides when the retry produces
				// content or the final native error arrives, so repeated attempts never make a wall.
				if (retries === 1) {
					progress([{

						kind: 'progressMessage',

						content: new MarkdownString(retryStatusForError(result.message)),

						shimmer: true,

					}]);
				}



				try {

					// Cancel-aware: pass the token so hitting Stop during a retry wait aborts the
					// backoff immediately instead of waiting the full delay (the prior call ignored
					// the token, leaving Stop unresponsive for up to 7.5s on the third retry).
					await timeout(backoff.delayMs, token);

				} catch {

					// timeout(token) rejects on cancellation — honor it.
					return finish();

				}



				if (token.isCancellationRequested) {

					return finish();

				}



				continue;

			}



			if (result.promptTokens !== undefined || result.completionTokens !== undefined) {

				turnPromptTokens += result.promptTokens ?? 0;
				turnCompletionTokens += result.completionTokens ?? 0;

				progress([{

					kind: 'usage',

					promptTokens: result.promptTokens ?? 0,

					completionTokens: result.completionTokens ?? 0,

					promptTokenDetails: this._estimatePromptBreakdown(separateSystemMessage, simpleMessages, result.promptTokens ?? 0),

				}]);

			}



			const toolCalls = (result.toolCalls && result.toolCalls.length) ? result.toolCalls : (result.toolCall ? [result.toolCall] : []);
			localTranscript?.recordAssistant({
				content: result.text,
				reasoning: result.reasoning,
				geminiParts: result.geminiParts,
				toolCalls,
			});
			simpleMessages.push({

				role: 'assistant',

				content: result.text,

				anthropicReasoning: result.anthropicReasoning,
				geminiParts: result.geminiParts,
				geminiCallIds: result.geminiParts ? toolCalls.map(call => call.id) : undefined,

				reasoning: result.reasoning,

			});

			toolCallsThisTurn += toolCalls.length;
			for (const tc of toolCalls) {
				if (VERIFYING_TOOLS.has(tc.name)) { verifyingToolCallsThisTurn++; }
			}

			if (toolCalls.length === 0) {

				if (!(result.text ?? '').trim()) {
					// THINKING-ONLY STEP: with interleaved thinking enabled, Claude can return a step that
					// carries a reasoning block but no visible text and no tool_use (e.g. it reasoned right up
					// to the output-token budget, or thought without committing an action yet). That is NOT a
					// failed/empty response — treating it as fatal here is exactly the "chat dies right after
					// thinking" drop. So if we got reasoning, nudge once and continue the loop (bounded by the
					// soft-continue cap) so the model actually answers or calls its tool on the next step.
					const hadReasoning = !!((result.reasoning ?? '').trim() || (result.anthropicReasoning && result.anthropicReasoning.length > 0));
					const recoverEmptyTurn = localRuntime
						? localRuntime.shouldRecoverEmptyTurn(hadReasoning)
						: hadReasoning && softContinueCount < MAX_SOFT_CONTINUES;
					if (recoverEmptyTurn) {
						if (!localRuntime) { softContinueCount++; }
						// Surface the silent recovery — without this, the user just sees "thinking" then a
						// long pause as we round-trip an invisible nudge. progressMessage auto-hides on the
						// next real content so it never piles up.
						progress([{
							kind: 'progressMessage',
							content: new MarkdownString(localRuntime
								? 'Local model produced reasoning without an answer — requesting one clean correction…'
								: `Thought without acting — nudging the model to continue (${softContinueCount}/${MAX_SOFT_CONTINUES})…`),
							shimmer: true,
						}]);
						// NOTE: the transient shimmer above is the anti-freeze signal; the nudge reason is
						// logged to DevTools (see [agent-step]/[agent-stop]). We intentionally do NOT inject a
						// permanent markdown breadcrumb into the reply — it leaked internal loop telemetry into
						// user-visible text and misfired on trivial no-tool answers.
						const emptyTurnReminder = `[AUTOMATED SYSTEM NOTICE — the user did NOT send this; do not treat it as user input]\n<system_reminder>Your previous step produced only internal reasoning — no visible reply and no tool call, so nothing happened. Continue now: either call the tool you intend to use, or give the user your answer in plain text.</system_reminder>`;
						localTranscript?.recordContinuation(emptyTurnReminder);
						simpleMessages.push({ role: 'user', content: emptyTurnReminder });
						continue;
					}
					const hint = modelSelection.providerName === 'ollama'
						? ' Check that `ollama serve` is running and try `ollama run <model>` in a terminal.'
						: '';
					const msg = `The model returned an empty response (${modelSelection.providerName}/${modelSelection.modelName}).${hint}`;
					progress([{ kind: 'markdownContent', content: new MarkdownString(msg) }]);
					return finish({ errorDetails: { message: msg } });
				}

				// SOFT CONTINUATION: openai-style models (DeepSeek/Grok) sometimes narrate a next
				// action in prose ("Let me search...", "Now I'll edit...") without emitting a
				// tool_call, which ends the turn prematurely. If the tail of the reply clearly
				// signals an unfinished action and we're under the per-turn cap, nudge the model to
				// actually call the tool and continue the loop instead of stopping. Also Anthropic
				// after a successful tool — Opus sometimes finishes its thought with "now I'll
				// write..." after a previous tool succeeded but then stops without the next
				// tool_use — same drop, different model.
				const replyText = (result.text ?? '').trim();
				const replyTail = replyText.slice(-560);
				// A next-action signal that actually indicates a stall sits at the CLOSING of the reply —
				// it is the last thing said before the model should have called the tool. Matching against
				// the looser 560-char tail also fired on completed answers that merely contained a phrase
				// like "now I…" mid-text, which cost a pointless round-trip and produced the duplicate
				// "no action needed" replies. Scope the trigger to the close; keep replyTail for quoting.
				const replyClose = replyText.slice(-400);
				// PENDING_WORK_RE is gated to agent mode. It matches "next step", "remaining",
				// "still needs", "to-do:", "proceed with" — the ordinary closing shape of a plan, an
				// investigation report or a handoff summary. In read and plan mode that prose IS the
				// deliverable, so matching it there is close to a guaranteed false positive: a correct,
				// complete answer gets told it has not done the work, and the user sees a finished reply
				// followed by a second appended one.
				//
				// INTENT_TO_ACT_RE ("let me read the file...") stays ungated — that is a genuine stall
				// signal in every mode, and removing it in read/plan would reintroduce the premature-stop
				// bug in the two modes used for investigation.
				const hasUnfinishedWorkSignal = INTENT_TO_ACT_RE.test(replyClose)
					|| (chatMode === 'agent' && PENDING_WORK_RE.test(replyClose));
				// HARD-narration regime: ZERO tool calls anywhere this turn AND the reply clearly
				// describes a next action / leaves work stated-but-undone. This is the "I'll read the
				// file → [stop]" and "Proceed with the smoke test → [stop]" pattern the user reads as a
				// stall. Effective cap = 1: bite on the FIRST occurrence with a stronger reminder. The
				// legacy (cap=3) regime applies only when the model already ran tools this turn and is
				// narrating a *next* step — that is recoverable mid-stream and OK to nudge gently.
				// Explicit early gate, not a && appended to shouldRecoverNarration. That expression is a
				// ternary — adding the flag to one branch leaves the localRuntime branch unguarded and
				// still burning its one-shot budget, so the setting would appear not to work.
				const nudgesEnabled = this.settingsService.state.globalSettings.softContinueNudges !== false;
				const isHardNarration = toolCallsThisTurn === 0;
				const effectiveCap = isHardNarration ? MAX_SOFT_CONTINUES_HARD_NARRATION : MAX_SOFT_CONTINUES;
				const canUseTools = chatMode === 'agent' || chatMode === 'read' || chatMode === 'plan' || chatMode === 'multitask' || chatMode === 'debug';
				const shouldRecoverNarration = localRuntime
					? canUseTools && localRuntime.shouldRecoverNarration(replyText)
					: canUseTools
						&& softContinueCount < effectiveCap
						&& hasUnfinishedWorkSignal
						&& !AWAITING_USER_DECISION_RE.test(replyTail);
				if (nudgesEnabled && shouldRecoverNarration) {
					softContinueCount++;
					// Surface to the user — narrating "let me check..." without acting is the
					// "narrates then stops" pattern; without this signal a 30s nudge round-trip
					// looks like a freeze.
					progress([{
						kind: 'progressMessage',
						content: new MarkdownString(`Model described next action but didn't call a tool — nudging it to act (${softContinueCount}/${effectiveCap})…`),
						shimmer: true,
					}]);
					// NOTE: the transient shimmer above is the anti-freeze signal; the nudge reason is logged
					// to DevTools ([agent-stop]). We intentionally do NOT inject a permanent markdown
					// breadcrumb here — the loose INTENT_TO_ACT_RE false-fires on ordinary no-tool answers,
					// so the "— nudge x/y" note leaked into completed replies (the weird text the user saw).
					// This is an AUTOMATED control notice, NOT the user. It must be role:'user' because it
					// follows an assistant text-only turn (Anthropic rejects a standalone tool/system turn
					// there), so we self-identify hard: the model previously mistook injected reminders —
					// and a real "ok" typed mid-stream — for the human acknowledging a stall. The framing
					// below makes that impossible to misread.
					//
					// Two reminder strengths: HARD (zero tools this turn) is non-negotiable — describing
					// the action without running it IS the failure; SOFT (tools already ran, narrated next
					// step) reuses the original wording.
					const reminder = isHardNarration
						// Offers the exit FIRST. The previous wording asserted "You have not done the work
						// yet" — which is false whenever this fires on a complete answer, and left no
						// graceful way to decline, so the model appended a second reply to a correct one.
						? `[AUTOMATED SYSTEM NOTICE — the user did NOT send this; do not treat it as user input or a reply to your work]\n<system_reminder>Your last step ended without a tool call, after mentioning work to do ("${replyTail.slice(-160).replace(/\n+/g, ' ')}"). If you were about to act, call that tool now. If you are actually finished, or the remaining items are the user's to decide, say so plainly in one line — that is a valid response and this notice will not repeat.</system_reminder>`
						: `[AUTOMATED SYSTEM NOTICE — the user did NOT send this; do not treat it as user input or a reply to your work]\n<system_reminder>You described a next action but did not call a tool, so nothing ran. If you intend to act, call the tool now in this same turn. If you are genuinely finished, say so plainly without describing another action.</system_reminder>`;
					simpleMessages.push({
						role: 'user',
						content: reminder,
					});
					localTranscript?.recordContinuation(reminder);
					continue;
				}

				// Final plan reconciliation: a model can produce an excellent implementation and
				// still leave the visible checklist at 1/7. If files changed after the most recent
				// update_plan call, allow one private continuation whose only job is to reconcile
				// the plan before the turn closes. This is guarded and fires only for a clean final
				// reply, so it cannot create a continuation loop or interrupt a real user question.
				const looksLikeCleanFinalReply = replyText.length > 0
					&& !INTENT_TO_ACT_RE.test(replyText.slice(-280))
					&& !PENDING_WORK_RE.test(replyText.slice(-280))
					&& !AWAITING_USER_DECISION_RE.test(replyText);
				// Debug mode joins agent here: it has a bounded fix surface (it DOES mutate files) and
				// its own mode prompt already requires mirroring progress into update_plan, so a debug
				// turn can end on a stale checklist in exactly the same way. Still one-shot and still
				// gated on planUsed + real mutations, so modes without a plan are unaffected.
				if (nudgesEnabled
					&& (chatMode === 'agent' || chatMode === 'debug')
					&& looksLikeCleanFinalReply
					&& planUsed
					&& mutationsSincePlanUpdate > 0
					&& !planFinalReconcileSent) {
					planFinalReconcileSent = true;
					// The checklist is the requirement list (see the turn-start decompose step in the
					// mode prompt), so reconciling it is not bookkeeping — it is the last point at
					// which a silently-dropped ask can still be caught. Two failure shapes to close,
					// and they need opposite corrections: an item finished but left pending (stale
					// checklist), and an item never touched at all (dropped requirement). The second
					// is the one this gate exists for: say it out loud rather than closing over it.
					const reconcileReminder = `[AUTOMATED SYSTEM NOTICE — the user did NOT send this; do not treat it as user input or repeat your final summary yet]\n<system_reminder>You changed files after the latest visible plan update. Before ending this turn, call update_plan once now and account for EVERY item: mark genuinely finished ones completed, leave exactly one real current item in_progress if work remains, and keep unfinished items pending. Then check the list against what the user actually asked for this turn — if any requirement of theirs never became an item, add it now. Any item you did not deliver must be named in your reply as still open; do not let a requirement close silently, and do not claim completion while the user's checklist is stale.</system_reminder>`;
					simpleMessages.push({ role: 'user', content: reconcileReminder });
					localTranscript?.recordContinuation(reconcileReminder);
					continue;
				}

				// [agent-stop] DIAGNOSTIC: the turn is ending with zero tool calls. Log why so a
				// deterministic "narrates then stops" pattern is visible in the renderer DevTools
				// console (Help > Toggle Developer Tools) instead of having to guess at it.
				const stopReason = (() => {
					const tail = (result.text ?? '').trim().slice(-280);
					if (localRuntime) {
						return 'local runtime received a visible assistant reply with no tool calls (turn complete)';
					}
					const capForLog = toolCallsThisTurn === 0 ? MAX_SOFT_CONTINUES_HARD_NARRATION : MAX_SOFT_CONTINUES;
					if (softContinueCount >= capForLog) {
						return `soft-continue cap (${capForLog}, ${toolCallsThisTurn === 0 ? 'hard-narration regime' : 'mid-turn regime'}) reached — model kept narrating without acting`;
					}
					if (chatMode === 'chat') {
						return `chat mode = chat (no tools)`;
					}
					if (INTENT_TO_ACT_RE.test(tail)) {
						return `intent-to-act detected but soft-continue spent — model said it would act but never called a tool`;
					}
					if (PENDING_WORK_RE.test(tail)) {
						return `pending-work phrasing detected but soft-continue spent — model stated remaining work but never called a tool`;
					}
					if ((result.text ?? '').trim().length === 0) {
						return `empty reply (no text, no tool call)`;
					}
					return `model returned final reply with no tool call (turn complete)`;
				})();
				console.warn(`[agent-stop] provider=${modelSelection?.providerName} model=${modelSelection?.modelName} step=${step} reason=${JSON.stringify(stopReason)} softContinues=${softContinueCount} textLen=${(result.text ?? '').length} tail=${JSON.stringify((result.text ?? '').trim().slice(-160))}`);

				// USER-FACING TRANSPARENCY: when the loop exits without producing a tool card or
				// further work, surface WHY in the chat. The "silent stop after narration" pattern
				// (the screenshot bug — model says "Now let me write..." then exits) was completely
				// invisible before; the user just saw a frozen chat.
				//
				// IMPORTANT: progressMessage is auto-hidden by the renderer when the request is no
				// longer in progress (see chatProgressContentPart.ts isHidden / showSpinner gate),
				// AND it is consumed by any non-progress content that follows it. That made the
				// stop-reason effectively invisible in scroll-back: by the time the user looked,
				// the spinner row had collapsed. Persist it as a small italic markdown note so the
				// reason stays in the transcript and the user can SEE what happened, not guess.
				const replyTrim = (result.text ?? '').trim();
				const isCleanFinish = (localRuntime ? replyTrim.length > 0 : ((!INTENT_TO_ACT_RE.test(replyTrim.slice(-280)) && !PENDING_WORK_RE.test(replyTrim.slice(-280))) || AWAITING_USER_DECISION_RE.test(replyTrim))
					&& replyTrim.length > 0
					&& softContinueCount === 0);
				if (!isCleanFinish) {
					progress([{
						kind: 'progressMessage',
						content: new MarkdownString(`Agent stopped: ${stopReason}. Type a follow-up to continue.`),
						shimmer: false,
					}]);
					// NOTE: no permanent markdown breadcrumb. The stop reason is preserved in DevTools via the
					// [agent-stop] console.warn above; injecting it into the reply dumped internal telemetry
					// ("— agent stopped: soft-continue cap …") into completed answers, which read as a bug.
				}

				// Stash the final reply so _provideFollowups can mine it for concrete
				// next-actions the agent offered. Bounded to avoid unbounded growth if
				// followups are never requested for a turn.
				if (this._lastResponseText.size > 50) {
					const firstKey = this._lastResponseText.keys().next().value;
					if (firstKey !== undefined) { this._lastResponseText.delete(firstKey); }
				}
				this._lastResponseText.set(request.requestId, result.text);

				// Fix 4 (claim-verification gate): if this turn ended with the assistant asserting
				// concrete facts about a file or command — quoting JSON it claims is "in the file",
				// or saying "I verified" / "I confirmed" / "I ran" — AND no read/run/inspect tool
				// was actually called this turn, the assertion was unsupported. Queue ONE private
				// reminder for the NEXT turn so the agent reads or runs before re-asserting. Cheap
				// heuristic; does NOT block output, does NOT interrupt this turn.
				if (verifyingToolCallsThisTurn === 0 && (result.text ?? '').trim().length > 0) {
					const replyForClaim = (result.text ?? '');
					const CLAIM_PHRASE_RE = /\b(?:i\s+(?:verified|confirmed|checked|ran|just\s+ran|already\s+ran|tested)|verified\s+that|confirmed\s+that|the\s+(?:file|json|output)\s+(?:contains|has|shows|says)|in\s+the\s+file\s*[:,]|file\s+contents?\s*(?:is|are|now)|(?:contents?\s+of\s+the\s+file)|the\s+command\s+(?:returned|output|printed)|output\s+(?:was|is)\s*[:`])/i;
					const QUOTED_FACT_RE = /```[\s\S]*?```|`[^`\n]{6,}`/;
					const looksLikeClaim = CLAIM_PHRASE_RE.test(replyForClaim) || (QUOTED_FACT_RE.test(replyForClaim) && /\b(?:in\s+the\s+file|file\s+says|here'?s\s+what'?s\s+in|verified|confirmed|i\s+ran)\b/i.test(replyForClaim));
					if (looksLikeClaim) {
						const sessionId = this._memorySessionId(request);
						if (this._pendingVerificationReminder.size > 50) {
							const firstKey = this._pendingVerificationReminder.keys().next().value;
							if (firstKey !== undefined) { this._pendingVerificationReminder.delete(firstKey); }
						}
						this._pendingVerificationReminder.set(
							sessionId,
							`[AUTOMATED SYSTEM NOTICE — the user did NOT send this; do not treat it as user input or a reply to your work]\n<system_reminder>On your previous turn you asserted concrete facts about a file's contents or a command's output (e.g. "verified", "confirmed", "I ran", or quoted file contents) but did NOT call read_file, run_command, or any inspecting tool that turn — so the assertion was unsupported. Before re-asserting any specific file contents or command output, call the relevant tool first (read_file, run_command, find_text, ...) and base the answer on that result. If you cannot or should not run a tool, say plainly that you are inferring rather than presenting it as verified.</system_reminder>`,
						);
					}
				}

				this._recordMemory({
					sessionId: this._memorySessionId(request),
					kind: 'reply',
					role: this._memoryRole(chatMode),
					title: this._memoryTitle(result.text),
					body: result.text,
					// Token cost of this whole turn — small derived scalars only (memory contract).
					// Unlocks per-event / per-task / per-session token totals from stored history.
					meta: {
						tokens: { prompt: turnPromptTokens, completion: turnCompletionTokens },
						model: modelSelection.modelName,
						provider: modelSelection.providerName,
					},
				});

				this.memoryCaptureService.scheduleRollup();

				const voiceFinal = parseV3VoiceFinalResult(
					result.text ?? '',
					AWAITING_USER_DECISION_RE.test((result.text ?? '').trim()),
				);
				publishVoiceFinal(voiceFinal.text, voiceFinal.outcome);

				// Per-turn model attribution — the renderer shows this as a chip on the
				// response so the user can always see which model actually served the turn.
				return finish();

			}



			// 'chat' is pure conversation — no tools. 'plan' DOES run its tools (read-only
			// investigation + markdown-only writes) so it can ground the plan in real code.
			if (chatMode === 'chat') {

				const names = toolCalls.map(tc => `\`${tc.name}\``).join(', ');
				progress([{ kind: 'markdownContent', content: new MarkdownString(`*(Tool${toolCalls.length > 1 ? 's' : ''} ${names} skipped — switch to **Read** for investigation or **Agent** to run tools.)*`) }]);

				return finish();

			}

			// RC-2/abort: the LLM call can resolve as 'final' in the same tick the user hits Stop
			// (the stream's last chunk wins the race against the cancel). Re-check the token HERE,
			// before we dispatch — otherwise the pending tool batch (which may mutate files) runs
			// after the user already stopped the turn.
			if (token.isCancellationRequested) {
				return finish();
			}

			const localBatchControl = localRuntime?.beforeToolBatch(toolCalls.map(normalizedSignature));

			// Execute every tool call from this turn (parallel tool dispatch). When ALL calls are
			// read-only we run them concurrently (Promise.all) for the latency win; if any call
			// mutates state (edit/write/delete/run_command) we run the whole batch sequentially to
			// avoid races and interleaved diffs. Results are then processed in the model's order.
			const runOne = async (tc: RawToolCallObj): Promise<{ tc: RawToolCallObj; toolResult: string; toolImages?: ToolImagePayload[] }> => {
				// Abort guard per tool: in a sequential mutating batch the user may Stop partway
				// through; never start another tool (especially an edit/write/delete) after cancel.
				if (token.isCancellationRequested) {
					return { tc, toolResult: 'Tool skipped: the request was cancelled before this tool ran.' };
				}
				if (localBatchControl?.block) {
					return { tc, toolResult: `Tool error: ${localBatchControl.reminder ?? 'Local agent runtime blocked a repeated tool loop.'}` };
				}
				if (localRuntime && tc.name === 'ask_user') {
					if (shouldSuppressLocalAskUser(latestUserText)) {
						return { tc, toolResult: 'Tool error: the user explicitly asked the agent to decide and proceed without questions. Use your best judgment and continue the work.' };
					}
					const askControl = localRuntime.beforeAskUser();
					if (askControl.block) {
						return { tc, toolResult: `Tool error: ${askControl.reminder}` };
					}
				}
							// Warn-once-then-allow (same pattern as the path-drift guard below). A hard
							// permanent block meant one ambiguous phrase ("research everything you can and
							// make the edits") refused EVERY mutating tool for the whole turn, so the agent
							// could not do the work it was asked to do. One bounce is enough to make a model
							// that genuinely needs current docs go get them; a model that re-issues the same
							// call is telling us the request was local all along.
							if (chatMode === 'agent'
								&& explicitResearchRequested
								&& !explicitResearchSatisfied
								&& !researchGateWarned
								&& !isReadOnlyCall(tc)
								&& !RESEARCH_PREFLIGHT_TOOLS.has(tc.name)
								&& !RESEARCH_GATE_EXEMPT_TOOLS.has(tc.name)) {
								researchGateWarned = true;
								return {
									tc,
									toolResult: `Research check (warning, not a permanent block): the live request reads as asking for current/web information, but no research source has been consulted this turn. If this genuinely depends on dated external facts, call web_search or web_fetch first. If the answer lives in THIS repo, re-issue the SAME ${tc.name} call and it will run.`,
								};
							}
				// Split narration markdown from the tool card (text → tool → text interleaving).
				const driftTarget = isPathDrift(tc);
				if (driftTarget) {
					const driftKey = driftTarget.replace(/\\/g, '/').toLowerCase();
					if (!driftWarnedTargets.has(driftKey)) {
						driftWarnedTargets.add(driftKey);
						return {
							tc,
							toolResult: `Task-drift check (warning, not a permanent block): the live user message named ${[...explicitUserPaths].join(', ')}, but ${tc.name} targeted ${driftTarget}. If this edit is genuinely REQUIRED for the current task (e.g. a companion change the named file depends on), re-issue the SAME call and it will run. If you were switching files/tasks based on memory or background context, do NOT re-issue — ask the user first.`,
						};
					}
					// Already warned for this target — the model re-issued deliberately, let it through.
				}
				if (chatMode === 'plan') {
					if (tc.name === 'web_search' && shouldBlockPlanWebSearch(planWebSearchCount, planGreenfield)) {
						return { tc, toolResult: planWebSearchBlockedMessage(planGreenfield) };
					}
					// Delegation is allowed in plan mode; dispatch coerces every plan-mode
					// subagent to the read-only research profile (_subagentProfileForCall).
				}
				// Aggregate workspace-inspection hard cap (Phase 3). Counts DISTINCT inspection targets,
				// not raw calls: listing twelve different directories is a legitimate wide trace, while
				// re-listing the SAME tree is the actual spiral and is owned by the repeat-signature guard
				// above. A path-agnostic scalar conflated the two and cut real investigation short.
				if (isInspectionCall(tc)) {
					const inspectionSig = normalizedSignature(tc);
					if (inspectionBlocked) {
						return { tc, toolResult: `Tool error: workspace-inspection budget exhausted (${MAX_WORKSPACE_INSPECTIONS} DISTINCT targets this turn). Widening the search will not reveal anything new. Act on what you already know: read a SPECIFIC file you need, make the edit, or answer the user.` };
					}
					// Exact repeat of a target already inspected this turn, with no edit since: that call
					// genuinely returns the same bytes, so refuse it on its own merits rather than
					// spending budget on it. Mutations clear the set below, so the legitimate
					// list -> create/edit -> list-again confirmation loop is NOT refused.
					if (inspectionTargets.has(inspectionSig)) {
						return { tc, toolResult: `Tool error: you already inspected this exact target this turn and nothing has changed since. Repeating it returns the same result. Read a SPECIFIC file, inspect a DIFFERENT path, or act on what you have.` };
					}
					if (!budgetedInspectionTargets.has(inspectionSig) && budgetedInspectionTargets.size >= MAX_WORKSPACE_INSPECTIONS) {
						inspectionBlocked = true;
						return { tc, toolResult: `Tool error: workspace-inspection budget exhausted (${MAX_WORKSPACE_INSPECTIONS} DISTINCT targets this turn). Widening the search will not reveal anything new. Act on what you already know: read a SPECIFIC file you need, make the edit, or answer the user.` };
					}
					inspectionTargets.add(inspectionSig);
					budgetedInspectionTargets.add(inspectionSig);
				}
				// Heavy memory replay cap: one full session/raw-record replay per turn. Replaying several
				// at once is what overflowed the response and cut the turn off mid-stream.
				if (HEAVY_MEMORY_TOOLS.has(tc.name)) {
					if (heavyMemoryCallsThisTurn >= MAX_HEAVY_MEMORY_PER_TURN) {
						return { tc, toolResult: `Tool error: only ONE full memory replay (${[...HEAVY_MEMORY_TOOLS].join(' / ')}) per turn — each returns a whole session/record and replaying several at once overflows the response and cuts the turn off. You already replayed one this turn. Read what you got, then call the next replay alone on your NEXT turn. To decide which session to replay, use the compact search_chat_memory / list_notes first.` };
					}
					heavyMemoryCallsThisTurn++;
				}
				if (voiceMode && tc.name === 'ask_user') {
					const question = voiceQuestionFromRawParams(tc.rawParams);
					if (question) {
						publishV3VoiceAgentEvent({
							kind: 'question',
							sessionResource: request.sessionResource.toString(),
							question: question.question,
							options: question.options,
						});
					}
				}
				progress([{ kind: 'undoStop', id: tc.id }]);
				const exec = await this._executeTool(tc, request, token, modelSelection);
				const toolResult = exec.text;
				if (RESEARCH_PREFLIGHT_TOOLS.has(tc.name) && !/^\s*tool error:/i.test(toolResult)) {
					explicitResearchSatisfied = true;
				}
				if (localRuntime && tc.name === 'ask_user') {
					localRuntime.recordAskUserResult(toolResult, /^\s*tool error:/i.test(toolResult));
				}
				if (chatMode === 'plan' && tc.name === 'web_search' && !/^\s*tool error:/i.test(toolResult)) {
					planWebSearchCount++;
				}
				// A background worker that finished while this tool ran reports via the native notice
				// board; deliver it now, delimited so the model does not read it as this tool's output.
				const midTurnNotices = this.nativeNoticeService.drain(request.sessionResource.toString());
				const withNotices = midTurnNotices.length > 0 ? `${toolResult}\n\n${formatNativeNotices(midTurnNotices)}` : toolResult;
				return { tc, toolResult: withNotices, toolImages: exec.images };
			};

			// When the model batches a slow tool with reads, run slow tools first (sequential).
			let executionOrder = toolCalls;
			if (toolCalls.some(tc => ISOLATED_SLOW_TOOLS.has(tc.name)) && toolCalls.length > 1) {
				const slow = toolCalls.filter(tc => ISOLATED_SLOW_TOOLS.has(tc.name));
				const rest = toolCalls.filter(tc => !ISOLATED_SLOW_TOOLS.has(tc.name));
				executionOrder = [...slow, ...rest];
			}

			// Never run heavy memory replays in parallel — even one alongside other big reads can overflow
			// the turn. If any is present, fall through to serial execution (and the per-turn cap above
			// blocks all but the first), so a giant session dump can't collide with other results.
			const hasHeavyMemory = executionOrder.some(tc => HEAVY_MEMORY_TOOLS.has(tc.name));
			const allReadOnly = !hasHeavyMemory
				&& (localRuntime?.limits.parallelReadOnly ?? true)
				&& executionOrder.every(tc => READONLY_TOOLS.has(tc.name));
			let toolResults: { tc: RawToolCallObj; toolResult: string; toolImages?: ToolImagePayload[] }[];
			if (allReadOnly && executionOrder.length > 1) {
				toolResults = [];
				for (let i = 0; i < executionOrder.length; i += MAX_PARALLEL_READONLY) {
					const batch = executionOrder.slice(i, i + MAX_PARALLEL_READONLY);
					toolResults.push(...await Promise.all(batch.map(runOne)));
				}
			} else {
				toolResults = [];
				for (const tc of executionOrder) { toolResults.push(await runOne(tc)); }
			}
			const localResultControl = localRuntime?.afterToolBatch(toolResults.map(({ toolResult }) => ({
				isError: /^\s*tool error:/i.test(toolResult),
			})));

			for (let toolResultIndex = 0; toolResultIndex < toolResults.length; toolResultIndex++) {
				const { tc, toolResult, toolImages } = toolResults[toolResultIndex];

				const toolFiles = this._toolFiles(tc.rawParams);

				this._recordMemory({
					sessionId: this._memorySessionId(request),
					kind: 'tool_call',
					role: this._memoryRole(chatMode),
					title: this._memoryTitle(tc.name),
					body: JSON.stringify(tc.rawParams ?? {}),
					files: toolFiles,
					meta: { tool: tc.name, toolCallId: tc.id },
				});
				this._recordMemory({
					sessionId: this._memorySessionId(request),
					kind: 'tool_result',
					role: this._memoryRole(chatMode),
					title: this._memoryTitle(`${tc.name} result`),
					body: toolResult,
					files: toolFiles,
					meta: { tool: tc.name, toolCallId: tc.id },
				});

				const toolName = tc.name;
				if (toolName === 'update_plan') {
					planUsed = true;
					mutationsSincePlanUpdate = 0;
					if (voiceMode && !/^\s*tool error:/i.test(toolResult)) {
						const plan = voicePlanFromRawParams(tc.rawParams);
						if (plan) {
							publishV3VoiceAgentEvent({
								kind: 'plan',
								sessionResource: request.sessionResource.toString(),
								todos: plan.todos,
								merge: plan.merge,
							});
						}
					}
				} else if (MUTATING_TOOLS.has(toolName)) {
					fileMutations++;
					if (planUsed) { mutationsSincePlanUpdate++; }
					// The workspace just changed, so a previously-seen build/read/status call is no
					// longer a repeat — re-running it is verification, not a spiral.
					clearRepeatSignaturesOnMutation();
				}

				let toolContent = toolResult;
				if (toolResultIndex === toolResults.length - 1) {
					const runtimeReminders = [localBatchControl?.reminder, localResultControl?.reminder].filter((value): value is string => !!value);
					if (runtimeReminders.length > 0) {
						toolContent += `\n\n<system_reminder>${runtimeReminders.join(' ')}</system_reminder>`;
					}
				}
				// Plan-first nudge: fire after the FIRST mutating edit with no tracked plan.
				// Soft reminder only — never a hard tool block.
				//
				// Phrased around the USER'S REQUIREMENTS, not around plan hygiene. The prompt's
				// turn-start decompose step asks for that checklist before the first action; this is
				// the recovery path for a turn that started editing without one. Asking for "the
				// requirements the user stated" (rather than "a plan") is what makes the later
				// reconcile gate able to catch a dropped ask — it can only enforce items that exist.
				if (!planUsed && !planNudgeSent && fileMutations >= 1) {
					planNudgeSent = true;
					toolContent += `\n\n<system_reminder>You're editing files without a tracked plan. Call update_plan now, before further edits: first restate EVERY requirement the user asked for in this turn as its own item — in their terms, including the short ones at the end of their message — then keep exactly one in_progress. This checklist is what your own final reconcile is checked against, so a requirement missing from it is one you will silently fail to deliver. Open items are injected as <active_plan>; completed items roll into editorial roadmap memory. Skip only if this is truly a single trivial change.</system_reminder>`;
				} else if (planUsed && mutationsSincePlanUpdate >= PLAN_PROGRESS_NUDGE_INTERVAL) {
					mutationsSincePlanUpdate = 0;
					toolContent += `\n\n<system_reminder>Your visible plan has not moved across ${PLAN_PROGRESS_NUDGE_INTERVAL} file changes. The user is watching that checklist. Before more implementation, call update_plan: mark genuinely finished milestones completed and keep exactly one current item in_progress. Do not leave completed work sitting as pending.</system_reminder>`;
				}

				const rawUri = tc.rawParams?.uri;
				const failureKey = (typeof rawUri === 'string' && rawUri) ? rawUri : toolName;
				const toolFailed = /^\s*tool error:/i.test(toolResult) || /no replacement was found|could not find the|did not match|search block/i.test(toolResult);
				if (toolFailed) {
					const n = (failuresByKey.get(failureKey) ?? 0) + 1;
					failuresByKey.set(failureKey, n);
					if (!localRuntime && n >= 3 && !failureGateSent.has(failureKey)) {
						failureGateSent.add(failureKey);
						toolContent += `\n\n<system_reminder>STOP: ${n} consecutive failures on the same target (${failureKey}). Do NOT attempt another variant of the same fix. First do exactly ONE of: (1) read_file the CURRENT state of this file (your memory of it is likely stale), (2) web_search the exact error string, or (3) ask the user for guidance. A 4th blind attempt will keep failing.</system_reminder>`;
					}
				} else {
					failuresByKey.set(failureKey, 0);
				}

				// Spiral guard: an identical tool call with identical args returns nothing new — tell
				// the model to stop repeating it (covers re-reading the SAME ghost path or re-listing
				// the same dir, which the per-path failure gate above does not catch).
				const callSig = normalizedSignature(tc);
				const sigCount = (toolCallSignatures.get(callSig) ?? 0) + 1;
				toolCallSignatures.set(callSig, sigCount);
				// Tools that observe the world outside the transcript are exempt: identical arguments do
				// not imply an identical result, so repeating one is an observation loop rather than a
				// spiral. See isExternalObservationTool.
				if (!localRuntime && sigCount >= 2 && !isExternalObservationTool(toolName)) {
					toolContent += `\n\n<system_reminder>You already ran an equivalent ${toolName} ${sigCount} times — the result will not change. Stop repeating it; do something different or answer the user with what you have.</system_reminder>`;
				}

				// Plan mode: when the agent writes/updates a markdown plan doc, open it in the
				// built-in markdown preview to the side. The preview renders mermaid (the same
				// extension feeds it) without the chat webview's cold-start lag — this is the
				// "plan preview out of the chat" the user wanted.
				if ((chatMode === 'plan' || chatMode === 'multitask') && !toolFailed && (toolName === 'create_file_or_folder' || toolName === 'rewrite_file' || toolName === 'append_file')
					&& typeof rawUri === 'string' && /\.(md|markdown)$/i.test(rawUri.trim())) {
					try {
						const planUri = rawUri.includes('://') ? URI.parse(rawUri) : URI.file(rawUri);
						// Open the rendered plan in the SAME editor group (stacks as a tab) rather
						// than forcing a side-by-side split. The rewrite_file tool already saved the
						// doc to disk, so there's no dirty state to trip a save dialog.
						this.commandService.executeCommand('markdown.showPreview', planUri);
					} catch { /* opening the preview is best-effort — never break the turn */ }
				}

				// Post-edit lint feedback: after a successful create/edit/rewrite, attach the file's
				// current build/lint errors to this tool result so the model SEES and fixes them next
				// step without an explicit get_build_errors call. Best-effort + sync (the edit tools
				// already settle markers); capped; only when errors exist.
				if (!toolFailed && typeof rawUri === 'string' && rawUri
					&& (toolName === 'edit_file' || toolName === 'rewrite_file' || toolName === 'append_file' || toolName === 'create_file_or_folder')) {
					try {
						const lintUri = rawUri.includes('://') ? URI.parse(rawUri) : URI.file(rawUri);
						const lintErrors = this.markerCheckService.collectDiagnostics(lintUri);
						if (lintErrors && lintErrors.length) {
							const shown = lintErrors.slice(0, 10)
								.map((e, i) => `[${i + 1}] lines ${e.startLineNumber}-${e.endLineNumber}: ${e.message}`)
								.join('\n');
							const more = lintErrors.length > 10 ? `\n(+${lintErrors.length - 10} more)` : '';
							toolContent += `\n\n<lint_check>Build/lint errors are now present in the file you just edited — fix them before moving on, or say why they are acceptable:\n${shown}${more}</lint_check>`;
						}
					} catch { /* diagnostics are best-effort — never break the turn */ }
				}

				localTranscript?.recordToolResult({
					id: tc.id,
					name: tc.name,
					content: toolContent,
				});
				simpleMessages.push({

					role: 'tool',

					content: toolContent,

					id: tc.id,

					name: tc.name as ToolName,

					rawParams: tc.rawParams,

					...(toolImages && toolImages.length > 0 ? { images: toolImages } : {}),

				});

			}

			// Spiral guard: cap consecutive read-only-only steps. When every tool this step was
			// read-only (no edit, no answer), grow the streak; the moment it crosses the cap, tell
			// the model to STOP reading and answer with what it has.
			// Terminal-aware: a step of only read-only tools (incl. `ls`/`cat`/`git status` via run_command)
			// grows the streak. This is what stops the ls_dir <-> `ls -la` alternation from resetting it.
			const allReadOnlyThisStep = toolCalls.every(tc => isReadOnlyCall(tc));
			readOnlyStreak = allReadOnlyThisStep ? readOnlyStreak + 1 : 0;
			if (readOnlyStreak >= MAX_READONLY_STREAK && simpleMessages.length > 0) {
				// Hard stop: also latch the inspection block so the NEXT inspection call is refused, not
				// just nudged. A reminder alone didn't bite — the model read the nudge and kept reading.
				inspectionBlocked = true;
				const lastMsg = simpleMessages[simpleMessages.length - 1];
				if (typeof lastMsg.content === 'string') {
					lastMsg.content += `\n\n<system_reminder>STOP INVESTIGATING: you have run ${readOnlyStreak} read-only steps in a row without making an edit or answering. You have enough context. Answer the user's question now, or make the change they asked for. Further workspace listings are now blocked this turn.</system_reminder>`;
				}
				readOnlyStreak = 0;
			}

			// [agent-step] one line per step for diagnosing spirals. Routed through ILogService at
			// TRACE rather than console.warn: at warn it printed on every step of every turn, so a
			// long turn buried genuine renderer errors under hundreds of lines of our own telemetry
			// and made the DevTools console useless for the bug the user was actually chasing.
			this.logService.trace(`[agent-step] step=${step} tools=[${toolCalls.map(tc => tc.name).join(',')}] readOnlyStreak=${readOnlyStreak} softContinues=${softContinueCount} mutations=${fileMutations}`);

			retries = 0;

		}



		progress([{ kind: 'markdownContent', content: new MarkdownString('(Stopped after maximum tool steps. Say "continue" to keep going.)') }]);

		return finish();

	}



	private _callLLM(

		messages: unknown[],

		separateSystemMessage: string | undefined,

		modelSelection: ModelSelection,

		modelSelectionOptions: unknown,

		chatMode: ChatMode,

		coreToolsOnly: boolean,

		excludeTools: readonly string[] | undefined,

		usageSessionId: string,

		progress: (parts: IChatProgress[]) => void,

		token: CancellationToken,

	): Promise<LLMCallResult> {

		return new Promise(resolve => {

			if (token.isCancellationRequested) {
				resolve({ kind: 'abort' });
				return;
			}

			let lastTextSent = '';

			let lastReasoningSent = '';

			let resolved = false;

			let requestId: string | null = null;

			let pendingAbort = false;

			// RC-2 stall watchdog — shared with LM provider; see v3codeLlmStreamWatchdog.ts (upstream alignment).
			const streamStallMs = llmStreamStallMs(modelSelection.providerName, modelSelection.modelName);
			const stallWatchdog = new LlmStreamWatchdog(() => {
				// Make the stall visible BEFORE we abort, as a permanent breadcrumb the user can
				// see in the transcript (the error path already surfaces a markdown error, but this
				// happens at the moment-of-truth so the cause is unambiguous).
				try {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`\n*— stall watchdog fired: no stream activity from ${modelSelection.providerName}/${modelSelection.modelName} for ${Math.round(streamStallMs / 1000)}s; aborting.*\n`),
					}]);
				} catch { /* progress sink may already be torn down */ }
				if (requestId) { this.llmMessageService.abort(requestId); }
				done({ kind: 'error', message: `No response from ${modelSelection.providerName}/${modelSelection.modelName} for ${Math.round(streamStallMs / 1000)}s — request timed out and was aborted.`, retryable: true });
			}, streamStallMs);

			const done = (r: LLMCallResult) => {

				if (!resolved) {

					resolved = true;

					stallWatchdog.dispose();

					cancelDisposable.dispose();

					resolve(r);

				}

			};

			// Register cancellation BEFORE dispatching the request so we never miss
			// a cancel that fires during the synchronous setup of sendLLMMessage.
			const cancelDisposable = token.onCancellationRequested(() => {

				if (requestId) {

					this.llmMessageService.abort(requestId);

				} else {

					pendingAbort = true;

				}

				done({ kind: 'abort' });

			});



			requestId = this.llmMessageService.sendLLMMessage({

				messagesType: 'chatMessages',

				messages: messages as never,

				separateSystemMessage,

				chatMode,

				coreToolsOnly,

				excludeTools,

				modelSelection,

				modelSelectionOptions: modelSelectionOptions as never,

				overridesOfModel: this.settingsService.state.overridesOfModel,

				usageSessionId,

				logging: { loggingName: 'V3Code Native Agent' },

				onText: ({ fullText, fullReasoning }) => {

					// Late deltas can arrive after `done()` has already resolved (the stall watchdog
					// fired, the user hit Stop, or onError raced with a final chunk in flight). The
					// abort RPC is async, so the upstream stream keeps pushing for a few hundred ms.
					// Forwarding those to `progress()` after the UI has shown the error/abort state
					// produced ghost text under the error message — drop them on the floor instead.
					if (resolved) { return; }

					// Streamed activity (text, reasoning, or tool-arg deltas) — reset stall watchdog.
					stallWatchdog.touch();

					// Display reasoning whenever the provider streams it back, regardless of the
					// reasoning *request* toggle. Providers normalize their own shapes into
					// `fullReasoning` (Anthropic thinking blocks, DeepSeek/o-series reasoning_content,
					// etc.); always-on reasoner models send it even when the capability table or the
					// enable-toggle says otherwise. Gating display on `isReasoningEnabled` silently
					// dropped thinking for those models — show whatever actually arrived.
					if (fullReasoning && fullReasoning.length > lastReasoningSent.length) {

						const reasoningDelta = fullReasoning.slice(lastReasoningSent.length);

						lastReasoningSent = fullReasoning;

						// Only suppress when reasoning is clearly a duplicate of visible narration
						// (some openai-style tool models emit reasoning_content that just mirrors the
						// final text). Require a SUBSTANTIAL chunk (>=24 chars) before treating it as a
						// duplicate — short deltas like "the" or "I" trivially appear in any reply and
						// would otherwise eat real Anthropic adaptive-thinking summaries before tool
						// calls. Anthropic thinking blocks always arrive before text, so this guard
						// only really fires on openai-compat providers anyway.
						const trimmed = reasoningDelta.trim();
						const looksLikeDuplicateNarration = trimmed.length >= 24
							&& fullText
							&& fullText.includes(trimmed);
						if (trimmed && !looksLikeDuplicateNarration) {
							progress([{ kind: 'thinking', value: reasoningDelta }]);
						}

					}

					if (fullText && fullText.length > lastTextSent.length) {

						let delta = fullText.slice(lastTextSent.length);
						// Strip Word Joiner U+2060 from deltas
						delta = delta.replace(/\u2060/g, '').replace(/&NoBreak;/gi, '');

						lastTextSent = fullText;

						// Forward every delta — chat surface merges whitespace cleanly
						if (delta.length > 0) {
							progress([{ kind: 'markdownContent', content: new MarkdownString(delta) }]);
						}

					}

				},

				onFinalMessage: ({ fullText, fullReasoning, anthropicReasoning, geminiParts, toolCall, toolCalls, ...rest }) => {

					const usage = rest as { promptTokens?: number; completionTokens?: number; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_write_tokens?: number } };

					const promptTokens = usage.promptTokens ?? usage.usage?.prompt_tokens;

					const completionTokens = usage.completionTokens ?? usage.usage?.completion_tokens;

					// Cache breakdown for cache-aware cost. prompt_tokens INCLUDES these; the cost
					// math splits fresh vs cached input. Absent on providers that don't report cache.
					const promptCacheHitTokens = usage.usage?.prompt_cache_hit_tokens;

					const promptCacheWriteTokens = usage.usage?.prompt_cache_write_tokens;

					// Accept tool calls that are either explicitly closed (isDone)
					// or that have a name + at least one parsed param. The XML grammar
					// extractor only flips isDone when the model emits the closing
					// </toolname> tag, but many providers (DeepSeek, Qwen, local models)
					// drop it — discarding the call there caused the "one sentence then
					// stop" loop-exit bug.
					const isUsable = (tc?: RawToolCallObj) => {
						if (!tc) { return false; }
						const hasName = !!tc.name;
						const hasParams = Object.keys(tc.rawParams || {}).length > 0;
						return tc.isDone || (hasName && hasParams);
					};
					// Parallel tool dispatch: prefer the full toolCalls[] array; fall back to the
					// single toolCall for providers/paths that only surface one.
					const allCalls = (toolCalls && toolCalls.length) ? toolCalls : (toolCall ? [toolCall] : []);
					const usableCalls = allCalls.filter(isUsable);

					done({

						kind: 'final',

						text: fullText,

						reasoning: fullReasoning || null,

						anthropicReasoning: anthropicReasoning || null,
						geminiParts,

						toolCall: usableCalls[0],

						toolCalls: usableCalls,

						promptTokens,

						completionTokens,

						promptCacheHitTokens,

						promptCacheWriteTokens,

					});

				},

				onError: ({ message }) => {

					done({ kind: 'error', message, retryable: isRetryableErrorMessage(message) });

				},

				onAbort: () => {

					done({ kind: 'abort' });

				},

			});



			if (!requestId) {

				done({ kind: 'error', message: 'Failed to start LLM request' });

				return;

			}



			// If cancellation fired during the synchronous sendLLMMessage call, the
			// abort hook above could not forward it (requestId was null). Forward now.
			if (pendingAbort) {

				this.llmMessageService.abort(requestId);

			}

			// Arm stall watchdog now that the request is live.
			stallWatchdog.arm();

		});

	}



	private _resolveMcpServerName(toolName: string): string | undefined {

		return this.mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName;

	}



	/** Resolve the capability profile a subagent call runs under: the model's requested
	 *  profile (default work), coerced to research in plan and debug mode (a work child
	 *  would hold delete/git/browser tools the Debug parent itself is denied). Same rules
	 *  as the background engine's launchSubagent — the two engines must agree. */
	private _subagentProfileForCall(rawParams: Record<string, string | undefined>, request: IChatAgentRequest): SubagentProfile {
		const raw = (rawParams.profile ?? '').trim().toLowerCase();
		const legacyReadOnly = rawParams.read_only === 'true';
		const requested: SubagentProfile = (raw === 'research' || raw === 'read_only' || raw === 'read-only' || legacyReadOnly) ? 'research' : 'work';
		const mode = this._resolveChatMode(request);
		return (mode === 'plan' || mode === 'debug') ? 'research' : requested;
	}

	private _convertParamsForNativeTool(toolName: string, rawParams: Record<string, string | undefined>, subagentProfile?: SubagentProfile): Record<string, any> {

		if (toolName === 'run_subagent') {

			// `profile` is a V3Code-schema param; the native runner takes the resolved
			// runtime-only readOnly flag instead (never model-controlled directly).
			const { agent_name, profile: _profile, read_only: _readOnly, ...rest } = rawParams;

			return { ...rest, agentName: agent_name, readOnly: (subagentProfile ?? 'research') === 'research' };

		}

		if (toolName === 'rename_symbol') {
			const { new_name, file_path, line_content, symbol, uri } = rawParams;
			return {
				symbol,
				newName: new_name,
				filePath: file_path,
				lineContent: line_content,
				uri,
			};
		}

		if (toolName === 'list_code_usages') {
			const { file_path, line_content, symbol, uri } = rawParams;
			return {
				symbol,
				filePath: file_path,
				lineContent: line_content,
				uri,
			};
		}

		if (toolName === 'run_tests') {
			// JSON is parsed upstream, so array params arrive as REAL arrays. Handle both.
			const parseJsonStringArray = (value: unknown): string[] | undefined => {
				if (Array.isArray(value)) { return value.map(String); }
				if (typeof value !== 'string' || !value.trim()) { return undefined; }
				try {
					const parsed = JSON.parse(value);
					return Array.isArray(parsed) ? parsed.map(String) : undefined;
				} catch {
					return undefined;
				}
			};
			return {
				files: parseJsonStringArray(rawParams.files),
				testNames: parseJsonStringArray(rawParams.test_names),
				mode: rawParams.mode,
				coverageFiles: parseJsonStringArray(rawParams.coverage_files),
			};
		}

		const BROWSER_AUTOMATION_TOOLS = new Set([
			'open_browser_page', 'read_page', 'click_element', 'type_in_page', 'screenshot_page', 'navigate_page',
			'hover_element', 'drag_element', 'handle_dialog', 'run_playwright_code',
			'extract_page_data', 'get_browser_console_logs', 'reconstruct_page_sources',
			'get_computed_styles', 'watch_page', 'save_browser_session', 'restore_browser_session',
			'fill_form', 'intercept_network', 'get_browser_network_log',
		]);
		if (BROWSER_AUTOMATION_TOOLS.has(toolName)) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(rawParams)) {
				if (v === undefined) {
					continue;
				}
				const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
				if (v === 'true') {
					out[camel] = true;
				} else if (v === 'false') {
					out[camel] = false;
				} else {
					out[camel] = v;
				}
			}
			if (toolName === 'handle_dialog' && typeof out.selectFiles === 'string' && out.selectFiles.startsWith('[')) {
				try {
					out.selectFiles = JSON.parse(out.selectFiles as string);
				} catch { /* keep string */ }
			}
			if (toolName === 'get_browser_console_logs' && out.maxLines !== undefined) {
				const n = Number(out.maxLines);
				if (!Number.isNaN(n)) {
					out.maxLines = n;
				}
			}
			if (toolName === 'run_playwright_code' && out.timeoutMs !== undefined) {
				const n = Number(out.timeoutMs);
				if (!Number.isNaN(n)) {
					out.timeoutMs = n;
				}
			}
			if (toolName === 'watch_page') {
				if (out.timeoutMs !== undefined) {
					const n = Number(out.timeoutMs);
					if (!Number.isNaN(n)) { out.timeoutMs = n; }
				}
				if (out.intervalMs !== undefined) {
					const n = Number(out.intervalMs);
					if (!Number.isNaN(n)) { out.intervalMs = n; }
				}
			}
			if (toolName === 'hover_element' && out.settleMs !== undefined) {
				const n = Number(out.settleMs);
				if (!Number.isNaN(n)) { out.settleMs = n; }
			}
			if (toolName === 'intercept_network' && out.includeBodies !== undefined && typeof out.includeBodies === 'string') {
				out.includeBodies = out.includeBodies === 'true';
			}
			if (toolName === 'get_browser_network_log' && out.clear !== undefined && typeof out.clear === 'string') {
				out.clear = out.clear === 'true';
			}
			if (toolName === 'restore_browser_session' && out.reload !== undefined && typeof out.reload === 'string') {
				out.reload = out.reload !== 'false';
			}
			return out;
		}

		return rawParams;

	}



	private _isToolEnabled(nativeId: string, request: IChatAgentRequest): boolean {

		const selected = request.userSelectedTools;

		if (!selected || Object.keys(selected).length === 0) {

			return true;

		}

		if (nativeId in selected) {

			return selected[nativeId] !== false;

		}

		return true;

	}



	private async _executeTool(

		toolCall: RawToolCallObj,

		request: IChatAgentRequest,

		token: CancellationToken,

		modelSelection: ModelSelection | null,

	): Promise<ToolExecutionResult> {

		const mcpTools = this.mcpService.getMCPTools();

		const nativeId = resolveNativeToolId(toolCall.name, mcpTools);

		if (!nativeId) {

			return { text: `Tool error: Unknown tool "${toolCall.name}"` };

		}

		if (!this._isToolEnabled(nativeId, request)) {

			const sel = request.userSelectedTools ?? {};

			const allKeys = Object.keys(sel);

			const enabledNames = allKeys.filter(k => sel[k] !== false);

			const nativeIdPresent = nativeId in sel;

			const keySample = allKeys.slice(0, 30).join(', ');

			const summary = enabledNames.length ? `Tools currently enabled for this agent: ${enabledNames.join(', ')}.` : 'No tools are enabled for this agent (userSelectedTools is empty or all-false).';

			// Diagnostic: dump the key-space so we can tell whether the allow-list is keyed by v3code_* ids (matching resolveNativeToolId) or some other namespace, and whether the resolved nativeId is even present.

			const diag = `[diag] resolvedNativeId="${nativeId}" present=${nativeIdPresent} totalKeys=${allKeys.length} keys=[${keySample}${allKeys.length > 30 ? ', …' : ''}]`;

			return { text: `Tool error: Tool "${toolCall.name}" (resolved id "${nativeId}") is disabled in Configure Tools. ${summary} ${diag}` };

		}



		const countTokens: CountTokensCallback = async (input) => {

			const text = typeof input === 'string' ? input : JSON.stringify(input);

			return Math.ceil(text.length / 4);

		};



		// Subagent dispatch resolves a work/research capability profile (plan mode always
		// coerces to research); the child's native tool selection is the parent's enabled
		// surface filtered through the same shared policy the background engine enforces.
		const subagentProfile = toolCall.name === 'run_subagent'
			? this._subagentProfileForCall(toolCall.rawParams, request)
			: undefined;

		const invocation: IToolInvocation = {

			callId: toolCall.id,

			toolId: nativeId,

			parameters: this._convertParamsForNativeTool(toolCall.name, toolCall.rawParams, subagentProfile),

			tokenBudget: undefined,

			context: { sessionResource: request.sessionResource, workingDirectory: request.workingDirectory },

			chatRequestId: request.requestId,

			chatStreamToolCallId: toolCall.id,

			userSelectedTools: subagentProfile !== undefined
				? subagentNativeToolSelection(subagentProfile, request.userSelectedTools, mcpTools)
				: request.userSelectedTools,

			modelId: request.userSelectedModelId ?? tierLanguageModelId(V3_MODEL_TIERS[0]),

		};



		// Create the streaming tool-invocation card up front and append it to the
		// chat response, so the user sees the tool call as its own card interleaved
		// with the assistant narration (text → tool card → text → tool card). This
		// mirrors the native agent-host path (agentHostSessionHandler.beginToolCall).
		// `force: true` creates the card even for tools without handleToolStream.
		// invokeTool() below finds this same pending call (by callId) and transitions
		// it through execution instead of creating a second card, so there's no dupe.
		try {

			this.nativeToolsService.beginToolCall({

				toolCallId: toolCall.id,

				toolId: nativeId,

				chatRequestId: request.requestId,

				sessionResource: request.sessionResource,

				force: true,

			});

		} catch (e: unknown) {

			// Non-fatal: if the streaming card can't be created, invokeTool still appends its own
			// invocation card before executing. Log it — a silently-failed begin can leave an orphan
			// "Reviewing…" row with no card behind it.
			console.warn(`[agent-tool] beginToolCall failed for ${nativeId}: ${e instanceof Error ? e.message : String(e)}`);

		}



		// Per-tool wall-clock budget. A tool that ignores its cancellation token (hung subprocess /
		// dead socket) would otherwise block the whole step loop after the LLM already returned. We
		// race invokeTool against a timer that cancels the tool and returns a "timed out" string so
		// the loop continues instead of wedging on a stuck card forever.
		const budgetMs = this._toolTimeoutBudget(toolCall.name);

		const toolCts = new CancellationTokenSource(token);

		let timedOut = false;

		const timer = setTimeout(() => {

			timedOut = true;

			toolCts.cancel();

		}, budgetMs);

		try {

			const result = await this.nativeToolsService.invokeTool(invocation, countTokens, toolCts.token);

			// NOTE: do not discard a resolved result just because the timeout flag flipped. If invokeTool
			// resolved (rather than threw), the tool finished its work — returning a false "timed out"
			// here would throw away a real, successful result in the timer-vs-resolve race. A genuinely
			// aborted tool rejects and is handled in the catch below.

			const text = result.content.map(c => (c.kind === 'text' ? c.value : '')).join('\n').trim();

			const images = extractToolImagesFromContent(result.content);

			if (result.toolResultError) {

				return { text: `Tool error: ${result.toolResultError}` };

			}

			const supportsVision = modelSelection
				? modelSupportsVision(modelSelection.providerName, modelSelection.modelName, this.settingsService.state.overridesOfModel)
				: true;

			if (images.length > 0) {
				if (supportsVision) {
					return {
						text: text || `${toolCall.name} captured ${images.length === 1 ? 'a screenshot' : `${images.length} screenshots`}.`,
						images,
					};
				}
				// Non-vision active model: give the blind agent "sight" of what it captured by routing the
				// screenshot through the vision-describe lane (a configured vision model describes the rendered
				// page — layout, colors, visual bugs). The human still sees the real pixels in the chat tool
				// card; only the model reads this text. Gated by Settings -> imageDescribeMode; 'manual' counts
				// as auto here because the agent calling a screenshot tool IS the explicit intent and there is
				// no user to click a describe dialog mid-loop.
				const describeMode = this.settingsService.state.globalSettings.imageDescribeMode ?? 'manual';
				if (describeMode !== 'off' && modelSelection) {
					const cacheKey = hash(images.map(img => img.data).join('|'));
					const cached = this._screenshotDescribeCache.get(cacheKey);
					const described = cached !== undefined
						? { description: cached, visionModel: null }
						: await describeToolScreenshots(images, modelSelection, this.settingsService, this.llmMessageService, this.convertService, token);
					if ('description' in described && described.description) {
						this._screenshotDescribeCache.set(cacheKey, described.description);
						const by = described.visionModel ? ` by ${described.visionModel.modelName}` : '';
						return {
							text: `${text ? text + '\n\n' : ''}[Visual description of the screenshot, generated${by} because your model is text-only — the human sees the real image in chat]:\n${described.description}\n\nJudge the visual quality from this description and iterate on the page if anything looks broken.`,
						};
					}
				}
				return {
					text: text || `${toolCall.name} captured ${images.length === 1 ? 'an image' : `${images.length} images`}, shown in the chat and saved as an artifact. NOTE: the image pixels are NOT included in this tool result because the active model is text-only. Use read_page for page structure, or configure a vision model (Claude / GPT-4o / Gemini) so screenshots can be described to you.`,
				};
			}

			return { text: text || '(tool completed with no output)' };

		} catch (e: unknown) {

			if (timedOut) {

				return { text: `Tool error: ${toolCall.name} timed out after ${Math.round(budgetMs / 1000)}s and was aborted.` };

			}

			const message = e instanceof Error ? e.message : String(e);

			return { text: `Tool error: ${message}` };

		} finally {

			clearTimeout(timer);

			toolCts.dispose();

		}

	}



	/** Rotating inter-step narration so a multi-step turn reads as live work, not a frozen label. */
	private _stepNarration(step: number): string {
		if (step === 0) { return 'Thinking…'; }
		const phrases = [
			'Reviewing results…',
			'Planning the next step…',
			'Working through it…',
			'Analyzing what came back…',
			'Connecting the pieces…',
			'Deciding what to do next…',
		];
		return phrases[(step - 1) % phrases.length];
	}

	/** Wall-clock budget for a tool by name: writes/terminal/browser get longer than reads. */
	private _toolTimeoutBudget(toolName: string): number {

		const n = toolName.toLowerCase();

		// A blocking subagent is a whole agent run, not a single wedged tool — the 3-minute
		// write budget was hard-killing every real worker mid-task. It still gets a hard
		// backstop so a truly dead child cannot wedge the parent loop forever.
		if (n === 'run_subagent') {

			return SUBAGENT_TOOL_TIMEOUT_MS;

		}

		const base = /edit|rewrite|create|write|delete|patch|replace|command|terminal|subagent|browser|page|playwright|run_tests|rename/.test(n)
			? TOOL_TIMEOUT_WRITE_MS
			: TOOL_TIMEOUT_READ_MS;

		// Approval-gated tools block inside invokeTool waiting for the user to click
		// Allow/Deny — that wait counted against the budget, so a user away from the
		// keyboard for 3 minutes had their pending approval auto-DENIED and the model
		// was told the tool "timed out". The timeout exists to catch WEDGED tools
		// (dead MCP socket), not humans deciding; give gated tools a long grace window.
		if (approvalTypeOfBuiltinToolName[toolName as BuiltinToolName]) {

			return base + TOOL_APPROVAL_GRACE_MS;

		}

		return base;

	}



	/** Final assistant text of the last completed turn, keyed by requestId, mined for follow-ups. */
	/** Screenshot data-hash → vision description, so identical re-screenshots (retries, unchanged page) don't re-pay the vision call. Session-scoped, never persisted. */
	private readonly _screenshotDescribeCache = new LRUCache<number, string>(24);

	private readonly _lastResponseText = new Map<string, string>();

	/** Cheap claim-verification gate (Fix 4). When a turn ends with the assistant asserting
	 *  concrete file/command facts ("the file contains X", "I verified", "I ran ...") AND no
	 *  read_file / run_command tool was actually called during that turn, queue ONE private
	 *  AUTOMATED-SYSTEM-NOTICE reminder to be prepended at the start of the NEXT turn for the
	 *  same session. Heuristic — deliberately simple — keyed by the session id (not requestId)
	 *  so it survives across turns. Bounded; oldest entry is evicted when the cap is hit. */
	private readonly _pendingVerificationReminder = new Map<string, string>();

	private async _provideFollowups(request: IChatAgentRequest): Promise<IChatFollowup[]> {

		const text = this._lastResponseText.get(request.requestId);
		this._lastResponseText.delete(request.requestId);
		if (!text) { return []; }
		return this._extractFollowups(text);

	}

	/**
	 * Build follow-up chips ONLY from concrete next-actions the agent itself offered in
	 * its reply ("Want me to X?", "Should I X?", …). Deliberately no generic filler — if
	 * the reply offered nothing actionable, this returns nothing rather than guessing.
	 */
	private _extractFollowups(text: string): IChatFollowup[] {

		const offerRe = /(?:want me to|would you like me to|do you want me to|should i|shall i)\s+([^?.!\n]{4,90})[?.!]/gi;
		const seen = new Set<string>();
		const followups: IChatFollowup[] = [];
		let m: RegExpExecArray | null;
		while ((m = offerRe.exec(text)) !== null) {
			const action = m[1].trim().replace(/\s+/g, ' ');
			if (!action) { continue; }
			const key = action.toLowerCase();
			if (seen.has(key)) { continue; }
			seen.add(key);
			const imperative = action.charAt(0).toUpperCase() + action.slice(1);
			const title = imperative.length > 48 ? imperative.slice(0, 47).trimEnd() + '…' : imperative;
			followups.push({ kind: 'reply', agentId: AGENT_ID, message: imperative, title });
			if (followups.length >= 3) { break; }
		}
		return followups;

	}



	private async _provideChatTitle(

		history: IChatAgentHistoryEntry[],

	): Promise<string | undefined> {

		if (history.length === 0) { return undefined; }

		const first = history[0].request.message;

		return first.length > 60 ? first.slice(0, 57) + '...' : first;

	}

}



registerWorkbenchContribution2(V3CodeChatAgent.ID, V3CodeChatAgent, WorkbenchPhase.BlockRestore);
