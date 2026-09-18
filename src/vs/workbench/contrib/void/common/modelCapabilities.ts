/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { FeatureName, ModelSelectionOptions, OverridesOfModel, ProviderName } from './voidSettingsTypes.js';
import { isV3CodeFreeModelId, V3CODE_FREE_AUTO_MODEL, V3CODE_FREE_ROTATION } from './v3codeFreeModels.js';

export const OPUS_HYBRID_MODEL_NAME = 'Opus Hybrid';
export const OPUS_HYBRID_ADVISOR_MODEL = 'claude-opus-4-8';
export const OPUS_HYBRID_HARD_EXECUTOR_MODEL = 'claude-sonnet-5';
export const OPUS_HYBRID_EASY_EXECUTOR_MODEL = 'claude-haiku-4-5-20251001';

export const isOpusHybridModel = (providerName: ProviderName, modelName: string): boolean =>
	(providerName === 'anthropic' || providerName === 'claudePlan')
	&& modelName.trim().toLowerCase() === OPUS_HYBRID_MODEL_NAME.toLowerCase();

export const opusHybridExecutorModel = (modelSelectionOptions: ModelSelectionOptions | undefined): string =>
	modelSelectionOptions?.advisorEffort === 'easy' ? OPUS_HYBRID_EASY_EXECUTOR_MODEL : OPUS_HYBRID_HARD_EXECUTOR_MODEL;





export const defaultProviderSettings = {
	// FIRST on purpose: `providerNames` follows this key order, and a feature that has never
	// been selected defaults to the 0th available model. Putting the zero-signup free lane
	// first means a brand-new user lands on a model that actually answers, instead of a
	// plan-gated hosted model that errors or a local GGUF that has not been downloaded.
	'v3code-free': {
		// Free lane — no key, no signup. Runs on the OpenCode Zen public gateway with the
		// literal key "public"; only its `-free` model ids are exposed (cost 0). Empty
		// settings object => always "configured" (visible in the picker).
	},
	'v3code-local': {
		// Built-in local inference (node-llama-cpp). No endpoint/key — it runs in-process.
	},
	anthropic: {
		apiKey: '',
	},
	openAI: {
		apiKey: '',
	},
	deepseek: {
		apiKey: '',
	},
	ollama: {
		endpoint: 'http://127.0.0.1:11434',
	},
	vLLM: {
		endpoint: 'http://localhost:8000',
	},
	openRouter: {
		apiKey: '',
	},
	openAICompatible: {
		endpoint: '',
		apiKey: '',
		headersJSON: '{}', // default to {}
	},
	// Extra fixed OpenAI-compatible slots. Some users run several OpenAI-compatible endpoints at
	// once (e.g. a local llama.cpp AND a cloud gateway AND a work proxy). Each slot is a full,
	// independent provider with its own endpoint/key/headers. Kept as a fixed few (not an unbounded
	// list) so every existing Record<ProviderName> map and the auto-iterating settings UI pick them
	// up with no storage refactor.
	openAICompatible2: {
		endpoint: '',
		apiKey: '',
		headersJSON: '{}',
	},
	openAICompatible3: {
		endpoint: '',
		apiKey: '',
		headersJSON: '{}',
	},
	gemini: {
		apiKey: '',
	},
	groq: {
		apiKey: '',
	},
	xAI: {
		apiKey: '',
	},
	grokPlan: {
		// Subscription lane — no user-entered key. Auth comes from `grok login` (~/.grok/auth.json),
		// read live in the main process. Empty settings object => always "configured" (visible in
		// the picker); a not-signed-in send surfaces a friendly "run grok login" error.
	},
	claudePlan: {
		// Subscription lane — Claude Pro/Max via the token Claude Code stores after `/login`
		// (macOS Keychain, or ~/.claude/.credentials.json elsewhere). No user-entered key.
	},
	copilot: {
		// Subscription lane — GitHub Copilot via the `ghu_` token written by `copilot login` or
		// the Copilot editor plugins, exchanged for a short-lived session token. No key to enter.
	},
	geminiPlan: {
		// Subscription lane — the Google OAuth credentials gemini-cli writes to
		// ~/.gemini/oauth_creds.json, used against the Code Assist surface. No key to enter.
	},
	cursorLocal: {
		// Local lane — the "API for Cursor" desktop app holds the official Cursor key and serves
		// an OpenAI-compatible API at 127.0.0.1:8788 against the user's Cursor subscription.
		// `endpoint` is overridable only for a non-default port; there is NO key field (the app
		// owns it) and the empty object keeps the lane always-configured so the status probe,
		// not a settings gate, decides picker visibility.
		endpoint: 'http://127.0.0.1:8788/v1',
	},
	openaiPlan: {
		// Subscription lane — ChatGPT Plus/Pro via ~/.codex/auth.json (auth_mode chatgpt).
		// Never an API key. The billed-per-token lane remains `openAI`.
	},
	mistral: {
		apiKey: '',
	},
	lmStudio: {
		endpoint: 'http://localhost:1234',
	},
	liteLLM: { // https://docs.litellm.ai/docs/providers/openai_compatible
		endpoint: '',
	},
	googleVertex: { // google https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		region: 'us-west2',
		project: '',
	},
	microsoftAzure: { // microsoft Azure Foundry
		project: '', // really 'resource'
		apiKey: '',
		azureApiVersion: '2024-05-01-preview',
	},
	awsBedrock: {
		apiKey: '',
		region: 'us-east-1', // add region setting
		endpoint: '', // optionally allow overriding default
	},

} as const




export const defaultModelsOfProvider = {
	'v3code-free': [ // zero-signup free lane; every id verified to stream + call tools at cost 0
		V3CODE_FREE_AUTO_MODEL, // FIRST: rotates across the current tool-capable ids below
		...V3CODE_FREE_ROTATION,
	],
	'v3code-local': [ // built-in local GGUFs (logical names; the engine resolves the file path)
		'qwen2.5-coder-1.5b', // default (GPU machines)
		'qwen2.5-coder-0.5b', // tiny (CPU-only / weak machines)
	],
	openAI: [
		'gpt-5.6-sol',
		'gpt-5.6-terra',
		'gpt-5.6-luna',
		'gpt-5.5',
		'gpt-5.5-pro',
		'gpt-5.4-mini',
		'gpt-5.4-nano',
		'o3',
		'o3-pro',
		'o4-mini',
	],
	anthropic: [
		OPUS_HYBRID_MODEL_NAME,
		'claude-opus-5',
		'claude-fable-5-1',
		'claude-fable-5',
		'claude-mythos-5',
		'claude-opus-4-8',
		'claude-opus-4-7',
		'claude-sonnet-5',
		'claude-sonnet-4-6',
		'claude-haiku-4-5-20251001',
		// claude-opus-4-0 / claude-sonnet-4-0 / claude-opus-4-6 removed from defaults
		// (superseded; records remain — users who added them keep them via settings state).
		// This list may exceed nine: modelInfoOfDefaultModelNames now hides only the TAIL past
		// MAX_VISIBLE_DEFAULT_MODELS. It used to hide EVERY model once a provider reached ten,
		// which is why this list was pinned at nine.
	],
	xAI: [
		'grok-4.5',
		'grok-4.3',
		'grok-build-0.1',
		'grok-4.20-multi-agent-0309',
		'grok-4.20-0309-reasoning',
		'grok-4.20-0309-non-reasoning',
		'grok-3',
	],
	grokPlan: [ // logical ids routed via x-grok-model-override; only entitled backends are served
		'grok-4.6',
		'grok-4.5',
		'grok-build',
	],
	claudePlan: [ // same wire ids as the Anthropic API — the lane differs only in how it authenticates
		OPUS_HYBRID_MODEL_NAME,
		'claude-opus-5',
		'claude-fable-5-1',
		'claude-fable-5',
		'claude-sonnet-5',
		'claude-opus-4-8',
		'claude-opus-4-6',
		'claude-sonnet-4-6',
		'claude-haiku-4-5-20251001',
	],
	copilot: [ // served by the Copilot chat endpoint; availability follows the user's plan
		'gpt-5.6-sol',
		'claude-sonnet-5',
		'gpt-5.4-mini',
	],
	geminiPlan: [ // same ids as the Gemini API, served through Code Assist on the user's plan
		'gemini-3.5-flash',
		'gemini-3.1-pro-preview',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
	],
	cursorLocal: [ // ids the "API for Cursor" app serves on the user's Cursor subscription
		'composer-2.5',
		'composer-2.5-fast',
		'grok-4.6',
		'grok-4.6-fast',
		'grok-4.5',
		'grok-4.5-fast',
	],
	openaiPlan: [ // ChatGPT Plus/Pro via Codex; ONLY ids the endpoint actually serves to a plan
		'gpt-5.6-sol', // default: the broadest-entitlement model of the verified set
		'gpt-6-astra',
		'gpt-5.6-terra',
		'gpt-5.6-luna',
		'gpt-5.5',
		'gpt-5.3-codex-spark',
	],
	gemini: [
		'gemini-3.5-flash',
		'gemini-3.1-pro-preview',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.0-flash',
	],
	deepseek: [ // https://api-docs.deepseek.com/quick_start/pricing
		'deepseek-flash',
		'deepseek-v4-pro',
		'deepseek-v4-flash',
		// deepseek-chat / deepseek-reasoner removed from defaults (deprecated upstream,
		// route to v4-flash; records remain for users who added them).
	],
	ollama: [ // autodetected
	],
	vLLM: [ // autodetected
	],
	lmStudio: [], // autodetected

	openRouter: [ // https://openrouter.ai/models
		// 'anthropic/claude-3.7-sonnet:thinking',
		'anthropic/claude-opus-4',
		'anthropic/claude-sonnet-4',
		'qwen/qwen3-235b-a22b',
		'anthropic/claude-3.7-sonnet',
		'anthropic/claude-3.5-sonnet',
		'deepseek/deepseek-r1',
		'deepseek/deepseek-r1-zero:free',
		'deepseek/deepseek-v4-pro',
		'deepseek/deepseek-v4-flash',
		'mistralai/devstral-small:free'
		// 'openrouter/quasar-alpha',
		// 'google/gemini-2.5-pro-preview-03-25',
		// 'mistralai/codestral-2501',
		// 'qwen/qwen-2.5-coder-32b-instruct',
		// 'mistralai/mistral-small-3.1-24b-instruct:free',
		// 'google/gemini-2.0-flash-lite-preview-02-05:free',
		// 'google/gemini-2.0-pro-exp-02-05:free',
		// 'google/gemini-2.0-flash-exp:free',
	],
	groq: [ // https://console.groq.com/docs/models
		'qwen-qwq-32b',
		'llama-3.3-70b-versatile',
		'llama-3.1-8b-instant',
		// 'qwen-2.5-coder-32b', // preview mode (experimental)
	],
	mistral: [ // https://docs.mistral.ai/getting-started/models/models_overview/
		'codestral-latest',
		'devstral-small-latest',
		'mistral-large-latest',
		'mistral-medium-latest',
		'ministral-3b-latest',
		'ministral-8b-latest',
	],
	openAICompatible: [], // fallback
	openAICompatible2: [], // fallback
	openAICompatible3: [], // fallback
	googleVertex: [],
	microsoftAzure: [],
	awsBedrock: [],
	liteLLM: [],


} as const satisfies Record<ProviderName, string[]>



