/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// disable foreign import complaints
/* eslint-disable */
import Anthropic, { APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import { Ollama, type Message as OllamaMessage, type Tool as OllamaTool } from 'ollama';
import OpenAI, { ClientOptions, AzureOpenAI } from 'openai';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
import { Tool as GeminiTool, FunctionDeclaration, GoogleGenAI, ThinkingConfig } from '@google/genai';
import { GoogleAuth } from 'google-auth-library'
/* eslint-enable */

import { AnthropicLLMChatMessage, GeminiLLMChatMessage, HostedInferenceOverride, LLMChatMessage, LLMFIMMessage, LLMUsage, ModelListParams, OllamaModelResponse, OnError, OnFinalMessage, OnText, OnUsage, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { anthropicUsageToLLMUsage, openAICompatUsageToLLMUsage, AnthropicRawUsage, OpenAICompatRawUsage } from '../../common/helpers/llmUsage.js';
import { ChatMode, displayInfoOfProviderName, isProviderTemporarilyDisabled, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { getIsReasoningEnabledState, getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, defaultProviderSettings, getReservedOutputTokenSpace, isOpusHybridModel, OPUS_HYBRID_ADVISOR_MODEL, opusHybridExecutorModel } from '../../common/modelCapabilities.js';
import { LocalInferenceService } from '../localInference/localInferenceService.js';
import { resolveLocalModelPath } from '../localInference/localModelStore.js';
import { fimRepoContextToComment } from '../../common/helpers/fimRepoContext.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { availableTools, filterToCoreAgentTools, filterExcludedTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { providerInputSchemaOfTool, toOpenAICompatibleTool } from '../../common/prompt/openAICompatibleTool.js';
import { parseRawToolParamsString } from '../../common/prompt/toolCallParams.js';
import { localModelParameterBillions } from '../../common/localAgentRuntime.js';
import { localize } from '../../../../../nls.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { extractLocalTextToolCalls, localTextToolFallbackPrompt } from './localToolCallFallback.js';
import { getGrokPlanCredentials, GROK_CHAT_PROXY_BASE_URL } from './grokSubscriptionAuth.js';
import { CURSOR_LOCAL_DEFAULT_ENDPOINT } from './cursorLocalAuth.js';
import { getOpenaiPlanCredentials, OPENAI_PLAN_BASE_URL } from './openaiPlanSubscriptionAuth.js';
import { CLAUDE_CODE_IDENTITY_PROMPT, CLAUDE_PLAN_BASE_URL, getClaudePlanCredentials } from './claudeSubscriptionAuth.js';
import { copilotIdentityHeaders, getCopilotPlanCredentials } from './copilotSubscriptionAuth.js';
import { getGeminiPlanCredentials, streamCodeAssist } from './geminiSubscriptionAuth.js';
import { toGeminiSchema } from './geminiToolSchema.js';
import { isV3CodeFreeModelId, isV3CodeFreeTransientError, V3CODE_FREE_AUTO_MODEL } from '../../common/v3codeFreeModels.js';
import { V3CodeFreeRoute } from '../../common/v3codeFreeRouteManifest.js';
import { getV3CodeFreeRouteResolution } from './v3codeFreeRouteManifest.js';

/** One process-level affinity id, matching OpenCode's own client contract without identifying a
 *  V3Code user or workspace. Each model attempt gets a separate request id below. */
const V3CODE_FREE_SESSION_ID = generateUuid()

/** route id -> timestamp when it becomes eligible again. This is a local circuit breaker, NOT a
 *  V3Code user quota. Every direct-free request still leaves the user's own machine/IP/region. */
const v3codeFreeCooldownUntil = new Map<string, number>()

const _messagesHaveImage = (messages: LLMChatMessage[]): boolean =>
	messages.some(m => Array.isArray((m as { content?: unknown }).content)
		&& ((m as { content: unknown[] }).content).some(part => (part as { type?: string })?.type === 'image_url'))

/**
 * The rotating free lane. Tries the eligible free backends in order and only surfaces an error
 * once they have all declined, so "Free" keeps answering while any single backend is limited.
 *
 * Rotation is deliberately limited to the `free-auto` pick: choosing a CONCRETE free model is an
 * explicit choice and must fail honestly rather than quietly running somewhere else. It also only
 * ever retries a request that produced NOTHING - once text, reasoning or a tool call has been
 * streamed, switching models would duplicate or contradict what the user already saw.
 */
const _sendV3CodeFreeChat = async (params: SendChatParams_Internal): Promise<void> => {
	const now = Date.now()
	const wantsVision = _messagesHaveImage(params.messages)
	const resolution = await getV3CodeFreeRouteResolution()
	const matching = resolution.routes.filter(route =>
		route.mode === 'public-direct' && route.logicalModels.includes(params.modelName)
	)
	if (matching.length === 0) {
		params.onError({
			message: `No direct route is configured for ${params.modelName}. Try Free (Auto), or refresh after the route service is restored.`,
			fullError: null,
		})
		return
	}
	// Vision-capable routes lead image turns. Text-only routes remain fallback candidates because
	// V3Code's describe step may already have converted the image to text.
	const ordered = [...matching].sort((a, b) =>
		(wantsVision ? Number(b.capabilities.vision) - Number(a.capabilities.vision) : 0) ||
		a.priority - b.priority || a.id.localeCompare(b.id)
	)
	const eligible = ordered.filter(route => (v3codeFreeCooldownUntil.get(route.id) ?? 0) <= now)
	// Everything is cooling down: rather than refuse, retry the one that recovers soonest.
	const candidates = eligible.length > 0
		? eligible
		: [ordered.reduce((soonest, route) =>
			(v3codeFreeCooldownUntil.get(route.id) ?? 0) < (v3codeFreeCooldownUntil.get(soonest.id) ?? 0) ? route : soonest,
			ordered[0],
		)]

	const attemptFailures: string[] = []

	const attempt = async (idx: number): Promise<void> => {
		const route = candidates[idx]
		const modelName = route.upstreamModel
		const isLastCandidate = idx >= candidates.length - 1
		let emittedAnything = false

		const send = route.protocol === 'openai-responses' ? _sendOpenAIResponsesChat : _sendOpenAICompatibleChat
		return send({
			...params,
			modelName,
			onText: (p) => {
				if (p.fullText || p.fullReasoning || p.toolCall) { emittedAnything = true }
				params.onText(p)
			},
			onFinalMessage: (p) => {
				emittedAnything = true
				// Which backend actually served the turn is not guessable from "Free", and the user
				// audits this in the console every turn. Say it plainly there, NOT in the chat.
				console.log(`[free-lane] served by ${modelName} via ${route.id} (${resolution.source}:${resolution.revision})${idx > 0 ? ` after ${idx} rotation${idx === 1 ? '' : 's'}` : ''}`)
				params.onFinalMessage(p)
			},
			onError: (e) => {
				const message = `${e.message ?? e.fullError ?? ''}`
				const status = Number(message.match(/\b([45]\d\d)\b/)?.[1])
				const transient = isV3CodeFreeTransientError(message) || route.retryableStatuses.includes(status)
				if (!emittedAnything && !isLastCandidate && transient) {
					v3codeFreeCooldownUntil.set(route.id, Date.now() + route.cooldownMs)
					attemptFailures.push(`${modelName}: ${message}`)
					console.log(`[free-lane] ${modelName} declined (${message.slice(0, 120)}) -> rotating to ${candidates[idx + 1].upstreamModel}`)
					void attempt(idx + 1)
					return
				}
				if (!emittedAnything && transient) {
					v3codeFreeCooldownUntil.set(route.id, Date.now() + route.cooldownMs)
					attemptFailures.push(`${modelName}: ${message}`)
					const tried = attemptFailures.length
					// "Pick a different provider" is useless advice to the person most likely to hit
					// this: a brand-new user on the default free lane who has no key to switch to.
					// Point at the subscription lanes instead — those need no key either, just an
					// account they may already pay for.
					params.onError({
						message: `No working free model is available right now (tried ${tried}: ${candidates.slice(0, tried).map(candidate => candidate.upstreamModel).join(', ')}). Public free models can be rate limited, replaced, or withdrawn by their providers without notice. Try again shortly — or, if you already subscribe to Claude, GitHub Copilot, Gemini or Grok, sign in under Settings > Account to use your plan instead. No API key needed.`,
						fullError: e.fullError ?? null,
					})
					return
				}
				// Not a capacity problem (or output already streamed): report it as-is, naming the
				// backend so the error is traceable to a real model rather than to "Free".
				params.onError({ message: `${modelName}: ${message}`, fullError: e.fullError ?? null })
			},
		}, route)
	}

	return attempt(0)
}

/** Static headers the Grok CLI chat proxy expects (identity gate). Per-request the model is
 *  routed via the `x-grok-model-override` header, added at call time in _sendOpenAICompatibleChat. */
const grokPlanStaticHeaders = (version: string): Record<string, string> => ({
	'X-XAI-Token-Auth': 'xai-grok-cli',
	'x-grok-client-identifier': 'grok-shell',
	'x-grok-client-version': version,
	'accept': 'text/event-stream',
})

const getGoogleApiKey = async () => {
	// module-level singleton
	const auth = new GoogleAuth({ scopes: `https://www.googleapis.com/auth/cloud-platform` });
	const key = await auth.getAccessToken()
	if (!key) throw new Error(`Google API failed to generate a key.`)
	return key
}




type InternalCommonMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	/** Report billed usage as soon as (and whenever) it is known — the wrapper keeps the last
	 *  snapshot so aborted/errored streams still get metered. Optional: providers that never
	 *  report usage simply don't call it. */
	onUsage?: OnUsage;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
}

type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	/** Minimal assembly preset: advertise only the core tool subset in the native tool payload. */
	coreToolsOnly: boolean | undefined;
	/** Tools the user disabled in settings (e.g. ask_user) — stripped from the native tool payload. */
	excludeTools: readonly string[] | undefined;
	mcpTools: InternalToolInfo[] | undefined;
	/** Set = route through the V3Code hub's hosted lane (paid plan); undefined = BYOK. */
	hosted: HostedInferenceOverride | undefined;
}
type SendFIMParams_Internal = InternalCommonMessageParams & { messages: LLMFIMMessage; separateSystemMessage: string | undefined; }
export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>


const invalidApiKeyMessage = (providerName: ProviderName) => `Invalid ${displayInfoOfProviderName(providerName).title} API key. Update the key in Settings > Models, or pick a model from a different provider in the model picker.`
// Shown for a HOSTED-lane 401 only if the renderer's silent refresh+retry (and clean sign-out)
// path did not handle it. Never say "invalid API key" to a paying user on the hosted lane.
const hostedSessionExpiredMessage = `Your V3Code session expired. Sign in again from Settings > Account to restore your plan.`

type ProviderErrorFields = { code?: string; type?: string; message?: string; status?: number }

const _asErrorRecord = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined

/** Pull the useful fields out of both OpenAI- and Anthropic-shaped error envelopes. */
function providerErrorFields(error: unknown): ProviderErrorFields {
	const errorRecord = _asErrorRecord(error)
	const outer = _asErrorRecord(errorRecord?.error)
	const nested = _asErrorRecord(outer?.error)
	const pickString = (key: string): string | undefined => {
		const nestedValue = nested?.[key]
		if (typeof nestedValue === 'string') { return nestedValue }
		const outerValue = outer?.[key]
		return typeof outerValue === 'string' ? outerValue : undefined
	}
	return {
		code: pickString('code'),
		type: pickString('type'),
		message: pickString('message'),
		status: typeof errorRecord?.status === 'number' ? errorRecord.status : undefined,
	}
}

const providerBrand = (providerName: ProviderName, hosted?: boolean): string => {
	// Hosted plan requests run on V3Code's platform, not the customer's relationship with the
	// upstream vendor — branding a hub failure "DeepSeek is temporarily unavailable" pointed
	// paying users at a company they never signed up with (and leaked the tier's identity).
	if (hosted) { return 'V3Code' }
	if (providerName === 'anthropic' || providerName === 'claudePlan') { return 'Anthropic' }
	if (providerName === 'gemini' || providerName === 'geminiPlan' || providerName === 'googleVertex') { return 'Google' }
	if (providerName === 'xAI' || providerName === 'grokPlan') { return 'Grok' }
	if (providerName === 'openAI' || providerName === 'openaiPlan') { return providerName === 'openaiPlan' ? 'OpenAI (Plan)' : 'OpenAI' }
	return displayInfoOfProviderName(providerName).title
}

/**
 * Provider SDK errors often stringify the complete JSON response, including request ids. Keep that
 * object in the console and send chat one stable, human sentence instead.
 */
function providerErrorMessage(providerName: ProviderName, error: unknown, hosted?: boolean): string {
	const brand = providerBrand(providerName, hosted)
	const fields = providerErrorFields(error)
	const errorMessage = error instanceof Error ? error.message : ''
	const signal = `${fields.status ?? ''} ${fields.code ?? ''} ${fields.type ?? ''} ${fields.message ?? ''} ${errorMessage}`.toLowerCase()

	if (providerName === 'ollama' && (signal.includes('econnrefused') || signal.includes('connection error') || signal.includes('fetch failed') || signal.includes('failed to connect'))) {
		return 'Ollama is not running at the configured endpoint. Start Ollama (or run `ollama serve`) and retry.'
	}
	if (providerName === 'ollama' && (signal.includes('not found') || signal.includes('model') && signal.includes('missing'))) {
		return 'That Ollama model is not installed. Run `ollama pull <model>` and retry.'
	}

	if (fields.status === 529 || /\b529\b/.test(signal) || signal.includes('overloaded')) {
		return `${brand} is overloaded — try again in a minute.`
	}
	// OpenAI's $0-balance state is a 429 with code `insufficient_quota` — it is NOT a rate limit
	// and retrying can never succeed. Check this BEFORE the generic 429 branch.
	if (signal.includes('insufficient_quota') || signal.includes('exceeded your current quota')) {
		return localize('void.llm.insufficientQuota', "Your {0} account has no API credits left, so retrying won't help. Add credits or a payment method in your {0} billing settings, then send again.", brand)
	}
	if (fields.status === 429 || /\b429\b/.test(signal) || signal.includes('rate_limit') || signal.includes('rate limit') || signal.includes('too many requests')) {
		return `${brand} rate limit reached — try again shortly.`
	}
	if (signal.includes('timed out') || signal.includes('timeout')) {
		return `${brand} timed out — try again.`
	}
	if ((fields.status !== undefined && fields.status >= 500) || /\b5\d\d\b/.test(signal) || signal.includes('temporarily unavailable')) {
		return `${brand} is temporarily unavailable — try again in a minute.`
	}

	// A nested provider message is generally concise and useful. Never fall back to Error.message
	// when it contains an encoded JSON body — that is the wall this presentation layer removes.
	const safeDetail = fields.message?.trim()
	if (safeDetail && safeDetail.length <= 240 && !/[{\[]/.test(safeDetail)) {
		return `${brand}: ${safeDetail.replace(/[.\s]+$/, '')}.`
	}
	return `${brand} request failed${fields.status ? ` (${fields.status})` : ''}. Try again.`
}

function reportProviderError(providerName: ProviderName, error: unknown, onError: OnError): void {
	console.error(`[llm:${providerName}] provider request failed`, error)
	onError({ message: providerErrorMessage(providerName, error), fullError: null })
}

// ------------ OPENAI-COMPATIBLE (HELPERS) ------------



const parseHeadersJSON = (s: string | undefined): Record<string, string | null | undefined> | undefined => {
	if (!s) return undefined
	try {
		return JSON.parse(s)
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`)
	}
}

// OpenAI's bundled node-fetch declaration predates Node's native Request/Response types. The
// runtime signatures are compatible; adapt the declaration once at this boundary.
const copilotNativeFetch = globalThis.fetch as unknown as NonNullable<ClientOptions['fetch']>

const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName, includeInPayload, hosted, v3codeFreeRoute }: { settingsOfProvider: SettingsOfProvider, providerName: ProviderName, includeInPayload?: { [s: string]: any }, hosted?: HostedInferenceOverride, v3codeFreeRoute?: V3CodeFreeRoute }) => {
	const commonPayloadOpts: ClientOptions = {
		dangerouslyAllowBrowser: true,
		...includeInPayload,
	}
	// Hosted plan lane: point the OpenAI SDK at the V3Code hub with the account token as
	// the bearer. Ignores the provider's own BYOK settings entirely (the whole point is
	// to run on OUR keys). `endpoint` already ends in the OpenAI base (…/v1).
	// maxRetries: 0 — the SDK's default silent retries (2× on 429/5xx, no idempotency key)
	// stacked under the app-level retry meant one user turn could reach the hub as up to 12
	// distinct billable requests. Retry policy for the hosted lane lives in ONE place (the
	// renderer's classified retry), and each request carries an idempotency key so the hub
	// can dedupe any redelivery.
	if (hosted) {
		return new OpenAI({
			baseURL: hosted.endpoint, apiKey: hosted.token, maxRetries: 0,
			// The renderer keys this to the logical request, so its silent 401 retry (a NEW
			// client with a fresh token) redelivers under the SAME key and the hub can dedupe.
			defaultHeaders: { 'Idempotency-Key': hosted.idempotencyKey ?? generateUuid() },
			...commonPayloadOpts,
		})
	}
	if (providerName === 'openAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'ollama') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'vLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'liteLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'lmStudio') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'openRouter') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: thisConfig.apiKey,
			defaultHeaders: {
				'HTTP-Referer': 'https://v3code.dev', // Optional, for including your app on openrouter.ai rankings.
				'X-Title': 'V3Code', // Optional. Shows in rankings on openrouter.ai.
			},
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'googleVertex') {
		// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		const thisConfig = settingsOfProvider[providerName]
		const baseURL = `https://${thisConfig.region}-aiplatform.googleapis.com/v1/projects/${thisConfig.project}/locations/${thisConfig.region}/endpoints/${'openapi'}`
		const apiKey = await getGoogleApiKey()
		return new OpenAI({ baseURL: baseURL, apiKey: apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'microsoftAzure') {
		// https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP
		//  https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
		const thisConfig = settingsOfProvider[providerName]
		const endpoint = `https://${thisConfig.project}.openai.azure.com/`;
		const apiVersion = thisConfig.azureApiVersion ?? '2024-04-01-preview';
		const options = { endpoint, apiKey: thisConfig.apiKey, apiVersion };
		return new AzureOpenAI({ ...options, ...commonPayloadOpts });
	}
	else if (providerName === 'awsBedrock') {
		/**
		  * We treat Bedrock as *OpenAI-compatible only through a proxy*:
		  *   • LiteLLM default → http://localhost:4000/v1
		  *   • Bedrock-Access-Gateway → https://<api-id>.execute-api.<region>.amazonaws.com/openai/
		  *
		  * The native Bedrock runtime endpoint
		  *   https://bedrock-runtime.<region>.amazonaws.com
		  * is **NOT** OpenAI-compatible, so we do *not* fall back to it here.
		  */
		const { endpoint, apiKey } = settingsOfProvider.awsBedrock

		// 1. use the user-supplied proxy if present
		// 2. otherwise default to local LiteLLM
		let baseURL = endpoint || 'http://localhost:4000/v1'

		// Normalize: make sure we end with "/v1"
		if (!baseURL.endsWith('/v1'))
			baseURL = baseURL.replace(/\/+$/, '') + '/v1'

		return new OpenAI({ baseURL, apiKey, ...commonPayloadOpts })
	}


	else if (providerName === 'v3code-free') {
		if (!v3codeFreeRoute) {
			throw new Error('V3Code free route was not resolved before transport setup.')
		}
		// The signed control plane supplies only PUBLIC connection metadata. This OpenAI client
		// still runs in Electron main, on the user's machine, so the upstream sees the user's real
		// IP/region. Redirects are rejected to prevent a route from forwarding prompts elsewhere.
		const directFetch = ((url: string | URL | Request, init?: RequestInit) =>
			globalThis.fetch(url, { ...init, redirect: 'error' })) as unknown as NonNullable<ClientOptions['fetch']>
		const endpointHost = new URL(v3codeFreeRoute.endpoint).hostname.toLowerCase()
		const providerHeaders = endpointHost === 'opencode.ai' ? {
			'x-opencode-session': V3CODE_FREE_SESSION_ID,
			'x-opencode-request': generateUuid(),
		} : {}
		return new OpenAI({
			baseURL: v3codeFreeRoute.endpoint,
			apiKey: v3codeFreeRoute.publicApiKey || 'public',
			maxRetries: 0,
			timeout: v3codeFreeRoute.timeoutMs,
			fetch: directFetch,
			defaultHeaders: {
				...(v3codeFreeRoute.headers ?? {}),
				...providerHeaders,
			},
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'deepseek') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'openAICompatible' || providerName === 'openAICompatible2' || providerName === 'openAICompatible3') {
		const thisConfig = settingsOfProvider[providerName]
		const headers = parseHeadersJSON(thisConfig.headersJSON)
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey, defaultHeaders: headers, ...commonPayloadOpts })
	}
	else if (providerName === 'cursorLocal') {
		// Local lane — the "API for Cursor" app holds the official key and serves an
		// OpenAI-compatible API against the user's Cursor subscription. No key in settings:
		// the SDK requires a non-empty apiKey field, so send a placeholder the local server
		// ignores (auth is implicit — only localhost can reach it).
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: thisConfig.endpoint || CURSOR_LOCAL_DEFAULT_ENDPOINT, apiKey: 'cursor-local', ...commonPayloadOpts })
	}
	else if (providerName === 'openaiPlan') {
		const creds = await getOpenaiPlanCredentials()
		if (!creds) {
			throw new Error(`Not signed in to ChatGPT. Run \`codex login\` in a terminal, then try again. (Settings > Models > OpenAI (Plan)). This lane never uses an API key.`)
		}
		const headers: Record<string, string> = {}
		if (creds.accountId) { headers['ChatGPT-Account-Id'] = creds.accountId }
		return new OpenAI({
			baseURL: OPENAI_PLAN_BASE_URL,
			apiKey: creds.token,
			defaultHeaders: headers,
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'groq') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'xAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'grokPlan') {
		// Subscription lane: token comes from `grok login` (~/.grok/auth.json), NOT a BYOK key.
		// Talks to the Grok CLI chat proxy with the CLI identity headers. Per-model routing is
		// done via the x-grok-model-override header appended per request.
		const creds = await getGrokPlanCredentials()
		if (!creds) {
			throw new Error(`Not signed in to Grok. Open a terminal and run \`grok login\`, then try again. (Settings > Models > Grok (Plan))`)
		}
		return new OpenAI({
			baseURL: GROK_CHAT_PROXY_BASE_URL,
			apiKey: creds.token,
			defaultHeaders: grokPlanStaticHeaders(creds.version),
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'copilot') {
		// Subscription lane: current Copilot CLI OAuth tokens go straight to the Copilot API;
		// older `ghu_` editor-plugin tokens are exchanged for a short-lived session first.
		const creds = await getCopilotPlanCredentials()
		if (!creds) {
			throw new Error(`Not signed in to GitHub Copilot. Open a terminal and run \`copilot login\`, then try again. (Settings > Models > GitHub Copilot)`)
		}
		return new OpenAI({
			baseURL: creds.baseURL,
			apiKey: creds.token,
			defaultHeaders: copilotIdentityHeaders(),
			// Copilot's SSE response ends cleanly for Node's native fetch, while the legacy
			// node-fetch shim reports ERR_STREAM_PREMATURE_CLOSE after the final [DONE] frame.
			fetch: copilotNativeFetch,
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'mistral') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}

	else throw new Error(`Void providerName was invalid: ${providerName}.`)
}


const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens, repoContext }, onFinalMessage, onError, onUsage, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel }: SendFIMParams_Internal) => {

	prefix = fimRepoContextToComment(repoContext) + prefix // repo-level neighbor files (no special-token support here)

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, includeInPayload: additionalOpenAIPayload })
	openai.completions
		.create({
			model: modelName,
			prompt: prefix,
			suffix: suffix,
			stop: stopTokens,
			max_tokens: 300,
		})
		.then(async response => {
			const fullText = response.choices[0]?.text
			// FIM completions bill like any other request — autocomplete was previously invisible
			// to the usage meter despite being the highest-request-count feature.
			const usage: LLMUsage | undefined = response.usage ? openAICompatUsageToLLMUsage(response.usage as OpenAICompatRawUsage) : undefined
			if (usage) { onUsage?.({ usage }) }
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null, ...(usage ? { usage } : {}) });
		})
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else { reportProviderError(providerName, error, onError); }
		})
}

