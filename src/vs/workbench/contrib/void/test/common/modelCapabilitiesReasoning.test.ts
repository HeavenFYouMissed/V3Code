/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities, getProviderCapabilities, getSendableReasoningInfo, getIsReasoningEnabledState } from '../../common/modelCapabilities.js';
import { ModelSelectionOptions } from '../../common/voidSettingsTypes.js';

suite('void modelCapabilities anthropic reasoning wire', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const includeInPayload = getProviderCapabilities('anthropic').providerReasoningIOSettings?.input?.includeInPayload;
	// what actually lands in the request body for a given model + user options
	const payloadFor = (modelName: string, options: ModelSelectionOptions | undefined) => {
		assert.ok(includeInPayload, 'anthropic must define includeInPayload');
		return includeInPayload(getSendableReasoningInfo('Chat', 'anthropic', modelName, options, undefined));
	};

	test('Chat hard-codes reasoning ON for every capable model (a stored reasoningEnabled:false is ignored)', () => {
		// V3Code policy: thinking is a core, non-optional part of Chat. Any model that supports
		// reasoning ALWAYS reasons in Chat, and a stale/stored reasoningEnabled:false can never
		// suppress it (getIsReasoningEnabledState forces it on).
		for (const modelName of ['claude-sonnet-5', 'claude-sonnet-5-latest', 'claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-3-7-sonnet-20250219']) {
			assert.strictEqual(getIsReasoningEnabledState('Chat', 'anthropic', modelName, { reasoningEnabled: false }, undefined), true, modelName);
			assert.strictEqual(getIsReasoningEnabledState('Chat', 'anthropic', modelName, undefined, undefined), true, modelName);
			// And the off flag produces the identical wire payload as the default (i.e. it is ignored).
			assert.deepStrictEqual(payloadFor(modelName, { reasoningEnabled: false }), payloadFor(modelName, undefined), modelName);
		}
	});

	test('local Chat defaults hybrid thinking off but honors the per-model switch', () => {
		for (const providerName of ['ollama', 'vLLM', 'lmStudio'] as const) {
			assert.strictEqual(getIsReasoningEnabledState('Chat', providerName, 'qwen3:8b', undefined, undefined), false, providerName);
			assert.strictEqual(getIsReasoningEnabledState('Chat', providerName, 'qwen3:8b', { reasoningEnabled: true }, undefined), true, providerName);
			assert.strictEqual(getIsReasoningEnabledState('Chat', providerName, 'qwen3:8b', { reasoningEnabled: false }, undefined), false, providerName);
		}
	});

	test('the explicit thinking-disable wire format is unchanged (still used by non-Chat features)', () => {
		// The disable wire itself is untouched - only the Chat enablement is forced. Non-Chat
		// features (apply/autocomplete) can still disable reasoning and reach this wire shape.
		assert.ok(includeInPayload, 'anthropic must define includeInPayload');
		assert.deepStrictEqual(includeInPayload({ type: 'disabled', isReasoningEnabled: false }), { thinking: { type: 'disabled' } });
	});

	test('sonnet 5 reasoning ON is unchanged: adaptive + summarized display + effort', () => {
		// Chat defaults reasoning to enabled; slider default is 'high'.
		assert.deepStrictEqual(payloadFor('claude-sonnet-5', undefined),
			{ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } });
	});

	test('sonnet 5 exposes xhigh on the effort slider and passes it through to the wire', () => {
		const caps = getModelCapabilities('anthropic', 'claude-sonnet-5', undefined).reasoningCapabilities;
		const slider = caps ? caps.reasoningSlider : undefined;
		if (!slider || slider.type !== 'effort_slider') { return assert.fail('sonnet 5 must use the effort slider'); }
		assert.deepStrictEqual(slider.values, ['low', 'medium', 'high', 'xhigh']);
		assert.strictEqual(slider.default, 'high');
		assert.deepStrictEqual(payloadFor('claude-sonnet-5', { reasoningEffort: 'xhigh' }),
			{ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'xhigh' } });
	});

	test('providers that do not know the disabled variant treat it as plain off', () => {
		const openAIInclude = getProviderCapabilities('openAI').providerReasoningIOSettings?.input?.includeInPayload;
		assert.ok(openAIInclude, 'openAI must define includeInPayload');
		assert.strictEqual(openAIInclude({ type: 'disabled', isReasoningEnabled: false }), null);
	});
});