export type VoidStaticModelInfo = { // not stateful
	// Void uses the information below to know how to handle each model.
	// for some examples, see openAIModelOptions and anthropicModelOptions (below).

	contextWindow: number; // input tokens
	reservedOutputTokenSpace: number | null; // reserve this much space in the context window for output, defaults to 4096 if null

	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated'; // typically you should use 'system-role'. 'separated' means the system message is passed as a separate field (e.g. anthropic)
	specialToolFormat?: 'openai-style' | 'anthropic-style' | 'gemini-style', // typically you should use 'openai-style'. null means "can't call tools by default", and asks the LLM to output XML in agent mode
	supportsFIM: boolean; // whether the model was specifically designed for autocomplete or "FIM" ("fill-in-middle" format)
	supportsNextEdit?: boolean; // trained for next-edit prediction (Instinct-style editable-region rewrite). Optional + defaults to false: models opt in explicitly. Gates the NextEdit feature's native prompt format.
	supportsVision?: boolean; // whether the model accepts image input. Optional + defaults to false (see defaultModelOptions): models opt in explicitly. Used to gate the non-vision describe-step.

	additionalOpenAIPayload?: { [key: string]: string } // additional payload in the message body for requests that are openai-compatible (ollama, vllm, openai, openrouter, etc)

	// reasoning options
	reasoningCapabilities: false | {
		readonly supportsReasoning: true; // for clarity, this must be true if anything below is specified
		readonly canTurnOffReasoning: boolean; // whether or not the user can disable reasoning mode (false if the model only supports reasoning)
		readonly canIOReasoning: boolean; // whether or not the model actually outputs reasoning (eg o1 lets us control reasoning but not output it)
		readonly reasoningReservedOutputTokenSpace?: number; // overrides normal reservedOutputTokenSpace
		readonly reasoningSlider?:
		| undefined
		| { type: 'budget_slider'; min: number; max: number; default: number } // anthropic supports this (reasoning budget)
		| { type: 'effort_slider'; values: string[]; default: string } // openai-compatible supports this (reasoning effort)

		// if it's open source and specifically outputs think tags, put the think tags here and we'll parse them out (e.g. ollama)
		readonly openSourceThinkTags?: [string, string];

		// Set when OMITTING the provider's thinking field does NOT turn reasoning off: the model
		// runs ADAPTIVE thinking by default, billed, and (where display defaults to 'omitted')
		// invisible — dead time before the first visible token even though the user toggled
		// reasoning off. Models with this flag get an explicit "disabled" sent in the payload
		// (e.g. Anthropic `thinking: { type: 'disabled' }`). Only set it on models that ACCEPT
		// the explicit disable: claude-sonnet-5 does; Fable/Mythos 5 400 on it and must NOT
		// carry this flag even though they are also adaptive-by-default.
		readonly omittedThinkingRunsAdaptive?: true;

		// the only other field related to reasoning is "providerReasoningIOSettings", which varies by provider.
	};


	// --- below is just informative, not used in sending / receiving, cannot be customized in settings ---
	cost: {
		input: number;
		output: number;
		cache_read?: number;
		/** 5-minute-TTL cache write rate. 1h-TTL writes are billed at 2x input (derived, not stored). */
		cache_write?: number;
		/** True when we have NO price data for this model (fallback/unrecognized entries). The
		 *  meter must surface "unpriced" instead of a silent-and-wrong $0. Genuinely free models
		 *  (local inference) keep input/output 0 WITHOUT this flag. */
		unpriced?: true;
	}
	downloadable: false | {
		sizeGb: number | 'not-known'
	}
}
// if you change the above type, remember to update the Settings link



export const modelOverrideKeys = [
	'supportsVision',
	'contextWindow',
	'reservedOutputTokenSpace',
	'supportsSystemMessage',
	'specialToolFormat',
	'supportsFIM',
	'reasoningCapabilities',
	'additionalOpenAIPayload'
] as const

export type ModelOverrides = Pick<
	VoidStaticModelInfo,
	(typeof modelOverrideKeys)[number]
> & { _discoveredCapabilities?: Partial<VoidStaticModelInfo> & { supportsTools?: boolean } }




type ProviderReasoningIOSettings = {
	// include this in payload to get reasoning
	input?: { includeInPayload?: (reasoningState: SendableReasoningInfo) => null | { [key: string]: any }, };
	// nameOfFieldInDelta: reasoning output is in response.choices[0].delta[deltaReasoningField]
	// needsManualParse: whether we must manually parse out the <think> tags
	output?:
	| { nameOfFieldInDelta?: string, needsManualParse?: undefined, }
	| { nameOfFieldInDelta?: undefined, needsManualParse?: true, };
}

type VoidStaticProviderInfo = { // doesn't change (not stateful)
	providerReasoningIOSettings?: ProviderReasoningIOSettings; // input/output settings around thinking (allowed to be empty) - only applied if the model supports reasoning output
	modelOptions: { [key: string]: VoidStaticModelInfo };
	modelOptionsFallback: (modelName: string, fallbackKnownValues?: Partial<VoidStaticModelInfo>) => (VoidStaticModelInfo & { modelName: string, recognizedModelName: string }) | null;
}



const defaultModelOptions = {
	contextWindow: 4_096,
	reservedOutputTokenSpace: 4_096,
	cost: { input: 0, output: 0, unpriced: true },
	downloadable: false,
	supportsSystemMessage: false,
	supportsFIM: false,
	supportsVision: false, // safe default: unknown/unrecognized models are treated as non-vision (routes through the describe-step)
	reasoningCapabilities: false,
} as const satisfies VoidStaticModelInfo

