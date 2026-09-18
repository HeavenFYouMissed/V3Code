
/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { defaultModelsOfProvider, defaultProviderSettings, ModelOverrides } from './modelCapabilities.js';
import { ToolApprovalType } from './toolsServiceTypes.js';
import type { VoidSettingsState } from './voidSettingsService.js'


type UnionOfKeys<T> = T extends T ? keyof T : never;



export type ProviderName = keyof typeof defaultProviderSettings
export const providerNames = Object.keys(defaultProviderSettings) as ProviderName[]

// Lanes that must stay fail-closed: hidden from the picker, and refused by the send path before it
// reads credentials or makes a network request. Retired lanes keep their saved settings for
// history compatibility, but are no longer offered or contacted. The API-key lane stays available.
//
// `openaiPlan` was the last entry. It was re-enabled on 2026-09-12 once the actual cause of its
// 400s was measured: the lane shipped model ids Codex does not serve to a ChatGPT account
// (`gpt-5.4`), which is a one-line data fix, not the prompt-validation problem originally assumed.
export const temporarilyDisabledProviderNames: readonly ProviderName[] = ['geminiPlan']
export const isProviderTemporarilyDisabled = (providerName: ProviderName): boolean =>
	(temporarilyDisabledProviderNames as readonly string[]).includes(providerName)

export const localProviderNames = ['ollama', 'vLLM', 'lmStudio'] satisfies ProviderName[] // all local names
export const nonlocalProviderNames = providerNames.filter((name) =>
	!(localProviderNames as string[]).includes(name) && !isProviderTemporarilyDisabled(name)
) // all enabled non-local names

/** Cloud providers with a list-models API — refreshable from Settings. (Most are
 * OpenAI-compatible GET /v1/models; anthropic uses its own SDK list.) */
export const apiRefreshableProviderNames = ['openAI', 'anthropic', 'deepseek', 'xAI', 'openRouter', 'groq', 'copilot', 'v3code-free'] as const satisfies readonly ProviderName[]
export type ApiRefreshableProviderName = typeof apiRefreshableProviderNames[number]

type CustomSettingName = UnionOfKeys<typeof defaultProviderSettings[ProviderName]>
type CustomProviderSettings<providerName extends ProviderName> = {
	[k in CustomSettingName]: k extends keyof typeof defaultProviderSettings[providerName] ? string : undefined
}
export const customSettingNamesOfProvider = (providerName: ProviderName) => {
	return Object.keys(defaultProviderSettings[providerName]) as CustomSettingName[]
}



export type VoidStatefulModelInfo = { // <-- STATEFUL
	modelName: string,
	type: 'default' | 'autodetected' | 'custom';
	isHidden: boolean, // whether or not the user is hiding it (switched off)
}



type CommonProviderSettings = {
	_didFillInProviderSettings: boolean | undefined, // undefined initially, computed when user types in all fields
	models: VoidStatefulModelInfo[],
}

export type SettingsAtProvider<providerName extends ProviderName> = CustomProviderSettings<providerName> & CommonProviderSettings

// part of state
export type SettingsOfProvider = {
	[providerName in ProviderName]: SettingsAtProvider<providerName>
}


export type SettingName = keyof SettingsAtProvider<ProviderName>

type DisplayInfoForProviderName = {
	title: string,
	desc?: string,
}