// DeepSeek FIM lives on the beta base URL (chat stays on /v1). See
// https://api-docs.deepseek.com/guides/fim_completion
const sendDeepSeekFIM = ({ messages: { prefix, suffix, stopTokens, repoContext }, onFinalMessage, onError, onUsage, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel }: SendFIMParams_Internal) => {
	prefix = fimRepoContextToComment(repoContext) + prefix

	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const apiKey = settingsOfProvider.deepseek.apiKey
	if (!apiKey) {
		onError({ message: invalidApiKeyMessage('deepseek'), fullError: null })
		return
	}

	const openai = new OpenAI({ baseURL: 'https://api.deepseek.com/beta', apiKey })
	openai.completions
		.create({
			model: modelName,
			prompt: prefix,
			suffix: suffix,
			stop: stopTokens,
			max_tokens: 300,
		})
		.then(async response => {
			const fullText = response.choices[0]?.text ?? ''
			const usage: LLMUsage | undefined = response.usage ? openAICompatUsageToLLMUsage(response.usage as OpenAICompatRawUsage) : undefined
			if (usage) { onUsage?.({ usage }) }
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null, ...(usage ? { usage } : {}) });
		})
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage('deepseek'), fullError: error }); }
			else { reportProviderError('deepseek', error, onError); }
		})
}


const allowedToolsForRequest = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, coreToolsOnly?: boolean, excludeTools?: readonly string[]) => {
	let allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || allowedTools.length === 0) return null
	if (coreToolsOnly) allowedTools = filterToCoreAgentTools(allowedTools, mcpTools)
	return filterExcludedTools(allowedTools, excludeTools)
}

const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, coreToolsOnly?: boolean, excludeTools?: readonly string[]) => {
	const allowedTools = allowedToolsForRequest(chatMode, mcpTools, coreToolsOnly, excludeTools)
	if (!allowedTools) return null

	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const tool of allowedTools) {
		openAITools.push(toOpenAICompatibleTool(tool))
	}
	return openAITools
}


/**
 * Parse tool-call JSON that is still arriving, so the UI can show a write AS IT STREAMS.
 *
 * The sidebar already renders a live preview of edit_file / rewrite_file from
 * `toolCallSoFar.rawParams.new_content` (see EditToolSoFar in SidebarChat.tsx), and it works for
 * models that emit tools as XML because parseXMLPrefixToToolCall returns real partial params.
 * Native tool-calling models -- every Claude model, and the OpenAI/Gemini paths -- emitted
 * `rawParams: {}` on every delta, so for them the preview never rendered at all. A 42,000
 * character write showed a bare tool name and nothing else for twenty minutes, which is
 * indistinguishable from a hang.
 *
 * Strategy: close whatever is open (a mid-string quote, unbalanced braces/brackets) and parse
 * the repaired text. A truncated value comes back as the prefix received so far, which is
 * exactly what a streaming preview wants.
 */