// TODO!!! double check all context sizes below
// TODO!!! add openrouter common models
// TODO!!! allow user to modify capabilities and tell them if autodetected model or falling back
const openSourceModelOptions_assumingOAICompat = {
	'deepseekR1': {
		supportsFIM: false,
		supportsSystemMessage: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'deepseekCoderV3': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'deepseekCoderV2': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'codestral': {
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'devstral': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 131_000, reservedOutputTokenSpace: 8_192,
	},
	'openhands-lm-32b': { // https://www.all-hands.dev/blog/introducing-openhands-lm-32b----a-strong-open-coding-agent-model
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false, // built on qwen 2.5 32B instruct
		contextWindow: 128_000, reservedOutputTokenSpace: 4_096
	},

	// really only phi4-reasoning supports reasoning... simpler to combine them though
	'phi4': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 16_000, reservedOutputTokenSpace: 4_096,
	},

	'gemma': { // https://news.ycombinator.com/item?id=43451406
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	// Large Gemma-3-generation variants (12B/26B/27B) carry a 128K window — the small
	// 'gemma' record above (32k) short-changes them badly.
	'gemma-large': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	// llama 4 https://ai.meta.com/blog/llama-4-multimodal-intelligence/
	'llama4-scout': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 10_000_000, reservedOutputTokenSpace: 4_096,
	},
	'llama4-maverick': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 10_000_000, reservedOutputTokenSpace: 4_096,
	},

	// llama 3
	'llama3': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'llama3.1': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'llama3.2': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'llama3.3': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	// qwen
	'qwen2.5coder': {
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	// Continue.dev's open NES model (Qwen2.5-Coder-7B fine-tune, Apache-2.0) — `ollama run nate/instinct`,
	// or any custom endpoint whose model name contains "instinct" (see extensiveModelOptionsFallback)
	'instinct': {
		supportsFIM: false,
		supportsNextEdit: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'qwq': {
		supportsFIM: false, // no FIM, yes reasoning
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	'qwen3': {
		supportsFIM: false, // replaces QwQ
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 32_768, reservedOutputTokenSpace: 8_192,
	},
	// FIM only
	'starcoder2': {
		supportsFIM: true,
		supportsSystemMessage: false,
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,

	},
	'codegemma:2b': {
		supportsFIM: true,
		supportsSystemMessage: false,
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,

	},
	'quasar': { // openrouter/quasar-alpha
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 1_000_000, reservedOutputTokenSpace: 32_000,
	}
} as const satisfies { [s: string]: Partial<VoidStaticModelInfo> }




// keep modelName, but use the fallback's defaults
const extensiveModelOptionsFallback: VoidStaticProviderInfo['modelOptionsFallback'] = (modelName, fallbackKnownValues) => {

	const lower = modelName.toLowerCase()

	const toFallback = <T extends { [s: string]: Omit<VoidStaticModelInfo, 'cost' | 'downloadable'> },>(obj: T, recognizedModelName: string & keyof T)
		: VoidStaticModelInfo & { modelName: string, recognizedModelName: string } => {

		const opts = obj[recognizedModelName]
		const supportsSystemMessage = opts.supportsSystemMessage === 'separated'
			? 'system-role'
			: opts.supportsSystemMessage

		return {
			recognizedModelName,
			modelName,
			...opts,
			supportsSystemMessage: supportsSystemMessage,
			// Fallback-recognized models (OpenRouter/ollama/vLLM/lmStudio/etc) have NO price data —
			// a plain {input:0, output:0} made every one of them silently meter as $0. Mark them
			// unpriced so the usage meter can say so instead of lying with a free bill.
			cost: { input: 0, output: 0, unpriced: true as const },
			downloadable: false,
			...fallbackKnownValues
		};
	}

	if (lower.includes('gemini') && (lower.includes('2.5') || lower.includes('2-5'))) return toFallback(geminiModelOptions, 'gemini-2.5-pro-exp-03-25')

	if (lower.includes('claude-3-5') || lower.includes('claude-3.5')) return toFallback(anthropicModelOptions, 'claude-3-5-sonnet-20241022')
	if (lower.includes('claude')) return toFallback(anthropicModelOptions, 'claude-3-7-sonnet-20250219')

	if (lower.includes('grok2') || lower.includes('grok2')) return toFallback(xAIModelOptions, 'grok-2')
	if (lower.includes('grok')) return toFallback(xAIModelOptions, 'grok-3')

	if (lower.includes('deepseek-v4-pro')) return toFallback(deepseekModelOptions, 'deepseek-v4-pro')
	// Only explicitly identified vision models opt in. Older local/third-party V4 Flash
	// checkpoints do not inherit the direct API's September 2026 alias upgrade.
	if (/^(?:deepseek\/)?deepseek-(?:flash|v4-flash-vision-exp)$/.test(lower)) return toFallback(deepseekModelOptions, 'deepseek-flash')
	if (lower.includes('deepseek-v4-flash')) return toFallback({ 'deepseek-v4-flash': deepseekV4FlashTextOptions }, 'deepseek-v4-flash')
	if (lower.includes('deepseek-v4')) return toFallback(deepseekModelOptions, 'deepseek-v4-pro')
	if (lower.includes('deepseek-r1') || lower.includes('deepseek-reasoner')) return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekR1')
	if (lower.includes('deepseek') && lower.includes('v2')) return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekCoderV2')
	if (lower.includes('deepseek')) return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekCoderV3')

	if (lower.includes('llama3')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3')
	if (lower.includes('llama3.1')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3.1')
	if (lower.includes('llama3.2')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3.2')
	if (lower.includes('llama3.3')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3.3')
	if (lower.includes('llama') || lower.includes('scout')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama4-scout')
	if (lower.includes('llama') || lower.includes('maverick')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama4-scout')
	if (lower.includes('llama')) return toFallback(openSourceModelOptions_assumingOAICompat, 'llama4-scout')

	if (lower.includes('instinct')) return toFallback(openSourceModelOptions_assumingOAICompat, 'instinct') // covers ollama tags like nate/instinct:latest

	if (lower.includes('qwen') && lower.includes('2.5') && lower.includes('coder')) return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen2.5coder')
	if (lower.includes('qwen') && lower.includes('3')) return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen3')
	if (lower.includes('qwen')) return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen3')
	if (lower.includes('qwq')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'qwq') }
	if (lower.includes('phi4')) return toFallback(openSourceModelOptions_assumingOAICompat, 'phi4')
	if (lower.includes('codestral')) return toFallback(openSourceModelOptions_assumingOAICompat, 'codestral')
	if (lower.includes('devstral')) return toFallback(openSourceModelOptions_assumingOAICompat, 'devstral')

	if (lower.includes('gemma') && (lower.includes('27b') || lower.includes('26b') || lower.includes('12b'))) return toFallback(openSourceModelOptions_assumingOAICompat, 'gemma-large')
	if (lower.includes('gemma')) return toFallback(openSourceModelOptions_assumingOAICompat, 'gemma')

	if (lower.includes('starcoder2')) return toFallback(openSourceModelOptions_assumingOAICompat, 'starcoder2')

	if (lower.includes('openhands')) return toFallback(openSourceModelOptions_assumingOAICompat, 'openhands-lm-32b') // max output uncler

	if (lower.includes('quasar') || lower.includes('quaser')) return toFallback(openSourceModelOptions_assumingOAICompat, 'quasar')

	if (lower.includes('gpt') && lower.includes('mini') && (lower.includes('4.1') || lower.includes('4-1'))) return toFallback(openAIModelOptions, 'gpt-4.1-mini')
	if (lower.includes('gpt') && lower.includes('nano') && (lower.includes('4.1') || lower.includes('4-1'))) return toFallback(openAIModelOptions, 'gpt-4.1-nano')
	if (lower.includes('gpt') && (lower.includes('4.1') || lower.includes('4-1'))) return toFallback(openAIModelOptions, 'gpt-4.1')

	if (lower.includes('4o') && lower.includes('mini')) return toFallback(openAIModelOptions, 'gpt-4o-mini')
	if (lower.includes('4o')) return toFallback(openAIModelOptions, 'gpt-4o')

	if (lower.includes('o1') && lower.includes('mini')) return toFallback(openAIModelOptions, 'o1-mini')
	if (lower.includes('o1')) return toFallback(openAIModelOptions, 'o1')
	if (lower.includes('o3') && lower.includes('mini')) return toFallback(openAIModelOptions, 'o3-mini')
	if (lower.includes('o3')) return toFallback(openAIModelOptions, 'o3')
	if (lower.includes('o4') && lower.includes('mini')) return toFallback(openAIModelOptions, 'o4-mini')


	if (Object.keys(openSourceModelOptions_assumingOAICompat).map(k => k.toLowerCase()).includes(lower))
		return toFallback(openSourceModelOptions_assumingOAICompat, lower as keyof typeof openSourceModelOptions_assumingOAICompat)

	return null
}






// ---------------- ANTHROPIC ----------------
const anthropicModelOptions = {
	[OPUS_HYBRID_MODEL_NAME]: {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 64_000,
		// Sonnet 5 rates (the Hard executor): intro $2 in / $10 out per Mtok through 2026-08-31, then $3/$15.
		// Display-only fallback — actual metering prices the WIRE model that ran (Sonnet hard /
		// Haiku easy), reported per-request by the Anthropic transport.
		cost: { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 10.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	},
	'claude-3-7-sonnet-20250219': { // https://docs.anthropic.com/en/docs/about-claude/models/all-models#model-comparison-table
		supportsVision: true,
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 10.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192, // can bump it to 128_000 with beta mode output-128k-2025-02-19
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // they recommend batching if max > 32_000. we cap at 8192 because above is typically not necessary (often even buggy)
		},

	},
	'claude-opus-5': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		// Official Anthropic pricing (per Mtok): $5 in / $25 out, cache read $0.50, 5m cache write $6.25.
		cost: { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 25.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			// Adaptive-thinking API, same wire shape as Opus 4.6/4.7/4.8 and Fable 5: it rejects
			// `thinking.type.enabled` (budget_tokens) and wants `thinking.type.adaptive` +
			// `output_config.effort`, so it MUST use the effort slider. Adaptive models interleave
			// thinking before each tool call on their own, which is why the send path deliberately
			// withholds the interleaved-thinking beta from them (sending it is what 400s).
			reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'high' },
		},
	},
	// Fable 5.1 — current frontier Fable revision. Same 1M-context adaptive-thinking wire shape as
	// Fable 5; the ONLY capability difference is a 4x cheaper cache read ($0.25 vs $1.00 per Mtok).
	// Wire id is `claude-fable-5-1` (hyphenated minor), NOT `claude-fable-5.1` — a dotted id 404s.
	'claude-fable-5-1': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		// Published pricing (per Mtok): $10 in / $50 out, cache read $0.25, 5m cache write $12.50.
		cost: { input: 10.00, cache_read: 0.25, cache_write: 12.50, output: 50.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			// Adaptive-thinking API: rejects `thinking.type.enabled` (budget_tokens) and wants
			// `thinking.type.adaptive` + `output_config.effort`, so it MUST use the effort slider.
			reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'high' },
		},
	},
	'claude-fable-5': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		// Official Anthropic pricing (per Mtok): $10 in / $50 out, cache read $1, 5m cache write $12.50.
		cost: { input: 10.00, cache_read: 1.00, cache_write: 12.50, output: 50.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			// Fable 5 — adaptive-thinking API (same wire shape as Opus 4.6/4.7/4.8).
			// Interleaves thinking before each tool call when display=summarized is set in payload.
			reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'high' },
		},
	},
	// Mythos 5 — same underlying model as Fable 5, available without dual-use safety measures to
	// approved orgs only. Same caps and pricing; its own wire id so requests aren't misrouted.
	'claude-mythos-5': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		cost: { input: 10.00, cache_read: 1.00, cache_write: 12.50, output: 50.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'high' },
		},
	},
	'claude-opus-4-8': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		// Official Anthropic pricing (per Mtok): $5 in / $25 out, cache read $0.50, 5m cache write $6.25.
		cost: { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 25.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			// Opus 4.8 uses Anthropic's NEW adaptive-thinking API: it rejects
			// `thinking.type.enabled` (budget_tokens) and requires `thinking.type.adaptive`
			// + `output_config.effort`. So it must use the effort slider, not the budget one.
			reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'high' },
		},
	},
	// Opus 4.7 — adaptive-thinking only (manual budget_tokens 400s). Same caps as 4.8 but its OWN
	// wire id (`claude-opus-4-7`); routing 4.7 to the 4.8 wire id was the source of the 404
	// "model: claude-opus-4-20250514" error reported by the user.
	'claude-opus-4-7': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		// Official Anthropic pricing (per Mtok): $5 in / $25 out, cache read $0.50, 5m cache write $6.25.
		cost: { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 25.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'high' },
		},
	},
	// Opus 4.6 — adaptive thinking is recommended; manual budget_tokens still works but is
	// deprecated and will be removed. Default display is "summarized" on 4.6 (unlike 4.7/4.8
	// which default to "omitted"), so thinking surfaces with or without `display: 'summarized'`.
	// We still route through the adaptive payload so 4.6 behaves consistently with 4.7/4.8.
	'claude-opus-4-6': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		cost: { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 25.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'high' },
		},
	},
	// Sonnet 5 (shipped 2026-06-30) — dateless wire id `claude-sonnet-5`. Adaptive-thinking
	// ONLY: the old `thinking.type.enabled` (budget_tokens) API is REMOVED on this model and
	// returns a 400 (same as Opus 4.7/4.8), so it must use the effort slider, never the budget
	// one. Do NOT wire it like Sonnet 4.6.
	'claude-sonnet-5': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		// Official Anthropic INTRO pricing (per Mtok): $2 in / $10 out, cache read $0.20,
		// 5m cache write $2.50 (standard 0.1x / 1.25x ratios). Re-check when intro pricing ends.
		cost: { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 10.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			// Sonnet 5 also accepts 'max'; we stop at 'xhigh' (the recommended coding/agentic
			// setting). Default stays 'high' so existing selections don't silently get pricier.
			reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high', 'xhigh'], default: 'high' },
			// Omitting `thinking` on Sonnet 5 does NOT mean off — adaptive thinking runs by
			// default (billed, display defaults to 'omitted' so it's invisible dead time). When
			// the user disables reasoning we must send `thinking: { type: 'disabled' }`, which
			// Sonnet 5 accepts (Fable/Mythos 5 don't — never copy this flag onto them).
			omittedThinkingRunsAdaptive: true,
		},
	},
	'claude-sonnet-4-6': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		// Official Anthropic pricing (per Mtok): $3 in / $15 out, cache read $0.30, 5m cache write $3.75.
		cost: { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 10.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 },
		},
	},
	'claude-haiku-4-5-20251001': {
		supportsVision: true,
		contextWindow: 200_000,
		reservedOutputTokenSpace: 64_000,
		// Official Anthropic pricing (per Mtok): $1 in / $5 out, cache read $0.10, 5m cache write $1.25.
		cost: { input: 1.00, cache_read: 0.10, cache_write: 1.25, output: 5.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	},
	'claude-opus-4-20250514': {
		supportsVision: true,
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 15.00, cache_read: 1.50, cache_write: 18.75, output: 30.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192, // can bump it to 128_000 with beta mode output-128k-2025-02-19
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // they recommend batching if max > 32_000. we cap at 8192 because above is typically not necessary (often even buggy)
		},

	},
	'claude-sonnet-4-20250514': {
		supportsVision: true,
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		// Official Anthropic pricing (per Mtok): $3 in / $15 out — output was wrongly $6/Mtok,
		// under-billing every Sonnet-4 completion by 2.5x in the meter.
		cost: { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 10.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192, // can bump it to 128_000 with beta mode output-128k-2025-02-19
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // they recommend batching if max > 32_000. we cap at 8192 because above is typically not necessary (often even buggy)
		},

	},
	'claude-3-5-sonnet-20241022': {
		supportsVision: true,
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 2.00, cache_read: 0.20, cache_write: 2.50, output: 10.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	},
	'claude-3-5-haiku-20241022': {
		supportsVision: true,
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.80, cache_read: 0.08, cache_write: 1.00, output: 4.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	},
	'claude-3-opus-20240229': {
		supportsVision: true,
		contextWindow: 200_000,
		reservedOutputTokenSpace: 4_096,
		cost: { input: 15.00, cache_read: 1.50, cache_write: 18.75, output: 75.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	},
	'claude-3-sonnet-20240229': { // no point of using this, but including this for people who put it in
		supportsVision: true,
		contextWindow: 200_000, cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		reservedOutputTokenSpace: 4_096,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	}
} as const satisfies { [s: string]: VoidStaticModelInfo }