export const displayInfoOfProviderName = (providerName: ProviderName): DisplayInfoForProviderName => {
	if (providerName === 'v3code-free') {
		return { title: 'Free (no key) — Beta', }
	}
	if (providerName === 'v3code-local') {
		return { title: 'Built-in (local)', }
	}
	if (providerName === 'anthropic') {
		return { title: 'Anthropic', }
	}
	else if (providerName === 'openAI') {
		return { title: 'OpenAI', }
	}
	else if (providerName === 'deepseek') {
		return { title: 'DeepSeek', }
	}
	else if (providerName === 'openRouter') {
		return { title: 'OpenRouter', }
	}
	else if (providerName === 'ollama') {
		return { title: 'Ollama', }
	}
	else if (providerName === 'vLLM') {
		return { title: 'vLLM', }
	}
	else if (providerName === 'liteLLM') {
		return { title: 'LiteLLM', }
	}
	else if (providerName === 'lmStudio') {
		return { title: 'LM Studio', }
	}
	else if (providerName === 'openAICompatible') {
		return { title: 'OpenAI-Compatible', }
	}
	else if (providerName === 'openAICompatible2') {
		return { title: 'OpenAI-Compatible 2', }
	}
	else if (providerName === 'openAICompatible3') {
		return { title: 'OpenAI-Compatible 3', }
	}
	else if (providerName === 'gemini') {
		return { title: 'Gemini', }
	}
	else if (providerName === 'groq') {
		return { title: 'Groq', }
	}
	else if (providerName === 'xAI') {
		return { title: 'Grok (xAI)', }
	}
	else if (providerName === 'grokPlan') {
		return { title: 'Grok (Plan)', }
	}
	else if (providerName === 'claudePlan') {
		return { title: 'Claude (Plan)', }
	}
	else if (providerName === 'copilot') {
		return { title: 'GitHub Copilot', }
	}
	else if (providerName === 'geminiPlan') {
		return { title: 'Gemini (Plan)', }
	}
	else if (providerName === 'cursorLocal') {
		return { title: 'Cursor (Local)', }
	}
	else if (providerName === 'openaiPlan') {
		return { title: 'OpenAI (Plan)', }
	}
	else if (providerName === 'mistral') {
		return { title: 'Mistral', }
	}
	else if (providerName === 'googleVertex') {
		return { title: 'Google Vertex AI', }
	}
	else if (providerName === 'microsoftAzure') {
		return { title: 'Microsoft Azure OpenAI', }
	}
	else if (providerName === 'awsBedrock') {
		return { title: 'AWS Bedrock', }
	}

	throw new Error(`descOfProviderName: Unknown provider name: "${providerName}"`)
}