const parsePartialToolJSON = (jsonSoFar: string): RawToolParamsObj | null => {
	const s = jsonSoFar.trimStart()
	if (!s.startsWith('{')) { return null }

	let inString = false
	let escaped = false
	const closers: string[] = []
	let end = s.length
	for (let i = 0; i < s.length; i++) {
		const c = s[i]
		if (escaped) { escaped = false; continue }
		if (c === '\\') { if (inString) { escaped = true } continue }
		if (c === '"') { inString = !inString; continue }
		if (inString) { continue }
		if (c === '{') { closers.push('}') }
		else if (c === '[') { closers.push(']') }
		else if (c === '}' || c === ']') { closers.pop() }
	}
	// A trailing backslash would escape the quote we are about to add.
	if (escaped) { end -= 1 }

	const attempt = (body: string): RawToolParamsObj | null => {
		let text = body
		if (inString) { text += '"' }
		for (let i = closers.length - 1; i >= 0; i--) { text += closers[i] }
		try {
			const parsed = JSON.parse(text)
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RawToolParamsObj : null
		} catch { return null }
	}

	const direct = attempt(s.slice(0, end))
	if (direct) { return direct }

	// Two shapes the naive close cannot fix: a dangling key with no value yet
	// (`{"uri":"a.ts","new_content"`) and a trailing comma (`{"uri":"a.ts",`). Cut back to the
	// last comma and retry, which yields every param completed so far.
	const lastComma = s.lastIndexOf(',', end)
	if (lastComma > 0) {
		inString = false
		return attempt(s.slice(0, lastComma))
	}
	return null
}

/** How often a still-streaming tool call is re-parsed for the live preview. */
const PARTIAL_TOOL_PARSE_INTERVAL_MS = 150

/**
 * Throttled live-preview parser for providers that accumulate tool arguments as a JSON string
 * (OpenAI-compatible, Gemini). Re-parsing a growing 40k payload on every delta would be
 * quadratic, so the parse is rate-limited and the last good result reused in between.
 */
const makeLiveToolParamsReader = () => {
	let lastMs = 0
	let last: RawToolParamsObj = {}
	let lastSource = ''
	return (argsSoFar: string | undefined): { rawParams: RawToolParamsObj, doneParams: RawToolCallObj['doneParams'] } => {
		if (!argsSoFar) { return { rawParams: {}, doneParams: [] } }
		if (argsSoFar !== lastSource) { lastSource = argsSoFar }
		const now = Date.now()
		if (now - lastMs >= PARTIAL_TOOL_PARSE_INTERVAL_MS) {
			lastMs = now
			last = parsePartialToolJSON(argsSoFar) ?? last
		}
		const keys = Object.keys(last) as RawToolCallObj['doneParams']
		return { rawParams: last, doneParams: keys.slice(0, Math.max(0, keys.length - 1)) }
	}
}

// convert LLM tool call to our tool format
const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	const rawParams = parseRawToolParamsString(toolParamsStr)
	if (!rawParams) return null
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


const rawToolCallObjOfAnthropicParams = (toolBlock: Anthropic.Messages.ToolUseBlock): RawToolCallObj | null => {
	const { id, name, input } = toolBlock

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


// ------------ OPENAI-COMPATIBLE ------------


const _sendOpenAICompatibleChat = async ({ messages, onText, onFinalMessage, onError, onUsage, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, coreToolsOnly, excludeTools, separateSystemMessage, overridesOfModel, mcpTools, hosted }: SendChatParams_Internal, v3codeFreeRoute?: V3CodeFreeRoute) => {
	const {
		modelName,
		specialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here

	// Reasoning payload (reasoning_effort / reasoning_format / OpenRouter `reasoning`, etc.)
	// belongs in the REQUEST BODY. It was only ever spread into the SDK *constructor*
	// (ClientOptions), which ignores unknown fields — so every reasoning/effort toggle on
	// OpenAI-compatible providers was a silent no-op. Build it once and add it to `options` below.
	const reasoningBodyPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
	}
	const includeInPayload = {
		...reasoningBodyPayload,
		...additionalOpenAIPayload
	}

	// tools
	const potentialTools = openAITools(chatMode, mcpTools, coreToolsOnly, excludeTools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {}

	// GPT-5.x reasoning models reject `reasoning_effort` when function tools are present on
	// /v1/chat/completions ("400 Function tools with reasoning_effort are not supported for
	// gpt-5.6-luna ... set reasoning_effort to 'none'"). Keep the tools (the agent is useless
	// without them) and follow OpenAI's documented remedy for this request: force 'none'.
	const hasNativeTools = 'tools' in nativeToolsObj
	if (hasNativeTools && /gpt-5/i.test(modelName) && 'reasoning_effort' in reasoningBodyPayload) {
		reasoningBodyPayload.reasoning_effort = 'none'
	}

	// instance
	const openai: OpenAI = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, includeInPayload, hosted, v3codeFreeRoute })
	if (providerName === 'microsoftAzure' && !hosted) {
		// Required to select the model
		(openai as AzureOpenAI).deploymentName = modelName;
	}
	const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		// Hosted lane sends the canonical wire model ("provider/model") the hub allowlists;
		// BYOK sends the provider's own model id.
		model: hosted?.wireModel ?? modelName,
		messages: messages as any,
		stream: true,
		stream_options: { include_usage: true },
		...nativeToolsObj,
		...reasoningBodyPayload,
		...additionalOpenAIPayload
		// max_completion_tokens: maxTokens,
	}

	// open source models - manually parse think tokens
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	// Accumulate streamed tool-call deltas BY INDEX. Some OpenAI-compatible providers (notably
	// xAI/Grok) omit `index` on the delta or start above 0; the old code did `if (index !== 0)
	// continue`, which silently dropped EVERY such tool call (undefined !== 0) — the agent then
	// saw zero tools and stopped mid-turn ("narrates then stops"). Treat a missing index as 0 and
	// keep one slot per index so PARALLEL tool calls also survive.
	const toolSlotsByIndex = new Map<number, { name: string; args: string; id: string }>()
	const readLiveToolParams = makeLiveToolParamsReader()
	const toolSlotFor = (index: number | undefined) => {
		const i = index ?? 0
		let slot = toolSlotsByIndex.get(i)
		if (!slot) { slot = { name: '', args: '', id: '' }; toolSlotsByIndex.set(i, slot) }
		return slot
	}
	let streamUsage: LLMUsage | undefined = undefined
	let finishReason: string | undefined = undefined

	// Grok CLI proxy routes on the x-grok-model-override header (not the JSON body model).
	// Register cancellation BEFORE waiting for response headers / the first stream chunk.
	// The OpenAI SDK only resolves create() after the provider begins responding; for a local
	// model, prompt ingestion can take minutes. Installing the old response.controller aborter
	// inside .then() meant Cancel and the stall watchdog were no-ops during exactly that window.
	const requestAbortController = new AbortController()
	_setAborter(() => requestAbortController.abort())
	const requestOptions = {
		...(providerName === 'grokPlan'
			? { headers: { 'x-grok-model-override': hosted?.wireModel ?? modelName } }
			: {}),
		signal: requestAbortController.signal,
	}
	openai.chat.completions
		.create(options, requestOptions)
		.then(async response => {
			// when receive text
			for await (const chunk of response) {
				// message
				const newText = chunk.choices[0]?.delta?.content ?? ''
				fullTextSoFar += newText

				// finish_reason — 'length' means the response was cut by the output-token cap,
				// which is the #1 way large tool-call payloads (rewrite_file) end up as
				// truncated, unparsable JSON. Track it so we can report instead of silently dropping.
				const fr = chunk.choices[0]?.finish_reason
				if (fr) { finishReason = fr }

				// tool call — accumulate per index so parallel and undefined-index tools all survive
				for (const tool of chunk.choices[0]?.delta?.tool_calls ?? []) {
					const slot = toolSlotFor(tool.index)
					slot.name += tool.function?.name ?? ''
					slot.args += tool.function?.arguments ?? ''
					slot.id += tool.id ?? ''
				}


				// reasoning
				let newReasoning = ''
				if (nameOfReasoningFieldInDelta) {
					// @ts-ignore
					newReasoning = (chunk.choices[0]?.delta?.[nameOfReasoningFieldInDelta] || '') + ''
					// A gateway that fronts several vendors behind ONE provider (the free Zen lane,
					// OpenRouter-backed lanes) mixes models that stream thinking in
					// `reasoning_content` with models that use `reasoning`, so a single configured
					// field name silently drops half of them — and a reasoning-only chunk whose
					// `content` is null then looks like an empty response. Try the other spelling.
					if (!newReasoning) {
						const otherReasoningField = nameOfReasoningFieldInDelta === 'reasoning' ? 'reasoning_content' : 'reasoning'
						// @ts-ignore
						newReasoning = (chunk.choices[0]?.delta?.[otherReasoningField] || '') + ''
					}
					fullReasoningSoFar += newReasoning
				}

				// usage (sent in the final chunk when stream_options.include_usage is true).
				// Cache hits live in prompt_tokens_details.cached_tokens on OpenAI/xAI/OpenRouter
				// (prompt_cache_hit_tokens is DeepSeek's spelling) — the normalizer reads both.
				// Reading only DeepSeek's field billed every cached GPT/Grok token at the full
				// input rate: a 2-4x over-count on cache-heavy sessions.
				if (chunk.usage) {
					streamUsage = openAICompatUsageToLLMUsage(chunk.usage as OpenAICompatRawUsage)
					onUsage?.({ usage: streamUsage })
				}

				// call onText — show the first tool live (the full set is assembled on final).
				// Partial args are parsed so the sidebar can render the write AS IT STREAMS;
				// sending rawParams: {} here is what made large writes look like a hang.
				const liveSlot = toolSlotsByIndex.get(0)
				const livePreview = readLiveToolParams(liveSlot?.args)
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !liveSlot?.name ? undefined : { name: liveSlot.name, rawParams: livePreview.rawParams, isDone: false, doneParams: livePreview.doneParams, id: liveSlot.id },
				})

			}
			// on final — assemble EVERY accumulated tool call (sorted by index), not just the first
			const toolSlots = [...toolSlotsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1])
			const anyToolName = toolSlots.some(s => s.name)
			if (!fullTextSoFar && !fullReasoningSoFar && !anyToolName) {
				// A bare "response was empty" told the user nothing and read as a random red failure
				// mid-turn. The finish reason is the whole diagnosis: 'length' means the model spent
				// its entire output budget before emitting anything visible (typical for a reasoning
				// model whose reserved output space is too small), while 'content_filter' or a missing
				// reason are different problems entirely. Report it.
				const emptyDetail = finishReason === 'length'
					? ` The model hit its output-token limit before producing any visible text — usually reasoning consumed the whole reply budget. Lower the reasoning effort for this model, or raise its reserved output space in Settings > Models.`
					: finishReason
						? ` (finish_reason: ${finishReason})`
						: ` The provider closed the stream without sending any content or finish reason.`
				onError({ message: `V3Code: Response from model was empty.${emptyDetail}`, fullError: null })
			}
			else {
				const parsedSlots = toolSlots.map(s => ({ slot: s, tc: rawToolCallObjOfParamsStr(s.name, s.args, s.id) }))
				// A slot that streamed a tool NAME but whose arguments don't parse means the call was
				// truncated (finish_reason 'length' — huge rewrite_file payloads hit the output-token
				// cap) or the provider sent malformed JSON. Silently filtering it out made the turn end
				// as plain text: the model's stated intent ("Now rewriting foo.ts…") stayed in history,
				// no tool ever ran, and nobody was told. Fail LOUDLY instead so the user/agent can retry.
				const droppedSlot = parsedSlots.find(p => p.slot.name && !p.tc)
				if (droppedSlot) {
					const lengthNote = finishReason === 'length' ? ' because the response hit the output-token limit' : ''
					onError({ message: `V3Code: The model's "${droppedSlot.slot.name}" tool call arrived with truncated or malformed arguments${lengthNote} and could not be executed. Retry, or ask for a smaller change per step.`, fullError: null })
					return
				}
				const toolCalls = parsedSlots
					.map(p => p.tc)
					.filter((tc): tc is NonNullable<typeof tc> => !!tc)
				const toolCallObj = toolCalls.length ? { toolCall: toolCalls[0], toolCalls } : {}
				const usageObj = streamUsage ? { usage: streamUsage } : {}
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj, ...usageObj });
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(error => {
			console.error(`[llm:${providerName}] provider request failed`, error)
			// A 401 on the HOSTED (paid) lane is a stale/revoked ACCOUNT token, NOT a bad API key
			// (there is no user key here). Flag it so the renderer silently refreshes + retries, and
			// never shows the misleading "Invalid API key" to a paying user.
			if (error instanceof OpenAI.APIError && error.status === 401) {
				// Zen's anonymous lane has no user-entered credential to invalidate. It returns 401
				// when a temporary free model id is retired or unsupported, so preserve that real
				// provider message and let free-auto rotate instead of blaming a nonexistent API key.
				if (!hosted && providerName === 'v3code-free') {
					onError({ message: providerErrorMessage(providerName, error), fullError: null });
					return;
				}
				if (!hosted && providerName === 'cursorLocal') {
					onError({ message: 'Cursor (Local) is not signed in. Open the API for Cursor app, paste your official Cursor API key (Dashboard → Integrations), and try again.', fullError: null });
					return;
				}
				if (!hosted && providerName === 'openaiPlan') {
					onError({ message: 'OpenAI (Plan) is not signed in. Run `codex login` so ChatGPT-plan tokens are in ~/.codex/auth.json. This lane never uses an API key.', fullError: null });
					return;
				}
				onError(hosted
					? { message: hostedSessionExpiredMessage, fullError: null, hostedAuthExpired: true }
					: { message: invalidApiKeyMessage(providerName), fullError: null });
				return;
			}
			// Hosted 402 = plan entitlement / included-credit gate (credit_exhausted, no_active_plan).
			// Surface a typed flag so the renderer shows the overage CTA — never "Invalid API key",
			// never silent BYOK.
			if (hosted && error instanceof OpenAI.APIError && error.status === 402) {
				const code = hostedErrorCode(error);
				const message = code === 'no_active_plan'
					? `A paid V3Code plan is required for this model. Upgrade from Settings > Account, or pick one of your own provider models (BYOK).`
					: `You've used this month's included plan AI. Enable on-demand overage on your account (Settings → Account → Manage) to keep using plan models, or switch to BYOK.`;
				onError({ message, fullError: null, hostedCreditExhausted: code !== 'no_active_plan', terminal: true });
				return;
			}
			if (!hosted && providerName === 'cursorLocal' && error instanceof OpenAI.APIError && error.status === 413) {
				onError({ message: 'Cursor (Local) rejected the request as too large. Start a new chat, or pick a smaller model, so the condensed payload fits the local app\'s body limit.', fullError: null });
				return;
			}
			onError({ message: providerErrorMessage(providerName, error, !!hosted), fullError: null });
		})
}