const anthropicSettings: VoidStaticProviderInfo = {
	providerReasoningIOSettings: {
		input: {
			includeInPayload: (reasoningInfo) => {
				if (!reasoningInfo?.isReasoningEnabled) {
					// Reasoning toggled off. On budget-thinking models omitting `thinking` IS off,
					// but on claude-sonnet-5 omission runs ADAPTIVE thinking by default with
					// display defaulting to 'omitted' — the model thinks silently (billed, seconds
					// of dead air before the first visible token) despite the toggle. Those models
					// reach here as type 'disabled' (via `omittedThinkingRunsAdaptive`) and need
					// the explicit opt-out. Fable/Mythos 5 must stay on the omission path — they
					// 400 on `thinking.type: 'disabled'` — so they don't carry the flag.
					if (reasoningInfo?.type === 'disabled') return { thinking: { type: 'disabled' } }
					return null
				}

				if (reasoningInfo.type === 'budget_slider_value') {
					// Classic extended-thinking API (Claude 3.7 / 4.0 era).
					return { thinking: { type: 'enabled', budget_tokens: reasoningInfo.reasoningBudget } }
				}
				if (reasoningInfo.type === 'effort_slider_value') {
					// New adaptive-thinking API (Opus 4.6+ / 4.7 / 4.8, Mythos/Fable). These models
					// 400 on `thinking.type.enabled` (budget_tokens); they want `thinking.type.adaptive`
					// plus an `output_config.effort` level ('low' | 'medium' | 'high'). Adaptive thinking
					// auto-interleaves between tool calls.
					//
					// `display: 'summarized'` is REQUIRED: on Opus 4.6/4.7/4.8 (and Mythos/Fable) the
					// `display` field defaults to 'omitted', which BILLS thinking tokens but returns an
					// EMPTY thinking field (signature only). Without this the Working panel shows no
					// thinking on Opus 4.6+ even though we pay for it. Setting it explicitly populates
					// the summarized thinking text so it streams to the panel exactly like Sonnet's
					// reasoning, AND so it surfaces before every tool call (interleaved).
					return { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: reasoningInfo.reasoningEffort } }
				}
				return null
			}
		},
	},
	modelOptions: anthropicModelOptions,
	modelOptionsFallback: (modelName) => {
		const lower = modelName.toLowerCase()
		let fallbackName: keyof typeof anthropicModelOptions | null = null
		if (lower === OPUS_HYBRID_MODEL_NAME.toLowerCase() || lower.includes('opus-hybrid') || lower.includes('opus hybrid')) fallbackName = OPUS_HYBRID_MODEL_NAME
		// Opus 5 — its own dateless wire id. Listed before the Opus 4.x rules; it shares no
		// substring with them, so a dated variant (claude-opus-5-YYYYMMDD) lands here rather
		// than falling through to the old budget-thinking Opus.
		if (lower.includes('claude-opus-5')) fallbackName = 'claude-opus-5'
		if (lower.includes('claude-fable-5')) fallbackName = 'claude-fable-5'
		// AFTER the fable-5 line on purpose: 'claude-fable-5-1' contains 'claude-fable-5', so a
		// dated 5.1 variant would otherwise be priced and configured as plain Fable 5.
		if (lower.includes('claude-fable-5-1')) fallbackName = 'claude-fable-5-1'
		if (lower.includes('claude-mythos-5')) fallbackName = 'claude-mythos-5'
		if (lower.includes('claude-opus-4-8')) fallbackName = 'claude-opus-4-8'
		// Opus 4.6 and 4.7 are their OWN wire ids (`claude-opus-4-6`, `claude-opus-4-7`).
		// Routing them to a different wire id (e.g. `claude-opus-4-20250514` = Opus 4.0, or
		// `claude-opus-4-8`) makes Anthropic 404 with `not_found_error: model: <wrong-id>`.
		// Both use adaptive thinking; the table entries above carry the right caps.
		if (lower.includes('claude-opus-4-7')) fallbackName = 'claude-opus-4-7'
		if (lower.includes('claude-opus-4-6')) fallbackName = 'claude-opus-4-6'
		// Generic Opus 4.x fallback (4.0 / 4.1 / 4.5 etc.) → old budget Opus, but DON'T clobber
		// the adaptive 4.6/4.7/4.8 routing above.
		if ((lower.includes('claude-4-opus') || lower.includes('claude-opus-4'))
			&& !lower.includes('claude-opus-4-6')
			&& !lower.includes('claude-opus-4-7')
			&& !lower.includes('claude-opus-4-8')
			&& !lower.includes('claude-fable-5')) fallbackName = 'claude-opus-4-20250514'
		// Sonnet 5 — its own dateless wire id; must route BEFORE the generic sonnet checks.
		// ('claude-sonnet-5' shares no substring with the sonnet-4 checks, but keep it grouped.)
		if (lower.includes('claude-sonnet-5')) fallbackName = 'claude-sonnet-5'
		if (lower.includes('claude-sonnet-4-6')) fallbackName = 'claude-sonnet-4-6'
		// Generic Sonnet 4.x fallback → old wire id, but DON'T clobber the 4-6 routing above
		// (same guard pattern as the Opus 4.6/4.7/4.8 block — 'claude-sonnet-4' is a substring
		// of 'claude-sonnet-4-6', so without the exclusion every Sonnet 4.6 request was
		// silently routed to the Sonnet 4.0 wire id).
		if ((lower.includes('claude-4-sonnet') || lower.includes('claude-sonnet-4'))
			&& !lower.includes('claude-sonnet-4-6')) fallbackName = 'claude-sonnet-4-20250514'
		if (lower.includes('claude-haiku-4-5')) fallbackName = 'claude-haiku-4-5-20251001'


		if (lower.includes('claude-3-7-sonnet')) fallbackName = 'claude-3-7-sonnet-20250219'
		if (lower.includes('claude-3-5-sonnet')) fallbackName = 'claude-3-5-sonnet-20241022'
		if (lower.includes('claude-3-5-haiku')) fallbackName = 'claude-3-5-haiku-20241022'
		if (lower.includes('claude-3-opus')) fallbackName = 'claude-3-opus-20240229'
		if (lower.includes('claude-3-sonnet')) fallbackName = 'claude-3-sonnet-20240229'
		if (fallbackName) return { modelName: fallbackName, recognizedModelName: fallbackName, ...anthropicModelOptions[fallbackName] }
		return null
	},
}


