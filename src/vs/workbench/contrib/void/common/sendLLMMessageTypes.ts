/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { FIMRepoContext } from './helpers/fimRepoContext.js'
import { InternalToolInfo } from './prompt/prompts.js'
import { ToolName, ToolParamName } from './toolsServiceTypes.js'
import { ChatMode, ModelSelection, ModelSelectionOptions, OverridesOfModel, ProviderName, RefreshableProviderName, SettingsOfProvider } from './voidSettingsTypes.js'


export const errorDetails = (fullError: Error | null): string | null => {
	if (fullError === null) {
		return null
	}
	else if (typeof fullError === 'object') {
		if (Object.keys(fullError).length === 0) return null
		return JSON.stringify(fullError, null, 2)
	}
	else if (typeof fullError === 'string') {
		return null
	}
	return null
}

export const getErrorMessage: (error: unknown) => string = (error) => {
	if (error instanceof Error) return `${error.name}: ${error.message}`
	return error + ''
}



export type AnthropicLLMChatMessage = {
	role: 'assistant',
	geminiParts?: GeminiResponsePart[];
	geminiCallIds?: string[];
	content: string | (AnthropicReasoning | { type: 'text'; text: string }
		| { type: 'tool_use'; name: string; input: Record<string, any>; id: string; }
	)[];
} | {
	role: 'user',
	content: string | (
		{ type: 'text'; text: string; }
		| { type: 'tool_result'; tool_use_id: string; content: string | (
			{ type: 'text'; text: string; }
			| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
		)[]; }
		| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	)[]
}
export type OpenAILLMChatMessage = {
	role: 'system' | 'user' | 'developer';
	content: string;
} | {
	role: 'assistant',
	content: string | (AnthropicReasoning | { type: 'text'; text: string })[];
	tool_calls?: { type: 'function'; id: string; function: { name: string; arguments: string; } }[];
} | {
	role: 'tool',
	content: string;
	tool_call_id: string;
}

/** Opaque response parts must survive unchanged for signed tool continuations. */
export type GeminiResponsePart = {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
};

export type GeminiLLMChatMessage = {
	role: 'model'
	parts: GeminiResponsePart[];
} | {
	role: 'user';
	parts: (
		| { text: string; }
		| { functionResponse: { id?: string; name: ToolName, response: { output: string } } }
		| { inlineData: { mimeType: string; data: string } }
	)[];
}

export type LLMChatMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage | GeminiLLMChatMessage



export type LLMFIMMessage = {
	prefix: string;
	suffix: string;
	stopTokens: string[];
	/** Optional repo-level neighbor files. The built-in local engine renders these with Qwen's
	 *  `<|file_sep|>` special tokens; other FIM providers fold them into a prefix comment. */
	repoContext?: FIMRepoContext;
	/** Max tokens to generate. Set per completion type (short for next-line predictions, which are
	 *  the slow path) so a big multi-line block can't run for seconds. */
	maxTokens?: number;
	/** When set, the caller already rendered the FULL model-specific FIM prompt. Raw/legacy
	 *  completions providers must send this as the entire prompt with NO suffix param. */
	renderedPrompt?: string;
}


export type RawToolParamsObj = {
	[paramName in ToolParamName<ToolName>]?: string;
}
export type RawToolCallObj = {
	name: ToolName;
	rawParams: RawToolParamsObj;
	doneParams: ToolParamName<ToolName>[];
	id: string;
	isDone: boolean;
};

export type AnthropicReasoning = ({ type: 'thinking'; thinking: any; signature: string; } | { type: 'redacted_thinking', data: any })

export type OnText = (p: { fullText: string; fullReasoning: string; toolCall?: RawToolCallObj }) => void
export type LLMUsage = {
	prompt_tokens?: number; // TOTAL input tokens the model processed, INCLUDING cached (cache read + write). Matches OpenAI semantics; the context-usage meter reads this.
	completion_tokens?: number;
	total_tokens?: number;
	prompt_cache_hit_tokens?: number; // subset of prompt_tokens served from cache (billed ~0.1x)
	prompt_cache_write_tokens?: number; // subset of prompt_tokens written to cache this turn (billed ~1.25x for 5m / 2x for 1h)
	prompt_cache_write_1h_tokens?: number; // subset of prompt_cache_write_tokens with the 1h TTL (billed 2x input, not the 5m 1.25x)
}
/**
 * Fired by the transport whenever its knowledge of a request's usage improves (Anthropic
 * message_start carries the full input-side bill before any output streams; message_delta
 * carries cumulative output). This is what lets aborted/errored streams still be metered —
 * they are billed by the provider even though onFinalMessage never fires.
 * `wireModelName` is the model that actually SERVED the request when it differs from the
 * selected one (e.g. 'Opus Hybrid' routes to a Sonnet/Haiku executor).
 */
export type OnUsage = (p: { usage: LLMUsage; wireModelName?: string }) => void
export type OnFinalMessage = (p: { fullText: string; fullReasoning: string; geminiParts?: GeminiResponsePart[]; toolCall?: RawToolCallObj; toolCalls?: RawToolCallObj[]; anthropicReasoning: AnthropicReasoning[] | null; usage?: LLMUsage }) => void // id is tool_use_id
export type OnError = (p: { message: string; fullError: Error | null; hostedAuthExpired?: boolean; hostedCreditExhausted?: boolean; terminal?: boolean }) => void
export type OnAbort = () => void
export type AbortRef = { current: (() => void) | null }


