/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Keeps native chat model-picker thinking/effort controls in sync with VoidSettingsService,
 * which is what v3codeChatAgent reads when building LLM requests.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import type { ModelSelection, ModelSelectionOptions } from '../common/voidSettingsTypes.js';
import {
	decodeV3CodeAdvisorConfig,
	decodeV3CodeReasoningConfig,
	modelSelectionFromV3CodeModelId,
	V3CODE_ADVISOR_CONFIG_KEY,
	V3CODE_REASONING_CONFIG_KEY,
	v3CodeModelConfigurationFromOptions,
} from './v3codeModelConfiguration.js';

const V3CODE_VENDOR = 'v3code';

class V3CodeReasoningConfigBridge extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3codeReasoningConfigBridge';

	private _syncing = false;

	constructor(
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IProductService productService: IProductService,
	) {
		super();

		if (productService.defaultChatAgent?.extensionId !== 'v3code.v3code') {
			return;
		}

		this._register(this.settingsService.onDidChangeState(() => {
			if (this._syncing) {
				return;
			}
			this._pushVoidSettingsToLanguageModels();
		}));

		this._register(this.languageModelsService.onDidChangeLanguageModels(() => {
			this._seedLanguageModelsFromVoidSettings();
		}));

		this._seedLanguageModelsFromVoidSettings();
	}

	private _currentChatSelection(): ModelSelection | null {
		return this.settingsService.state.modelSelectionOfFeature?.['Chat'] ?? null;
	}

	private _modelIdForSelection(selection: ModelSelection): string {
		return `${V3CODE_VENDOR}/${selection.providerName}/${selection.modelName}`;
	}

	private _pushVoidSettingsToLanguageModels(): void {
		const selection = this._currentChatSelection();
		if (!selection) {
			return;
		}

		const modelId = this._modelIdForSelection(selection);
		const metadata = this.languageModelsService.lookupLanguageModel(modelId);
		if (!metadata || metadata.vendor !== V3CODE_VENDOR) {
			return;
		}

		const options = this.settingsService.state.optionsOfModelSelection['Chat']?.[selection.providerName]?.[selection.modelName];
		const config = v3CodeModelConfigurationFromOptions(modelId, options, this.settingsService.state.overridesOfModel);
		if (!config) {
			return;
		}

		const existing = this.languageModelsService.getModelConfiguration(modelId) ?? {};
		const nextValue = config[V3CODE_REASONING_CONFIG_KEY];
		if (existing[V3CODE_REASONING_CONFIG_KEY] === nextValue) {
			return;
		}

		this._syncing = true;
		try {
			this.languageModelsService.setModelConfiguration(modelId, config);
		} finally {
			this._syncing = false;
		}
	}

	/**
	 * One-time heal for stale per-model options left from the inverted-toggle era:
	 * explicit `reasoningEnabled: false` while Chat defaults to enabled and the user
	 * has the global Thinking lever set to 'on'.
	 */
	private _maybeHealStaleReasoningOptions(
		selection: ModelSelection,
		options: ModelSelectionOptions | undefined,
	): ModelSelectionOptions | undefined {
		// Local models intentionally support Thinking Off in Chat. Never "heal" that explicit
		// low-latency choice using the retired global cloud-thinking preference.
		if (selection.providerName === 'ollama' || selection.providerName === 'vLLM' || selection.providerName === 'lmStudio') {
			return options;
		}
		const thinkingPref = this.configurationService.getValue<'default' | 'on' | 'off'>('v3code.agent.thinking');
		if (thinkingPref !== 'on' || options?.reasoningEnabled !== false) {
			return options;
		}

		const { reasoningCapabilities } = getModelCapabilities(
			selection.providerName,
			selection.modelName,
			this.settingsService.state.overridesOfModel,
		);
		if (reasoningCapabilities === false) {
			return options;
		}

		const needsEffortHeal = options.reasoningEffort === 'off';
		const healPatch: Partial<ModelSelectionOptions> = { reasoningEnabled: undefined };
		if (needsEffortHeal) {
			healPatch.reasoningEffort = undefined;
		}
		void this.settingsService.setOptionsOfModelSelection('Chat', selection.providerName, selection.modelName, healPatch);

		const { reasoningEnabled: _staleOff, reasoningEffort: _staleEffort, ...rest } = options;
		return Object.keys(rest).length > 0 ? rest : undefined;
	}

	private _seedLanguageModelsFromVoidSettings(): void {
		if (this._syncing) {
			return;
		}

		const state = this.settingsService.state;
		const chatOptions = state.optionsOfModelSelection['Chat'] ?? {};
		const modelsToSeed: ModelSelection[] = [];

		const chatSelection = state.modelSelectionOfFeature?.['Chat'];
		if (chatSelection) {
			modelsToSeed.push(chatSelection);
		}

		for (const opt of state._modelOptions ?? []) {
			modelsToSeed.push(opt.selection);
		}

		this._syncing = true;
		try {
			for (const selection of modelsToSeed) {
				const modelId = this._modelIdForSelection(selection);
				const metadata = this.languageModelsService.lookupLanguageModel(modelId);
				if (!metadata || metadata.vendor !== V3CODE_VENDOR) {
					continue;
				}

				const rawOptions = chatOptions[selection.providerName]?.[selection.modelName];
				const options = this._maybeHealStaleReasoningOptions(selection, rawOptions);
				const config = v3CodeModelConfigurationFromOptions(modelId, options, state.overridesOfModel);
				if (!config) {
					continue;
				}

				const existing = this.languageModelsService.getModelConfiguration(modelId) ?? {};
				if (existing[V3CODE_REASONING_CONFIG_KEY] !== config[V3CODE_REASONING_CONFIG_KEY]) {
					this.languageModelsService.setModelConfiguration(modelId, config);
				}
			}
		} finally {
			this._syncing = false;
		}

		this._registerModelConfigurationListener();
	}

	private _modelConfigListenerRegistered = false;

	private _registerModelConfigurationListener(): void {
		if (this._modelConfigListenerRegistered) {
			return;
		}
		this._modelConfigListenerRegistered = true;

		// LanguageModelsService has no onDidChangeModelConfiguration — poll via
		// setModelConfiguration calls from the picker. Hook setModelConfiguration
		// by wrapping is not available; instead listen through a custom event path.
		// The picker calls setModelConfiguration directly; we intercept by patching
		// the service method once.
		const original = this.languageModelsService.setModelConfiguration.bind(this.languageModelsService);
		this._register({
			dispose: () => {
				this.languageModelsService.setModelConfiguration = original;
			},
		});

		this.languageModelsService.setModelConfiguration = async (modelId: string, values: Record<string, unknown>) => {
			if (this._syncing) {
				return original(modelId, values);
			}

			const selection = modelSelectionFromV3CodeModelId(modelId);
			if (!selection) {
				return original(modelId, values);
			}

			const rawReasoning = values[V3CODE_REASONING_CONFIG_KEY];
			const rawAdvisor = values[V3CODE_ADVISOR_CONFIG_KEY];
			if (typeof rawReasoning !== 'string' && typeof rawAdvisor !== 'string') {
				return original(modelId, values);
			}

			const decoded = {
				...(typeof rawReasoning === 'string' ? decodeV3CodeReasoningConfig(
					rawReasoning,
					selection.providerName,
					selection.modelName,
					this.settingsService.state.overridesOfModel,
				) : {}),
				...(typeof rawAdvisor === 'string' ? decodeV3CodeAdvisorConfig(rawAdvisor) : {}),
			};

			this._syncing = true;
			try {
				// Persist the user's selection before model-change notifications can seed
				// the picker from the previous settings and undo this choice.
				await this.settingsService.setOptionsOfModelSelection('Chat', selection.providerName, selection.modelName, decoded);
				await original(modelId, values);
			} finally {
				this._syncing = false;
			}
		};
	}
}

registerWorkbenchContribution2(V3CodeReasoningConfigBridge.ID, V3CodeReasoningConfigBridge, WorkbenchPhase.AfterRestored);