// ---------------- OPENAI ----------------
const openAIModelOptions = { // https://platform.openai.com/docs/pricing
	'o3': {
		supportsVision: true,
		contextWindow: 1_047_576,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 10.00, output: 40.00, cache_read: 2.50 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'o4-mini': {
		supportsVision: true,
		contextWindow: 1_047_576,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 1.10, output: 4.40, cache_read: 0.275 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'gpt-4.1': {
		supportsVision: true,
		contextWindow: 1_047_576,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 2.00, output: 8.00, cache_read: 0.50 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	// GPT-5.6 family (2026-07-09): three tiers, 1M context, 128K max output,
	// explicit prompt-cache breakpoints (writes billed 1.25x input — short-context
	// rates below; long-context requests bill higher on OpenAI's side).
	'gpt-5.6-sol': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		cost: { input: 5.00, cache_read: 0.50, cache_write: 6.25, output: 30.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' } },
	},
	'gpt-5.6-terra': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		cost: { input: 2.50, cache_read: 0.25, cache_write: 3.125, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' } },
	},
	'gpt-5.6-luna': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		cost: { input: 1.00, cache_read: 0.10, cache_write: 1.25, output: 6.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' } },
	},
	'gpt-5.5': {
		supportsVision: true,
		contextWindow: 1_050_000,
		reservedOutputTokenSpace: 128_000,
		cost: { input: 5.00, output: 30.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' } },
	},
	'gpt-5.5-pro': {
		supportsVision: true,
		contextWindow: 1_050_000,
		reservedOutputTokenSpace: 128_000,
		cost: { input: 30.00, output: 180.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high', 'xhigh'], default: 'high' } },
	},
	'gpt-5.4-mini': {
		supportsVision: true,
		contextWindow: 1_050_000,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0.40, output: 1.60 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	'gpt-5.4-nano': {
		supportsVision: true,
		contextWindow: 1_050_000,
		reservedOutputTokenSpace: 16_384,
		cost: { input: 0.10, output: 0.40 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	'o3-pro': {
		supportsVision: true,
		contextWindow: 1_047_576,
		reservedOutputTokenSpace: 100_000,
		cost: { input: 20.00, output: 80.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' } },
	},
	'gpt-4.1-mini': {
		supportsVision: true,
		contextWindow: 1_047_576,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0.40, output: 1.60, cache_read: 0.10 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	'gpt-4.1-nano': {
		supportsVision: true,
		contextWindow: 1_047_576,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0.10, output: 0.40, cache_read: 0.03 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	'o1': {
		supportsVision: true,
		contextWindow: 128_000,
		reservedOutputTokenSpace: 100_000,
		cost: { input: 15.00, cache_read: 7.50, output: 60.00, },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'o3-mini': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 100_000,
		cost: { input: 1.10, cache_read: 0.55, output: 4.40, },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'gpt-4o': {
		supportsVision: true,
		contextWindow: 128_000,
		reservedOutputTokenSpace: 16_384,
		cost: { input: 2.50, cache_read: 1.25, output: 10.00, },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'o1-mini': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 65_536,
		cost: { input: 1.10, cache_read: 0.55, output: 4.40, },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: false, // does not support any system
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'gpt-4o-mini': {
		supportsVision: true,
		contextWindow: 128_000,
		reservedOutputTokenSpace: 16_384,
		cost: { input: 0.15, cache_read: 0.075, output: 0.60, },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'system-role', // ??
		reasoningCapabilities: false,
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }


// https://platform.openai.com/docs/guides/reasoning?api-mode=chat
const openAICompatIncludeInPayloadReasoning = (reasoningInfo: SendableReasoningInfo) => {
	if (!reasoningInfo?.isReasoningEnabled) return null
	if (reasoningInfo.type === 'effort_slider_value') {
		return { reasoning_effort: reasoningInfo.reasoningEffort }
	}
	return null

}

const openAISettings: VoidStaticProviderInfo = {
	modelOptions: openAIModelOptions,
	modelOptionsFallback: (modelName) => {
		const lower = modelName.toLowerCase()
		let fallbackName: keyof typeof openAIModelOptions | null = null
		if (lower.includes('o1')) { fallbackName = 'o1' }
		if (lower.includes('o3-mini')) { fallbackName = 'o3-mini' }
		if (lower.includes('gpt-4o')) { fallbackName = 'gpt-4o' }
		if (fallbackName) return { modelName: fallbackName, recognizedModelName: fallbackName, ...openAIModelOptions[fallbackName] }
		return null
	},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
}

// ---------------- XAI ----------------
const xAIModelOptions = {
	// https://docs.x.ai/docs/guides/reasoning#reasoning
	// https://docs.x.ai/docs/models#models-and-pricing
	'grok-2': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 2.00, output: 10.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	'grok-3': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	// Released 2026-07-10 (composer-data trained — strong coding value at the price).
	// BYOK raw name here; the HOSTED white-label of the same model ships as
	// "V3Code Build 4.5" through the v3code hosted lane (see V3CODE-PRICING-MODEL.md).
	'grok-4.5': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 2.00, output: 6.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' } },
	},
	'grok-4.3': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 1.25, output: 2.50 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' } },
	},
	'grok-build-0.1': {
		contextWindow: 256_000,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 1.00, output: 2.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	'grok-4.20-multi-agent-0309': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 1.25, output: 2.50 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' } },
	},
	// Grok 4.20's single-agent wire ids. The non-reasoning one is the FAST lane: same model and
	// price, thinking disabled server-side, so it answers immediately. It declares
	// reasoningCapabilities: false rather than "reasoning off by default" so no thinking payload
	// is ever sent to a model that cannot accept one.
	'grok-4.20-0309-reasoning': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 30_000,
		cost: { input: 1.25, cache_read: 0.20, output: 2.50 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' } },
	},
	'grok-4.20-0309-non-reasoning': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 30_000,
		cost: { input: 1.25, cache_read: 0.20, output: 2.50 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	'grok-3-fast': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 5.00, output: 25.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	// only mini supports thinking
	'grok-3-mini': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 0.30, output: 0.50 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'high'], default: 'low' } },
	},
	'grok-3-mini-fast': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 0.60, output: 4.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'high'], default: 'low' } },
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }

const xAISettings: VoidStaticProviderInfo = {
	modelOptions: xAIModelOptions,
	modelOptionsFallback: (modelName) => {
		const lower = modelName.toLowerCase()
		let fallbackName: keyof typeof xAIModelOptions | null = null
		if (lower.includes('grok-2')) fallbackName = 'grok-2'
		if (lower.includes('grok-3')) fallbackName = 'grok-3'
		if (lower.includes('grok')) fallbackName = 'grok-3'
		if (fallbackName) return { modelName: fallbackName, recognizedModelName: fallbackName, ...xAIModelOptions[fallbackName] }
		return null
	},
	// same implementation as openai
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		// xAI streams Grok reasoning back in `delta.reasoning_content` (OpenAI-compat reasoning
		// pattern, same shape DeepSeek and litellm use). Without this, the Grok 4.3 / 4.20
		// "thinking" never makes it into `fullReasoning` and the white thinking row + green
		// snake never appear in the chat — the user reported this regression for grok.
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}

// ---------------- GROK (PLAN) ----------------
// Subscription lane via the Grok CLI chat proxy. Logical ids here are routed to entitled
// backends by the x-grok-model-override header (grok-4.5 -> grok-4.5-build, grok-build -> grok-build).
const grokPlanModelOptions = {
	'grok-4.6': {
		supportsVision: true,
		contextWindow: 500_000,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high', 'xhigh'], default: 'high' } },
	},
	'grok-4.5': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 }, // billed to the user's subscription plan, not per-token
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' } },
	},
	'grok-build': {
		contextWindow: 256_000,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }

/** Claude (Plan) serves the SAME wire ids over the SAME Messages API as the Anthropic provider —
 *  the lane differs only in how the request authenticates. So the capability table is the
 *  Anthropic one with per-token pricing zeroed out (the turn is billed to the subscription).
 *  Reusing the table rather than copying it keeps the two lanes from drifting: a reasoning or
 *  tool-format fix for Anthropic lands here automatically. */
const claudePlanModelOptions = Object.fromEntries(
	([OPUS_HYBRID_MODEL_NAME, 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] as const)
		.map(name => [name, { ...anthropicModelOptions[name], cost: { input: 0, output: 0 } }])
) as { [s: string]: VoidStaticModelInfo }

const claudePlanSettings: VoidStaticProviderInfo = {
	...anthropicSettings,
	modelOptions: claudePlanModelOptions,
	modelOptionsFallback: (modelName) => {
		// Anthropic's own fallback resolves against the billed table, which would reintroduce
		// per-token cost on a subscription turn. Resolve here, then re-zero the cost.
		const fallback = anthropicSettings.modelOptionsFallback(modelName)
		return fallback ? { ...fallback, cost: { input: 0, output: 0 } } : null
	},
}

/** Copilot is the one subscription lane that speaks plain OpenAI `/chat/completions`, so every
 *  model here is openai-style REGARDLESS of who made it — a Claude model served through Copilot
 *  must not be sent anthropic-style tools or a `thinking` block. Capabilities are deliberately
 *  conservative for that reason: Copilot's endpoint does not expose the vendors' native reasoning
 *  controls, so reasoning is off rather than requested with parameters the gateway would reject. */
const copilotModelOptions = {
	'gpt-5.6-sol': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		cost: { input: 0, output: 0 }, // billed as Copilot premium requests, not per-token
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	'claude-sonnet-5': {
		supportsVision: true,
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 128_000,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style', // NOT anthropic-style: this hop is OpenAI-compatible
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'gpt-5.4-mini': {
		supportsVision: true,
		contextWindow: 1_050_000,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }

const copilotSettings: VoidStaticProviderInfo = {
	modelOptions: copilotModelOptions,
	modelOptionsFallback: (modelName) => {
		// Copilot's catalogue moves with the user's plan, so an unrecognized id is normal.
		// Borrow a same-family capability profile instead of dropping to the 4k unknown-model
		// profile, but preserve the selected wire id. Replacing modelName here silently routed
		// every dynamic catalogue entry onto one of the original three hard-coded models.
		const lower = modelName.toLowerCase()
		const pick = (name: keyof typeof copilotModelOptions) =>
			({ modelName, recognizedModelName: name, ...copilotModelOptions[name] })
		if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus')) return pick('claude-sonnet-5')
		if (lower.includes('mini') || lower.includes('nano') || lower.includes('haiku')) return pick('gpt-5.4-mini')
		return pick('gpt-5.6-sol')
	},
	providerReasoningIOSettings: {
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}

const grokPlanSettings: VoidStaticProviderInfo = {
	modelOptions: grokPlanModelOptions,
	modelOptionsFallback: (modelName) => {
		const lower = modelName.toLowerCase()
		if (lower.includes('build') || lower.includes('code')) return { modelName: 'grok-build', recognizedModelName: 'grok-build', ...grokPlanModelOptions['grok-build'] }
		if (lower.includes('grok')) return { modelName: 'grok-4.5', recognizedModelName: 'grok-4.5', ...grokPlanModelOptions['grok-4.5'] }
		return null
	},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}

/** Cursor (Local) speaks plain OpenAI `/chat/completions` through the "API for Cursor" app.
 *  Context windows are declared conservatively (well under the models' real limits) because
 *  the app rejects oversized bodies with a bare 413 — the editor's system prompt + 114-tool
 *  payload must be budgeted by prompt assembly BEFORE send, which only happens when the
 *  capability row reports a finite window instead of the 4k unknown-model fallback. */
const CURSOR_LOCAL_CONTEXT = 120_000
const cursorLocalModelOptions = {
	'composer-2.5': {
		supportsVision: true,
		contextWindow: CURSOR_LOCAL_CONTEXT,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 }, // Cursor subscription, not per-token
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' } },
	},
	'composer-2.5-fast': {
		supportsVision: true,
		contextWindow: CURSOR_LOCAL_CONTEXT,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	'grok-4.6': {
		supportsVision: true,
		contextWindow: CURSOR_LOCAL_CONTEXT,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' } },
	},
	'grok-4.6-fast': {
		supportsVision: true,
		contextWindow: CURSOR_LOCAL_CONTEXT,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	'grok-4.5': {
		supportsVision: true,
		contextWindow: CURSOR_LOCAL_CONTEXT,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'medium' } },
	},
	'grok-4.5-fast': {
		supportsVision: true,
		contextWindow: CURSOR_LOCAL_CONTEXT,
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }

const cursorLocalSettings: VoidStaticProviderInfo = {
	modelOptions: cursorLocalModelOptions,
	modelOptionsFallback: (modelName) => {
		// The app's catalogue tracks the user's Cursor entitlements, so an unrecognized id is
		// normal — borrow a same-family profile (preserving the selected wire id) instead of
		// the 4k unknown-model fallback that caused the 413s.
		const lower = modelName.toLowerCase()
		const pick = (name: keyof typeof cursorLocalModelOptions) =>
			({ modelName, recognizedModelName: name, ...cursorLocalModelOptions[name] })
		if (lower.includes('composer')) return pick(lower.includes('fast') ? 'composer-2.5-fast' : 'composer-2.5')
		if (lower.includes('grok')) return pick(lower.includes('fast') ? 'grok-4.6-fast' : 'grok-4.6')
		return pick('composer-2.5')
	},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}

/**
 * ChatGPT Plus/Pro via Codex. Same openai-style tools as the BYOK OpenAI lane, cost zeroed.
 *
 * THE ID LIST IS NOT A FREE CHOICE. The Codex endpoint answers
 * `400 {"detail":"The '<id>' model is not supported when using Codex with a ChatGPT account."}`
 * for anything the signed-in plan is not entitled to, and that entitlement is much narrower than
 * the public platform API. Every id below was probed against the live endpoint on 2026-09-12 with
 * a ChatGPT **Pro** account, and each returned HTTP 200 with a real `function_call` item.
 *
 * Deliberately ABSENT — every one of these was rejected on that same Pro account: `gpt-5.4`,
 * `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro`, `gpt-5.5-pro`, `gpt-5.3-codex`, `gpt-5.2-codex`,
 * `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5-codex`, `gpt-5`. An id being valid on the platform
 * API says NOTHING about whether this lane may use it, and that exact mismatch — a `gpt-5.4`
 * default — is why this lane read as broken. Do not "correct" these back toward the platform list
 * without re-probing the endpoint.
 *
 * `supportsSystemMessage: 'developer-role'` is inherited from `openAIModelOptions` and is
 * MANDATORY, not cosmetic: the Codex endpoint rejects a `system` message outright with
 * `400 {"detail":"System messages are not allowed"}` and accepts only `developer`.
 */
const openaiPlanModelOptions = {
	'gpt-6-astra': { ...openAIModelOptions['gpt-5.6-sol'], contextWindow: 1_050_000, cost: { input: 0, output: 0 } },
	'gpt-5.6-sol': { ...openAIModelOptions['gpt-5.6-sol'], cost: { input: 0, output: 0 } },
	'gpt-5.6-terra': { ...openAIModelOptions['gpt-5.6-terra'], cost: { input: 0, output: 0 } },
	'gpt-5.6-luna': { ...openAIModelOptions['gpt-5.6-luna'], cost: { input: 0, output: 0 } },
	'gpt-5.5': { ...openAIModelOptions['gpt-5.5'], cost: { input: 0, output: 0 } },
	'gpt-5.3-codex-spark': { ...openAIModelOptions['gpt-5.4-mini'], cost: { input: 0, output: 0 } },
} as const satisfies { [s: string]: VoidStaticModelInfo }

const openaiPlanSettings: VoidStaticProviderInfo = {
	modelOptions: openaiPlanModelOptions,
	// A saved selection can name an id this build has no record for — an older configuration, or a
	// model the plan has since lost entitlement to. Fall back to a verified sibling so the request
	// is still shaped correctly (tools, roles, reasoning); whether the plan may USE the id is the
	// endpoint's decision, and it says so plainly rather than silently substituting.
	modelOptionsFallback: (modelName) => {
		const lower = modelName.toLowerCase()
		const pick = (name: keyof typeof openaiPlanModelOptions) =>
			({ modelName, recognizedModelName: name, ...openaiPlanModelOptions[name] })
		if (lower.includes('spark') || lower.includes('codex') || lower.includes('mini')) return pick('gpt-5.3-codex-spark')
		if (lower.includes('astra')) return pick('gpt-6-astra')
		if (lower.includes('luna')) return pick('gpt-5.6-luna')
		if (lower.includes('terra')) return pick('gpt-5.6-terra')
		if (lower.includes('sol')) return pick('gpt-5.6-sol')
		return pick('gpt-5.5')
	},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}


// ---------------- GEMINI ----------------
const geminiModelOptions = { // https://ai.google.dev/gemini-api/docs/pricing
	'gemini-3.5-flash': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 65_536,
		cost: { input: 1.50, output: 9.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, reasoningReservedOutputTokenSpace: 8192 },
	},
	'gemini-3.1-pro-preview': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 65_536,
		cost: { input: 2.00, output: 12.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 2048 }, reasoningReservedOutputTokenSpace: 8192 },
	},
	'gemini-2.5-pro': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 1.25, output: 10 }, // was unpriced (0/0) — real Gemini 2.5 Pro GA pricing
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, reasoningReservedOutputTokenSpace: 8192 },
	},
	'gemini-2.5-flash': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.15, output: 0.60 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, reasoningReservedOutputTokenSpace: 8192 },
	},
	'gemini-2.5-pro-preview-05-06': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: false,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // max is really 24576
			reasoningReservedOutputTokenSpace: 8192,
		},
	},
	'gemini-2.0-flash-lite': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false, // no reasoning
	},
	'gemini-2.5-flash-preview-04-17': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.15, output: .60 }, // TODO $3.50 output with thinking not included
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: false,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // max is really 24576
			reasoningReservedOutputTokenSpace: 8192,
		},
	},
	'gemini-2.5-pro-exp-03-25': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: false,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // max is really 24576
			reasoningReservedOutputTokenSpace: 8192,
		},
	},
	'gemini-2.0-flash': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192, // 8_192,
		cost: { input: 0.10, output: 0.40 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
	'gemini-2.0-flash-lite-preview-02-05': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192, // 8_192,
		cost: { input: 0.075, output: 0.30 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
	'gemini-1.5-flash': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192, // 8_192,
		cost: { input: 0.075, output: 0.30 },  // TODO!!! price doubles after 128K tokens, we are NOT encoding that info right now
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
	'gemini-1.5-pro': {
		supportsVision: true,
		contextWindow: 2_097_152,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 1.25, output: 5.00 },  // TODO!!! price doubles after 128K tokens, we are NOT encoding that info right now
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
	'gemini-1.5-flash-8b': {
		supportsVision: true,
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.0375, output: 0.15 },  // TODO!!! price doubles after 128K tokens, we are NOT encoding that info right now
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }

const geminiSettings: VoidStaticProviderInfo = {
	modelOptions: geminiModelOptions,
	modelOptionsFallback: (modelName) => { return null },
}

/** Gemini (Plan) serves the same models over the Code Assist surface, billed to the user's Google
 *  plan rather than per token. Capabilities are the public table with cost zeroed; the transport
 *  differs (wrapped envelope), not the models. */
const geminiPlanModelOptions = Object.fromEntries(
	Object.entries(geminiModelOptions).map(([name, opts]) => [name, { ...opts, cost: { input: 0, output: 0 } }])
) as { [s: string]: VoidStaticModelInfo }

const geminiPlanSettings: VoidStaticProviderInfo = {
	modelOptions: geminiPlanModelOptions,
	modelOptionsFallback: (modelName) => { return null },
}



// ---------------- DEEPSEEK API ----------------
const deepseekV4FlashTextOptions = {
	contextWindow: 1_000_000,
	reservedOutputTokenSpace: 384_000,
	cost: { cache_read: 0.0028, input: 0.14, output: 0.28 },
	downloadable: false,
	supportsFIM: true,
	supportsSystemMessage: 'system-role',
	specialToolFormat: 'openai-style',
	reasoningCapabilities: {
		supportsReasoning: true,
		canTurnOffReasoning: true,
		canIOReasoning: true,
		openSourceThinkTags: ['<think>', '</think>'] as [string, string],
	},
} as const satisfies VoidStaticModelInfo

// https://api-docs.deepseek.com/updates/#deepseek-v41-flash-release (2026-09-10).
// Peak rates are an upper-bound estimate; the existing meter has no time-of-day pricing.
const deepseekFlashVisionOptions = {
	...deepseekV4FlashTextOptions,
	supportsVision: true,
	cost: { cache_read: 0.006, input: 0.30, output: 1.20 },
} as const satisfies VoidStaticModelInfo

const deepseekModelOptions = {
	'deepseek-flash': deepseekFlashVisionOptions,
	'deepseek-v4-flash-vision-exp': deepseekFlashVisionOptions,
	'deepseek-v4-pro': {
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 384_000,
		cost: { cache_read: 0.003625, input: 0.435, output: 0.87 },
		downloadable: false,
		// FIM via https://api.deepseek.com/beta + /completions (non-thinking). Documented model id.
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			openSourceThinkTags: ['<think>', '</think>'] as [string, string],
		},
	},
	// The direct API routes this legacy name to V4.1 Flash; do not rewrite the wire ID.
	'deepseek-v4-flash': deepseekFlashVisionOptions,
	'deepseek-chat': { // deprecated -- routes to deepseek-v4-flash non-thinking. Remove after July 24, 2026.
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 384_000,
		cost: { cache_read: 0.0028, input: 0.14, output: 0.28 },
		downloadable: false,
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	'deepseek-reasoner': { // deprecated -- routes to deepseek-v4-flash thinking. Remove after July 24, 2026.
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 384_000,
		cost: { cache_read: 0.0028, input: 0.14, output: 0.28 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: false,
			canIOReasoning: true,
			openSourceThinkTags: ['<think>', '</think>'] as [string, string],
		},
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }


const deepseekSettings: VoidStaticProviderInfo = {
	modelOptions: deepseekModelOptions,
	modelOptionsFallback: extensiveModelOptionsFallback,
	providerReasoningIOSettings: {
		// reasoning: OAICompat +  response.choices[0].delta.reasoning_content // https://api-docs.deepseek.com/guides/reasoning_model
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}



// ---------------- MISTRAL ----------------

const mistralModelOptions = { // https://mistral.ai/products/la-plateforme#pricing https://docs.mistral.ai/getting-started/models/models_overview/#premier-models
	'mistral-large-latest': {
		contextWindow: 131_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 2.00, output: 6.00 },
		supportsFIM: false,
		downloadable: { sizeGb: 73 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'mistral-medium-latest': { // https://openrouter.ai/mistralai/mistral-medium-3
		contextWindow: 131_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.40, output: 2.00 },
		supportsFIM: false,
		downloadable: { sizeGb: 'not-known' },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'codestral-latest': {
		contextWindow: 256_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.30, output: 0.90 },
		supportsFIM: true,
		downloadable: { sizeGb: 13 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'magistral-medium-latest': {
		contextWindow: 256_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.30, output: 0.90 }, // TODO: check this
		supportsFIM: true,
		downloadable: { sizeGb: 13 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] },
	},
	'magistral-small-latest': {
		contextWindow: 40_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.30, output: 0.90 }, // TODO: check this
		supportsFIM: true,
		downloadable: { sizeGb: 13 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] },
	},
	'devstral-small-latest': { //https://openrouter.ai/mistralai/devstral-small:free
		contextWindow: 131_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		supportsFIM: false,
		downloadable: { sizeGb: 14 }, //https://ollama.com/library/devstral
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'ministral-8b-latest': { // ollama 'mistral'
		contextWindow: 131_000,
		reservedOutputTokenSpace: 4_096,
		cost: { input: 0.10, output: 0.10 },
		supportsFIM: false,
		downloadable: { sizeGb: 4.1 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'ministral-3b-latest': {
		contextWindow: 131_000,
		reservedOutputTokenSpace: 4_096,
		cost: { input: 0.04, output: 0.04 },
		supportsFIM: false,
		downloadable: { sizeGb: 'not-known' },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }

const mistralSettings: VoidStaticProviderInfo = {
	modelOptions: mistralModelOptions,
	modelOptionsFallback: (modelName) => { return null },
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
}


// ---------------- GROQ ----------------
const groqModelOptions = { // https://console.groq.com/docs/models, https://groq.com/pricing/
	'llama-3.3-70b-versatile': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 32_768, // 32_768,
		cost: { input: 0.59, output: 0.79 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'llama-3.1-8b-instant': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.05, output: 0.08 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'qwen-2.5-coder-32b': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null, // not specified?
		cost: { input: 0.79, output: 0.79 },
		downloadable: false,
		supportsFIM: false, // unfortunately looks like no FIM support on groq
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'qwen-qwq-32b': { // https://huggingface.co/Qwen/QwQ-32B
		contextWindow: 128_000,
		reservedOutputTokenSpace: null, // not specified?
		cost: { input: 0.29, output: 0.39 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] }, // we're using reasoning_format:parsed so really don't need to know openSourceThinkTags
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }
const groqSettings: VoidStaticProviderInfo = {
	modelOptions: groqModelOptions,
	modelOptionsFallback: (modelName) => { return null },
	providerReasoningIOSettings: {
		// Must be set to either parsed or hidden when using tool calling https://console.groq.com/docs/reasoning
		input: {
			includeInPayload: (reasoningInfo) => {
				if (!reasoningInfo?.isReasoningEnabled) return null
				if (reasoningInfo.type === 'budget_slider_value') {
					return { reasoning_format: 'parsed' }
				}
				return null
			}
		},
		output: { nameOfFieldInDelta: 'reasoning' },
	},
}


// ---------------- GOOGLE VERTEX ----------------
const googleVertexModelOptions = {
} as const satisfies Record<string, VoidStaticModelInfo>
const googleVertexSettings: VoidStaticProviderInfo = {
	modelOptions: googleVertexModelOptions,
	modelOptionsFallback: (modelName) => { return null },
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
}

// ---------------- MICROSOFT AZURE ----------------
const microsoftAzureModelOptions = {
} as const satisfies Record<string, VoidStaticModelInfo>
const microsoftAzureSettings: VoidStaticProviderInfo = {
	modelOptions: microsoftAzureModelOptions,
	modelOptionsFallback: (modelName) => { return null },
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
}

// ---------------- AWS BEDROCK ----------------
const awsBedrockModelOptions = {
} as const satisfies Record<string, VoidStaticModelInfo>

const awsBedrockSettings: VoidStaticProviderInfo = {
	modelOptions: awsBedrockModelOptions,
	modelOptionsFallback: (modelName) => { return null },
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
}


// ---------------- VLLM, OLLAMA, OPENAICOMPAT (self-hosted / local) ----------------
const ollamaModelOptions = {
	'qwen2.5-coder:7b': {
		contextWindow: 32_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 1.9 },
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'qwen2.5-coder:3b': {
		contextWindow: 32_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 1.9 },
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'qwen2.5-coder:1.5b': {
		contextWindow: 32_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: .986 },
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'nate/instinct': { // Continue.dev Instinct — open NES model (Qwen2.5-Coder-7B fine-tune, Apache-2.0). Tagged names (nate/instinct:latest) resolve via the 'instinct' fallback.
		contextWindow: 32_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 4.7 },
		supportsFIM: false,
		supportsNextEdit: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'llama3.1': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 4.9 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'qwen2.5-coder': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 4.7 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'qwq': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 32_000,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 20 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: false, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] },
	},
	'deepseek-r1': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 4.7 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: false, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] },
	},
	'devstral:latest': {
		contextWindow: 131_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 14 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},

} as const satisfies Record<string, VoidStaticModelInfo>