type CopilotResponsesToolSlot = { name: string; args: string; id: string }

/** Convert the OpenAI chat history V3Code already assembles into stateless Responses API items. */
const copilotResponsesInput = (messages: LLMChatMessage[]): unknown[] => {
	const input: unknown[] = []

	const messageContent = (content: unknown, allowImages: boolean): string | unknown[] => {
		if (typeof content === 'string') { return content }
		if (!Array.isArray(content)) { return '' }
		const parts: unknown[] = []
		for (const rawPart of content) {
			const part = _asErrorRecord(rawPart)
			if (!part) { continue }
			if (part.type === 'text' && typeof part.text === 'string') {
				parts.push({ type: 'input_text', text: part.text })
				continue
			}
			if (allowImages && part.type === 'image_url') {
				const image = _asErrorRecord(part.image_url)
				const url = typeof image?.url === 'string' ? image.url : typeof part.image_url === 'string' ? part.image_url : undefined
				if (url) { parts.push({ type: 'input_image', detail: 'auto', image_url: url }) }
			}
		}
		return parts
	}

	for (const rawMessage of messages) {
		const message = rawMessage as unknown as {
			role?: string;
			content?: unknown;
			tool_call_id?: string;
			tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
		}
		if (message.role === 'tool' && message.tool_call_id) {
			input.push({
				type: 'function_call_output',
				call_id: message.tool_call_id,
				output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
			})
			continue
		}

		if (message.role === 'assistant') {
			const content = messageContent(message.content, false)
			const hasContent = typeof content === 'string' ? content.length > 0 : content.length > 0
			if (hasContent) { input.push({ type: 'message', role: 'assistant', content }) }
			for (const toolCall of message.tool_calls ?? []) {
				if (!toolCall.id || !toolCall.function?.name) { continue }
				input.push({
					type: 'function_call',
					call_id: toolCall.id,
					name: toolCall.function.name,
					arguments: toolCall.function.arguments ?? '{}',
				})
			}
			continue
		}

		if (message.role === 'system' || message.role === 'developer' || message.role === 'user') {
			input.push({
				type: 'message',
				role: message.role,
				content: messageContent(message.content, message.role === 'user'),
			})
		}
	}

	return input
}

const copilotResponsesUsage = (usage: unknown): LLMUsage | undefined => {
	const raw = _asErrorRecord(usage)
	if (!raw) { return undefined }
	const inputDetails = _asErrorRecord(raw.input_tokens_details)
	return {
		prompt_tokens: typeof raw.input_tokens === 'number' ? raw.input_tokens : undefined,
		completion_tokens: typeof raw.output_tokens === 'number' ? raw.output_tokens : undefined,
		total_tokens: typeof raw.total_tokens === 'number' ? raw.total_tokens : undefined,
		prompt_cache_hit_tokens: typeof inputDetails?.cached_tokens === 'number' ? inputDetails.cached_tokens : undefined,
		prompt_cache_write_tokens: typeof inputDetails?.cache_write_tokens === 'number' ? inputDetails.cache_write_tokens : undefined,
	}
}

/**
 * Shared OpenAI Responses transport for Copilot's Responses-only models, the disabled OpenAI Plan
 * lane, and signed public-free routes that explicitly select the Responses protocol.
 */
const _sendOpenAIResponsesChat = async ({ messages, onText, onFinalMessage, onError, onUsage, settingsOfProvider, modelName: modelName_, _setAborter, chatMode, coreToolsOnly, excludeTools, overridesOfModel, mcpTools, providerName: requestedProviderName }: SendChatParams_Internal, v3codeFreeRoute?: V3CodeFreeRoute) => {
	const providerName: ProviderName = v3codeFreeRoute ? 'v3code-free' : requestedProviderName
	const { modelName: capabilityModelName, specialToolFormat } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	const modelName = v3codeFreeRoute?.upstreamModel ?? capabilityModelName
	const responseBrand = v3codeFreeRoute?.label ?? providerBrand(providerName)
	const potentialTools = openAITools(chatMode, mcpTools, coreToolsOnly, excludeTools)
	const tools = potentialTools && (specialToolFormat === 'openai-style' || v3codeFreeRoute?.capabilities.tools)
		? potentialTools.map(tool => ({
			type: 'function' as const,
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters ?? null,
			strict: false,
		}))
		: undefined

	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider, v3codeFreeRoute })
	let fullText = ''
	let fullReasoning = ''
	let finalResponse: Record<string, unknown> | undefined
	const slots = new Map<number, CopilotResponsesToolSlot>()
	const slotFor = (index: number): CopilotResponsesToolSlot => {
		let slot = slots.get(index)
		if (!slot) { slot = { name: '', args: '', id: '' }; slots.set(index, slot) }
		return slot
	}
	const emitProgress = () => {
		const liveSlot = [...slots.entries()].sort((a, b) => a[0] - b[0])[0]?.[1]
		onText({
			fullText,
			fullReasoning,
			toolCall: !liveSlot?.name ? undefined : { name: liveSlot.name, rawParams: {}, isDone: false, doneParams: [], id: liveSlot.id },
		})
	}
	const captureToolItem = (item: unknown, outputIndex: number) => {
		const record = _asErrorRecord(item)
		if (record?.type !== 'function_call') { return }
		const slot = slotFor(outputIndex)
		if (typeof record.name === 'string') { slot.name = record.name }
		if (typeof record.arguments === 'string') { slot.args = record.arguments }
		if (typeof record.call_id === 'string') { slot.id = record.call_id }
	}

	try {
		const stream = await openai.responses.create({
			model: modelName as OpenAI.ResponsesModel,
			input: copilotResponsesInput(messages) as any,
			stream: true,
			store: false,
			parallel_tool_calls: true,
			...(tools ? { tools } : {}),
		})
		_setAborter(() => stream.controller.abort())

		for await (const event of stream) {
			if (event.type === 'response.output_text.delta') {
				fullText += event.delta
				emitProgress()
			}
			else if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning.delta') {
				fullReasoning += event.delta
				emitProgress()
			}
			else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
				captureToolItem(event.item, event.output_index)
				emitProgress()
			}
			else if (event.type === 'response.function_call_arguments.delta') {
				slotFor(event.output_index).args += event.delta
				emitProgress()
			}
			else if (event.type === 'response.function_call_arguments.done') {
				slotFor(event.output_index).args = event.arguments
				emitProgress()
			}
			else if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
				finalResponse = event.response as unknown as Record<string, unknown>
			}
		}

		// The terminal response is authoritative and fills any fields an upstream omitted from deltas.
		const finalOutput = finalResponse?.output
		if (Array.isArray(finalOutput)) {
			for (let index = 0; index < finalOutput.length; index += 1) {
				const item = _asErrorRecord(finalOutput[index])
				captureToolItem(item, index)
				if (!fullText && item?.type === 'message' && Array.isArray(item.content)) {
					fullText = item.content.map(part => {
						const content = _asErrorRecord(part)
						return content?.type === 'output_text' && typeof content.text === 'string' ? content.text : ''
					}).join('')
				}
			}
		}

		const usage = copilotResponsesUsage(finalResponse?.usage)
		if (usage) { onUsage?.({ usage }) }
		if (finalResponse?.status === 'failed') {
			console.error(`[llm:${providerName}] Responses request failed`, finalResponse)
			const failure = _asErrorRecord(finalResponse.error)
			const detail = typeof failure?.message === 'string' ? failure.message.replace(/[.\s]+$/, '') : 'request failed'
			onError({ message: `${responseBrand}: ${detail}.`, fullError: null })
			return
		}
		if (finalResponse?.status === 'incomplete') {
			console.error(`[llm:${providerName}] Responses request incomplete`, finalResponse)
			const details = _asErrorRecord(finalResponse.incomplete_details)
			const reason = typeof details?.reason === 'string' ? ` (${details.reason})` : ''
			onError({ message: `${responseBrand} stopped before completing the response${reason}. Try again.`, fullError: null })
			return
		}

		const parsedSlots = [...slots.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, slot]) => ({ slot, toolCall: rawToolCallObjOfParamsStr(slot.name, slot.args, slot.id) }))
		const malformed = parsedSlots.find(item => item.slot.name && !item.toolCall)
		if (malformed) {
			onError({ message: `V3Code: The model's "${malformed.slot.name}" tool call arrived with malformed arguments and could not be executed. Retry the step.`, fullError: null })
			return
		}
		const toolCalls = parsedSlots.map(item => item.toolCall).filter((toolCall): toolCall is NonNullable<typeof toolCall> => !!toolCall)
		if (!fullText && !fullReasoning && toolCalls.length === 0) {
			onError({ message: 'V3Code: Response from model was empty. The provider closed the stream without content.', fullError: null })
			return
		}
		onFinalMessage({
			fullText,
			fullReasoning,
			anthropicReasoning: null,
			...(toolCalls.length ? { toolCall: toolCalls[0], toolCalls } : {}),
			...(usage ? { usage } : {}),
		})
	}
	catch (error) {
		console.error(`[llm:${providerName}] Responses provider request failed`, error)
		onError({ message: providerErrorMessage(providerName, error), fullError: null })
	}
}

/** Pull hub `{ error: { code } }` (or nested OpenAI-shaped body) from an APIError. */
function hostedErrorCode(error: InstanceType<typeof OpenAI.APIError>): string | undefined {
	const body = (error as { error?: unknown }).error;
	if (body && typeof body === 'object') {
		const nested = body as { code?: unknown; error?: { code?: unknown } };
		if (typeof nested.code === 'string') { return nested.code; }
		if (nested.error && typeof nested.error.code === 'string') { return nested.error.code; }
	}
	const msg = String(error.message || '');
	if (msg.includes('credit_exhausted')) { return 'credit_exhausted'; }
	if (msg.includes('no_active_plan')) { return 'no_active_plan'; }
	return undefined;
}



