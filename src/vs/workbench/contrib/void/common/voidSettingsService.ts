/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { mergeOpenRouterModels, parseOpenRouterCatalogue } from './openRouterCatalogue.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { localize } from '../../../../nls.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IMetricsService } from './metricsService.js';
import { defaultProviderSettings, getModelCapabilities, ModelOverrides } from './modelCapabilities.js';
import { hostedTierByWireName } from './modelTiers.js';
import { ONBOARDING_COMPLETE_KEY, VOID_SETTINGS_STORAGE_KEY } from './storageKeys.js';
import { defaultSettingsOfProvider, FeatureName, ProviderName, ModelSelectionOfFeature, SettingsOfProvider, SettingName, providerNames, ModelSelection, modelSelectionsEqual, featureNames, VoidStatefulModelInfo, GlobalSettings, GlobalSettingName, defaultGlobalSettings, ModelSelectionOptions, OptionsOfModelSelection, ChatMode, OverridesOfModel, defaultOverridesOfModel, MCPUserStateOfName as MCPUserStateOfName, MCPUserState, isProviderTemporarilyDisabled } from './voidSettingsTypes.js';


// name is the name in the dropdown
export type ModelOption = { name: string, selection: ModelSelection }



type SetSettingOfProviderFn = <S extends SettingName>(
	providerName: ProviderName,
	settingName: S,
	newVal: SettingsOfProvider[ProviderName][S extends keyof SettingsOfProvider[ProviderName] ? S : never],
) => Promise<void>;

type SetModelSelectionOfFeatureFn = <K extends FeatureName>(
	featureName: K,
	newVal: ModelSelectionOfFeature[K],
) => Promise<void>;

type SetGlobalSettingFn = <T extends GlobalSettingName>(settingName: T, newVal: GlobalSettings[T]) => void;

type SetOptionsOfModelSelection = (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => void


export type VoidSettingsState = {
	readonly settingsOfProvider: SettingsOfProvider; // optionsOfProvider
	readonly modelSelectionOfFeature: ModelSelectionOfFeature; // stateOfFeature
	readonly optionsOfModelSelection: OptionsOfModelSelection;
	readonly overridesOfModel: OverridesOfModel;
	readonly globalSettings: GlobalSettings;
	readonly mcpUserStateOfName: MCPUserStateOfName; // user-controlled state of MCP servers

	readonly _modelOptions: ModelOption[] // computed based on the two above items
}

// type RealVoidSettings = Exclude<keyof VoidSettingsState, '_modelOptions'>
// type EventProp<T extends RealVoidSettings = RealVoidSettings> = T extends 'globalSettings' ? [T, keyof VoidSettingsState[T]] : T | 'all'


export interface IVoidSettingsService {
	readonly _serviceBrand: undefined;
	readonly state: VoidSettingsState; // in order to play nicely with react, you should immutably change state
	readonly waitForInitState: Promise<void>;

	onDidChangeState: Event<void>;

	setSettingOfProvider: SetSettingOfProviderFn;
	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn;
	setOptionsOfModelSelection: SetOptionsOfModelSelection;
	setGlobalSetting: SetGlobalSettingFn;
	// setMCPServerStates: (newStates: MCPServerStates) => Promise<void>;

	// setting to undefined CLEARS it, unlike others:
	setOverridesOfModel(providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined): Promise<void>;

	dangerousSetState(newState: VoidSettingsState): Promise<void>;
	resetState(): Promise<void>;

	setAutodetectedModels(providerName: ProviderName, modelNames: string[], logging: object): void;
	setOpenRouterCatalogue(rows: readonly unknown[]): Promise<void>;
	toggleModelHidden(providerName: ProviderName, modelName: string): void;
	addModel(providerName: ProviderName, modelName: string): void;
	deleteModel(providerName: ProviderName, modelName: string): boolean;

	addMCPUserStateOfNames(userStateOfName: MCPUserStateOfName): Promise<void>;
	removeMCPUserStateOfNames(serverNames: string[]): Promise<void>;
	setMCPServerState(serverName: string, state: MCPUserState): Promise<void>;
}




const _modelsWithSwappedInNewModels = (options: { existingModels: VoidStatefulModelInfo[], models: string[], type: 'autodetected' | 'default' }) => {
	const { existingModels, models, type } = options

	const existingModelsMap: Record<string, VoidStatefulModelInfo> = {}
	for (const existingModel of existingModels) {
		existingModelsMap[existingModel.modelName] = existingModel
	}

	if (type === 'autodetected') {
		// default/custom wins over autodetected — skip incoming names already present under another type
		const filteredModels = models.filter(modelName => {
			const existing = existingModelsMap[modelName]
			return !existing || existing.type === 'autodetected'
		})
		const newAutodetectedModels = filteredModels.map(modelName => ({
			modelName,
			type,
			isHidden: !!existingModelsMap[modelName]?.isHidden,
		}))
		return [
			...newAutodetectedModels,
			...existingModels.filter(m => m.type !== type)
		]
	}

	// type === 'default': new defaults replace any same-named autodetected/custom entry
	const defaultModelNameSet = new Set(models)
	const newDefaultModels = models.map(modelName => ({
		modelName,
		type,
		isHidden: !!existingModelsMap[modelName]?.isHidden,
	}))
	return [
		...newDefaultModels,
		...existingModels.filter(m => m.type !== type && !defaultModelNameSet.has(m.modelName))
	]
}


const _modelsEqual = (a: VoidStatefulModelInfo[], b: VoidStatefulModelInfo[]): boolean => {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i].modelName !== b[i].modelName) return false
		if (a[i].type !== b[i].type) return false
		if (a[i].isHidden !== b[i].isHidden) return false
	}
	return true
}


