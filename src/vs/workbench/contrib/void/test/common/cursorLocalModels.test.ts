/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { defaultModelsOfProvider, defaultProviderSettings, getModelCapabilities } from '../../common/modelCapabilities.js';
import { defaultOverridesOfModel, displayInfoOfProviderName, subTextMdOfProviderName } from '../../common/voidSettingsTypes.js';
import { routerBillingLaneOfSelection as billingLane } from '../../common/router/modelCandidates.js';

suite('Cursor (Local) models', () => {
	test('defaults the local app endpoint and lists Cursor-subscription models at cost 0', () => {
		assert.strictEqual(defaultProviderSettings.cursorLocal.endpoint, 'http://127.0.0.1:8788/v1');
		assert.ok(defaultModelsOfProvider.cursorLocal.includes('composer-2.5'));
		assert.ok(defaultModelsOfProvider.cursorLocal.includes('composer-2.5-fast'));
		assert.ok(defaultModelsOfProvider.cursorLocal.includes('grok-4.6'));
		for (const modelName of defaultModelsOfProvider.cursorLocal) {
			const caps = getModelCapabilities('cursorLocal', modelName, defaultOverridesOfModel);
			assert.strictEqual(caps.cost.input, 0, modelName);
			assert.strictEqual(caps.specialToolFormat, 'openai-style', modelName);
			assert.ok(caps.contextWindow >= 100_000, `${modelName} must declare a bounded window so prompt assembly budgets the body`);
		}
	});

	test('unrecognized Cursor ids borrow a 120k profile instead of the 4k unknown-model fallback', () => {
		const caps = getModelCapabilities('cursorLocal', 'composer-3-preview', defaultOverridesOfModel);
		assert.strictEqual(caps.isUnrecognizedModel, false);
		assert.ok(caps.contextWindow >= 100_000);
		assert.strictEqual(caps.cost.input, 0);
	});

	test('is a subscription lane, not BYOK, and is labeled as local Cursor', () => {
		assert.strictEqual(billingLane({ providerName: 'cursorLocal', modelName: 'composer-2.5' }), 'subscription');
		assert.strictEqual(displayInfoOfProviderName('cursorLocal').title, 'Cursor (Local)');
		assert.ok(subTextMdOfProviderName('cursorLocal').includes('Cursor subscription'));
	});
});
