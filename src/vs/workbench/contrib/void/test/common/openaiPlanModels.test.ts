/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { defaultModelsOfProvider, getModelCapabilities } from '../../common/modelCapabilities.js';
import { defaultOverridesOfModel, displayInfoOfProviderName, isProviderTemporarilyDisabled, nonlocalProviderNames, subTextMdOfProviderName } from '../../common/voidSettingsTypes.js';
import { routerBillingLaneOfSelection } from '../../common/router/modelCandidates.js';

suite('OpenAI (Plan) models', () => {
	test('is enabled and visible in provider settings', () => {
		// Re-enabled 2026-09-12. The 400s that took this lane offline were caused by the shipped
		// MODEL IDS (`gpt-5.4` is not served to a ChatGPT account on the Codex endpoint), not by the
		// system prompt the original plan doc blamed — a custom `instructions` string is accepted.
		assert.strictEqual(isProviderTemporarilyDisabled('openaiPlan'), false);
		assert.ok(nonlocalProviderNames.includes('openaiPlan'));
	});

	test('lists only ids the Codex endpoint serves to a ChatGPT account, at cost 0', () => {
		// Every id here answered HTTP 200 with a real `function_call` against the live endpoint on
		// 2026-09-12 using a ChatGPT Pro account.
		for (const modelName of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex-spark', 'gpt-6-astra']) {
			assert.ok((defaultModelsOfProvider.openaiPlan as readonly string[]).includes(modelName), modelName);
		}
		// Ids the endpoint rejects must never be offered. A model that 400s on every turn is worse
		// than an absent one, and `gpt-5.4` was exactly that: the old default for this lane.
		for (const unsupported of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5-pro', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5-codex']) {
			assert.ok(!(defaultModelsOfProvider.openaiPlan as readonly string[]).includes(unsupported), `${unsupported} 400s on this lane`);
		}
		for (const modelName of defaultModelsOfProvider.openaiPlan) {
			const caps = getModelCapabilities('openaiPlan', modelName, defaultOverridesOfModel);
			assert.strictEqual(caps.cost.input, 0, modelName);
			assert.strictEqual(caps.cost.output, 0, modelName);
			assert.strictEqual(caps.specialToolFormat, 'openai-style', modelName);
			// The Codex endpoint rejects a `system` message outright
			// (`400 {"detail":"System messages are not allowed"}`) and accepts only `developer`.
			assert.strictEqual(caps.supportsSystemMessage, 'developer-role', modelName);
		}
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'openaiPlan', modelName: 'gpt-5.5' }), 'subscription');
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'openAI', modelName: 'gpt-5.5' }), 'byok');
		assert.strictEqual(displayInfoOfProviderName('openaiPlan').title, 'OpenAI (Plan)');
		assert.ok(subTextMdOfProviderName('openaiPlan').includes('never falls back'));
	});
});