export const modelFilterOfFeatureName: {
	[featureName in FeatureName]: {
		filter: (
			o: ModelSelection,
			opts: { chatMode: ChatMode, overridesOfModel: OverridesOfModel }
		) => boolean;
		emptyMessage: null | { message: string, priority: 'always' | 'fallback' }
	} } = {
	'Autocomplete': { filter: (o, opts) => getModelCapabilities(o.providerName, o.modelName, opts.overridesOfModel).supportsFIM, emptyMessage: { message: 'No models support FIM', priority: 'always' } },
	// NES-tuned models (Instinct/Zeta-style) or FIM-capable small models; a big chat model would
	// be too slow + noisy for speculative background predictions
	'NextEdit': { filter: (o, opts) => { const c = getModelCapabilities(o.providerName, o.modelName, opts.overridesOfModel); return !!c.supportsNextEdit || c.supportsFIM }, emptyMessage: { message: 'No models support Next Edit', priority: 'always' } },
	'Chat': { filter: o => true, emptyMessage: null, },
	'Ctrl+K': { filter: o => true, emptyMessage: null, },
	'Apply': { filter: o => true, emptyMessage: null, },
	'SCM': { filter: o => true, emptyMessage: null, },
	// Whole-file rewrite agent — cloud/chat models only (local FIM 0.5b/1.5b is too weak).
	'TurboDraft': {
		filter: o => o.providerName !== 'v3code-local',
		emptyMessage: { message: 'Pick a cloud model for Turbo Draft (Settings → Features)', priority: 'always' },
	},
}


const _stateWithMergedDefaultModels = (state: VoidSettingsState): VoidSettingsState => {
	let newSettingsOfProvider = state.settingsOfProvider

	// recompute default models
	for (const providerName of providerNames) {
		const defaultModels = defaultSettingsOfProvider[providerName]?.models ?? []
		const currentModels = newSettingsOfProvider[providerName]?.models ?? []
		if (providerName === 'openRouter' && currentModels.some(model => model.type === 'autodetected')) { continue; }
		const defaultModelNames = defaultModels.map(m => m.modelName)
		const newModels = _modelsWithSwappedInNewModels({ existingModels: currentModels, models: defaultModelNames, type: 'default' })
		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...newSettingsOfProvider[providerName],
				models: newModels,
			},
		}
	}
	return {
		...state,
		settingsOfProvider: newSettingsOfProvider,
	}
}