type OpenAIModel = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}
const _openaiCompatibleList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider, providerName }: ListParams_Internal<OpenAIModel>) => {
	const onSuccess = ({ models }: { models: OpenAIModel[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
		openai.models.list()
			.then(async (response) => {
				const models: OpenAIModel[] = []
				models.push(...response.data)
				while (response.hasNextPage()) {
					models.push(...(await response.getNextPage()).data)
				}
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

/** The picker follows the same signed sheet as free-auto. New/retired public-free model ids can
 *  therefore appear/disappear without shipping another desktop build. */
const v3codeFreeList = async ({ onSuccess, onError }: ListParams_Internal<OpenAIModel>) => {
	try {
		const resolution = await getV3CodeFreeRouteResolution()
		const ids = new Set<string>([V3CODE_FREE_AUTO_MODEL])
		for (const route of resolution.routes) {
			for (const logicalModel of route.logicalModels) {
				// isV3CodeFreeModelId, not endsWith('-free'): some genuinely free Zen ids carry no
				// suffix (`big-pickle`), and a bare suffix test silently hid them from the picker.
				if (logicalModel !== V3CODE_FREE_AUTO_MODEL && isV3CodeFreeModelId(logicalModel)) ids.add(logicalModel)
			}
		}
		onSuccess({
			models: [...ids].map(id => ({ id, created: 0, object: 'model' as const, owned_by: `v3code-route:${resolution.revision}` })),
		})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

type CopilotModel = OpenAIModel & {
	model_picker_enabled?: boolean;
	policy?: { state?: string };
	supported_endpoints?: string[];
}

let copilotModelsCache: { expiresAt: number; models: CopilotModel[] } | undefined
let copilotModelsInFlight: Promise<CopilotModel[]> | undefined

const loadCopilotModels = async (settingsOfProvider: SettingsOfProvider): Promise<CopilotModel[]> => {
	if (copilotModelsCache && copilotModelsCache.expiresAt > Date.now()) { return copilotModelsCache.models }
	if (!copilotModelsInFlight) {
		copilotModelsInFlight = (async () => {
	const openai = await newOpenAICompatibleSDK({ providerName: 'copilot', settingsOfProvider })
			const response = await openai.models.list()
			const models: CopilotModel[] = [...response.data] as CopilotModel[]
			while (response.hasNextPage()) {
				models.push(...(await response.getNextPage()).data as CopilotModel[])
			}
			copilotModelsCache = { expiresAt: Date.now() + 60_000, models }
			return models
		})().finally(() => { copilotModelsInFlight = undefined })
	}
	return copilotModelsInFlight
}

const knownCopilotResponsesOnlyModels = new Set([
	'gpt-5.3-codex',
	'gpt-5.4-mini',
	'gpt-5.5',
	'gpt-5.6-luna',
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'mai-code-1-flash-picker',
])

// Copilot currently advertises this retired row as policy-enabled on individual accounts, but
// rejects it on both endpoints it claims to support. Keep the picker honest until the upstream
// catalogue removes or re-enables it; every other advertised row is verified by the model matrix.
const knownCopilotUnavailableModels = new Set(['claude-opus-4.5'])

const copilotModelUsesResponsesAPI = async (modelName: string, settingsOfProvider: SettingsOfProvider): Promise<boolean> => {
	try {
		const model = (await loadCopilotModels(settingsOfProvider)).find(candidate => candidate.id === modelName)
		const endpoints = model?.supported_endpoints
		if (endpoints) {
			return endpoints.includes('/responses') && !endpoints.includes('/chat/completions')
		}
	}
	catch (error) {
		// A send should still get a chance when the optional catalogue refresh is transiently down.
		console.error('[llm:copilot] Could not refresh model endpoint metadata', error)
	}
	return knownCopilotResponsesOnlyModels.has(modelName)
}

/** Only expose models the signed-in account can actually select in Copilot CLI. */
const copilotList = async ({ onSuccess, onError, settingsOfProvider }: ListParams_Internal<OpenAIModel>) => {
	try {
		const models = await loadCopilotModels(settingsOfProvider)
		onSuccess({
			models: models.filter(model =>
				model.model_picker_enabled === true &&
				model.policy?.state !== 'disabled' &&
				!knownCopilotUnavailableModels.has(model.id)
			),
		})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

const sendCopilotChat = async (params: SendChatParams_Internal): Promise<void> => {
	if (await copilotModelUsesResponsesAPI(params.modelName, params.settingsOfProvider)) {
		return _sendOpenAIResponsesChat(params)
	}
	return _sendOpenAICompatibleChat(params)
}

// Anthropic is not OpenAI-compatible (x-api-key auth), so it gets its own list fn via the
// official SDK's GET /v1/models. Results are mapped onto the OpenAI model shape the shared
// refresh pipeline expects.
const anthropicList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OpenAIModel>) => {
	try {
		const thisConfig = settingsOfProvider.anthropic
		const anthropic = new Anthropic({ apiKey: thisConfig.apiKey, dangerouslyAllowBrowser: true })
		const models: OpenAIModel[] = []
		for await (const m of anthropic.models.list()) {
			models.push({
				id: m.id,
				created: Math.floor(Date.parse(m.created_at) / 1000) || 0,
				object: 'model',
				owned_by: 'anthropic',
			})
		}
		onSuccess_({ models })
	}
	catch (error) {
		onError_({ error: error + '' })
	}
}




// ------------ ANTHROPIC (HELPERS) ------------
const toAnthropicTool = (toolInfo: InternalToolInfo) => {
	const { name, description } = toolInfo
	return {
		name: name,
		description: description,
		input_schema: providerInputSchemaOfTool(toolInfo),
	} as Anthropic.Messages.Tool
}

const anthropicTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, coreToolsOnly?: boolean, excludeTools?: readonly string[]) => {
	let allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null
	if (coreToolsOnly) allowedTools = filterToCoreAgentTools(allowedTools, mcpTools)
	allowedTools = filterExcludedTools(allowedTools, excludeTools)

	const anthropicTools: Anthropic.Messages.ToolUnion[] = []
	for (const t in allowedTools ?? {}) {
		anthropicTools.push(toAnthropicTool(allowedTools[t]))
	}
	return anthropicTools
}

const withOpusHybridAdvisorTool = (tools: Anthropic.Messages.ToolUnion[] | null, modelSelectionOptions: SendChatParams_Internal['modelSelectionOptions']) => {
	const advisorTool = ({
		type: 'advisor_20260301' as const,
		name: 'advisor' as const,
		model: OPUS_HYBRID_ADVISOR_MODEL,
		max_uses: modelSelectionOptions?.advisorEffort === 'easy' ? 1 : 3,
		max_tokens: modelSelectionOptions?.advisorEffort === 'easy' ? 1024 : 2048,
		caching: { type: 'ephemeral' as const, ttl: '5m' as const },
	} as unknown) as Anthropic.Messages.ToolUnion
	return [...(tools ?? []), advisorTool]
}

const isOpusHybridAdvisorTool = (tool: Anthropic.Messages.ToolUnion): boolean =>
	((tool as unknown) as { type?: string }).type === 'advisor_20260301'



// ------------ ANTHROPIC ------------
const sendAnthropicChat = async ({ messages, providerName, onText, onFinalMessage, onError, onUsage, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName: modelName_, _setAborter, separateSystemMessage, chatMode, coreToolsOnly, excludeTools, mcpTools }: SendChatParams_Internal) => {
	const hybridAdvisor = isOpusHybridModel(providerName, modelName_)
	const executorModelName = hybridAdvisor ? opusHybridExecutorModel(modelSelectionOptions) : modelName_
	const {
		modelName,
		specialToolFormat,
	} = getModelCapabilities(providerName, executorModelName, overridesOfModel)

	const thisConfig = settingsOfProvider.anthropic
	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// In Hybrid mode the user's `modelSelectionOptions` (incl. `reasoningEnabled`,
	// `reasoningBudget`, `reasoningEffort`) are stored against the WRAPPER model id
	// ("Opus Hybrid") — they do NOT semantically describe the executor (Sonnet 4.6 hard /
	// Haiku 4.5 easy). Forwarding them as-is regresses thinking: a stale
	// `reasoningEnabled:false` (from the per-feature thinking lever, a Tier write, or a
	// previous executor's settings) silently disables Sonnet 4.6's budget thinking on Hard,
	// which is exactly the "external toggle breaks Hybrid thinking" bug the user reported.
	// Strategy: for Hybrid Hard always force thinking ON (Sonnet's budget thinking is the
	// whole point of Hard mode), and for Hybrid Easy drop reasoning options entirely (Haiku
	// 4.5 has reasoningCapabilities:false → the flag is a no-op anyway, but stripping it
	// keeps the merge clean for downstream sites that read the options).
	const executorOptions: typeof modelSelectionOptions = hybridAdvisor
		? (
			modelSelectionOptions?.advisorEffort === 'easy'
				? (modelSelectionOptions ? { ...modelSelectionOptions, reasoningEnabled: false } : { reasoningEnabled: false })
				: { ...modelSelectionOptions, reasoningEnabled: true }
		)
		: modelSelectionOptions

	// reasoning
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, executorModelName, executorOptions, overridesOfModel)
	const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	// anthropic-specific - max tokens
	const maxTokens = getReservedOutputTokenSpace(providerName, executorModelName, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel })

	// tools
	const potentialTools = hybridAdvisor
		? withOpusHybridAdvisorTool(anthropicTools(chatMode, mcpTools, coreToolsOnly, excludeTools), modelSelectionOptions)
		: anthropicTools(chatMode, mcpTools, coreToolsOnly, excludeTools)

	// --- Prompt caching ---------------------------------------------------------
	// Mark the stable prefix (tool definitions + system prompt) and the conversation
	// tail with ephemeral cache_control. Anthropic then reuses cached input tokens on
	// repeated turns at ~10% of the input price — typically a 50-90% input-cost drop on
	// long agent sessions. cache_control on a prefix below the model's minimum cacheable
	// size is silently ignored by the API, so this is safe for short prompts too.
	const cacheControl = { type: 'ephemeral' as const }
	// ONE 5-minute window for everything (product decision, 2026-09-02). The tool definitions
	// and system prompt used to carry the 1-hour TTL, whose writes bill at 2x; the composer now
	// shows a 5:00 countdown from the end of every reply, so the user knows exactly how long
	// the cached prefix lives and can answer inside it at 1x write / 0.1x read. Reply inside the
	// window and 5m is strictly cheaper than 1h; the trade is a full re-write after a longer
	// pause. Kept as a named constant so the split can be reintroduced in one line if the
	// usage telemetry (cache_creation.ephemeral_*_input_tokens) says the trade went the wrong way.
	const stableCacheControl = { type: 'ephemeral' as const }

	// Tools: marking the LAST non-advisor tool caches the normal tool-definition block before it.
	// Anthropic's advisor tool has its own `caching` field and must not receive content
	// `cache_control` metadata.
	const lastCacheableToolIndex = potentialTools
		? potentialTools.findLastIndex(t => !isOpusHybridAdvisorTool(t))
		: -1
	const cachedTools = potentialTools && potentialTools.length > 0
		? potentialTools.map((t, i) => i === lastCacheableToolIndex ? { ...t, cache_control: stableCacheControl } : t)
		: potentialTools
	const nativeToolsObj = cachedTools && specialToolFormat === 'anthropic-style' ?
		{ tools: cachedTools, tool_choice: { type: 'auto' as const } }
		: {}

	// System: send as a single cached text block instead of a bare string.
	// On the subscription lane Anthropic gates every non-Haiku model on an identity block that
	// must be the FIRST element of the system array, verbatim and on its own. Our real prompt
	// follows as a second block; the model obeys the LAST identity instruction, so it still
	// answers as V3Code. Getting this wrong returns a 400 whose message is literally "Error".
	const isClaudePlan = providerName === 'claudePlan'
	const systemBlocks = separateSystemMessage
		? [{ type: 'text' as const, text: separateSystemMessage, cache_control: stableCacheControl }]
		: []
	const systemParam = isClaudePlan
		? [{ type: 'text' as const, text: CLAUDE_CODE_IDENTITY_PROMPT }, ...systemBlocks]
		: (systemBlocks.length > 0 ? systemBlocks : undefined)

	// Conversation: cache up to the final message so the growing history prefix is
	// reused turn-over-turn (the biggest win on long chats). Clone so we never mutate
	// the caller's array; only the last message's last content block is touched.
	const cachedMessages = (messages as AnthropicLLMChatMessage[]).map(m => ({ ...m })) as Array<{ role: string; content: unknown }>
	const lastMsg = cachedMessages[cachedMessages.length - 1]
	if (lastMsg) {
		if (typeof lastMsg.content === 'string') {
			lastMsg.content = [{ type: 'text', text: lastMsg.content, cache_control: cacheControl }]
		} else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
			const blocks = (lastMsg.content as unknown[]).map(b => ({ ...(b as object) }))
			blocks[blocks.length - 1] = { ...(blocks[blocks.length - 1] as object), cache_control: cacheControl }
			lastMsg.content = blocks
		}
	}
	// ---------------------------------------------------------------------------

	// instance
	// Both lanes hit api.anthropic.com; only the credential differs. The subscription lane sends
	// an OAuth token as `Authorization: Bearer` (never x-api-key, and never both) plus the oauth
	// beta header, without which the token is rejected outright.
	let anthropic: Anthropic
	if (isClaudePlan) {
		const creds = await getClaudePlanCredentials()
		if (!creds) {
			throw new Error(`Not signed in to Claude. Open a terminal, run \`claude\`, then \`/login\`, and try again. (Settings > Models > Claude (Plan))`)
		}
		anthropic = new Anthropic({
			apiKey: null,
			authToken: creds.token,
			baseURL: CLAUDE_PLAN_BASE_URL,
			timeout: 600_000,
			dangerouslyAllowBrowser: true,
			defaultHeaders: {
				'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
				'x-app': 'cli',
				'User-Agent': 'claude-cli/2.1.220 (external, cli)',
			},
		});
	} else {
		anthropic = new Anthropic({
			apiKey: thisConfig.apiKey,
			timeout: 600_000,
			dangerouslyAllowBrowser: true
		});
	}

	const streamParams: Anthropic.Messages.MessageCreateParams = {
		system: systemParam as Anthropic.Messages.MessageCreateParams['system'],
		messages: cachedMessages as Anthropic.Messages.MessageCreateParams['messages'],
		model: hybridAdvisor ? executorModelName : modelName,
		max_tokens: maxTokens ?? 4_096, // anthropic requires this
		...includeInPayload,
		...nativeToolsObj,
	}
	if (hybridAdvisor) {
		console.log(`[opus-hybrid] advisor tool attached: executor=${executorModelName} advisor=${OPUS_HYBRID_ADVISOR_MODEL} effort=${modelSelectionOptions?.advisorEffort ?? 'hard'} max_uses=${modelSelectionOptions?.advisorEffort === 'easy' ? 1 : 3}`)
	}
	// Beta headers. Interleaved thinking is the key one for the agent loop: WITHOUT it, Claude emits
	// a thinking block only before its FIRST tool call in the conversation — every later step (after
	// a tool_result is fed back) returns with no thinking at all, which is why the chat showed
	// reasoning once at the start and then went silent for the rest of the turn. WITH it, Claude
	// thinks before EACH tool call, so the user sees the model's reasoning on every step. Only added
	// when reasoning is actually enabled (a thinking budget is in the payload), so non-thinking runs
	// are unaffected.
	const betas: string[] = []
	// On the subscription lane these MUST ride in `betas`, not only in defaultHeaders: the SDK
	// builds the anthropic-beta header from this array whenever it is non-empty, which would
	// otherwise replace the oauth grant we set at construction and 401 the request.
	if (isClaudePlan) { betas.push('claude-code-20250219', 'oauth-2025-04-20') }
	if (hybridAdvisor) { betas.push('advisor-tool-2026-03-01') }
	// Interleaved-thinking beta applies ONLY to the classic budget-thinking API (Sonnet 4.6, Opus 4.0,
	// Claude 3.7, and the hybrid's Sonnet executor). Adaptive-thinking models (Opus 4.6/4.7/4.8,
	// Mythos/Fable — `reasoningInfo.type === 'effort_slider_value'`) interleave automatically and do NOT
	// accept this header (manual interleaved is unsupported there); sending it can 400 or be ignored,
	// and it is NOT what makes adaptive thinking surface. The adaptive payload (thinking.type=adaptive +
	// display=summarized, set in modelCapabilities) is what populates Opus thinking.
	const isAdaptiveThinking = reasoningInfo?.type === 'effort_slider_value'
	if (reasoningInfo?.isReasoningEnabled && !isAdaptiveThinking) { betas.push('interleaved-thinking-2025-05-14') }
	const resolvedModel = hybridAdvisor ? executorModelName : modelName
	const thinkingDiag = !reasoningInfo?.isReasoningEnabled
		? (reasoningInfo?.type === 'disabled' ? 'disabled' : 'none')
		: reasoningInfo.type === 'budget_slider_value'
			? `enabled/budget=${reasoningInfo.reasoningBudget}`
			: reasoningInfo.type === 'effort_slider_value'
				? `adaptive/effort=${reasoningInfo.reasoningEffort}`
				: 'enabled'
	console.log(`[anthropic] thinking: ${thinkingDiag} model=${resolvedModel} betas=${JSON.stringify(betas)}`)
	const stream = betas.length > 0
		? ((anthropic.beta.messages.stream as unknown) as (params: Anthropic.Messages.MessageCreateParams & { betas: string[] }) => ReturnType<typeof anthropic.messages.stream>)({ ...streamParams, betas })
		: anthropic.messages.stream(streamParams)

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullText = ''
	let fullReasoning = ''

	let fullToolName = ''
	// Raw streamed tool JSON per content-block index. The SDK hands back `input: {}` for a
	// tool_use block whose JSON never finished arriving, which is indistinguishable from a
	// genuinely parameterless call (git_status, index_health) unless the raw text is kept.
	// This accumulator used to be a single string that was written and never read, so a
	// rewrite_file whose content was cut off looked exactly like a valid empty call.
	const streamedToolJsonByIndex = new Map<number, string>()


	// Index of the tool block currently streaming, so the live preview reads the right JSON.
	let liveToolIndex: number | undefined = undefined
	// Re-parsing a growing 40k-char payload on every delta would be quadratic, so the parse is
	// throttled and the last good result reused in between.
	let lastPartialParseMs = 0
	let lastPartialEmitMs = 0
	let lastPartialParams: RawToolParamsObj = {}

	const livePartialParams = (): { rawParams: RawToolParamsObj, doneParams: RawToolCallObj['doneParams'] } => {
		const raw = liveToolIndex === undefined ? undefined : streamedToolJsonByIndex.get(liveToolIndex)
		if (!raw) { return { rawParams: {}, doneParams: [] } }
		const now = Date.now()
		if (now - lastPartialParseMs >= PARTIAL_TOOL_PARSE_INTERVAL_MS) {
			lastPartialParseMs = now
			lastPartialParams = parsePartialToolJSON(raw) ?? lastPartialParams
		}
		// Every key except the one still arriving is settled; the UI uses doneParams to decide
		// what it can treat as final (e.g. the filename above a streaming diff).
		const keys = Object.keys(lastPartialParams) as RawToolCallObj['doneParams']
		return { rawParams: lastPartialParams, doneParams: keys.slice(0, Math.max(0, keys.length - 1)) }
	}

	const runOnText = () => {
		const { rawParams, doneParams } = fullToolName ? livePartialParams() : { rawParams: {}, doneParams: [] as RawToolCallObj['doneParams'] }
		onText({
			fullText,
			fullReasoning,
			toolCall: !fullToolName ? undefined : { name: fullToolName, rawParams, isDone: false, doneParams, id: 'dummy' },
		})
	}
	// Partial-usage capture so aborted/errored streams still get metered: message_start carries
	// the ENTIRE input-side bill (input + cache read + cache write, split by TTL) plus the wire
	// model id before any output streams; message_delta carries the cumulative output count.
	// The wire model matters for Hybrid: usage must be priced by the executor that actually ran
	// (Sonnet hard / Haiku easy), not by the 'Opus Hybrid' label the user selected.
	let partialRawUsage: AnthropicRawUsage | undefined = undefined
	let wireModelName: string | undefined = hybridAdvisor ? executorModelName : undefined
	const reportPartialUsage = () => {
		if (partialRawUsage) { onUsage?.({ usage: anthropicUsageToLLMUsage(partialRawUsage), wireModelName }) }
	}

	// there are no events for tool_use, it comes in at the end
	stream.on('streamEvent', (e: Anthropic.Messages.MessageStreamEvent) => {
		// message-level usage events
		if (e.type === 'message_start') {
			partialRawUsage = { ...(e.message.usage as AnthropicRawUsage) }
			if (e.message.model) { wireModelName = e.message.model }
			reportPartialUsage()
		}
		else if (e.type === 'message_delta') {
			const outputTokens = (e.usage as { output_tokens?: number } | undefined)?.output_tokens
			if (outputTokens !== undefined) {
				partialRawUsage = { ...(partialRawUsage ?? {}), output_tokens: outputTokens }
				reportPartialUsage()
			}
		}
		// start block
		if (e.type === 'content_block_start') {
			if (e.content_block.type === 'text') {
				if (fullText) fullText += '\n\n' // starting a 2nd text block
				fullText += e.content_block.text
				runOnText()
			}
			else if (e.content_block.type === 'thinking') {
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += e.content_block.thinking
				runOnText()
			}
			else if (e.content_block.type === 'redacted_thinking') {
				console.log('delta', e.content_block.type)
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += '[redacted_thinking]'
				runOnText()
			}
			else if (e.content_block.type === 'tool_use') {
				fullToolName += e.content_block.name ?? '' // anthropic gives us the tool name in the start block
				liveToolIndex = e.index
				lastPartialParseMs = 0
				lastPartialEmitMs = 0
				lastPartialParams = {}
				runOnText()
			}
		}

		// delta
		else if (e.type === 'content_block_delta') {
			if (e.delta.type === 'text_delta') {
				fullText += e.delta.text
				runOnText()
			}
			else if (e.delta.type === 'thinking_delta') {
				fullReasoning += e.delta.thinking
				runOnText()
			}
			else if (e.delta.type === 'input_json_delta') { // tool use
				// anthropic gives us the partial delta (string) here - https://docs.anthropic.com/en/api/messages-streaming
				streamedToolJsonByIndex.set(e.index, (streamedToolJsonByIndex.get(e.index) ?? '') + (e.delta.partial_json ?? ''))
				// Emitting on EVERY delta would push the whole accumulated document across the
				// process boundary once per token — thousands of messages carrying tens of
				// kilobytes each for one large write. Emit on the same cadence as the parse.
				const now = Date.now()
				if (now - lastPartialEmitMs >= PARTIAL_TOOL_PARSE_INTERVAL_MS) {
					lastPartialEmitMs = now
					runOnText()
				}
			}
		}
	})

	// on done - (or when error/fail) - this is called AFTER last streamEvent
	stream.on('finalMessage', (response: Anthropic.Messages.Message) => {
		const anthropicReasoning = response.content.filter((c: Anthropic.Messages.ContentBlock) => c.type === 'thinking' || c.type === 'redacted_thinking')
		const tools = response.content.filter((c: Anthropic.Messages.ContentBlock) => c.type === 'tool_use')
		// Fable/Opus classifier refusals are successful HTTP responses, not transport errors. If we
		// treat one as an ordinary empty answer the agent appears to stop or hallucinate a completed
		// turn. Surface the provider's explanation explicitly. Server-side model fallback remains
		// disabled until the conversation serializer can replay Anthropic's ordered `fallback`
		// content block exactly on the next cached/tool turn.
		if ((response.stop_reason as string) === 'refusal') {
			const explanation = (response as unknown as { stop_details?: { explanation?: string } }).stop_details?.explanation?.trim()
			onError({
				message: explanation
					? `Claude declined this request: ${explanation}`
					: `Claude declined this request under the model provider's safety policy. Try rephrasing the request or choose another model.`,
				fullError: null,
			})
			return
		}
		// Claude models routinely emit PARALLEL tool_use blocks (e.g. two edits to different files in
		// one response). Emit ALL of them as `toolCalls`, mirroring the OpenAI path — taking only
		// tools[0] silently dropped every call after the first: the model believed those writes
		// landed, the user saw "agent said it edited but nothing happened".
		// A tool_use block whose `input` never finished streaming parses to null. Filtering it out
		// silently is how a large rewrite_file VANISHED: the model spends its output budget on the
		// content, stop_reason comes back 'max_tokens', the block is truncated, the call is
		// dropped, and the turn ends as plain text with the model's stated intent ("Writing the
		// document now") still in history. Nothing was written and nobody was told. The
		// OpenAI-compatible path already fails loudly here; this one never did, and Claude is what
		// most users run.
		// A tool_use block whose arguments never finished arriving. Two shapes:
		//   input === null / not an object  -> rawToolCallObjOfAnthropicParams returns null
		//   input === {}                    -> parses "fine" as a call with NO arguments
		// The second one is the bug users hit: a large rewrite_file spends the output budget on
		// its content, the JSON is cut mid-string, the SDK cannot parse it so it yields `{}`, and
		// the harness ran a rewrite_file with no uri and no content. Live repro: the model said
		// "Writing the document now", the tool reported Completed, a 0-BYTE FILE was left on
		// disk, and it concluded "the content didn't attach on that call" and started chunking.
		// That is why every model learned to split writes. Comparing against the raw streamed
		// JSON is what separates a truncated call from a genuinely parameterless one.
		const truncatedIdx = response.content.findIndex((c, i) => {
			if (c.type !== 'tool_use') { return false }
			const streamed = streamedToolJsonByIndex.get(i) ?? ''
			const parsedKeys = c.input && typeof c.input === 'object' ? Object.keys(c.input).length : 0
			return parsedKeys === 0 && streamed.trim().length > 0
		})
		const parsedTools = tools.map(t => ({ block: t, tc: rawToolCallObjOfAnthropicParams(t) }))
		const droppedTool = parsedTools.find(p => !p.tc)
		const brokenName = truncatedIdx >= 0
			? (response.content[truncatedIdx] as Anthropic.Messages.ToolUseBlock).name
			: droppedTool?.block.name
		if (brokenName) {
			const lengthNote = response.stop_reason === 'max_tokens'
				? ` because the response hit the output-token limit — the content was too large for one call`
				: ''
			onError({ message: `V3Code: The model's "${brokenName}" tool call arrived with truncated or malformed arguments${lengthNote} and could not be executed. NOTHING WAS WRITTEN. Retry with a smaller change per call.`, fullError: null })
			return
		}
		// Same cap, no tool at all: the model was cut off mid-sentence and the turn would otherwise
		// end looking like a deliberate, complete answer.
		if (response.stop_reason === 'max_tokens' && !tools.length) {
			onError({ message: `V3Code: The model hit its output-token limit and the reply was cut off mid-response. Nothing it was about to do was executed. Retry, or break the work into smaller steps.`, fullError: null })
			return
		}
		const toolCalls = parsedTools
			.map(p => p.tc)
			.filter((tc): tc is NonNullable<typeof tc> => !!tc)
		const toolCallObj = toolCalls.length ? { toolCall: toolCalls[0], toolCalls } : {}

		const anthropicUsage = response.usage
		// Anthropic reports input_tokens as the NON-cached portion ONLY; cached tokens live in
		// cache_read_input_tokens (served from cache) and cache_creation_input_tokens (written to
		// cache this turn, with the 5m/1h TTL split in cache_creation — 1h writes bill at 2x
		// input, not the 5m 1.25x). The context-usage meter needs the TRUE prompt size, so the
		// normalizer folds them back in — this matches OpenAI's prompt_tokens (which already
		// includes cached tokens). Without it, prompt caching collapses input_tokens to a handful
		// of tokens (e.g. 12 of a real 326k prompt) and the meter reads ~0% forever — the
		// "context meter never tracks" bug.
		const usage: LLMUsage | undefined = anthropicUsage ? anthropicUsageToLLMUsage(anthropicUsage as AnthropicRawUsage) : undefined
		if (response.model) { wireModelName = response.model }
		if (usage) { onUsage?.({ usage, wireModelName }) }
		const usageObj = usage ? { usage } : {}

		if (hybridAdvisor) {
			// The advisor tool runs server-side; its invocation count + token cost surface in the
			// response usage (e.g. server_tool_use / advisor_* fields). Dump the raw usage so we can
			// confirm whether the executor actually escalated to Opus this turn.
			const advisorUsage = (anthropicUsage as { server_tool_use?: unknown; advisor?: unknown } | undefined)
			console.log(`[opus-hybrid] response usage=${JSON.stringify(anthropicUsage ?? null)} server_tool_use=${JSON.stringify(advisorUsage?.server_tool_use ?? null)} advisor=${JSON.stringify(advisorUsage?.advisor ?? null)}`)
		}

		onFinalMessage({ fullText, fullReasoning, anthropicReasoning, ...toolCallObj, ...usageObj })
	})
	// on error
	stream.on('error', (error: Error) => {
		console.error(`[llm:${providerName}/${resolvedModel}] provider request failed`, error)
		if (error instanceof Anthropic.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: null }) }
		else if (error instanceof APIConnectionTimeoutError) { onError({ message: `Anthropic timed out after 600s — try again.`, fullError: null }) }
		else { onError({ message: providerErrorMessage(providerName, error), fullError: null }) }
	})
	_setAborter(() => stream.controller.abort())
}



// ------------ MISTRAL ------------
// https://docs.mistral.ai/api/#tag/fim
const sendMistralFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, overridesOfModel, modelName: modelName_, _setAborter, providerName }: SendFIMParams_Internal) => {
	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const mistral = new MistralCore({ apiKey: settingsOfProvider.mistral.apiKey })
	fimComplete(mistral,
		{
			model: modelName,
			prompt: fimRepoContextToComment(messages.repoContext) + messages.prefix, // repo-level neighbor files
			suffix: messages.suffix,
			stream: false,
			maxTokens: 300,
			stop: messages.stopTokens,
		})
		.then(async response => {

			// unfortunately, _setAborter() does not exist
			let content = response?.ok ? response.value.choices?.[0]?.message?.content ?? '' : '';
			const fullText = typeof content === 'string' ? content
				: content.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join('')

			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			onError({ message: error + '', fullError: error });
		})
}


// ------------ OLLAMA ------------
const newOllamaSDK = ({ endpoint }: { endpoint: string }) => {
	// if endpoint is empty, normally ollama will send to 11434, but we want it to fail - the user should type it in
	if (!endpoint) throw new Error(`Ollama Endpoint was empty (please enter ${defaultProviderSettings.ollama.endpoint} in Void if you want the default url).`)
	const ollama = new Ollama({ host: endpoint })
	return ollama
}

type OllamaRuntimeInfo = {
	supportsNativeTools: boolean;
	parameterBillions: number | undefined;
}

const ollamaRuntimeInfoCache = new Map<string, Promise<OllamaRuntimeInfo>>()

/** `/api/show` is the authoritative capability source. Cache per endpoint/model so the agent
 * loop does not add a metadata round-trip to every tool iteration. Older Ollama servers did not
 * return `capabilities`; those retain native tools for backwards compatibility and let /api/chat
 * provide the real error if unsupported. */
const getOllamaRuntimeInfo = async (ollama: Ollama, endpoint: string, model: string): Promise<OllamaRuntimeInfo> => {
	const key = `${endpoint.replace(/\/$/, '')}\u0000${model}`
	let pending = ollamaRuntimeInfoCache.get(key)
	if (!pending) {
		pending = ollama.show({ model }).then(show => ({
			supportsNativeTools: !Array.isArray(show.capabilities) || show.capabilities.length === 0 || show.capabilities.includes('tools'),
			parameterBillions: localModelParameterBillions(show.details?.parameter_size) ?? localModelParameterBillions(model),
		}))
		ollamaRuntimeInfoCache.set(key, pending)
		pending.catch(() => ollamaRuntimeInfoCache.delete(key))
	}
	return pending
}

const ollamaGenerationOptions = (parameterBillions: number | undefined, contextWindow: number | undefined) => {
	const advertisedContext = Math.max(4_096, contextWindow ?? 32_768)
	if (parameterBillions !== undefined && parameterBillions < 6) {
		return { num_ctx: Math.min(advertisedContext, 16_384), num_predict: 2_048 }
	}
	if (parameterBillions === undefined || parameterBillions < 20) {
		return { num_ctx: Math.min(advertisedContext, 32_768), num_predict: 4_096 }
	}
	return { num_ctx: Math.min(advertisedContext, 65_536), num_predict: 8_192 }
}

const canonicalToolArguments = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalToolArguments).join(',')}]`
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalToolArguments(child)}`).join(',')}}`
	}
	return JSON.stringify(value) ?? String(value)
}

/** Convert V3Code's OpenAI-shaped history into Ollama's native chat messages. The native
 * endpoint is required for Ollama's `think` control; `/v1/chat/completions` ignores it. */
const ollamaMessagesFromLLM = (messages: LLMChatMessage[], separateSystemMessage: string | undefined): OllamaMessage[] => {
	const result: OllamaMessage[] = []
	const toolNamesByCallId = new Map<string, string>()
	if (separateSystemMessage) {
		result.push({ role: 'system', content: separateSystemMessage })
	}

	for (const rawMessage of messages) {
		const message = rawMessage as any
		const role = message.role === 'developer' ? 'system' : String(message.role ?? 'user')
		let content = ''
		const images: string[] = []
		if (typeof message.content === 'string') {
			content = message.content
		} else if (Array.isArray(message.content)) {
			const textParts: string[] = []
			for (const part of message.content) {
				if (part?.type === 'text' && typeof part.text === 'string') {
					textParts.push(part.text)
				} else if (part?.type === 'image_url') {
					const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
					if (typeof url === 'string') { images.push(url.replace(/^data:[^;]+;base64,/, '')) }
				} else if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
					images.push(part.source.data)
				}
			}
			content = textParts.join('')
		}

		const ollamaMessage: OllamaMessage = { role, content }
		if (images.length) { ollamaMessage.images = images }
		if (role === 'assistant' && Array.isArray(message.tool_calls)) {
			ollamaMessage.tool_calls = message.tool_calls.map((call: any) => {
				const name = String(call?.function?.name ?? '')
				const id = String(call?.id ?? '')
				if (id && name) { toolNamesByCallId.set(id, name) }
				let args: Record<string, any> = {}
				try {
					args = typeof call?.function?.arguments === 'string'
						? JSON.parse(call.function.arguments || '{}')
						: (call?.function?.arguments ?? {})
				} catch { /* malformed history should not crash the next turn */ }
				return { function: { name, arguments: args } }
			})
		}
		if (role === 'tool') {
			const toolName = toolNamesByCallId.get(String(message.tool_call_id ?? ''))
			if (toolName) { ollamaMessage.tool_name = toolName }
		}
		result.push(ollamaMessage)
	}
	return result
}

/** Native Ollama chat transport: streams content/reasoning/tools and, critically, honors
 * `think: false` for fast local agent turns while leaving Thinking On user-selectable. */
const sendOllamaChat = async ({ messages, separateSystemMessage, onText, onFinalMessage, onError, onUsage, settingsOfProvider, modelSelectionOptions, modelName, _setAborter, chatMode, coreToolsOnly, excludeTools, overridesOfModel, mcpTools }: SendChatParams_Internal) => {
	const ollama = newOllamaSDK({ endpoint: settingsOfProvider.ollama.endpoint })
	const capabilities = getModelCapabilities('ollama', modelName, overridesOfModel)
	const think = getIsReasoningEnabledState('Chat', 'ollama', modelName, modelSelectionOptions, overridesOfModel)
	const allowedTools = allowedToolsForRequest(chatMode, mcpTools, coreToolsOnly, excludeTools) ?? []
	const potentialTools = capabilities.specialToolFormat === 'openai-style'
		? openAITools(chatMode, mcpTools, coreToolsOnly, excludeTools)
		: undefined
	const runtimeInfo = await getOllamaRuntimeInfo(ollama, settingsOfProvider.ollama.endpoint, capabilities.modelName).catch(() => ({
		// A missing/older `/api/show` response must not prevent the real chat request from
		// producing Ollama's useful connection/model error. Preserve the legacy native path.
		supportsNativeTools: true,
		parameterBillions: localModelParameterBillions(capabilities.modelName),
	}))
	const tools = runtimeInfo.supportsNativeTools ? potentialTools?.map(tool => ({
		type: 'function',
		function: {
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters,
		},
	})) as OllamaTool[] | undefined : undefined
	const effectiveSystemMessage = !runtimeInfo.supportsNativeTools && allowedTools.length > 0
		? `${separateSystemMessage ?? ''}${localTextToolFallbackPrompt(allowedTools)}`
		: separateSystemMessage

	let fullText = ''
	let fullReasoning = ''
	let usage: LLMUsage | undefined
	const toolCalls: RawToolCallObj[] = []
	const seenToolCalls = new Set<string>()
	let streamRef: { abort: () => void } | undefined
	let abortRequested = false
	_setAborter(() => {
		abortRequested = true
		streamRef?.abort()
	})

	ollama.chat({
		model: capabilities.modelName,
		messages: ollamaMessagesFromLLM(messages, effectiveSystemMessage),
		stream: true,
		think,
		keep_alive: '5m',
		options: ollamaGenerationOptions(runtimeInfo.parameterBillions, capabilities.contextWindow),
		...(tools?.length ? { tools } : {}),
	}).then(async stream => {
		streamRef = stream
		if (abortRequested) { stream.abort(); return }
		for await (const chunk of stream) {
			fullText += chunk.message?.content ?? ''
			fullReasoning += chunk.message?.thinking ?? ''
			for (const call of chunk.message?.tool_calls ?? []) {
				const rawParams = call.function.arguments ?? {}
				const fingerprint = `${call.function.name}\u0000${canonicalToolArguments(rawParams)}`
				if (seenToolCalls.has(fingerprint)) { continue }
				seenToolCalls.add(fingerprint)
				toolCalls.push({
					name: call.function.name as RawToolCallObj['name'],
					rawParams: rawParams as RawToolParamsObj,
					doneParams: Object.keys(rawParams) as RawToolCallObj['doneParams'],
					id: generateUuid(),
					isDone: true,
				})
			}
			if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
				usage = { prompt_tokens: chunk.prompt_eval_count, completion_tokens: chunk.eval_count }
				onUsage?.({ usage })
			}
			onText({ fullText, fullReasoning, ...(toolCalls.length ? { toolCall: toolCalls[0] } : {}) })
		}
		if (abortRequested) { return }
		if (toolCalls.length === 0 && !runtimeInfo.supportsNativeTools && fullText) {
			const fallback = extractLocalTextToolCalls(fullText, allowedTools)
			if (fallback) {
				fullText = fallback.text
				for (const call of fallback.toolCalls) {
					toolCalls.push({
						name: call.name as RawToolCallObj['name'],
						rawParams: call.rawParams,
						doneParams: Object.keys(call.rawParams) as RawToolCallObj['doneParams'],
						id: generateUuid(),
						isDone: true,
					})
				}
			}
		}
		if (!fullText && !fullReasoning && toolCalls.length === 0) {
			onError({ message: `V3Code: Ollama returned an empty response.`, fullError: null })
			return
		}
		onFinalMessage({
			fullText,
			fullReasoning,
			anthropicReasoning: null,
			...(toolCalls.length ? { toolCall: toolCalls[0], toolCalls } : {}),
			...(usage ? { usage } : {}),
		})
	}).catch(error => {
		if (abortRequested || /abort/i.test(`${error?.name ?? ''} ${error?.message ?? error ?? ''}`)) { return }
		onError({ message: providerErrorMessage('ollama', error), fullError: null })
	})
}

const ollamaList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OllamaModelResponse>) => {
	const onSuccess = ({ models }: { models: OllamaModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const thisConfig = settingsOfProvider.ollama
		const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })
		ollama.list()
			.then((response) => {
				const { models } = response
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

const sendOllamaFIM = ({ messages, onFinalMessage, onError, onUsage, settingsOfProvider, modelName, _setAborter }: SendFIMParams_Internal) => {
	const thisConfig = settingsOfProvider.ollama
	const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })

	let fullText = ''
	let usage: LLMUsage | undefined = undefined
	ollama.generate({
		model: modelName,
		prompt: fimRepoContextToComment(messages.repoContext) + messages.prefix, // repo-level neighbor files
		suffix: messages.suffix,
		options: {
			stop: messages.stopTokens,
			num_predict: 300, // max tokens
			// repeat_penalty: 1,
		},
		raw: true,
		stream: true, // stream is not necessary but lets us expose the
	})
		.then(async stream => {
			_setAborter(() => stream.abort())
			for await (const chunk of stream) {
				const newText = chunk.response
				fullText += newText
				// the final chunk (done=true) carries the token counts
				if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
					usage = { prompt_tokens: chunk.prompt_eval_count, completion_tokens: chunk.eval_count }
					onUsage?.({ usage })
				}
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null, ...(usage ? { usage } : {}) })
		})
		// when error/fail
		.catch((error) => {
			onError({ message: error + '', fullError: error })
		})
}

// ---------------- V3CODE BUILT-IN LOCAL (node-llama-cpp, in-process) ----------------
// FIM + basic chat against a bundled/downloaded GGUF. The model file is resolved from the
// per-user models dir (Phase 2 downloads it); until a file exists there the call errors
// cleanly. The engine loads the model once and keeps it warm across requests.
const _localInference = new LocalInferenceService()

// A preempted/cancelled generation is NOT an error — resolve it silently so it never spams the
// console with AbortError (e.g. when typing preempts a speculative next-edit prediction).
const _isAbortError = (e: any): boolean => /abort/i.test(`${e?.name ?? ''} ${e?.message ?? e ?? ''}`)

const sendV3codeLocalFIM = ({ messages, onFinalMessage, onError, modelName, _setAborter }: SendFIMParams_Internal) => {
	const modelPath = resolveLocalModelPath(modelName)
	let aborted = false
	_setAborter(() => { aborted = true }) // soft cancel (true mid-gen abort is a later refinement)
	_localInference.generateFim(modelPath, messages.prefix, messages.suffix, { maxTokens: messages.maxTokens ?? 200, stopTriggers: messages.stopTokens, repoContext: messages.repoContext })
		.then((fullText) => { if (!aborted) { onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null }) } })
		.catch((error) => {
			if (aborted) { return } // upstream already cancelled + resolved this request
			if (_isAbortError(error)) { onFinalMessage({ fullText: '', fullReasoning: '', anthropicReasoning: null }); return } // preempted -> empty, silent
			onError({ message: error + '', fullError: error })
		})
}

const _localMsgText = (m: any): string => {
	if (typeof m?.content === 'string') { return m.content }
	if (Array.isArray(m?.content)) { return m.content.map((c: any) => typeof c === 'string' ? c : (c?.text ?? '')).join('') }
	return ''
}
const sendV3codeLocalChat = async ({ messages, separateSystemMessage, onFinalMessage, onError, modelName, _setAborter }: SendChatParams_Internal) => {
	// The built-in local model is primarily a FIM/autocomplete engine; this is a basic one-shot
	// chat path so it can still be picked for Chat. (No streaming / tools yet.)
	const modelPath = resolveLocalModelPath(modelName)
	let aborted = false
	_setAborter(() => { aborted = true })
	try {
		const sys = separateSystemMessage ? `${separateSystemMessage}\n\n` : ''
		const turns = (messages as any[]).map(m => `${m.role}: ${_localMsgText(m)}`).join('\n')
		const fullText = await _localInference.generateCompletion(modelPath, `${sys}${turns}\nassistant:`, { maxTokens: 512 })
		if (!aborted) { onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null }) }
	} catch (error) {
		if (aborted) { return } // upstream already cancelled
		if (_isAbortError(error)) { onFinalMessage({ fullText: '', fullReasoning: '', anthropicReasoning: null }); return } // preempted (FIM took the lane) -> silent
		onError({ message: error + '', fullError: error })
	}
}

// ---------------- GEMINI NATIVE IMPLEMENTATION ----------------

const toGeminiFunctionDecl = (toolInfo: InternalToolInfo) => {
	const { name, description } = toolInfo
	return {
		name,
		description,
		parameters: toGeminiSchema(providerInputSchemaOfTool(toolInfo)),
	} satisfies FunctionDeclaration
}

const geminiTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, coreToolsOnly?: boolean, excludeTools?: readonly string[]): GeminiTool[] | null => {
	let allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null
	if (coreToolsOnly) allowedTools = filterToCoreAgentTools(allowedTools, mcpTools)
	allowedTools = filterExcludedTools(allowedTools, excludeTools)
	const functionDecls: FunctionDeclaration[] = []
	for (const t in allowedTools ?? {}) {
		functionDecls.push(toGeminiFunctionDecl(allowedTools[t]))
	}
	const tools: GeminiTool = { functionDeclarations: functionDecls, }
	return [tools]
}



// Implementation for Gemini using Google's native API
const sendGeminiChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	onUsage,
	settingsOfProvider,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	chatMode,
	coreToolsOnly,
	excludeTools,
	mcpTools,
}: SendChatParams_Internal) => {

	if (providerName !== 'gemini') throw new Error(`Sending Gemini chat, but provider was ${providerName}`)

	const thisConfig = settingsOfProvider[providerName]

	const {
		modelName,
		specialToolFormat,
		// reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	// const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	// const { canIOReasoning, openSourceThinkTags, } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	// const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	const thinkingConfig: ThinkingConfig | undefined = !reasoningInfo?.isReasoningEnabled ? undefined
		: reasoningInfo.type === 'budget_slider_value' ?
			{ thinkingBudget: reasoningInfo.reasoningBudget }
			: undefined

	// tools
	const potentialTools = geminiTools(chatMode, mcpTools, coreToolsOnly, excludeTools)
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ?
		potentialTools
		: undefined

	// instance
	const genAI = new GoogleGenAI({ apiKey: thisConfig.apiKey });


	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	// Accumulate EVERY function call across all chunks. The old code kept only functionCalls[0]
	// and OVERWROTE it on each later chunk — when Gemini emitted N calls (parallel edits, or one
	// call per chunk), N-1 were silently dropped with no error to the model or the user.
	const geminiToolCalls: { name: string; paramsStr: string; id: string }[] = []
	const geminiParts: import('../../common/sendLLMMessageTypes.js').GeminiResponsePart[] = []
	let geminiUsage: LLMUsage | undefined = undefined


	genAI.models.generateContentStream({
		model: modelName,
		config: {
			systemInstruction: separateSystemMessage,
			thinkingConfig: thinkingConfig,
			tools: toolConfig,
		},
		contents: messages as GeminiLLMChatMessage[],
	})
		.then(async (stream) => {
			_setAborter(() => { stream.return(fullTextSoFar); });

			// Process the stream
			for await (const chunk of stream) {
				// message
				const newText = chunk.text ?? ''
				fullTextSoFar += newText

				// tool calls — append them ALL (Gemini function calls arrive complete per chunk, not as deltas)
				for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
					geminiParts.push(part);
					if (!part.functionCall) { continue; }
					const functionCall = part.functionCall;
					geminiToolCalls.push({
						name: functionCall.name ?? '',
						paramsStr: JSON.stringify(functionCall.args ?? {}),
						id: functionCall.id ?? '',
					})
				}

				// usage metadata
				const um = chunk.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number } | undefined
				if (um) {
					geminiUsage = {
						prompt_tokens: um.promptTokenCount,
						completion_tokens: um.candidatesTokenCount,
						total_tokens: um.totalTokenCount,
						prompt_cache_hit_tokens: um.cachedContentTokenCount,
					}
					onUsage?.({ usage: geminiUsage })
				}

				// (do not handle reasoning yet)

				// call onText — show the first tool live (the full set is assembled on final)
				const liveTool = geminiToolCalls[0]
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !liveTool?.name ? undefined : { name: liveTool.name, rawParams: {}, isDone: false, doneParams: [], id: liveTool.id },
				})
			}

			// on final — assemble EVERY accumulated tool call, not just the first
			if (!fullTextSoFar && !fullReasoningSoFar && geminiToolCalls.length === 0) {
				onError({ message: 'V3Code: Response from model was empty.', fullError: null })
			} else {
				// A named tool whose arguments do not parse was truncated (a large write that ran
				// out of output budget) or arrived malformed. Dropping it silently ends the turn
				// as plain text with the model's stated intent in history and nothing executed --
				// the same failure the Anthropic and OpenAI paths already fail loudly on.
				const parsedGeminiTools = geminiToolCalls
					.map(t => ({ t, tc: rawToolCallObjOfParamsStr(t.name, t.paramsStr, t.id || generateUuid()) })) // ids can be empty, but other providers might expect an id
				const droppedGeminiTool = parsedGeminiTools.find(p => p.t.name && !p.tc)
				if (droppedGeminiTool) {
					onError({ message: `V3Code: The model's "${droppedGeminiTool.t.name}" tool call arrived with truncated or malformed arguments and could not be executed. NOTHING WAS WRITTEN. Retry with a smaller change per call.`, fullError: null })
					return
				}
				const toolCalls = parsedGeminiTools
					.map(p => p.tc)
					.filter((tc): tc is NonNullable<typeof tc> => !!tc)
				const toolCallObj = toolCalls.length ? { toolCall: toolCalls[0], toolCalls } : {}
				const usageObj = geminiUsage ? { usage: geminiUsage } : {}
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, geminiParts, ...toolCallObj, ...usageObj });
			}
		})
		.catch(error => {
			if (typeof error?.message === 'string' && error.message.includes('API key')) {
				console.error(`[llm:${providerName}] provider request failed`, error)
				onError({ message: invalidApiKeyMessage(providerName), fullError: null });
				return
			}
			reportProviderError(providerName, error, onError)
		})
};