// service types
type SendLLMType = {
	messagesType: 'chatMessages';
	messages: LLMChatMessage[]; // the type of raw chat messages that we send to Anthropic, OAI, etc
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	/** From the resolved PromptAssemblyProfile (minimal preset): advertise only the core tool subset in the NATIVE tool payload too, not just the XML defs. */
	coreToolsOnly?: boolean;
	/** Tools the user disabled in settings (e.g. ask_user) — stripped from the native tool payload like the XML defs. */
	excludeTools?: readonly string[];
} | {
	messagesType: 'FIMMessage';
	messages: LLMFIMMessage;
	separateSystemMessage?: undefined;
	chatMode?: undefined;
	coreToolsOnly?: undefined;
	excludeTools?: undefined;
}
export type ServiceSendLLMMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	logging: { loggingName: string, loggingExtras?: { [k: string]: any } };
	modelSelection: ModelSelection | null;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	onAbort: OnAbort;
	/** Which token-usage session this request bills to (a chat session URI). Omitted for
	 *  non-chat features — usage then books under a per-feature bucket from loggingName. */
	usageSessionId?: string;
} & SendLLMType;

// params to the true sendLLMMessage function
/** Routes a request through the V3Code hub's hosted inference (paid plan) instead of the
 *  user's own key: the OpenAI-compatible client is pointed at `endpoint` with `token` as the
 *  bearer and `wireModel` (canonical "provider/model") is sent as the model. Injected fresh
 *  per request in sendLLMMessageService — never persisted into settings. */
/** `idempotencyKey` is the logical request's id: the renderer's silent 401 retry re-dispatches
 *  with a FRESH override but the SAME key, so the hub can dedupe the redelivery. */
export type HostedInferenceOverride = { endpoint: string; token: string; wireModel: string; idempotencyKey?: string };

/** Providers whose BYOK path actually implements FIM — a mirror of sendLLMMessage.impl.ts's
 *  `sendFIM` map (electron-main can't be imported from common/browser code; keep in sync when
 *  adding a FIM impl). Lets the renderer refuse an autocomplete dispatch that main can only
 *  answer with a generic "Error running Autocomplete with <provider>". */
export const FIM_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(['v3code-local', 'mistral', 'ollama', 'openAICompatible', 'openAICompatible2', 'openAICompatible3', 'openRouter', 'vLLM', 'deepseek', 'lmStudio', 'liteLLM']);

export type SendLLMMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	/** Called AT MOST ONCE per request, when it terminates (final, error, or abort), with the
	 *  transport's best knowledge of billed usage. Always fired — with usage undefined when the
	 *  provider never reported any — so the browser side can release per-request state. */
	onUsage: (p: { usage?: LLMUsage; wireModelName?: string }) => void;
	logging: { loggingName: string, loggingExtras?: { [k: string]: any } };
	abortRef: AbortRef;

	modelSelection: ModelSelection;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;

	settingsOfProvider: SettingsOfProvider;
	mcpTools: InternalToolInfo[] | undefined;

	/** Set = route this request through the hub's hosted lane (paid plan); undefined = BYOK.
	 *  Survives the IPC crossing (not a blocked param). */
	hosted?: HostedInferenceOverride;
} & SendLLMType



// can't send functions across a proxy, use listeners instead
export type BlockedMainLLMMessageParams = 'onText' | 'onFinalMessage' | 'onError' | 'onUsage' | 'abortRef'
export type MainSendLLMMessageParams = Omit<SendLLMMessageParams, BlockedMainLLMMessageParams> & { requestId: string } & SendLLMType

export type MainLLMMessageAbortParams = { requestId: string }

export type EventLLMMessageOnTextParams = Parameters<OnText>[0] & { requestId: string }
export type EventLLMMessageOnFinalMessageParams = Parameters<OnFinalMessage>[0] & { requestId: string }
export type EventLLMMessageOnErrorParams = Parameters<OnError>[0] & { requestId: string }
export type EventLLMMessageOnUsageParams = { requestId: string; usage?: LLMUsage; wireModelName?: string }

// service -> main -> internal -> event (back to main)
// (browser)









// These are from 'ollama' SDK
interface OllamaModelDetails {
	parent_model: string;
	format: string;
	family: string;
	families: string[];
	parameter_size: string;
	quantization_level: string;
}

export type OllamaModelResponse = {
	name: string;
	modified_at: Date;
	size: number;
	digest: string;
	details: OllamaModelDetails;
	expires_at: Date;
	size_vram: number;
}

export type OpenaiCompatibleModelResponse = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}



// params to the true list fn
export type ModelListParams<ModelResponse> = {
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	onSuccess: (param: { models: ModelResponse[] }) => void;
	onError: (param: { error: string }) => void;
}

// params to the service
export type ServiceModelListParams<modelResponse> = {
	providerName: RefreshableProviderName;
	onSuccess: (param: { models: modelResponse[] }) => void;
	onError: (param: { error: any }) => void;
}

type BlockedMainModelListParams = 'onSuccess' | 'onError'
export type MainModelListParams<modelResponse> = Omit<ModelListParams<modelResponse>, BlockedMainModelListParams> & { providerName: RefreshableProviderName, requestId: string }

export type EventModelListOnSuccessParams<modelResponse> = Parameters<ModelListParams<modelResponse>['onSuccess']>[0] & { requestId: string }
export type EventModelListOnErrorParams<modelResponse> = Parameters<ModelListParams<modelResponse>['onError']>[0] & { requestId: string }