export const subTextMdOfProviderName = (providerName: ProviderName): string => {

	// Transparency matters more here than anywhere else: this lane is ON by default and needs
	// no signup, so the user must be able to see exactly whose servers their prompts reach and
	// that they can switch it off.
	if (providerName === 'v3code-free') return 'Beta — on by default. No key, no signup — these models are served free through the public [OpenCode Zen](https://opencode.ai/docs/zen/) gateway, so prompts and file context you send with them leave your machine and are processed by that third-party gateway and its upstream model vendors. Free access is best-effort and can be rate limited or withdrawn by them at any time. `free-auto` rotates across the models below when one is rate limited (the console names whichever one served each turn) and routes image attachments to the one that can see them; picking a specific model instead disables rotation and fails honestly. Hide the models below, or pick another provider in the model picker, to stop using it.'
	if (providerName === 'anthropic') return 'Get your [API Key here](https://console.anthropic.com/settings/keys).'
	if (providerName === 'openAI') return 'Get your [API Key here](https://platform.openai.com/api-keys).'
	if (providerName === 'deepseek') return 'Get your [API Key here](https://platform.deepseek.com/api_keys).'
	if (providerName === 'openRouter') return 'Get your [API Key here](https://openrouter.ai/settings/keys). Read about [rate limits here](https://openrouter.ai/docs/api-reference/limits).'
	if (providerName === 'gemini') return 'Get your [API Key here](https://aistudio.google.com/apikey). Read about [rate limits here](https://ai.google.dev/gemini-api/docs/rate-limits#current-rate-limits).'
	if (providerName === 'groq') return 'Get your [API Key here](https://console.groq.com/keys).'
	if (providerName === 'xAI') return 'Get your [API Key here](https://console.x.ai).'
	if (providerName === 'grokPlan') return 'Uses your Grok subscription (SuperGrok / X Premium) — no API key. Run `grok login` in a terminal to sign in, then Grok models appear in the picker. Runs on your plan, not per-token billing.'
	if (providerName === 'claudePlan') return 'Uses your Claude subscription (Pro / Max) — no API key. Sign in to [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (`claude`, then `/login`) and these models appear in the picker. Turns count against your plan\'s limits, shared with your own Claude Code usage, instead of being billed per token. On macOS the token lives in your Keychain, so the first read may ask for your permission.'
	if (providerName === 'geminiPlan') return 'Uses your Google account — no API key. Install [gemini-cli](https://github.com/google-gemini/gemini-cli), run `gemini`, and choose "Sign in with Google"; these models then appear in the picker. Runs on your Gemini plan (free tier or Google One AI Pro) through Google\'s Code Assist service rather than per-token billing. Capacity on that service is shared and can be exhausted at busy times independently of your own quota.'
	if (providerName === 'copilot') return 'Uses your GitHub Copilot subscription — no API key. Sign in with `copilot login`, or sign in to Copilot in VS Code / JetBrains, and these models appear in the picker. Turns count against your Copilot premium-request allowance instead of being billed per token.'
	if (providerName === 'cursorLocal') return 'Uses your Cursor subscription through the local [API for Cursor](https://github.com/standardagents/composer-api) app — no key to paste here. Install the app, paste your official Cursor API key (Dashboard → Integrations) into it, and keep it running at `http://127.0.0.1:8788/v1`. Composer and Cursor-served Grok models then appear in the picker. Turns count against your Cursor plan, not per-token billing.'
	if (providerName === 'openaiPlan') return 'Uses your ChatGPT Plus/Pro subscription — no API key. Sign in with Codex (`codex login`) so `~/.codex/auth.json` holds ChatGPT-plan tokens. Turns count against your ChatGPT plan. The separate **OpenAI** provider is the billed-per-token API-key lane; this one never falls back to it.'
	if (providerName === 'mistral') return 'Get your [API Key here](https://console.mistral.ai/api-keys).'
	if (providerName === 'openAICompatible') return `Use any provider that's OpenAI-compatible (use this for llama.cpp and more).`
	if (providerName === 'openAICompatible2') return `A second, independent OpenAI-compatible endpoint — add another provider with its own base URL and key.`
	if (providerName === 'openAICompatible3') return `A third, independent OpenAI-compatible endpoint — add another provider with its own base URL and key.`
	if (providerName === 'googleVertex') return 'You must authenticate before using Vertex with Void. Read more about endpoints [here](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library), and regions [here](https://cloud.google.com/vertex-ai/docs/general/locations#available-regions).'
	if (providerName === 'microsoftAzure') return 'Read more about endpoints [here](https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP), and get your API key [here](https://learn.microsoft.com/en-us/azure/search/search-security-api-keys?tabs=rest-use%2Cportal-find%2Cportal-query#find-existing-keys).'
	if (providerName === 'awsBedrock') return 'Connect via a LiteLLM proxy or the AWS [Bedrock-Access-Gateway](https://github.com/aws-samples/bedrock-access-gateway). LiteLLM Bedrock setup docs are [here](https://docs.litellm.ai/docs/providers/bedrock).'
	if (providerName === 'ollama') return 'Read more about custom [Endpoints here](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-can-i-expose-ollama-on-my-network).'
	if (providerName === 'vLLM') return 'Read more about custom [Endpoints here](https://docs.vllm.ai/en/latest/getting_started/quickstart.html#openai-compatible-server).'
	if (providerName === 'lmStudio') return 'Read more about custom [Endpoints here](https://lmstudio.ai/docs/app/api/endpoints/openai).'
	if (providerName === 'liteLLM') return 'Read more about endpoints [here](https://docs.litellm.ai/docs/providers/openai_compatible).'

	throw new Error(`subTextMdOfProviderName: Unknown provider name: "${providerName}"`)
}