const _validatedModelState = (state: Omit<VoidSettingsState, '_modelOptions'>): VoidSettingsState => {

	let newSettingsOfProvider = state.settingsOfProvider

	// recompute _didFillInProviderSettings
	for (const providerName of providerNames) {
		const settingsAtProvider = newSettingsOfProvider[providerName]

		const didFillInProviderSettings = Object.keys(defaultProviderSettings[providerName]).every(key => !!settingsAtProvider[key as keyof typeof settingsAtProvider])

		if (didFillInProviderSettings === settingsAtProvider._didFillInProviderSettings) continue

		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...settingsAtProvider,
				_didFillInProviderSettings: didFillInProviderSettings,
			},
		}
	}

	// update model options (one entry per provider/model — polluted state can list the same name twice)
	let newModelOptions: ModelOption[] = []
	const seenModelSelections = new Set<string>()
	for (const providerName of providerNames) {
		if (isProviderTemporarilyDisabled(providerName)) continue
		const providerTitle = providerName // displayInfoOfProviderName(providerName).title.toLowerCase() // looks better lowercase, best practice to not use raw providerName
		if (!newSettingsOfProvider[providerName]._didFillInProviderSettings) continue // if disabled, don't display model options
		for (const { modelName, isHidden } of newSettingsOfProvider[providerName].models) {
			if (isHidden) continue
			const selectionKey = `${providerName}\0${modelName}`
			if (seenModelSelections.has(selectionKey)) {
				continue
			}
			seenModelSelections.add(selectionKey)
			newModelOptions.push({ name: `${modelName} (${providerTitle})`, selection: { providerName, modelName } })
		}
	}

	// now that model options are updated, make sure the selection is valid.
	// Only a feature that has NEVER been selected (null) may be defaulted to the 0th
	// available model; an existing pick is preserved (see the note below).
	let newModelSelectionOfFeature = state.modelSelectionOfFeature
	for (const featureName of featureNames) {

		const { filter } = modelFilterOfFeatureName[featureName]
		const filterOpts = { chatMode: state.globalSettings.chatMode, overridesOfModel: state.overridesOfModel }
		const modelOptionsForThisFeature = newModelOptions.filter((o) => filter(o.selection, filterOpts))

		// `?? null` self-heals states from before a feature existed (e.g. a settings-JSON import
		// predating 'NextEdit') — a missing key would otherwise throw in modelSelectionsEqual
		const modelSelectionAtFeature = newModelSelectionOfFeature[featureName] ?? null
		// Hosted tier selections run on the hub's keys — never reset them because the
		// provider has no BYOK key filled in (they are valid without one).
		if (modelSelectionAtFeature?.hostedTierId) { continue }
		const selnIdx = modelSelectionAtFeature === null ? -1 : modelOptionsForThisFeature.findIndex(m => modelSelectionsEqual(m.selection, modelSelectionAtFeature))

		if (selnIdx !== -1) continue // still available — keep it

		// The selection is not in the current option list. NEVER silently re-point an
		// explicit pick at a DIFFERENT provider: newModelOptions is ordered by
		// `providerNames`, whose first entry is 'v3code-local', and the local lanes
		// (v3code-local, ollama, vLLM, lmStudio) are the only ones always
		// `_didFillInProviderSettings` — their endpoint has a non-empty default and the
		// built-in lane needs nothing. So index 0 is normally a LOCAL model, and a cloud
		// pick that is only *temporarily* unavailable (key cleared, model hidden, provider
		// list not refreshed yet, BYOK-only tier with no key) used to be rewritten onto
		// that local model — after which every later turn silently ran on it. Keep the
		// pick instead and let the send path surface the real error (invalid key / plan).
		if (modelSelectionAtFeature !== null) {
			// Same provider, different model (e.g. an autodetected local model was renamed):
			// staying inside the user's chosen provider is a safe self-heal.
			const sameProviderOption = modelOptionsForThisFeature.find(m => m.selection.providerName === modelSelectionAtFeature.providerName)
			if (sameProviderOption) {
				newModelSelectionOfFeature = { ...newModelSelectionOfFeature, [featureName]: sameProviderOption.selection }
			}
			continue
		}

		// Nothing was ever selected for this feature (first run) — a sensible default is fine.
		newModelSelectionOfFeature = {
			...newModelSelectionOfFeature,
			[featureName]: modelOptionsForThisFeature.length === 0 ? null : modelOptionsForThisFeature[0].selection
		}
	}


	// same self-heal for optionsOfModelSelection — every feature key must exist or the
	// per-feature lookups (`optionsOfModelSelection[featureName][providerName]`) throw
	let newOptionsOfModelSelection = state.optionsOfModelSelection
	for (const featureName of featureNames) {
		if (!newOptionsOfModelSelection[featureName]) {
			newOptionsOfModelSelection = { ...newOptionsOfModelSelection, [featureName]: {} }
		}
	}

	const newState = {
		...state,
		settingsOfProvider: newSettingsOfProvider,
		modelSelectionOfFeature: newModelSelectionOfFeature,
		optionsOfModelSelection: newOptionsOfModelSelection,
		overridesOfModel: state.overridesOfModel,
		_modelOptions: newModelOptions,
	} satisfies VoidSettingsState

	return newState
}





const defaultState = () => {
	const d: VoidSettingsState = {
		settingsOfProvider: deepClone(defaultSettingsOfProvider),
		modelSelectionOfFeature: { 'Chat': null, 'Ctrl+K': null, 'Autocomplete': { providerName: 'v3code-local', modelName: 'qwen2.5-coder-1.5b' }, 'NextEdit': { providerName: 'v3code-local', modelName: 'qwen2.5-coder-1.5b' }, 'Apply': null, 'SCM': null, 'TurboDraft': null },
		globalSettings: deepClone(defaultGlobalSettings),
		optionsOfModelSelection: { 'Chat': {}, 'Ctrl+K': {}, 'Autocomplete': {}, 'NextEdit': {}, 'Apply': {}, 'SCM': {}, 'TurboDraft': {} },
		overridesOfModel: deepClone(defaultOverridesOfModel),
		_modelOptions: [], // computed later
		mcpUserStateOfName: {},
	}
	return d
}


export const IVoidSettingsService = createDecorator<IVoidSettingsService>('VoidSettingsService');
class VoidSettingsService extends Disposable implements IVoidSettingsService {
	_serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<void>();
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes

	state: VoidSettingsState;

	private readonly _resolver: () => void
	waitForInitState: Promise<void> // await this if you need a valid state initially