export const ollamaRecommendedModels = ['qwen2.5-coder:1.5b', 'llama3.1', 'qwq', 'deepseek-r1', 'devstral:latest'] as const satisfies (keyof typeof ollamaModelOptions)[]


const vLLMSettings: VoidStaticProviderInfo = {
	modelOptionsFallback: (modelName) => extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' } }),
	modelOptions: {},
	providerReasoningIOSettings: {
		// reasoning: OAICompat + response.choices[0].delta.reasoning_content // https://docs.vllm.ai/en/stable/features/reasoning_outputs.html#streaming-chat-completions
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}

const lmStudioSettings: VoidStaticProviderInfo = {
	modelOptionsFallback: (modelName) => extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' }, contextWindow: 4_096 }),
	modelOptions: {},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { needsManualParse: true },
	},
}

const ollamaSettings: VoidStaticProviderInfo = {
	modelOptionsFallback: (modelName) => extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' } }),
	modelOptions: ollamaModelOptions,
	providerReasoningIOSettings: {
		// reasoning: we need to filter out reasoning <think> tags manually
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { needsManualParse: true },
	},
}

const openaiCompatible: VoidStaticProviderInfo = {
	modelOptionsFallback: (modelName) => extensiveModelOptionsFallback(modelName),
	modelOptions: {},
	providerReasoningIOSettings: {
		// reasoning: we have no idea what endpoint they used, so we can't consistently parse out reasoning
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}

const liteLLMSettings: VoidStaticProviderInfo = { // https://docs.litellm.ai/docs/reasoning_content
	modelOptionsFallback: (modelName) => extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' } }),
	modelOptions: {},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}


// ---------------- OPENROUTER ----------------
const openRouterModelOptions_assumingOpenAICompat = {
	'deepseek/deepseek-v4-pro': {
		specialToolFormat: 'openai-style',
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 384_000,
		cost: { input: 2.19, output: 8.76 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: true },
	},
	'deepseek/deepseek-v4-flash': {
		specialToolFormat: 'openai-style',
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 384_000,
		cost: { input: 0.10, output: 0.39 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: true },
	},
	'qwen/qwen3-235b-a22b': {
		specialToolFormat: 'openai-style',
		contextWindow: 40_960,
		reservedOutputTokenSpace: null,
		cost: { input: .10, output: .10 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false },
	},
	'microsoft/phi-4-reasoning-plus:free': { // a 14B model...
		contextWindow: 32_768,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false },
	},
	'mistralai/mistral-small-3.1-24b-instruct:free': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'google/gemini-2.0-flash-lite-preview-02-05:free': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'google/gemini-2.0-pro-exp-02-05:free': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'google/gemini-2.0-flash-exp:free': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'deepseek/deepseek-r1': {
		...openSourceModelOptions_assumingOAICompat.deepseekR1,
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0.8, output: 2.4 },
		downloadable: false,
	},
	'anthropic/claude-opus-4': {
		specialToolFormat: 'openai-style',
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 15.00, output: 75.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'anthropic/claude-sonnet-4': {
		specialToolFormat: 'openai-style',
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'anthropic/claude-3.7-sonnet:thinking': {
		specialToolFormat: 'openai-style',
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { // same as anthropic, see above
			supportsReasoning: true,
			canTurnOffReasoning: false,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // they recommend batching if max > 32_000.
		},
	},
	'anthropic/claude-3.7-sonnet': {
		specialToolFormat: 'openai-style',
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false, // stupidly, openrouter separates thinking from non-thinking
	},
	'anthropic/claude-3.5-sonnet': {
		specialToolFormat: 'openai-style',
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'mistralai/codestral-2501': {
		...openSourceModelOptions_assumingOAICompat.codestral,
		contextWindow: 256_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0.3, output: 0.9 },
		downloadable: false,
		reasoningCapabilities: false,
	},
	'mistralai/devstral-small:free': {
		...openSourceModelOptions_assumingOAICompat.devstral,
		specialToolFormat: 'openai-style',
		contextWindow: 130_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		reasoningCapabilities: false,
	},
	'qwen/qwen-2.5-coder-32b-instruct': {
		...openSourceModelOptions_assumingOAICompat['qwen2.5coder'],
		contextWindow: 33_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0.07, output: 0.16 },
		downloadable: false,
	},
	'qwen/qwq-32b': {
		...openSourceModelOptions_assumingOAICompat['qwq'],
		contextWindow: 131_072, // QwQ-32B is 128K (was mistakenly 33k)
		reservedOutputTokenSpace: null,
		cost: { input: 0.07, output: 0.16 },
		downloadable: false,
	}
} as const satisfies { [s: string]: VoidStaticModelInfo }