type DisplayInfo = {
	title: string;
	placeholder: string;
	isPasswordField?: boolean;
}
export const displayInfoOfSettingName = (providerName: ProviderName, settingName: SettingName): DisplayInfo => {
	if (settingName === 'apiKey') {
		return {
			title: 'API Key',

			// **Please follow this convention**:
			// The word "key..." here is a placeholder for the hash. For example, sk-ant-key... means the key will look like sk-ant-abcdefg123...
			placeholder: providerName === 'anthropic' ? 'sk-ant-key...' : // sk-ant-api03-key
				providerName === 'openAI' ? 'sk-proj-key...' :
					providerName === 'deepseek' ? 'sk-key...' :
						providerName === 'openRouter' ? 'sk-or-key...' : // sk-or-v1-key
							providerName === 'gemini' ? 'AIzaSy...' :
								providerName === 'groq' ? 'gsk_key...' :
									providerName === 'openAICompatible' ? 'sk-key...' :
									providerName === 'openAICompatible2' ? 'sk-key...' :
									providerName === 'openAICompatible3' ? 'sk-key...' :
										providerName === 'xAI' ? 'xai-key...' :
											providerName === 'mistral' ? 'api-key...' :
												providerName === 'googleVertex' ? 'AIzaSy...' :
													providerName === 'microsoftAzure' ? 'key-...' :
														providerName === 'awsBedrock' ? 'key-...' :
															'',

			isPasswordField: true,
		}
	}
	else if (settingName === 'endpoint') {
		return {
			title: providerName === 'ollama' ? 'Endpoint' :
				providerName === 'vLLM' ? 'Endpoint' :
					providerName === 'lmStudio' ? 'Endpoint' :
						providerName === 'openAICompatible' ? 'baseURL' : // (do not include /chat/completions)
							providerName === 'openAICompatible2' ? 'baseURL' :
							providerName === 'openAICompatible3' ? 'baseURL' :
							providerName === 'cursorLocal' ? 'baseURL' :
							providerName === 'googleVertex' ? 'baseURL' :
								providerName === 'microsoftAzure' ? 'baseURL' :
									providerName === 'liteLLM' ? 'baseURL' :
										providerName === 'awsBedrock' ? 'Endpoint' :
											'(never)',

			placeholder: providerName === 'ollama' ? defaultProviderSettings.ollama.endpoint
				: providerName === 'vLLM' ? defaultProviderSettings.vLLM.endpoint
						: providerName === 'openAICompatible' ? 'https://my-website.com/v1'
						: providerName === 'openAICompatible2' ? 'https://my-website.com/v1'
						: providerName === 'openAICompatible3' ? 'https://my-website.com/v1'
						: providerName === 'cursorLocal' ? defaultProviderSettings.cursorLocal.endpoint
						: providerName === 'lmStudio' ? defaultProviderSettings.lmStudio.endpoint
							: providerName === 'liteLLM' ? 'http://localhost:4000'
								: providerName === 'awsBedrock' ? 'http://localhost:4000/v1'
									: '(never)',


		}
	}
	else if (settingName === 'headersJSON') {
		return { title: 'Custom Headers', placeholder: '{ "X-Request-Id": "..." }' }
	}
	else if (settingName === 'region') {
		// vertex only
		return {
			title: 'Region',
			placeholder: providerName === 'googleVertex' ? defaultProviderSettings.googleVertex.region
				: providerName === 'awsBedrock'
					? defaultProviderSettings.awsBedrock.region
					: ''
		}
	}
	else if (settingName === 'azureApiVersion') {
		// azure only
		return {
			title: 'API Version',
			placeholder: providerName === 'microsoftAzure' ? defaultProviderSettings.microsoftAzure.azureApiVersion
				: ''
		}
	}
	else if (settingName === 'project') {
		return {
			title: providerName === 'microsoftAzure' ? 'Resource'
				: providerName === 'googleVertex' ? 'Project'
					: '',
			placeholder: providerName === 'microsoftAzure' ? 'my-resource'
				: providerName === 'googleVertex' ? 'my-project'
					: ''

		}

	}
	else if (settingName === '_didFillInProviderSettings') {
		return {
			title: '(never)',
			placeholder: '(never)',
		}
	}
	else if (settingName === 'models') {
		return {
			title: '(never)',
			placeholder: '(never)',
		}
	}

	throw new Error(`displayInfo: Unknown setting name: "${settingName}"`)
}


const defaultCustomSettings: Record<CustomSettingName, undefined> = {
	apiKey: undefined,
	endpoint: undefined,
	region: undefined, // googleVertex
	project: undefined,
	azureApiVersion: undefined,
	headersJSON: undefined,
}


/** How many of a provider's default models stay visible in the picker on a fresh install. */
export const MAX_VISIBLE_DEFAULT_MODELS = 12

/**
 * Builds the initial picker state for a provider's default model list.
 *
 * Hides only the TAIL past MAX_VISIBLE_DEFAULT_MODELS so a long catalogue stays manageable while
 * the curated leaders remain visible. The previous rule hid EVERY model once a provider reached
 * ten defaults, which meant adding one model to a nine-model provider silently emptied that
 * provider's picker — the reason the Anthropic list was frozen at nine and Fable 5.1 could not
 * be added. Order matters: put the models users should see first at the top of the list.
 */
const modelInfoOfDefaultModelNames = (defaultModelNames: string[]): { models: VoidStatefulModelInfo[] } => {
	return {
		models: defaultModelNames.map((modelName, i) => ({
			modelName,
			type: 'default',
			isHidden: i >= MAX_VISIBLE_DEFAULT_MODELS,
		}))
	}
}