/**
 * Gemini (Plan) — the subscription lane.
 *
 * Same message/tool construction as `sendGeminiChat`, but the Code Assist surface wraps both the
 * request and the response in an envelope the @google/genai SDK cannot produce, so this goes
 * through streamCodeAssist and adapts the raw chunks to the same accumulate-and-finalize shape.
 */
const sendGeminiPlanChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	onUsage,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	chatMode,
	coreToolsOnly,
	excludeTools,
	mcpTools,
}: SendChatParams_Internal) => {
	if (isProviderTemporarilyDisabled('geminiPlan')) {
		onError({ message: 'Gemini Plan is no longer available in this editor. Select Gemini with an API key in Settings > Models.', fullError: null });
		return;
	}
	const { modelName, specialToolFormat } = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel)
	const thinkingConfig = reasoningInfo?.isReasoningEnabled && reasoningInfo.type === 'budget_slider_value'
		? { thinkingBudget: reasoningInfo.reasoningBudget }
		: undefined

	const potentialTools = geminiTools(chatMode, mcpTools, coreToolsOnly, excludeTools)
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ? potentialTools : undefined

	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	let fullTextSoFar = ''
	let fullReasoningSoFar = ''
	const geminiToolCalls: { name: string; paramsStr: string; id: string }[] = []
	let geminiUsage: LLMUsage | undefined = undefined

	const abortController = new AbortController()
	_setAborter(() => { abortController.abort() })

	try {
		const creds = await getGeminiPlanCredentials()
		if (!creds) {
			throw new Error(`Not signed in to Gemini. Open a terminal, run \`gemini\`, and choose "Sign in with Google", then try again. (Settings > Models > Gemini (Plan))`)
		}

		const generationConfig: Record<string, unknown> | undefined = thinkingConfig
			? { thinkingConfig }
			: undefined

		for await (const chunk of streamCodeAssist({
			creds,
			model: modelName,
			contents: messages as GeminiLLMChatMessage[],
			systemInstruction: separateSystemMessage
				? { role: 'user', parts: [{ text: separateSystemMessage }] }
				: undefined,
			tools: toolConfig,
			generationConfig,
			signal: abortController.signal,
		})) {
			// Raw chunks carry parts rather than the SDK's computed .text/.functionCalls, so
			// split them here. A part flagged `thought: true` is reasoning, not answer text —
			// concatenating it into fullText would print the model's thinking as its reply.
			for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
				if (part.functionCall) {
					geminiToolCalls.push({
						name: part.functionCall.name ?? '',
						paramsStr: JSON.stringify(part.functionCall.args ?? {}),
						id: part.functionCall.id ?? '',
					})
				} else if (typeof part.text === 'string') {
					if (part.thought) { fullReasoningSoFar += part.text }
					else { fullTextSoFar += part.text }
				}
			}

			const um = chunk.usageMetadata
			if (um) {
				geminiUsage = {
					prompt_tokens: um.promptTokenCount,
					completion_tokens: um.candidatesTokenCount,
					total_tokens: um.totalTokenCount,
					prompt_cache_hit_tokens: um.cachedContentTokenCount,
				}
				onUsage?.({ usage: geminiUsage })
			}

			const liveTool = geminiToolCalls[0]
			onText({
				fullText: fullTextSoFar,
				fullReasoning: fullReasoningSoFar,
				toolCall: !liveTool?.name ? undefined : { name: liveTool.name, rawParams: {}, isDone: false, doneParams: [], id: liveTool.id },
			})
		}

		if (!fullTextSoFar && !fullReasoningSoFar && geminiToolCalls.length === 0) {
			onError({ message: 'V3Code: Response from model was empty.', fullError: null })
		} else {
			// See the streaming path above: a named tool whose arguments do not parse must fail
			// loudly, not vanish into a plain-text turn.
			const parsedGeminiTools = geminiToolCalls
				.map(t => ({ t, tc: rawToolCallObjOfParamsStr(t.name, t.paramsStr, t.id || generateUuid()) }))
			const droppedGeminiTool = parsedGeminiTools.find(p => p.t.name && !p.tc)
			if (droppedGeminiTool) {
				onError({ message: `V3Code: The model's "${droppedGeminiTool.t.name}" tool call arrived with truncated or malformed arguments and could not be executed. NOTHING WAS WRITTEN. Retry with a smaller change per call.`, fullError: null })
				return
			}
			const toolCalls = parsedGeminiTools
				.map(p => p.tc)
				.filter((tc): tc is NonNullable<typeof tc> => !!tc)
			const toolCallObj = toolCalls.length ? { toolCall: toolCalls[0], toolCalls } : {}
			const usageObj = geminiUsage ? { usage: geminiUsage } : {}
			onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj, ...usageObj })
		}
	} catch (error) {
		if (abortController.signal.aborted) { return }
		reportProviderError(providerName, error, onError)
	}
}


