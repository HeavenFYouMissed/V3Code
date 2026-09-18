/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IVoidSettingsService } from './voidSettingsService.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { RefreshableProviderName, refreshableProviderNames, SettingsOfProvider, localProviderNames } from './voidSettingsTypes.js';
import { OllamaModelResponse, OpenaiCompatibleModelResponse } from './sendLLMMessageTypes.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';




type RefreshableState = ({
	state: 'init',
	timeoutId: null,
} | {
	state: 'refreshing',
	timeoutId: ReturnType<typeof setTimeout> | null, // the timeoutId of the most recent call to refreshModels
} | {
	state: 'finished',
	timeoutId: null,
} | {
	state: 'error',
	timeoutId: null,
})


/*

user click -> error -> fire(error)
		   \> success -> fire(success)
	finally: keep polling

poll -> do not fire

*/
export type RefreshModelStateOfProvider = Record<RefreshableProviderName, RefreshableState>



const refreshBasedOn: { [k in RefreshableProviderName]: (keyof SettingsOfProvider[k])[] } = {
	ollama: ['_didFillInProviderSettings', 'endpoint'],
	vLLM: ['_didFillInProviderSettings', 'endpoint'],
	lmStudio: ['_didFillInProviderSettings', 'endpoint'],
	openAI: ['_didFillInProviderSettings', 'apiKey'],
	anthropic: ['_didFillInProviderSettings', 'apiKey'],
	deepseek: ['_didFillInProviderSettings', 'apiKey'],
	xAI: ['_didFillInProviderSettings', 'apiKey'],
	openRouter: ['_didFillInProviderSettings', 'apiKey'],
	groq: ['_didFillInProviderSettings', 'apiKey'],
	copilot: ['_didFillInProviderSettings'],
	'v3code-free': ['_didFillInProviderSettings'],
}
const REFRESH_INTERVAL_LOCAL = 5_000
const REFRESH_INTERVAL_API = 15 * 60_000
// const COOLDOWN_TIMEOUT = 300

// Providers whose model catalogue is CURATED in defaultModelsOfProvider: their /v1/models
// response is used only as a key/reachability probe (health), never spliced into the model
// list. OpenRouter is discovered separately, with new entries hidden until selected.
const CURATED_CATALOG_PROVIDERS: ReadonlySet<string> = new Set(['openAI', 'deepseek', 'xAI', 'groq', 'v3code-free'])

/** Result of the most recent list/probe for a provider — drives picker gating + settings badges. */
export type ProviderHealth = {
	status: 'unknown' | 'ok' | 'badKey' | 'unreachable';
	checkedAt: number;
	error?: string;
}

const BAD_KEY_RE = /\b(401|403|invalid[ _-]?api[ _-]?key|incorrect api key|authentication|unauthorized|permission)\b/i

const autoOptions = { enableProviderOnSuccess: true, doNotFire: true }

// element-wise equals
function eq<T>(a: T[], b: T[]): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}
export interface IRefreshModelService {
	readonly _serviceBrand: undefined;
	startRefreshingModels: (providerName: RefreshableProviderName, options: { enableProviderOnSuccess: boolean, doNotFire: boolean }) => void;
	onDidChangeState: Event<RefreshableProviderName>;
	state: RefreshModelStateOfProvider;
	/** Per-provider key/reachability health from the most recent probe. Fires onDidChangeHealth
	 *  on every probe completion (auto-poll included — unlike onDidChangeState's doNotFire). */
	onDidChangeHealth: Event<RefreshableProviderName>;
	healthOfProvider: Partial<Record<RefreshableProviderName, ProviderHealth>>;
}

export const IRefreshModelService = createDecorator<IRefreshModelService>('RefreshModelService');

export class RefreshModelService extends Disposable implements IRefreshModelService {

	readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<RefreshableProviderName>();
	readonly onDidChangeState: Event<RefreshableProviderName> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes

	private readonly _onDidChangeHealth = new Emitter<RefreshableProviderName>();
	readonly onDidChangeHealth: Event<RefreshableProviderName> = this._onDidChangeHealth.event;

	healthOfProvider: Partial<Record<RefreshableProviderName, ProviderHealth>> = {};

	private _setHealth(providerName: RefreshableProviderName, status: ProviderHealth['status'], error?: string) {
		this.healthOfProvider[providerName] = { status, checkedAt: Date.now(), ...(error ? { error } : {}) };
		this._onDidChangeHealth.fire(providerName);
	}