// used when waiting and for a type reference
export const defaultSettingsOfProvider: SettingsOfProvider = {
	'v3code-free': {
		...defaultCustomSettings,
		...defaultProviderSettings['v3code-free'],
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider['v3code-free']),
		_didFillInProviderSettings: true, // ENABLED by default — no key to fill in
	},
	'v3code-local': {
		...defaultCustomSettings,
		...defaultProviderSettings['v3code-local'],
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider['v3code-local']),
		_didFillInProviderSettings: true, // ENABLED by default — built-in, nothing to fill in
	},
	anthropic: {
		...defaultCustomSettings,
		...defaultProviderSettings.anthropic,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.anthropic),
		_didFillInProviderSettings: undefined,
	},
	openAI: {
		...defaultCustomSettings,
		...defaultProviderSettings.openAI,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openAI),
		_didFillInProviderSettings: undefined,
	},
	deepseek: {
		...defaultCustomSettings,
		...defaultProviderSettings.deepseek,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.deepseek),
		_didFillInProviderSettings: undefined,
	},
	gemini: {
		...defaultCustomSettings,
		...defaultProviderSettings.gemini,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.gemini),
		_didFillInProviderSettings: undefined,
	},
	xAI: {
		...defaultCustomSettings,
		...defaultProviderSettings.xAI,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.xAI),
		_didFillInProviderSettings: undefined,
	},
	grokPlan: {
		...defaultCustomSettings,
		...defaultProviderSettings.grokPlan,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.grokPlan),
		_didFillInProviderSettings: undefined,
	},
	claudePlan: {
		...defaultCustomSettings,
		...defaultProviderSettings.claudePlan,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.claudePlan),
		_didFillInProviderSettings: undefined,
	},
	copilot: {
		...defaultCustomSettings,
		...defaultProviderSettings.copilot,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.copilot),
		_didFillInProviderSettings: undefined,
	},
	geminiPlan: {
		...defaultCustomSettings,
		...defaultProviderSettings.geminiPlan,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.geminiPlan),
		_didFillInProviderSettings: undefined,
	},
	cursorLocal: {
		...defaultCustomSettings,
		...defaultProviderSettings.cursorLocal,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.cursorLocal),
		_didFillInProviderSettings: true, // default endpoint is enough — the local app owns the key
	},
	openaiPlan: {
		...defaultCustomSettings,
		...defaultProviderSettings.openaiPlan,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openaiPlan),
		_didFillInProviderSettings: undefined,
	},
	mistral: {
		...defaultCustomSettings,
		...defaultProviderSettings.mistral,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.mistral),
		_didFillInProviderSettings: undefined,
	},
	liteLLM: {
		...defaultCustomSettings,
		...defaultProviderSettings.liteLLM,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.liteLLM),
		_didFillInProviderSettings: undefined,
	},
	lmStudio: {
		...defaultCustomSettings,
		...defaultProviderSettings.lmStudio,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.lmStudio),
		_didFillInProviderSettings: undefined,
	},
	groq: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.groq,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.groq),
		_didFillInProviderSettings: undefined,
	},
	openRouter: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.openRouter,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openRouter),
		_didFillInProviderSettings: undefined,
	},
	openAICompatible: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.openAICompatible,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openAICompatible),
		_didFillInProviderSettings: undefined,
	},
	openAICompatible2: { // extra fixed OpenAI-compatible slot
		...defaultCustomSettings,
		...defaultProviderSettings.openAICompatible2,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openAICompatible2),
		_didFillInProviderSettings: undefined,
	},
	openAICompatible3: { // extra fixed OpenAI-compatible slot
		...defaultCustomSettings,
		...defaultProviderSettings.openAICompatible3,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openAICompatible3),
		_didFillInProviderSettings: undefined,
	},
	ollama: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.ollama,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.ollama),
		_didFillInProviderSettings: undefined,
	},
	vLLM: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.vLLM,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.vLLM),
		_didFillInProviderSettings: undefined,
	},
	googleVertex: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.googleVertex,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.googleVertex),
		_didFillInProviderSettings: undefined,
	},
	microsoftAzure: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.microsoftAzure,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.microsoftAzure),
		_didFillInProviderSettings: undefined,
	},
	awsBedrock: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.awsBedrock,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.awsBedrock),
		_didFillInProviderSettings: undefined,
	},
}