type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: ListParams_Internal<any>) => void) | null;
	}
}

export const sendLLMMessageToProviderImplementation = {
	'v3code-local': {
		sendChat: (params) => sendV3codeLocalChat(params),
		sendFIM: (params) => sendV3codeLocalFIM(params),
		list: null,
	},
	anthropic: {
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: anthropicList,
	},
	openAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: (params) => _openaiCompatibleList(params),
	},
	xAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: (params) => _openaiCompatibleList(params),
	},
	grokPlan: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	claudePlan: {
		// Same Messages-API transport as `anthropic`; the auth swap happens inside.
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: null,
	},
	copilot: {
		sendChat: sendCopilotChat,
		sendFIM: null,
		list: copilotList,
	},
	geminiPlan: {
		sendChat: (params) => sendGeminiPlanChat(params),
		sendFIM: null,
		list: null,
	},
	cursorLocal: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null, // models are the static lane list; the app is a localhost proxy, not a catalogue
	},
	openaiPlan: {
		sendChat: async (params) => {
			// A saved selection can outlive the picker entry. Refuse it before the shared
			// Responses transport reads ~/.codex/auth.json or makes a network request.
			if (isProviderTemporarilyDisabled('openaiPlan')) {
				params.onError({
					message: 'OpenAI (Plan) is temporarily disabled while V3Code validates subscription routing. Choose another model.',
					fullError: null,
				});
				return;
			}
			return _sendOpenAIResponsesChat(params);
		},
		sendFIM: null,
		list: null,
	},
	'v3code-free': {
		sendChat: (params) => _sendV3CodeFreeChat(params),
		sendFIM: null, // none of the free ids are FIM-trained
		list: v3codeFreeList,
	},
	gemini: {
		sendChat: (params) => sendGeminiChat(params),
		sendFIM: null,
		list: null,
	},
	mistral: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => sendMistralFIM(params),
		list: null,
	},
	ollama: {
		sendChat: (params) => sendOllamaChat(params),
		sendFIM: sendOllamaFIM,
		list: ollamaList,
	},
	openAICompatible: {
		sendChat: (params) => _sendOpenAICompatibleChat(params), // using openai's SDK is not ideal (your implementation might not do tools, reasoning, FIM etc correctly), talk to us for a custom integration
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openAICompatible2: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openAICompatible3: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openRouter: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	vLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	deepseek: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => sendDeepSeekFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	groq: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: (params) => _openaiCompatibleList(params),
	},

	lmStudio: {
		// lmStudio has no suffix parameter in /completions, so sendFIM might not work
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	liteLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	googleVertex: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	microsoftAzure: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	awsBedrock: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

} satisfies CallFnOfProvider




/*
FIM info (this may be useful in the future with vLLM, but in most cases the only way to use FIM is if the provider explicitly supports it):

qwen2.5-coder https://ollama.com/library/qwen2.5-coder/blobs/e94a8ecb9327
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

codestral https://ollama.com/library/codestral/blobs/51707752a87c
[SUFFIX]{{ .Suffix }}[PREFIX] {{ .Prompt }}

deepseek-coder-v2 https://ollama.com/library/deepseek-coder-v2/blobs/22091531faf0
allow-any-unicode-next-line
<｜fim▁begin｜>{{ .Prompt }}<｜fim▁hole｜>{{ .Suffix }}<｜fim▁end｜>

starcoder2 https://ollama.com/library/starcoder2/blobs/3b190e68fefe
<file_sep>
<fim_prefix>
{{ .Prompt }}<fim_suffix>{{ .Suffix }}<fim_middle>
<|end_of_text|>

codegemma https://ollama.com/library/codegemma:2b/blobs/48d9a8140749
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

*/
