/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ILanguageModelConfigurationSchema } from '../../chat/common/languageModels.js';
import {
	getIsReasoningEnabledState,
	getModelCapabilities,
	isOpusHybridModel,
} from '../common/modelCapabilities.js';
import type { AdvisorEffort, FeatureName, ModelSelection, ModelSelectionOptions, OverridesOfModel, ProviderName } from '../common/voidSettingsTypes.js';

/** Single navigation-group property key used by the native chat model picker effort button. */
export const V3CODE_REASONING_CONFIG_KEY = 'v3codeReasoning';
export const V3CODE_ADVISOR_CONFIG_KEY = 'v3codeAdvisor';

const BUDGET_STEPS = [1024, 2048, 4096, 8192] as const;

export function buildV3CodeConfigurationSchema(
	providerName: ProviderName,
	modelName: string,
	overridesOfModel: OverridesOfModel | undefined,
	options: ModelSelectionOptions | undefined,
	featureName: FeatureName = 'Chat',
): ILanguageModelConfigurationSchema | undefined {
	const { reasoningCapabilities } = getModelCapabilities(providerName, modelName, overridesOfModel);
	const properties: ILanguageModelConfigurationSchema['properties'] = {};
	const { canTurnOffReasoning, reasoningSlider } = reasoningCapabilities || {};
	const enumValues: string[] = [];
	const enumLabels: string[] = [];

	if (reasoningCapabilities && reasoningCapabilities.supportsReasoning && canTurnOffReasoning) {
		enumValues.push('off');
		enumLabels.push('Off');
	}

	if (reasoningCapabilities && reasoningCapabilities.supportsReasoning && reasoningSlider?.type === 'effort_slider') {
		for (const effort of reasoningSlider.values) {
			enumValues.push(effort);
			enumLabels.push(effort.charAt(0).toUpperCase() + effort.slice(1));
		}
	} else if (reasoningCapabilities && reasoningCapabilities.supportsReasoning && reasoningSlider?.type === 'budget_slider') {
		for (const budget of BUDGET_STEPS) {
			if (budget >= reasoningSlider.min && budget <= reasoningSlider.max) {
				enumValues.push(String(budget));
				enumLabels.push(budget >= 1000 ? `${budget / 1000}k` : String(budget));
			}
		}
	} else if (reasoningCapabilities && reasoningCapabilities.supportsReasoning && canTurnOffReasoning) {
		enumValues.push('on');
		enumLabels.push('On');
	}

	if (enumValues.length >= 2) {
		properties[V3CODE_REASONING_CONFIG_KEY] = {
			type: 'string',
			title: 'Thinking',
			enum: enumValues,
			enumItemLabels: enumLabels,
			default: encodeV3CodeReasoningConfig(
				providerName,
				modelName,
				overridesOfModel,
				options,
				featureName,
			),
			group: 'navigation',
		};
	}

	if (isOpusHybridModel(providerName, modelName)) {
		properties[V3CODE_ADVISOR_CONFIG_KEY] = {
			type: 'string',
			title: 'Advisor',
			enum: ['easy', 'hard'],
			enumItemLabels: ['Easy', 'Hard'],
			default: encodeV3CodeAdvisorConfig(options),
			group: 'navigation',
		};
	}

	if (Object.keys(properties).length === 0) {
		return undefined;
	}

	return {
		properties,
	};
}

export function encodeV3CodeAdvisorConfig(options: ModelSelectionOptions | undefined): AdvisorEffort {
	return options?.advisorEffort === 'easy' ? 'easy' : 'hard';
}

export function encodeV3CodeReasoningConfig(
	providerName: ProviderName,
	modelName: string,
	overridesOfModel: OverridesOfModel | undefined,
	options: ModelSelectionOptions | undefined,
	featureName: FeatureName = 'Chat',
): string {
	const { reasoningCapabilities } = getModelCapabilities(providerName, modelName, overridesOfModel);
	if (!reasoningCapabilities || !reasoningCapabilities.supportsReasoning) {
		return 'off';
	}

	const isEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, options, overridesOfModel);
	if (!isEnabled && reasoningCapabilities.canTurnOffReasoning) {
		return 'off';
	}

	const slider = reasoningCapabilities.reasoningSlider;
	if (slider?.type === 'effort_slider') {
		return options?.reasoningEffort ?? slider.default;
	}
	if (slider?.type === 'budget_slider') {
		return String(options?.reasoningBudget ?? slider.default);
	}

	return isEnabled ? 'on' : 'off';
}

export function decodeV3CodeReasoningConfig(
	value: string,
	providerName: ProviderName,
	modelName: string,
	overridesOfModel: OverridesOfModel | undefined,
): ModelSelectionOptions {
	const { reasoningCapabilities } = getModelCapabilities(providerName, modelName, overridesOfModel);
	const slider = reasoningCapabilities ? reasoningCapabilities.reasoningSlider : undefined;

	if (value === 'off') {
		return { reasoningEnabled: false };
	}
	if (value === 'on') {
		return { reasoningEnabled: true };
	}
	if (slider?.type === 'effort_slider' && slider.values.includes(value)) {
		return { reasoningEnabled: true, reasoningEffort: value };
	}
	if (slider?.type === 'budget_slider') {
		const budget = Number(value);
		if (Number.isFinite(budget)) {
			return { reasoningEnabled: true, reasoningBudget: budget };
		}
	}

	return { reasoningEnabled: true };
}

export function decodeV3CodeAdvisorConfig(value: string): ModelSelectionOptions {
	return { advisorEffort: value === 'easy' ? 'easy' : 'hard' };
}

export function modelSelectionFromV3CodeModelId(modelId: string): ModelSelection | null {
	const parts = modelId.split('/');
	if (parts.length >= 3 && parts[0] === 'v3code' && parts[1] !== 'none' && parts[1] !== 'tier') {
		return {
			providerName: parts[1] as ProviderName,
			modelName: parts.slice(2).join('/'),
		};
	}
	return null;
}

export function v3CodeModelConfigurationFromOptions(
	modelId: string,
	options: ModelSelectionOptions | undefined,
	overridesOfModel: OverridesOfModel | undefined,
): Record<string, unknown> | undefined {
	const selection = modelSelectionFromV3CodeModelId(modelId);
	if (!selection) {
		return undefined;
	}
	const schema = buildV3CodeConfigurationSchema(
		selection.providerName,
		selection.modelName,
		overridesOfModel,
		options,
	);
	if (!schema) {
		return undefined;
	}
	const properties = schema.properties ?? {};
	const config: Record<string, unknown> = {};
	if (V3CODE_REASONING_CONFIG_KEY in properties) {
		config[V3CODE_REASONING_CONFIG_KEY] = encodeV3CodeReasoningConfig(
			selection.providerName,
			selection.modelName,
			overridesOfModel,
			options,
		);
	}
	if (V3CODE_ADVISOR_CONFIG_KEY in properties) {
		config[V3CODE_ADVISOR_CONFIG_KEY] = encodeV3CodeAdvisorConfig(options);
	}
	return config;
}