export type ModelSelection = {
	providerName: ProviderName,
	modelName: string,
	/** Set ONLY when the selection was created from the V3Code hosted tier picker
	 *  (a V3ModelTierId). Its presence is what routes through the hub's hosted
	 *  lane — a BYOK selection never carries it, even when the model name
	 *  collides with a hosted tier's wire name. */
	hostedTierId?: string,
}

export const modelSelectionsEqual = (m1: ModelSelection, m2: ModelSelection) => {
	return m1.modelName === m2.modelName && m1.providerName === m2.providerName
		&& (m1.hostedTierId ?? undefined) === (m2.hostedTierId ?? undefined)
}

// this is a state
export const featureNames = ['Chat', 'Ctrl+K', 'Autocomplete', 'NextEdit', 'Apply', 'SCM', 'TurboDraft'] as const
export type ModelSelectionOfFeature = Record<(typeof featureNames)[number], ModelSelection | null>
export type FeatureName = keyof ModelSelectionOfFeature

export const displayInfoOfFeatureName = (featureName: FeatureName) => {
	// editor:
	if (featureName === 'Autocomplete')
		return 'Autocomplete'
	else if (featureName === 'NextEdit')
		return 'Next Edit'
	else if (featureName === 'Ctrl+K')
		return 'Quick Edit'
	// sidebar:
	else if (featureName === 'Chat')
		return 'Chat'
	else if (featureName === 'Apply')
		return 'Apply'
	else if (featureName === 'TurboDraft')
		return 'Turbo Draft'
	// source control:
	else if (featureName === 'SCM')
		return 'Commit Message Generator'
	else
		throw new Error(`Feature Name ${featureName} not allowed`)
}


// the models of these can be refreshed (in theory all can, but not all should)
export const refreshableProviderNames = [...localProviderNames, ...apiRefreshableProviderNames] as const
export type RefreshableProviderName = typeof refreshableProviderNames[number]

// models that come with download buttons
export const hasDownloadButtonsOnModelsProviderNames = ['ollama'] as const satisfies ProviderName[]





// use this in isFeatuerNameDissbled
export const isProviderNameDisabled = (providerName: ProviderName, settingsState: VoidSettingsState) => {

	const settingsAtProvider = settingsState.settingsOfProvider[providerName]
	const isAutodetected = (refreshableProviderNames as readonly string[]).includes(providerName)

	const isDisabled = settingsAtProvider.models.length === 0
	if (isDisabled) {
		return isAutodetected ? 'providerNotAutoDetected' : (!settingsAtProvider._didFillInProviderSettings ? 'notFilledIn' : 'addModel')
	}
	return false
}

export const isFeatureNameDisabled = (featureName: FeatureName, settingsState: VoidSettingsState) => {
	// if has a selected provider, check if it's enabled
	const selectedProvider = settingsState.modelSelectionOfFeature[featureName]

	if (selectedProvider) {
		const { providerName } = selectedProvider
		return isProviderNameDisabled(providerName, settingsState)
	}

	// if there are any models they can turn on, tell them that
	const canTurnOnAModel = !!providerNames.find(providerName => settingsState.settingsOfProvider[providerName].models.filter(m => m.isHidden).length !== 0)
	if (canTurnOnAModel) return 'needToEnableModel'

	// if there are any providers filled in, then they just need to add a model
	const anyFilledIn = !!providerNames.find(providerName => settingsState.settingsOfProvider[providerName]._didFillInProviderSettings)
	if (anyFilledIn) return 'addModel'

	return 'addProvider'
}







// 'multitask': the coordinator (foreman) mode — researches, plans with direct paths per
// worker, freezes contracts, dispatches work subagents in phases, reconciles what comes
// back. The coordinator itself cannot edit or run terminals (its toolset omits them):
// all mutation flows through bounded, approval-gated workers. Agent mode is untouched.
// 'debug': the permanent built-in Debug investigator — read-only tools plus a bounded
// fix surface (file writes, run_command, run_tests) behind the normal approvals. Travels
// over the Agent wire kind like multitask; see v3DebugMode.ts for the stable name.
export type ChatMode = 'agent' | 'read' | 'chat' | 'plan' | 'multitask' | 'debug'

/** Modes that inject workspace memory, auto-context, symbol skeleton, etc. */
export function modeHasWorkspaceContext(mode: ChatMode): boolean {
	return mode === 'agent' || mode === 'read' || mode === 'chat' || mode === 'plan' || mode === 'multitask' || mode === 'debug';
}