	constructor(
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
	) {
		super()


		const disposables: Set<IDisposable> = new Set()

		const initializeAutoPollingAndOnChange = () => {
			this._clearAllTimeouts()
			disposables.forEach(d => d.dispose())
			disposables.clear()

			if (!voidSettingsService.state.globalSettings.autoRefreshModels) return

			for (const providerName of refreshableProviderNames) {

				// const { '_didFillInProviderSettings': enabled } = this.voidSettingsService.state.settingsOfProvider[providerName]
				this.startRefreshingModels(providerName, autoOptions)

				// every time providerName.enabled changes, refresh models too, like a useEffect
				let relevantVals = () => refreshBasedOn[providerName].map(settingName => voidSettingsService.state.settingsOfProvider[providerName][settingName])
				let prevVals = relevantVals() // each iteration of a for loop has its own context and vars, so this is ok
				disposables.add(
					voidSettingsService.onDidChangeState(() => { // we might want to debounce this
						const newVals = relevantVals()
						if (!eq(prevVals, newVals)) {

							const prevEnabled = prevVals[0] as boolean
							const enabled = newVals[0] as boolean

							// if it was just enabled, or there was a change and it wasn't to the enabled state, refresh
							if ((enabled && !prevEnabled) || (!enabled && !prevEnabled)) {
								// if user just clicked enable, refresh
								this.startRefreshingModels(providerName, autoOptions)
							}
							else {
								// else if user just clicked disable, don't refresh

								// //give cooldown before re-enabling (or at least re-fetching)
								// const timeoutId = setTimeout(() => this.refreshModels(providerName, !enabled), COOLDOWN_TIMEOUT)
								// this._setTimeoutId(providerName, timeoutId)
							}
							prevVals = newVals
						}
					})
				)
			}
		}

		// on mount (when get init settings state), and if a relevant feature flag changes, start refreshing models
		voidSettingsService.waitForInitState.then(() => {
			initializeAutoPollingAndOnChange()
			this._register(
				voidSettingsService.onDidChangeState((type) => { if (typeof type === 'object' && type[1] === 'autoRefreshModels') initializeAutoPollingAndOnChange() })
			)
		})

	}

	state: RefreshModelStateOfProvider = {
		ollama: { state: 'init', timeoutId: null },
		vLLM: { state: 'init', timeoutId: null },
		lmStudio: { state: 'init', timeoutId: null },
		openAI: { state: 'init', timeoutId: null },
		anthropic: { state: 'init', timeoutId: null },
		deepseek: { state: 'init', timeoutId: null },
		xAI: { state: 'init', timeoutId: null },
		openRouter: { state: 'init', timeoutId: null },
		groq: { state: 'init', timeoutId: null },
		copilot: { state: 'init', timeoutId: null },
		'v3code-free': { state: 'init', timeoutId: null },
	}


	// start listening for models (and don't stop)
	startRefreshingModels: IRefreshModelService['startRefreshingModels'] = (providerName, options) => {

		this._clearProviderTimeout(providerName)

		this._setRefreshState(providerName, 'refreshing', options)

		const autoPoll = () => {
			if (this.voidSettingsService.state.globalSettings.autoRefreshModels) {
				// resume auto-polling — local providers poll frequently; API providers poll every 15min
				const interval = (localProviderNames as readonly string[]).includes(providerName)
					? REFRESH_INTERVAL_LOCAL
					: REFRESH_INTERVAL_API
				const timeoutId = setTimeout(() => this.startRefreshingModels(providerName, autoOptions), interval)
				this._setTimeoutId(providerName, timeoutId)
			}
		}
		const listFn = providerName === 'ollama' ? this.llmMessageService.ollamaList
			: this.llmMessageService.openAICompatibleList

		listFn({
			providerName,
			onSuccess: async ({ models }) => {
				if (providerName === 'openRouter') {
					try { await this.voidSettingsService.setOpenRouterCatalogue(models); }
					catch (error) {
						this._setHealth(providerName, 'unreachable', String(error));
						this._setRefreshState(providerName, 'error', options);
						autoPoll();
						return;
					}
				}
				// Curated providers use the list call purely as a key/reachability PROBE — their
				// picker catalogue stays the hand-picked defaults, never the API's full list.
				if (providerName !== 'openRouter' && !CURATED_CATALOG_PROVIDERS.has(providerName)) {
					// set the models to the detected models
					this.voidSettingsService.setAutodetectedModels(
						providerName,
						models.map(model => {
							if (providerName === 'ollama') return (model as OllamaModelResponse).name;
							return (model as OpenaiCompatibleModelResponse).id;
						}),
						{ enableProviderOnSuccess: options.enableProviderOnSuccess, hideRefresh: options.doNotFire }
					)

					if (options.enableProviderOnSuccess) this.voidSettingsService.setSettingOfProvider(providerName, '_didFillInProviderSettings', true)
				}

				this._setHealth(providerName, 'ok')
				this._setRefreshState(providerName, 'finished', options)
				autoPoll()
			},
			onError: ({ error }) => {
				this._setHealth(providerName, BAD_KEY_RE.test(error) ? 'badKey' : 'unreachable', error)
				this._setRefreshState(providerName, 'error', options)
				autoPoll()
			}
		})


	}

	_clearAllTimeouts() {
		for (const providerName of refreshableProviderNames) {
			this._clearProviderTimeout(providerName)
		}
	}

	_clearProviderTimeout(providerName: RefreshableProviderName) {
		// cancel any existing poll
		if (this.state[providerName].timeoutId) {
			clearTimeout(this.state[providerName].timeoutId)
			this._setTimeoutId(providerName, null)
		}
	}

	private _setTimeoutId(providerName: RefreshableProviderName, timeoutId: ReturnType<typeof setTimeout> | null) {
		this.state[providerName].timeoutId = timeoutId
	}

	private _setRefreshState(providerName: RefreshableProviderName, state: RefreshableState['state'], options?: { doNotFire: boolean }) {
		// Always record the state — auto-polls used to return before writing it, which left
		// `state` frozen at 'init' forever unless the user clicked a manual refresh, so nothing
		// built on top of it could ever reflect the 15-minute poll. doNotFire now suppresses
		// only the EVENT (the React refresh spinners), not the data.
		this.state[providerName].state = state
		if (options?.doNotFire) return
		this._onDidChangeState.fire(providerName)
	}
}

registerSingleton(IRefreshModelService, RefreshModelService, InstantiationType.Eager);
