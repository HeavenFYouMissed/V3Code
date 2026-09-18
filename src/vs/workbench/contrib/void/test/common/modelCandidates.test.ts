/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { OPUS_HYBRID_MODEL_NAME } from '../../common/modelCapabilities.js';
import { V3_MODEL_TIERS } from '../../common/modelTiers.js';
import { estimateRouterPromptComplexity, resolveRouterTierForOrigin, routerBillingLaneOfSelection, routerCandidatesForOrigin, routerCapabilityBandOfSelection, selectAutoRouterCandidate } from '../../common/router/modelCandidates.js';
import type { ModelSelection } from '../../common/voidSettingsTypes.js';

suite('Provider-aware Auto Router candidates', () => {
	test('classifies authentication and billing lanes', () => {
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'v3code-free', modelName: 'auto-free' }), 'free');
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'ollama', modelName: 'qwen' }), 'local');
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'v3code-local', modelName: 'built-in' }), 'local');
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'claudePlan', modelName: 'claude-opus-4-6' }), 'subscription');
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'cursorLocal', modelName: 'composer-2.5' }), 'subscription');
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'openaiPlan', modelName: 'gpt-5.4' }), 'subscription');
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'openAI', modelName: 'gpt-5.4' }), 'byok');
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'anthropic', modelName: 'claude-opus-4-6' }), 'byok');
		assert.strictEqual(routerBillingLaneOfSelection({ providerName: 'deepseek', modelName: 'deepseek-v4-pro', hostedTierId: 'V3Pro' }), 'hosted');
	});

	test('keeps subscription routes inside the exact subscribed provider', () => {
		const origin: ModelSelection = { providerName: 'claudePlan', modelName: 'claude-opus-4-6' };
		const candidates = routerCandidatesForOrigin([
			{ providerName: 'claudePlan', modelName: OPUS_HYBRID_MODEL_NAME },
			{ providerName: 'copilot', modelName: 'claude-opus-4-6' },
			{ providerName: 'anthropic', modelName: OPUS_HYBRID_MODEL_NAME },
		], origin);

		assert.deepStrictEqual(candidates.map(candidate => candidate.providerName), ['claudePlan', 'claudePlan']);
	});

	test('does not cross API keys unless a future explicit opt-in enables it', () => {
		const origin: ModelSelection = { providerName: 'anthropic', modelName: 'claude-opus-4-6' };
		const available: ModelSelection[] = [
			{ providerName: 'anthropic', modelName: OPUS_HYBRID_MODEL_NAME },
			{ providerName: 'openAI', modelName: 'gpt-5.6-sol' },
		];

		assert.deepStrictEqual(routerCandidatesForOrigin(available, origin).map(candidate => candidate.providerName), ['anthropic', 'anthropic']);
		assert.deepStrictEqual(routerCandidatesForOrigin(available, origin, { allowCrossProviderByok: true }).map(candidate => candidate.providerName), ['anthropic', 'anthropic', 'openAI']);
	});

	test('routes Claude Plan Auto to the Plan-lane hybrid', () => {
		const easy = V3_MODEL_TIERS.find(tier => tier.id === 'OpusEasy')!;
		const origin: ModelSelection = { providerName: 'claudePlan', modelName: 'claude-opus-4-6' };
		const resolved = resolveRouterTierForOrigin(easy, origin, [
			origin,
			{ providerName: 'claudePlan', modelName: OPUS_HYBRID_MODEL_NAME },
		]);

		assert.strictEqual(resolved.usedTarget, true);
		assert.deepStrictEqual(resolved.selection, { providerName: 'claudePlan', modelName: OPUS_HYBRID_MODEL_NAME });
	});

	test('holds an unrelated Plan model instead of moving it onto Anthropic BYOK', () => {
		const easy = V3_MODEL_TIERS.find(tier => tier.id === 'OpusEasy')!;
		const origin: ModelSelection = { providerName: 'grokPlan', modelName: 'grok-4.5' };
		const resolved = resolveRouterTierForOrigin(easy, origin, [
			origin,
			{ providerName: 'anthropic', modelName: OPUS_HYBRID_MODEL_NAME },
		]);

		assert.strictEqual(resolved.usedTarget, false);
		assert.deepStrictEqual(resolved.selection, origin);
	});

	test('allows a paid hosted rung only after explicit hosted opt-in', () => {
		const pro = V3_MODEL_TIERS.find(tier => tier.id === 'V3Pro')!;
		const origin: ModelSelection = { providerName: 'openAI', modelName: 'gpt-5.6-sol' };

		assert.strictEqual(resolveRouterTierForOrigin(pro, origin, [origin]).usedTarget, false);
		assert.strictEqual(resolveRouterTierForOrigin(pro, origin, [origin], { allowHostedUpgrade: true }).usedTarget, true);
	});

	test('profiles representative models without pretending unknown models are frontier', () => {
		assert.strictEqual(routerCapabilityBandOfSelection({ providerName: 'claudePlan', modelName: 'claude-haiku-4-5-20251001' }), 'fast');
		assert.strictEqual(routerCapabilityBandOfSelection({ providerName: 'claudePlan', modelName: 'claude-sonnet-4-6' }), 'balanced');
		assert.strictEqual(routerCapabilityBandOfSelection({ providerName: 'claudePlan', modelName: 'claude-opus-5' }), 'strong');
		assert.strictEqual(routerCapabilityBandOfSelection({ providerName: 'v3code-local', modelName: 'qwen2.5-coder-1.5b' }), 'balanced');
		assert.strictEqual(routerCapabilityBandOfSelection({ providerName: 'openAICompatible', modelName: 'unknown-new-model' }), 'balanced');
	});

	test('estimates simple prompts below security and architecture work', () => {
		const simple = estimateRouterPromptComplexity('Quick question: explain this one line.');
		const complex = estimateRouterPromptComplexity('Investigate the root cause of an authentication race condition across the production agent architecture and test suite.');
		assert.ok(simple < 0.34, `expected fast score, got ${simple}`);
		assert.ok(complex >= 0.68, `expected strong score, got ${complex}`);
	});

	test('chooses the smallest adequate model from any contained provider catalog', () => {
		const candidates: ModelSelection[] = [
			{ providerName: 'claudePlan', modelName: 'claude-opus-5' },
			{ providerName: 'claudePlan', modelName: OPUS_HYBRID_MODEL_NAME },
			{ providerName: 'claudePlan', modelName: 'claude-sonnet-4-6' },
			{ providerName: 'claudePlan', modelName: 'claude-haiku-4-5-20251001' },
		];

		assert.strictEqual(selectAutoRouterCandidate(candidates, 'Quick question: explain this one line.', 1)?.selection.modelName, 'claude-haiku-4-5-20251001');
		assert.strictEqual(selectAutoRouterCandidate(candidates, 'Implement a new settings panel and test it.', 2)?.selection.modelName, 'claude-sonnet-4-6');
		assert.strictEqual(selectAutoRouterCandidate(candidates, 'Investigate a production authentication race condition and its security impact.', 3)?.selection.modelName, OPUS_HYBRID_MODEL_NAME);
	});

	test('treats Manual as no automatic route and Value as the default budget', () => {
		const candidates: ModelSelection[] = [
			{ providerName: 'claudePlan', modelName: 'claude-sonnet-4-6' },
		];

		assert.strictEqual(selectAutoRouterCandidate(candidates, 'Implement this.', 0), undefined);
		assert.strictEqual(selectAutoRouterCandidate(candidates, 'Implement this.')?.budget, 2);
	});

	test('uses actual BYOK catalog prices to keep lower budgets away from premium models', () => {
		const candidates: ModelSelection[] = [
			{ providerName: 'openAI', modelName: 'gpt-5.6-sol' },
			{ providerName: 'openAI', modelName: 'gpt-5.6-terra' },
			{ providerName: 'openAI', modelName: 'gpt-5.6-luna' },
			{ providerName: 'openAI', modelName: 'unknown-unpriced-model' },
		];
		const hardPrompt = `${'Investigate a production security and architecture failure across files, then test the migration and billing behavior. '.repeat(8)}`;

		const economy = selectAutoRouterCandidate(candidates, hardPrompt, 1);
		const value = selectAutoRouterCandidate(candidates, hardPrompt, 2);
		const balanced = selectAutoRouterCandidate(candidates, hardPrompt, 3);
		const premium = selectAutoRouterCandidate(candidates, hardPrompt, 4);

		assert.strictEqual(economy?.budgetMode, 'api-price');
		assert.strictEqual(economy?.selection.modelName, 'gpt-5.6-luna');
		assert.strictEqual(value?.selection.modelName, 'gpt-5.6-terra');
		assert.strictEqual(balanced?.selection.modelName, 'gpt-5.6-terra');
		assert.strictEqual(premium?.selection.modelName, 'gpt-5.6-sol');
		assert.strictEqual(value?.wasCapped, true);
		assert.strictEqual(premium?.wasCapped, false);
	});

	test('uses model power rather than API price for subscription plans', () => {
		const candidates: ModelSelection[] = [
			{ providerName: 'claudePlan', modelName: 'claude-opus-5' },
			{ providerName: 'claudePlan', modelName: OPUS_HYBRID_MODEL_NAME },
			{ providerName: 'claudePlan', modelName: 'claude-sonnet-4-6' },
			{ providerName: 'claudePlan', modelName: 'claude-haiku-4-5-20251001' },
		];
		const hardPrompt = `${'Investigate a production security and architecture failure across files, then test the migration and billing behavior. '.repeat(8)}`;

		assert.strictEqual(selectAutoRouterCandidate(candidates, hardPrompt, 1)?.selection.modelName, 'claude-haiku-4-5-20251001');
		assert.strictEqual(selectAutoRouterCandidate(candidates, hardPrompt, 2)?.selection.modelName, 'claude-sonnet-4-6');
		assert.strictEqual(selectAutoRouterCandidate(candidates, hardPrompt, 3)?.selection.modelName, OPUS_HYBRID_MODEL_NAME);
		assert.strictEqual(selectAutoRouterCandidate(candidates, hardPrompt, 4)?.selection.modelName, 'claude-opus-5');
		assert.strictEqual(selectAutoRouterCandidate(candidates, hardPrompt, 3)?.budgetMode, 'model-power');
	});

	test('keeps all-model selection inside the origin billing boundary', () => {
		const origin: ModelSelection = { providerName: 'geminiPlan', modelName: 'gemini-3.5-flash' };
		const contained = routerCandidatesForOrigin([
			origin,
			{ providerName: 'geminiPlan', modelName: 'gemini-3.1-pro-preview' },
			{ providerName: 'openAI', modelName: 'gpt-5.6-sol' },
		], origin);
		const choice = selectAutoRouterCandidate(contained, 'Investigate a production authentication race condition and its security impact.', 3);

		assert.strictEqual(choice?.selection.providerName, 'geminiPlan');
		assert.strictEqual(choice?.selection.modelName, 'gemini-3.1-pro-preview');
	});
});