const openRouterSettings: VoidStaticProviderInfo = {
	modelOptions: openRouterModelOptions_assumingOpenAICompat,
	modelOptionsFallback: (modelName) => {
		const res = extensiveModelOptionsFallback(modelName)
		// Routed models use the gateway wire format, not the upstream provider format.
		if (res?.specialToolFormat) {
			return { ...res, specialToolFormat: 'openai-style' }
		}
		return res
	},
	providerReasoningIOSettings: {
		// reasoning: OAICompat + response.choices[0].delta.reasoning : payload should have {include_reasoning: true} https://openrouter.ai/announcements/reasoning-tokens-for-thinking-models
		input: {
			// https://openrouter.ai/docs/use-cases/reasoning-tokens
			includeInPayload: (reasoningInfo) => {
				if (!reasoningInfo?.isReasoningEnabled) return null

				if (reasoningInfo.type === 'budget_slider_value') {
					return {
						reasoning: {
							max_tokens: reasoningInfo.reasoningBudget
						}
					}
				}
				if (reasoningInfo.type === 'effort_slider_value')
					return {
						reasoning: {
							effort: reasoningInfo.reasoningEffort
						}
					}
				return null
			}
		},
		output: { nameOfFieldInDelta: 'reasoning' },
	},
}




// Built-in local inference (node-llama-cpp). Free + FIM-capable + downloadable (the
// `downloadable` field drives the one-click download button in settings).
const v3codeLocalModelOptions = {
	'qwen2.5-coder-1.5b': {
		contextWindow: 32_000,
		reservedOutputTokenSpace: 2_048,
		supportsSystemMessage: 'system-role',
		supportsFIM: true,
		reasoningCapabilities: false,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 1 },
	},
	'qwen2.5-coder-0.5b': {
		contextWindow: 32_000,
		reservedOutputTokenSpace: 2_048,
		supportsSystemMessage: 'system-role',
		supportsFIM: true,
		reasoningCapabilities: false,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 0.4 },
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }

const v3codeLocalSettings: VoidStaticProviderInfo = {
	modelOptions: v3codeLocalModelOptions,
	modelOptionsFallback: (modelName) => ({
		modelName,
		recognizedModelName: 'qwen2.5-coder-1.5b',
		contextWindow: 32_000,
		reservedOutputTokenSpace: 2_048,
		supportsSystemMessage: 'system-role',
		supportsFIM: true,
		reasoningCapabilities: false,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 'not-known' },
	}),
}

// Free lane (OpenCode Zen public gateway, key "public"). Context/output limits below are the
// published values from the models.dev registry that Zen itself publishes, not estimates.
// Output space is capped at 64k even where the model allows more: reservedOutputTokenSpace is
// subtracted from the usable context window, so reserving the full 128k would shrink the
// prompt for no benefit. Every one of these is a reasoning model that ALWAYS thinks (there is
// no off switch on the gateway), and none accepts an effort slider, so no slider is declared.
const v3codeFreeModelOptions = {
	// The rotating pick. Limits are the CONSERVATIVE values across the rotation (the smallest
	// context and output space any candidate offers) so a prompt built for this id fits whichever
	// backend ends up serving it. Vision is advertised because an image turn is routed to the one
	// candidate that accepts images.
	'free-auto': {
		contextWindow: 190_000,
		reservedOutputTokenSpace: 32_000,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		supportsFIM: false,
		supportsVision: true,
		cost: { input: 0, output: 0 },
		downloadable: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true },
	},
	'nemotron-3.5-lightning-free': {
		contextWindow: 262_144,
		reservedOutputTokenSpace: 64_000,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		supportsFIM: false,
		cost: { input: 0, output: 0, cache_read: 0 },
		downloadable: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true },
	},
	'ling-3.0-flash-fin-free': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 32_000,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		supportsFIM: false,
		cost: { input: 0, output: 0, cache_read: 0 },
		downloadable: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true },
	},
	// Zen's stealth free model. Its id carries NO `-free` suffix, which is why the lane's
	// membership test is isV3CodeFreeModelId() rather than a bare endsWith('-free').
	'big-pickle': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 32_000,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		supportsFIM: false,
		cost: { input: 0, output: 0, cache_read: 0 },
		downloadable: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true },
	},
	// Re-verified 2026-09-12: answers with a real tool call again, so it is back in the rotation.
	// (It was pulled 2026-09-04 over upstream NVIDIA capacity 502s.) The record is kept whether or
	// not it is rotating, so a user who already picked it never drops to the fallback.
	'nemotron-3-ultra-free': {
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 64_000,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		supportsFIM: false,
		cost: { input: 0, output: 0, cache_read: 0 },
		downloadable: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true },
	},
	'mimo-v2.5-free': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 32_000,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		supportsFIM: false,
		supportsVision: true,
		cost: { input: 0, output: 0, cache_read: 0 },
		downloadable: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true },
	},
	// The `muse-spark-*-contributor-free` pair speak the OpenAI RESPONSES protocol, not Chat
	// Completions. They are ordinary rotation members rather than a separate lane because the free
	// transport dispatches on the resolved route's `protocol` (see _sendV3CodeFreeChat).
	//
	// "Contributor" is literal: Meta grants free access in exchange for permission to train on the
	// prompts and completions. The provider description states that plainly, and Zen flags the same
	// condition — do not quietly drop that disclosure when editing these entries.
	//
	// `supportsVision: true` is real, not aspirational: both accept image input and
	// copilotResponsesInput() already maps `image_url` parts onto Responses `input_image` items.
	'muse-spark-1.3-contributor-free': {
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 64_000,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		supportsFIM: false,
		supportsVision: true,
		cost: { input: 0, output: 0, cache_read: 0 },
		downloadable: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true },
	},
	'muse-spark-1.2-contributor-free': {
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 64_000,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		supportsFIM: false,
		supportsVision: true,
		cost: { input: 0, output: 0, cache_read: 0 },
		downloadable: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true },
	},
} as const satisfies { [s: string]: VoidStaticModelInfo }