/** How non-vision models receive image content (via a separate vision model). */
export type ImageDescribeMode = 'off' | 'on_send' | 'manual'

/**
 * Prompt assembly preset the user selected (see common/prompt/promptAssemblyProfiles.ts).
 * 'auto' = context-aware cloud routing plus compact-small / lean-large local routing.
 */
export type PromptAssemblyPresetSetting = 'auto' | 'full' | 'lean' | 'minimal'

/**
 * Prompt VOICE variant — a debugging picker for the A/B/C prompt bakeoff. Swaps the
 * cloud (full-profile) OS prompt text only; the tier logic (full/lean/minimal) is
 * unchanged. 'original' = today's shipped prompt (control). Once a winner is picked
 * this collapses back to one cloud prompt + one tiny local prompt.
 */
export type PromptVariantSetting = 'v3' | 'original' | 'cherrypick' | 'overwrite' | 'flat'

export type GlobalSettings = {
	autoRefreshModels: boolean;
	aiInstructions: string;
	enableAutocomplete: boolean;
	syncApplyToChat: boolean;
	syncSCMToChat: boolean;
	/** When true, Turbo Draft follows the Chat model. When false, use the Turbo Draft picker. */
	syncTurboDraftToChat: boolean;
	/** Feed Turbo Draft live diagnostics, real signatures and call sites from the language server. */
	turboDraftCompilerTruth: boolean;
	/** After you review a draft, check whether it introduced new errors and offer one fix pass. */
	turboDraftVerifyDraft: boolean;
	enableFastApply: boolean;
	chatMode: ChatMode;
	autoApprove: { [approvalType in ToolApprovalType]?: boolean };
	didMigrateAutoApproveDefaults: boolean;
	didMigrateAutocompleteDefault: boolean;
	/** One-time C1 back-compat: tag pre-existing hosted tier picks with hostedTierId. */
	didMigrateHostedTierTags: boolean;
	showInlineSuggestions: boolean;
	includeToolLintErrors: boolean;
	isOnboardingComplete: boolean;
	disableSystemMessage: boolean;
	autoAcceptLLMChanges: boolean;
	/** off = ignore images; on_send = auto-describe; manual = describe button / prompt on send */
	imageDescribeMode: ImageDescribeMode;
	/** Which model transcribes images for text-only chat models. `'auto'` (default) picks the
	 *  cheapest available vision-capable model; otherwise a JSON-encoded `{ providerName, modelName }`
	 *  selection (see encode/decodeVisionModelSetting in v3codeVisionDescribe.ts). */
	visionDescribeModel: string;
	/** Roll back edit_file/rewrite_file when lint errors appear after apply (Phase 1 shadow verify). */
	shadowVerify: boolean;
	/** Phase 2 shelving: per-profile UUID workspace memory addressing (default off = legacy folder paths). */
	memoryLibraryV2: boolean;
	/** Phase 3 MemLegend: show the Memory Ledger view (the timeline rail). */
	memoryLedger: boolean;
	/** Default model for the generate_image tool (Grok/xAI). The tool's own `model` param
	 *  overrides this per-call; empty falls back to the built-in default. */
	imageModel: string;
	/** Push the semantic index to a V3Index cloud deployment (see cloudIndexSyncer.ts). */
	cloudIndexEnabled: boolean;
	/** V3Index base URL, e.g. https://v3index.<account>.workers.dev */
	cloudIndexEndpoint: string;
	/** Bearer token (v3k_… registry key, or HMAC dev token). */
	cloudIndexToken: string;
	/** Workspace id on the V3Index side; empty = derived from the workspace folder name. */
	cloudIndexWorkspaceId: string;
	/** Prompt assembly preset: how much of the OS prompt / skills catalog / memory is pushed each turn. */
	promptAssemblyPreset: PromptAssemblyPresetSetting;
	/** Prompt VOICE variant for the cloud (full) prompt — debugging picker for the prompt bakeoff. */
	promptVariant: PromptVariantSetting;
	/** Let the agent pause and ask a multiple-choice question (ask_user tool) with clickable options. */
	enableAskUserTool: boolean;
	/**
	 * Let the agent loop nudge itself when a step ends without a tool call.
	 *
	 * On by default because the narrow version of this genuinely prevents a chat dying right after
	 * a thinking-only step. Off makes the harness fully hands-off: the agent stops when it stops.
	 *
	 * Does NOT disable the empty-step recovery, which is a real stall rather than a judgement call —
	 * only the narration nudge and the plan reconcile, which are the two that can fire on a complete
	 * and correct answer.
	 */
	softContinueNudges: boolean;
	/**
	 * Let the agent see the screen and drive the mouse and keyboard (computer use).
	 *
	 * Off by default, and deliberately so: this grants control of the whole machine rather than just
	 * the editor, so it must be an explicit choice. Turning it on is still not sufficient — a
	 * one-time consent dialog and per-application approval both gate the first real action.
	 */
	enableComputerUse: boolean;
	/**
	 * Let the agent watch an approved application continuously, on a timer, and keep a history of what
	 * it saw (ambient observation).
	 *
	 * Off by default, and separate from {@link GlobalSettings.enableComputerUse} on purpose: consent to
	 * let an agent drive the machine when asked is not consent to be watched while working, and one
	 * switch for both would mean the narrower capability silently bought the broader one. Turning this on
	 * is still not sufficient — a second one-time consent dialog, a per-application grant with an expiry,
	 * and a retention window all gate the first sample.
	 */
	enableComputerUseObservation: boolean;
	/**
	 * Serve this editor's intelligence tools (semantic_search, the LSP context bridge, memory
	 * search) to external agents over the local MCP endpoint.
	 *
	 * On by default — it is loopback-only and token-guarded. The reason it is a setting at all
	 * is that two editors can run at once (installed app + dev build): turning it off in one
	 * makes the other the unambiguous target, which is how you test a dev build's tools from
	 * Claude Code without guessing which instance answered.
	 */
	mcpExposeEnabled: boolean;
}

