/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ROUTER_LADDER, nextRung, clampToCeiling, resolveRung, rungFromSelection } from '../../common/router/routerLadder.js';
import { selectionForRouterTier, tierFromModelSelection, V3_MODEL_TIERS } from '../../common/modelTiers.js';

suite('void adaptive router ladder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ladder is ordered Local -> V3Fast -> V3Pro -> OpusEasy -> OpusHard -> FullOpus', () => {
		assert.deepStrictEqual(ROUTER_LADDER.map(r => r.id), ['Local', 'V3Fast', 'V3Pro', 'OpusEasy', 'OpusHard', 'FullOpus']);
	});

	test('nextRung escalates one step, clamps to ceiling, never moves down', () => {
		assert.strictEqual(nextRung('V3Fast', 'FullOpus'), 'V3Pro');
		assert.strictEqual(nextRung('OpusHard', 'FullOpus'), 'FullOpus');
		assert.strictEqual(nextRung('FullOpus', 'FullOpus'), 'FullOpus');   // already at ceiling
		assert.strictEqual(nextRung('OpusHard', 'V3Pro'), 'OpusHard');      // ceiling below current -> hold
		assert.strictEqual(nextRung('Local', 'V3Fast'), 'V3Fast');
	});

	test('clampToCeiling caps at the ceiling', () => {
		assert.strictEqual(clampToCeiling('FullOpus', 'V3Pro'), 'V3Pro');
		assert.strictEqual(clampToCeiling('V3Fast', 'FullOpus'), 'V3Fast');
	});

	test('resolveRung carries the shipped tier advisorEffort verbatim; FullOpus drops the advisor', () => {
		assert.strictEqual(resolveRung('OpusEasy').options?.advisorEffort, 'easy');
		assert.strictEqual(resolveRung('OpusHard').options?.advisorEffort, 'hard');
		const full = resolveRung('FullOpus');
		assert.strictEqual(full.selection.modelName, 'claude-opus-4-8');
		assert.strictEqual(full.options?.advisorEffort, undefined);
	});

	test('rungFromSelection disambiguates Opus Hybrid by advisorEffort and identifies Full Opus', () => {
		assert.strictEqual(rungFromSelection({ providerName: 'deepseek', modelName: 'deepseek-v4-pro' })?.id, 'V3Pro');
		assert.strictEqual(rungFromSelection({ providerName: 'anthropic', modelName: 'Opus Hybrid' }, { advisorEffort: 'easy' })?.id, 'OpusEasy');
		assert.strictEqual(rungFromSelection({ providerName: 'anthropic', modelName: 'Opus Hybrid' }, { advisorEffort: 'hard' })?.id, 'OpusHard');
		assert.strictEqual(rungFromSelection({ providerName: 'anthropic', modelName: 'claude-opus-4-8' })?.id, 'FullOpus');
	});

	test('keeps Auto Advisor on Claude Plan without changing other router providers', () => {
		const easy = V3_MODEL_TIERS.find(tier => tier.id === 'OpusEasy')!;
		const pro = V3_MODEL_TIERS.find(tier => tier.id === 'V3Pro')!;
		const planHybrid = selectionForRouterTier(easy, 'claudePlan');

		assert.deepStrictEqual(planHybrid, { providerName: 'claudePlan', modelName: 'Opus Hybrid' });
		assert.strictEqual(tierFromModelSelection(planHybrid, { advisorEffort: 'easy' })?.id, 'OpusEasy');
		assert.strictEqual(selectionForRouterTier(pro, 'claudePlan'), pro.selection);
		assert.strictEqual(selectionForRouterTier(easy, 'anthropic'), easy.selection);
	});
});