const v3codeFreeSettings: VoidStaticProviderInfo = {
	modelOptions: v3codeFreeModelOptions,
	// Only `-free` ids are ever routed here (the paid Zen catalogue would silently bill the
	// gateway owner), so an unknown name falls back to the conservative default rather than
	// being passed through.
	modelOptionsFallback: (modelName) => {
		if (!isV3CodeFreeModelId(modelName)) { return null }
		return { modelName, recognizedModelName: 'nemotron-3.5-lightning-free', ...v3codeFreeModelOptions['nemotron-3.5-lightning-free'] }
	},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		// Zen fronts several vendors: DeepSeek-family models stream thinking in
		// `reasoning_content`, the OpenRouter-backed ones use `reasoning`. The stream reader
		// falls back to the other spelling when the configured field is empty.
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
}

// ---------------- model settings of everything above ----------------

const modelSettingsOfProvider: { [providerName in ProviderName]: VoidStaticProviderInfo } = {
	'v3code-free': v3codeFreeSettings,
	'v3code-local': v3codeLocalSettings,
	openAI: openAISettings,
	anthropic: anthropicSettings,
	xAI: xAISettings,
	grokPlan: grokPlanSettings,
	claudePlan: claudePlanSettings,
	copilot: copilotSettings,
	geminiPlan: geminiPlanSettings,
	cursorLocal: cursorLocalSettings,
	openaiPlan: openaiPlanSettings,
	gemini: geminiSettings,

	// open source models
	deepseek: deepseekSettings,
	groq: groqSettings,

	// open source models + providers (mixture of everything)
	openRouter: openRouterSettings,
	vLLM: vLLMSettings,
	ollama: ollamaSettings,
	openAICompatible: openaiCompatible,
	openAICompatible2: openaiCompatible,
	openAICompatible3: openaiCompatible,
	mistral: mistralSettings,

	liteLLM: liteLLMSettings,
	lmStudio: lmStudioSettings,

	googleVertex: googleVertexSettings,
	microsoftAzure: microsoftAzureSettings,
	awsBedrock: awsBedrockSettings,
} as const


// ---------------- exports ----------------

/** Chat for these providers goes through `_sendOpenAICompatibleChat` (OpenAI SDK + /v1). */
	const openAICompatChatProviders = new Set<ProviderName>(['ollama', 'vLLM', 'lmStudio', 'openAICompatible', 'openAICompatible2', 'openAICompatible3', 'liteLLM', 'cursorLocal']);

const withOpenAICompatToolDefaults = <T extends VoidStaticModelInfo & { modelName: string }>(
	providerName: ProviderName,
	caps: T,
): T => {
	if (!caps.specialToolFormat && openAICompatChatProviders.has(providerName)) {
		return { ...caps, specialToolFormat: 'openai-style' };
	}
	return caps;
};

// returns the capabilities and the adjusted modelName if it was a fallback
export const getModelCapabilities = (
	providerName: ProviderName,
	modelName: string,
	overridesOfModel: OverridesOfModel | undefined
): VoidStaticModelInfo & (
	| { modelName: string; recognizedModelName: string; isUnrecognizedModel: false }
	| { modelName: string; recognizedModelName?: undefined; isUnrecognizedModel: true }
) => {

	const lowercaseModelName = modelName.toLowerCase()

	const { modelOptions, modelOptionsFallback } = modelSettingsOfProvider[providerName]

	// Get any override settings for this model
	const storedOverrides = overridesOfModel?.[providerName]?.[modelName];
	const overrides = storedOverrides && { ...storedOverrides._discoveredCapabilities, ...storedOverrides };
	if (overrides) {
		if (storedOverrides?._discoveredCapabilities?.supportsTools === false && !storedOverrides.specialToolFormat) {
			overrides.specialToolFormat = undefined;
		}
		delete overrides._discoveredCapabilities;
		delete overrides.supportsTools;
	}
	// Settings are persisted JSON: strings such as "false" must never enable image upload.
	if (overrides && typeof overrides.supportsVision !== 'boolean') {
		delete overrides.supportsVision;
	}

	// search model options object directly first
	for (const modelName_ in modelOptions) {
		const lowercaseModelName_ = modelName_.toLowerCase()
		if (lowercaseModelName === lowercaseModelName_) {
			// Read the capability row with the TABLE key (modelName_), not the user's casing
			// (modelName). If the user typed different casing, modelOptions[modelName] is
			// undefined and spread nothing — returning an EMPTY capability object marked as
			// recognized, so the model looked known but had no real capabilities.
			return withOpenAICompatToolDefaults(providerName, { ...modelOptions[modelName_], ...overrides, modelName, recognizedModelName: modelName_, isUnrecognizedModel: false });
		}
	}

	const result = modelOptionsFallback(modelName)
	if (result) {
		return withOpenAICompatToolDefaults(providerName, { ...result, ...overrides, modelName: result.modelName, isUnrecognizedModel: false });
	}

	return withOpenAICompatToolDefaults(providerName, { modelName, ...defaultModelOptions, ...overrides, isUnrecognizedModel: true });
}

// non-model settings
export const getProviderCapabilities = (providerName: ProviderName) => {
	const { providerReasoningIOSettings } = modelSettingsOfProvider[providerName]
	return { providerReasoningIOSettings }
}


export type SendableReasoningInfo = {
	type: 'budget_slider_value',
	isReasoningEnabled: true,
	reasoningBudget: number,
} | {
	type: 'effort_slider_value',
	isReasoningEnabled: true,
	reasoningEffort: string,
} | {
	// Reasoning is OFF on a model where omitting the thinking field would NOT turn it off
	// (`omittedThinkingRunsAdaptive`) — the provider payload must disable it explicitly.
	// Every includeInPayload guards `!reasoningInfo?.isReasoningEnabled`, so providers that
	// don't know this variant treat it exactly like the plain-null "off" and send nothing.
	type: 'disabled',
	isReasoningEnabled: false,
} | null



export const getIsReasoningEnabledState = (
	featureName: FeatureName,
	providerName: ProviderName,
	modelName: string,
	modelSelectionOptions: ModelSelectionOptions | undefined,
	overridesOfModel: OverridesOfModel | undefined,
) => {
	const { supportsReasoning, canTurnOffReasoning } = getModelCapabilities(providerName, modelName, overridesOfModel).reasoningCapabilities || {}
	if (!supportsReasoning) return false

	// Cloud Chat keeps thinking as the quality-first default. Local hybrid-thinking models are the
	// latency-sensitive exception: on consumer hardware a short Qwen tool call can spend minutes in
	// a hidden reasoning trace. Default those models to direct/tool mode while preserving the native
	// model-picker switch for users running larger local models who want thinking on.
	if (featureName === 'Chat') {
		const isLocalProvider = providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio'
		if (isLocalProvider && canTurnOffReasoning) {
			return modelSelectionOptions?.reasoningEnabled ?? false
		}
		return true
	}

	// Non-Chat features (apply / autocomplete / etc.) keep the model default: on when the model can't
	// turn reasoning off, otherwise the persisted/model default. These never surface thinking to the
	// user, so they stay fast.
	const defaultEnabledVal = !canTurnOffReasoning
	return modelSelectionOptions?.reasoningEnabled ?? defaultEnabledVal
}


export const getReservedOutputTokenSpace = (providerName: ProviderName, modelName: string, opts: { isReasoningEnabled: boolean, overridesOfModel: OverridesOfModel | undefined }) => {
	const {
		reasoningCapabilities,
		reservedOutputTokenSpace,
	} = getModelCapabilities(providerName, modelName, opts.overridesOfModel)
	if (!opts.isReasoningEnabled || !reasoningCapabilities) { return reservedOutputTokenSpace }

	// Turning thinking ON must never SHRINK the output budget. Thinking tokens are additive to
	// the reply -- they come out of the same max_tokens -- so the reasoning reserve has to be at
	// least the normal one.
	//
	// Every Claude entry still carries reasoningReservedOutputTokenSpace: 8192, which was the
	// real ceiling in the Claude 3.5/3.7 era. The Claude 5 family reserves 128_000 without
	// thinking, but thinking is hard-wired on, so this function returned 8192 and that is the
	// max_tokens actually sent. Thinking, visible text and the tool-call JSON then shared 8k
	// tokens: a rewrite_file bigger than a few thousand tokens got cut off mid-JSON, the SDK
	// yielded `input: {}`, and the write silently vanished (0-byte file, model told nothing).
	// That is why models learned to chunk every large write.
	const reasoningReserve = reasoningCapabilities.reasoningReservedOutputTokenSpace
	if (reasoningReserve === undefined || reasoningReserve === null) { return reservedOutputTokenSpace }
	if (reservedOutputTokenSpace === null) { return reasoningReserve }
	return Math.max(reasoningReserve, reservedOutputTokenSpace)
}

// used to force reasoning state (complex) into something simple we can just read from when sending a message
export const getSendableReasoningInfo = (
	featureName: FeatureName,
	providerName: ProviderName,
	modelName: string,
	modelSelectionOptions: ModelSelectionOptions | undefined,
	overridesOfModel: OverridesOfModel | undefined,
): SendableReasoningInfo => {

	const { reasoningSlider: reasoningBudgetSlider, omittedThinkingRunsAdaptive } = getModelCapabilities(providerName, modelName, overridesOfModel).reasoningCapabilities || {}
	const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel)
	if (!isReasoningEnabled) {
		// "Off by omission" doesn't exist on adaptive-by-default models — they need the payload
		// to say disabled explicitly, so surface the off state instead of collapsing it to null.
		if (omittedThinkingRunsAdaptive) return { type: 'disabled', isReasoningEnabled: false }
		return null
	}

	// check for reasoning budget
	const reasoningBudget = reasoningBudgetSlider?.type === 'budget_slider' ? modelSelectionOptions?.reasoningBudget ?? reasoningBudgetSlider?.default : undefined
	if (reasoningBudget) {
		return { type: 'budget_slider_value', isReasoningEnabled: isReasoningEnabled, reasoningBudget: reasoningBudget }
	}

	// check for reasoning effort
	const reasoningEffort = reasoningBudgetSlider?.type === 'effort_slider' ? modelSelectionOptions?.reasoningEffort ?? reasoningBudgetSlider?.default : undefined
	if (reasoningEffort) {
		return { type: 'effort_slider_value', isReasoningEnabled: isReasoningEnabled, reasoningEffort: reasoningEffort }
	}

	return null
}
