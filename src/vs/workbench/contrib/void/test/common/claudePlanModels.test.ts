/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { defaultModelsOfProvider, getModelCapabilities, isOpusHybridModel, OPUS_HYBRID_MODEL_NAME } from '../../common/modelCapabilities.js';
import { defaultOverridesOfModel, defaultSettingsOfProvider, MAX_VISIBLE_DEFAULT_MODELS } from '../../common/voidSettingsTypes.js';

/** Model names a fresh install actually shows in the picker for a provider. */
const visibleDefaults = (providerName: keyof typeof defaultSettingsOfProvider): string[] =>
	defaultSettingsOfProvider[providerName].models.filter(m => !m.isHidden).map(m => m.modelName);

suite('Claude Plan models', () => {
	test('offers Opus 4.6 and the Advisor hybrid on the subscription lane', () => {
		assert.ok(defaultModelsOfProvider.claudePlan.includes(OPUS_HYBRID_MODEL_NAME));
		assert.ok(defaultModelsOfProvider.claudePlan.includes('claude-opus-4-6'));
		assert.ok(isOpusHybridModel('claudePlan', OPUS_HYBRID_MODEL_NAME));
		assert.strictEqual(getModelCapabilities('claudePlan', OPUS_HYBRID_MODEL_NAME, defaultOverridesOfModel).cost.input, 0);
		assert.strictEqual(getModelCapabilities('claudePlan', 'claude-opus-4-6', defaultOverridesOfModel).cost.input, 0);
	});

	test('does not classify unrelated Claude Plan models as the Advisor hybrid', () => {
		assert.ok(!isOpusHybridModel('claudePlan', 'claude-opus-4-6'));
		assert.ok(!isOpusHybridModel('openAI', OPUS_HYBRID_MODEL_NAME));
	});

	test('Fable 5.1 is offered on BOTH the Claude Plan and Anthropic lanes', () => {
		// The wire id is the hyphenated minor. `claude-fable-5.1` is not a real id and 404s.
		assert.ok(defaultModelsOfProvider.claudePlan.includes('claude-fable-5-1'));
		assert.ok(defaultModelsOfProvider.anthropic.includes('claude-fable-5-1'));
		// Subscription turns are billed to the plan, so the plan lane must be zero-cost...
		assert.strictEqual(getModelCapabilities('claudePlan', 'claude-fable-5-1', defaultOverridesOfModel).cost.input, 0);
		// ...while the metered API lane keeps real published pricing ($10 in / $50 out per Mtok).
		const billed = getModelCapabilities('anthropic', 'claude-fable-5-1', defaultOverridesOfModel);
		assert.strictEqual(billed.cost.input, 10);
		assert.strictEqual(billed.cost.output, 50);
	});

	test('Fable 5.1 is a record of its own, not resolved as Fable 5', () => {
		// 'claude-fable-5-1' CONTAINS 'claude-fable-5', so a mis-ordered substring fallback would
		// silently give 5.1 the old model's config and 4x-wrong cache pricing.
		for (const providerName of ['anthropic', 'claudePlan'] as const) {
			assert.strictEqual(
				getModelCapabilities(providerName, 'claude-fable-5-1', defaultOverridesOfModel).recognizedModelName,
				'claude-fable-5-1',
				providerName,
			);
		}
		assert.strictEqual(getModelCapabilities('anthropic', 'claude-fable-5-1', defaultOverridesOfModel).cost.cache_read, 0.25);
		assert.strictEqual(getModelCapabilities('anthropic', 'claude-fable-5', defaultOverridesOfModel).cost.cache_read, 1);
	});

	test('Fable 5.1 uses the adaptive effort slider, never budget thinking', () => {
		// Adaptive models 400 on `thinking.type.enabled` (budget_tokens); the effort slider is
		// what routes them to the `thinking.type.adaptive` payload.
		const reasoning = getModelCapabilities('anthropic', 'claude-fable-5-1', defaultOverridesOfModel).reasoningCapabilities;
		assert.ok(reasoning && reasoning.supportsReasoning);
		assert.strictEqual(reasoning.reasoningSlider?.type, 'effort_slider');
		// Fable/Mythos 400 on an explicit `thinking: { type: 'disabled' }`, so they must stay on
		// the omission path and must NOT carry omittedThinkingRunsAdaptive.
		assert.strictEqual(reasoning.omittedThinkingRunsAdaptive, undefined);
	});

	test('a provider with many defaults hides only the tail, never the whole picker', () => {
		// Regression guard for the rule that blocked this work: isHidden used to be
		// `defaultModelNames.length >= 10`, so a provider's TENTH default hid ALL of its models
		// and left a fresh install with an empty picker for that provider.
		for (const providerName of ['anthropic', 'claudePlan'] as const) {
			const visible = visibleDefaults(providerName);
			assert.ok(visible.length > 0, `${providerName} has no visible default models`);
			assert.ok(visible.includes('claude-fable-5-1'), `${providerName} hides Fable 5.1`);
			assert.ok(visible.includes(OPUS_HYBRID_MODEL_NAME), `${providerName} hides the hybrid`);
			assert.ok(visible.length <= MAX_VISIBLE_DEFAULT_MODELS, `${providerName} shows too many by default`);
		}
	});
});