	// Set when reading persisted settings THREW (decrypt or JSON.parse failed) and we fell back
	// to defaults. While set, _storeState() refuses to write.
	//
	// Without this, a single transient read failure was permanent data loss: the defaulted state
	// resolved waitForInitState, refreshModelService then auto-polls and writes on startup, and
	// the empty defaults got encrypted back over the user's real settings — deleting every API
	// key with no user action. This is Windows-hostile in particular, because the OSCrypt key
	// that decrypts this blob lives in <userData>\Local State and dies with the user-data dir,
	// whereas macOS keeps it in the login Keychain where it survives.
	//
	// NOTE: a first run with nothing stored is NOT a failure — _readState() returns defaults
	// without throwing, so the flag stays false and normal saving still works.
	private _loadFailed = false

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IEncryptionService private readonly _encryptionService: IEncryptionService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@INotificationService private readonly _notificationService: INotificationService,
		// could have used this, but it's clearer the way it is (+ slightly different eg StorageTarget.USER)
		// @ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
	) {
		super()

		// at the start, we haven't read the partial config yet, but we need to set state to something
		this.state = defaultState()
		let resolver: () => void = () => { }
		this.waitForInitState = new Promise((res, rej) => resolver = res)
		this._resolver = resolver

		this.readAndInitializeState()
	}




	dangerousSetState = async (newState: VoidSettingsState) => {
		// Explicit, user-initiated whole-state replacement (Reset Settings / settings import).
		// This is the escape hatch from _loadFailed: the guard exists to stop SILENT background
		// writes from clobbering unread settings, not to lock a user out of saving forever when
		// the stored blob is permanently undecryptable.
		this._loadFailed = false
		this.state = _validatedModelState(newState)
		await this._storeState()
		this._onDidChangeState.fire()
		this._onUpdate_syncApplyToChat()
		this._onUpdate_syncSCMToChat()
	}
	async resetState() {
		await this.dangerousSetState(defaultState())
	}




	async readAndInitializeState() {
		let readS: VoidSettingsState
		try {
			readS = await this._readState();
			// 1.0.3 addition, remove when enough users have had this code run
			if (readS.globalSettings.includeToolLintErrors === undefined) readS.globalSettings.includeToolLintErrors = true

			// autoapprove is now an obj not a boolean (1.2.5)
			if (typeof readS.globalSettings.autoApprove === 'boolean') readS.globalSettings.autoApprove = {}

			// Dangerous tool approval is opt-in. Older builds wrote `{ edits:true, terminal:true }`
			// as defaults, so clear those categories exactly once on upgrade. After the migration
			// flag is set, any user opt-in persists normally.
			if (readS.globalSettings.didMigrateAutoApproveDefaults === undefined) {
				readS.globalSettings.autoApprove.edits = false
				readS.globalSettings.autoApprove.terminal = false
				readS.globalSettings.didMigrateAutoApproveDefaults = true
			}

			// 1.3.5 add source control feature
			if (readS.modelSelectionOfFeature && !readS.modelSelectionOfFeature['SCM']) {
				readS.modelSelectionOfFeature['SCM'] = deepClone(readS.modelSelectionOfFeature['Chat'])
				readS.optionsOfModelSelection['SCM'] = deepClone(readS.optionsOfModelSelection['Chat'])
			}
			// NES gets its own model role (was hardcoded to the Autocomplete model). Seed from
			// Autocomplete so existing users keep exactly the behavior they had.
			if (readS.modelSelectionOfFeature && !readS.modelSelectionOfFeature['NextEdit']) {
				readS.modelSelectionOfFeature['NextEdit'] = deepClone(readS.modelSelectionOfFeature['Autocomplete'])
				readS.optionsOfModelSelection['NextEdit'] = deepClone(readS.optionsOfModelSelection['Autocomplete'] ?? {})
			}
			// Turbo Draft: dedicated slot. Seed from Chat only when Chat is a cloud model.
			if (readS.globalSettings.syncTurboDraftToChat === undefined) {
				readS.globalSettings.syncTurboDraftToChat = false
			}
			if (readS.modelSelectionOfFeature) {
				const chatSel = readS.modelSelectionOfFeature['Chat']
				const turboSel = readS.modelSelectionOfFeature['TurboDraft']
				const chatIsCloud = !!chatSel && chatSel.providerName !== 'v3code-local'
				if (!turboSel || turboSel.providerName === 'v3code-local') {
					if (chatIsCloud) {
						readS.modelSelectionOfFeature['TurboDraft'] = deepClone(chatSel)
						readS.optionsOfModelSelection['TurboDraft'] = deepClone(readS.optionsOfModelSelection['Chat'] ?? {})
					} else if (turboSel?.providerName === 'v3code-local') {
						readS.modelSelectionOfFeature['TurboDraft'] = null
					}
				}
			}
			// add disableSystemMessage feature
			if (readS.globalSettings.disableSystemMessage === undefined) readS.globalSettings.disableSystemMessage = false;
			
			// add autoAcceptLLMChanges feature
			if (readS.globalSettings.autoAcceptLLMChanges === undefined) readS.globalSettings.autoAcceptLLMChanges = false;
			// image describe mode (manual opt-in by default)
			if (readS.globalSettings.imageDescribeMode === undefined) readS.globalSettings.imageDescribeMode = 'manual';
			// vision transcription model: 'auto' picks the cheapest vision-capable model; a user can
			// pin a specific one (JSON-encoded selection). Normalize empty/missing to 'auto'.
			if (!readS.globalSettings.visionDescribeModel) readS.globalSettings.visionDescribeModel = 'auto';
			// prompt assembly preset (auto = full for cloud, lean for local/small-context).
			// Also normalize invalid strings (settings import applies raw JSON): the resolver
			// degrades gracefully, but persisted state should still be self-healing.
			if (!['auto', 'full', 'lean', 'minimal'].includes(readS.globalSettings.promptAssemblyPreset as string)) readS.globalSettings.promptAssemblyPreset = 'auto';
			// ask_user tool (multiple-choice questions with clickable options; default on)
			if (readS.globalSettings.enableAskUserTool === undefined) readS.globalSettings.enableAskUserTool = true;
			// Existing profiles predate this setting; default it on so behaviour is unchanged until
			// someone deliberately turns it off.
			if (readS.globalSettings.softContinueNudges === undefined) readS.globalSettings.softContinueNudges = true;

			// computer use (see the screen, drive mouse/keyboard; default OFF — opt-in only)
			if (readS.globalSettings.enableComputerUse === undefined) readS.globalSettings.enableComputerUse = false;
			// ambient observation (watch an approved app on a timer and keep a history; default OFF, and a
			// separate switch from enableComputerUse — being driven on request is not being watched)
			if (readS.globalSettings.enableComputerUseObservation === undefined) readS.globalSettings.enableComputerUseObservation = false;
			if (readS.globalSettings.shadowVerify === undefined) readS.globalSettings.shadowVerify = false;
			if (readS.globalSettings.memoryLibraryV2 === undefined) readS.globalSettings.memoryLibraryV2 = true;
			// Catalog C8 ship: memory library v2 always on (Phase 2 complete).
			readS.globalSettings.memoryLibraryV2 = true;
			if (readS.globalSettings.memoryLedger === undefined) readS.globalSettings.memoryLedger = true;
			readS.globalSettings.memoryLedger = true;
			// Autocomplete is opt-in. Older profiles may predate the migration marker, but they can
			// already contain an explicit user choice; preserve that value instead of forcing either
			// direction. Only a genuinely missing value inherits the lightweight default.
			if (readS.globalSettings.didMigrateAutocompleteDefault === undefined) {
				if (readS.globalSettings.enableAutocomplete === undefined) {
					readS.globalSettings.enableAutocomplete = false;
				}
				readS.globalSettings.didMigrateAutocompleteDefault = true;
			}
			// C1 hosted-origin tags: pre-tag installs persisted hosted tier picks as plain
			// {provider, model}, colliding with BYOK model names. Tag a selection as hosted
			// ONLY when the user has NO own key for that provider (then it can only have
			// come from the tier picker). With an own key present it stays BYOK — fail-open:
			// we never bill a user's own-key request to their plan; a genuine tier pick
			// re-tags itself on the next pick. Chat/Apply/SCM only — tagging Autocomplete/
			// NextEdit selections would bypass their FIM validation forever.
			if (readS.globalSettings.didMigrateHostedTierTags === undefined) {
				const ambiguous: string[] = [];
				for (const featureName of ['Chat', 'Apply', 'SCM'] as const) {
					const sel = readS.modelSelectionOfFeature?.[featureName];
					if (!sel || sel.hostedTierId) { continue; }
					const tier = hostedTierByWireName(sel.providerName, sel.modelName);
					if (!tier) { continue; }
					const apiKey = (readS.settingsOfProvider?.[sel.providerName] as { apiKey?: string } | undefined)?.apiKey;
					if (!apiKey) {
						readS.modelSelectionOfFeature[featureName] = { ...sel, hostedTierId: tier.id };
					} else {
						ambiguous.push(`${featureName} (${sel.modelName})`);
					}
				}
				readS.globalSettings.didMigrateHostedTierTags = true;
				if (ambiguous.length > 0) {
					// One-time heads-up: these features now run on the user's OWN key.
					// Silently moving where charges land generates support tickets.
					this._notificationService.info(localize('v3code.hostedTierMigration', "V3Code: {0} will now use your own API key since you have one set for that provider. Pick a V3 tier from the model picker to use your plan instead.", ambiguous.join(', ')));
				}
			}
		}
		catch (e) {
			// Reading/decrypting persisted settings failed. Keep running on defaults, but never
			// let those defaults be written back over the real settings.
			this._loadFailed = true
			console.error('[V3Code] failed to read persisted settings; running on defaults and BLOCKING writes to avoid overwriting them:', e)
			readS = defaultState()
		}

		// the stored data structure might be outdated, so we need to update it here
		try {
			readS = {
				...defaultState(),
				...readS,
				// no idea why this was here, seems like a bug
				// ...defaultSettingsOfProvider,
				// ...readS.settingsOfProvider,
			}

			for (const providerName of providerNames) {
				readS.settingsOfProvider[providerName] = {
					...defaultSettingsOfProvider[providerName],
					...readS.settingsOfProvider[providerName],
				} as any

				// conversion from 1.0.3 to 1.2.5 (can remove this when enough people update)
				for (const m of readS.settingsOfProvider[providerName].models) {
					if (!m.type) {
						const old = (m as { isAutodetected?: boolean; isDefault?: boolean })
						if (old.isAutodetected)
							m.type = 'autodetected'
						else if (old.isDefault)
							m.type = 'default'
						else m.type = 'custom'
					}
				}

				// remove when enough people have had it run (default is now {})
				if ((providerName === 'openAICompatible' || providerName === 'openAICompatible2' || providerName === 'openAICompatible3') && !readS.settingsOfProvider[providerName].headersJSON) {
					readS.settingsOfProvider[providerName].headersJSON = '{}'
				}
			}
		}

		catch (e) {
			this._loadFailed = true
			console.error('[V3Code] failed to migrate persisted settings; running on defaults and BLOCKING writes to avoid overwriting them:', e)
			readS = defaultState()
		}

		// A decrypt/parse hiccup above lands us on defaultState(), which reports onboarding as
		// incomplete and throws the full-screen overlay at an existing user. The mirrored flag is
		// written in plain storage and survives that fallback, so trust it when it says complete.
		if (!readS.globalSettings.isOnboardingComplete
			&& this._storageService.getBoolean(ONBOARDING_COMPLETE_KEY, StorageScope.APPLICATION, false)) {
			readS.globalSettings.isOnboardingComplete = true
		}
		// Backfill the mirror for users who completed onboarding BEFORE the mirror existed — their
		// blob says complete but plain storage has nothing, so the very hiccup the mirror protects
		// against would still re-show the overlay. Only after a HEALTHY read: a fallback-defaults
		// state proves nothing about what the user actually completed.
		if (!this._loadFailed
			&& readS.globalSettings.isOnboardingComplete
			&& !this._storageService.getBoolean(ONBOARDING_COMPLETE_KEY, StorageScope.APPLICATION, false)) {
			this._storageService.store(ONBOARDING_COMPLETE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER)
		}

		this.state = readS
		this.state = _stateWithMergedDefaultModels(this.state)
		this.state = _validatedModelState(this.state);

		if (this._loadFailed) {
			// Say so out loud. Silently running on defaults is what made this look like
			// "V3Code deleted my API keys" instead of "V3Code could not read them".
			this._notificationService.error(localize('v3code.settingsLoadFailed', "V3Code could not read your saved settings and is running with defaults. Your saved settings (including API keys) are preserved and will NOT be overwritten, so changes won't persist this session. Restart V3Code to try again; if it keeps failing, use Reset Settings to start fresh."))
		}

		this._resolver();
		this._onDidChangeState.fire();

	}


	private async _readState(): Promise<VoidSettingsState> {
		const encryptedState = this._storageService.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)

		if (!encryptedState)
			return defaultState()

		const stateStr = await this._encryptionService.decrypt(encryptedState)
		const state = JSON.parse(stateStr)
		return state
	}


	private async _storeState() {
		// Refuse to persist while running on fallback defaults — writing here would destroy the
		// stored settings (API keys included) that we merely failed to READ. The user can still
		// change settings in-memory for this session; a restart that reads successfully will
		// resume saving normally.
		if (this._loadFailed) {
			console.error('[V3Code] _storeState skipped: settings failed to load this session, so writing would overwrite the persisted settings.');
			return
		}
		try {
			const state = this.state
			const encryptedState = await this._encryptionService.encrypt(JSON.stringify(state))
			this._storageService.store(VOID_SETTINGS_STORAGE_KEY, encryptedState, StorageScope.APPLICATION, StorageTarget.USER);
		} catch (err) {
			console.error('[V3Code] _storeState failed (in-memory state still updated):', err);
		}
	}

	setSettingOfProvider: SetSettingOfProviderFn = async (providerName, settingName, newVal) => {

		const newModelSelectionOfFeature = this.state.modelSelectionOfFeature

		const newOptionsOfModelSelection = this.state.optionsOfModelSelection

		const newSettingsOfProvider: SettingsOfProvider = {
			...this.state.settingsOfProvider,
			[providerName]: {
				...this.state.settingsOfProvider[providerName],
				[settingName]: newVal,
			}
		}

		const newGlobalSettings = this.state.globalSettings
		const newOverridesOfModel = this.state.overridesOfModel
		const newMCPUserStateOfName = this.state.mcpUserStateOfName

		const newState = {
			modelSelectionOfFeature: newModelSelectionOfFeature,
			optionsOfModelSelection: newOptionsOfModelSelection,
			settingsOfProvider: newSettingsOfProvider,
			globalSettings: newGlobalSettings,
			overridesOfModel: newOverridesOfModel,
			mcpUserStateOfName: newMCPUserStateOfName,
		}

		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()

	}


	private _onUpdate_syncApplyToChat() {
		// if sync is turned on, sync (call this whenever Chat model or !!sync changes)
		this.setModelSelectionOfFeature('Apply', deepClone(this.state.modelSelectionOfFeature['Chat']))
	}

	private _onUpdate_syncSCMToChat() {
		this.setModelSelectionOfFeature('SCM', deepClone(this.state.modelSelectionOfFeature['Chat']))
	}

	private _onUpdate_syncTurboDraftToChat() {
		const chat = this.state.modelSelectionOfFeature['Chat']
		if (chat && chat.providerName === 'v3code-local') { return }
		this.setModelSelectionOfFeature('TurboDraft', deepClone(chat))
	}

	setGlobalSetting: SetGlobalSettingFn = async (settingName, newVal) => {
		const newState: VoidSettingsState = {
			...this.state,
			globalSettings: {
				...this.state.globalSettings,
				[settingName]: newVal
			}
		}
		this.state = _validatedModelState(newState)
		await this._storeState()

		// Mirror onboarding completion outside the encrypted blob so a later decrypt/parse failure
		// can't re-show the overlay. Must track BOTH directions — the "redo onboarding" button in
		// settings sets this false, and a stale mirror would silently suppress the replay.
		if (settingName === 'isOnboardingComplete') {
			if (newVal === true) {
				this._storageService.store(ONBOARDING_COMPLETE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER)
			} else {
				this._storageService.remove(ONBOARDING_COMPLETE_KEY, StorageScope.APPLICATION)
			}
		}

		this._onDidChangeState.fire()

		// hooks
		if (this.state.globalSettings.syncApplyToChat) this._onUpdate_syncApplyToChat()
		if (this.state.globalSettings.syncSCMToChat) this._onUpdate_syncSCMToChat()
		if (this.state.globalSettings.syncTurboDraftToChat) this._onUpdate_syncTurboDraftToChat()

	}


	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn = async (featureName, newVal) => {
		const newState: VoidSettingsState = {
			...this.state,
			modelSelectionOfFeature: {
				...this.state.modelSelectionOfFeature,
				[featureName]: newVal
			}
		}

		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()

		// hooks
		if (featureName === 'Chat') {
			// When Chat model changes, update synced features — but ONLY when their sync toggle
			// is on. Firing unconditionally overwrote a user's explicit Apply/SCM model choice
			// every time they changed the Chat model, even with "Same as Chat model" turned OFF.
			if (this.state.globalSettings.syncApplyToChat) this._onUpdate_syncApplyToChat()
			if (this.state.globalSettings.syncSCMToChat) this._onUpdate_syncSCMToChat()
			if (this.state.globalSettings.syncTurboDraftToChat) this._onUpdate_syncTurboDraftToChat()
		}
	}


	setOptionsOfModelSelection = async (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => {
		const newState: VoidSettingsState = {
			...this.state,
			optionsOfModelSelection: {
				...this.state.optionsOfModelSelection,
				[featureName]: {
					...this.state.optionsOfModelSelection[featureName],
					[providerName]: {
						...this.state.optionsOfModelSelection[featureName][providerName],
						[modelName]: {
							...this.state.optionsOfModelSelection[featureName][providerName]?.[modelName],
							...newVal
						}
					}
				}
			}
		}
		this.state = _validatedModelState(newState)

		await this._storeState()
		this._onDidChangeState.fire()
	}

	setOverridesOfModel = async (providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined) => {
		const discovered = this.state.overridesOfModel[providerName][modelName]?._discoveredCapabilities;
		const newState: VoidSettingsState = {
			...this.state,
			overridesOfModel: {
				...this.state.overridesOfModel,
				[providerName]: {
					...this.state.overridesOfModel[providerName],
					[modelName]: overrides === undefined ? (discovered ? { _discoveredCapabilities: discovered } : undefined) : {
						...this.state.overridesOfModel[providerName][modelName],
						...overrides
					},
				}
			}
		};

		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();

		this._metricsService.capture('Update Model Overrides', { providerName, modelName, overrides });
	}




	async setOpenRouterCatalogue(rows: readonly unknown[]): Promise<void> {
		const catalogue = parseOpenRouterCatalogue(rows);
		if (!catalogue.size) { return; } // A malformed/empty response must not wipe user settings.
		const models = mergeOpenRouterModels(this.state.settingsOfProvider.openRouter.models, [...catalogue.keys()]);
		const overrides = { ...this.state.overridesOfModel.openRouter };
		for (const [id, capabilities] of catalogue) {
			overrides[id] = { ...overrides[id], _discoveredCapabilities: capabilities };
		}
		this.state = _validatedModelState({ ...this.state,
			settingsOfProvider: { ...this.state.settingsOfProvider, openRouter: { ...this.state.settingsOfProvider.openRouter, models } },
			overridesOfModel: { ...this.state.overridesOfModel, openRouter: overrides },
		});
		await this._storeState();
		this._onDidChangeState.fire();
	}

	setAutodetectedModels(providerName: ProviderName, autodetectedModelNames: string[], logging: object) {

		const { models } = this.state.settingsOfProvider[providerName]
		const oldModelNames = models.map(m => m.modelName)

		const newModels = _modelsWithSwappedInNewModels({ existingModels: models, models: autodetectedModelNames, type: 'autodetected' })
		if (_modelsEqual(models, newModels)) {
			return
		}
		this.setSettingOfProvider(providerName, 'models', newModels)

		// if the models changed, log it
		const new_names = newModels.map(m => m.modelName)
		if (!(oldModelNames.length === new_names.length
			&& oldModelNames.every((_, i) => oldModelNames[i] === new_names[i]))
		) {
			this._metricsService.capture('Autodetect Models', { providerName, newModels: newModels, ...logging })
		}
	}
	toggleModelHidden(providerName: ProviderName, modelName: string) {


		const { models } = this.state.settingsOfProvider[providerName]
		const modelIdx = models.findIndex(m => m.modelName === modelName)
		if (modelIdx === -1) return
		const newIsHidden = !models[modelIdx].isHidden
		const newModels: VoidStatefulModelInfo[] = [
			...models.slice(0, modelIdx),
			{ ...models[modelIdx], isHidden: newIsHidden },
			...models.slice(modelIdx + 1, Infinity)
		]
		this.setSettingOfProvider(providerName, 'models', newModels)

		this._metricsService.capture('Toggle Model Hidden', { providerName, modelName, newIsHidden })

	}
	addModel(providerName: ProviderName, modelName: string) {
		const { models } = this.state.settingsOfProvider[providerName]
		const existingIdx = models.findIndex(m => m.modelName === modelName)
		if (existingIdx !== -1) return // if exists, do nothing
		const newModels = [
			...models,
			{ modelName, type: 'custom', isHidden: false } as const
		]
		this.setSettingOfProvider(providerName, 'models', newModels)

		this._metricsService.capture('Add Model', { providerName, modelName })

	}
	deleteModel(providerName: ProviderName, modelName: string): boolean {
		const { models } = this.state.settingsOfProvider[providerName]
		const delIdx = models.findIndex(m => m.modelName === modelName)
		if (delIdx === -1) return false
		const newModels = [
			...models.slice(0, delIdx), // delete the idx
			...models.slice(delIdx + 1, Infinity)
		]
		this.setSettingOfProvider(providerName, 'models', newModels)

		this._metricsService.capture('Delete Model', { providerName, modelName })

		return true
	}

	// MCP Server State
	private _setMCPUserStateOfName = async (newStates: MCPUserStateOfName) => {
		const newState: VoidSettingsState = {
			...this.state,
			mcpUserStateOfName: {
				...this.state.mcpUserStateOfName,
				...newStates
			}
		};
		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();
		this._metricsService.capture('Set MCP Server States', { newStates });
	}

	addMCPUserStateOfNames = async (newMCPStates: MCPUserStateOfName) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state
		const newMCPServerStates = {
			...mcpServerStates,
			...newMCPStates,
		}
		await this._setMCPUserStateOfName(newMCPServerStates)
		this._metricsService.capture('Add MCP Servers', { servers: Object.keys(newMCPStates).join(', ') });
	}

	removeMCPUserStateOfNames = async (serverNames: string[]) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state
		const newMCPServerStates = {
			...mcpServerStates,
		}
		serverNames.forEach(serverName => {
			if (serverName in newMCPServerStates) {
				delete newMCPServerStates[serverName]
			}
		})
		await this._setMCPUserStateOfName(newMCPServerStates)
		this._metricsService.capture('Remove MCP Servers', { servers: serverNames.join(', ') });
	}

	setMCPServerState = async (serverName: string, state: MCPUserState) => {
		const { mcpUserStateOfName } = this.state
		const newMCPServerStates = {
			...mcpUserStateOfName,
			[serverName]: state,
		}
		await this._setMCPUserStateOfName(newMCPServerStates)
		this._metricsService.capture('Update MCP Server State', { serverName, state });
	}

}


registerSingleton(IVoidSettingsService, VoidSettingsService, InstantiationType.Eager);