export const defaultGlobalSettings: GlobalSettings = {
	autoRefreshModels: true,
	aiInstructions: '',
	// Keep the local inference model off the machine's hot path until the user asks for it.
	// Enabling Autocomplete remains a one-click choice and starts the model download on demand.
	enableAutocomplete: false,
	syncApplyToChat: true,
	syncSCMToChat: true,
	syncTurboDraftToChat: false,
	turboDraftCompilerTruth: true,
	turboDraftVerifyDraft: true,
	enableFastApply: true,
	chatMode: 'agent',
	autoApprove: {},
	didMigrateAutoApproveDefaults: true,
	didMigrateAutocompleteDefault: true,
	didMigrateHostedTierTags: true,
	showInlineSuggestions: true,
	includeToolLintErrors: true,
	isOnboardingComplete: false,
	disableSystemMessage: false,
	autoAcceptLLMChanges: false,
	imageDescribeMode: 'manual',
	visionDescribeModel: 'auto',
	shadowVerify: false,
	memoryLibraryV2: true,
	memoryLedger: true,
	imageModel: 'grok-imagine-image-quality',
	cloudIndexEnabled: false,
	cloudIndexEndpoint: '',
	cloudIndexToken: '',
	cloudIndexWorkspaceId: '',
	promptAssemblyPreset: 'auto',
	promptVariant: 'v3',
	enableAskUserTool: true,
	softContinueNudges: true,
	enableComputerUse: false,
	enableComputerUseObservation: false,
	mcpExposeEnabled: true,
}

export type GlobalSettingName = keyof GlobalSettings
export const globalSettingNames = Object.keys(defaultGlobalSettings) as GlobalSettingName[]












export type AdvisorEffort = 'easy' | 'hard'

export type ModelSelectionOptions = {
	reasoningEnabled?: boolean;
	reasoningBudget?: number;
	reasoningEffort?: string;
	advisorEffort?: AdvisorEffort;
}

export type OptionsOfModelSelection = {
	[featureName in FeatureName]: Partial<{
		[providerName in ProviderName]: {
			[modelName: string]: ModelSelectionOptions | undefined
		}
	}>
}





export type OverridesOfModel = {
	[providerName in ProviderName]: {
		[modelName: string]: Partial<ModelOverrides> | undefined
	}
}


const overridesOfModel = {} as OverridesOfModel
for (const providerName of providerNames) { overridesOfModel[providerName] = {} }
export const defaultOverridesOfModel = overridesOfModel



export interface MCPUserStateOfName {
	[serverName: string]: MCPUserState | undefined;
}

export interface MCPUserState {
	isOn: boolean;
}
