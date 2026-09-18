/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import { getModelCapabilities } from '../../common/modelCapabilities.js';
import { mergeOpenRouterModels, parseOpenRouterCatalogue } from '../../common/openRouterCatalogue.js';
import type { OverridesOfModel } from '../../common/voidSettingsTypes.js';

suite('OpenRouter discovered catalogue', () => {
	test('preserves enabled and hidden choices; new entries default hidden and custom models survive', () => {
		const result = mergeOpenRouterModels([
			{ modelName: 'kept', type: 'default', isHidden: false },
			{ modelName: 'hidden', type: 'autodetected', isHidden: true },
			{ modelName: 'private', type: 'custom', isHidden: false },
			{ modelName: 'retired', type: 'default', isHidden: false },
		], ['kept', 'hidden', 'new']);
		assert.deepStrictEqual(result.map(model => [model.modelName, model.isHidden]), [['kept', false], ['hidden', true], ['new', true], ['private', false]]);
	});
	test('does not truncate a catalogue larger than 500 models', () => {
		const catalogue = parseOpenRouterCatalogue(Array.from({ length: 600 }, (_, i) => ({ id: `vendor/model-${i}`, supported_parameters: ['tools'] })));
		assert.strictEqual(catalogue.size, 600);
		assert.strictEqual(mergeOpenRouterModels([], [...catalogue.keys()]).filter(model => !model.isHidden).length, 0);
	});
	test('uses API metadata for previously unknown tool-capable models after JSON persistence', () => {
		const caps = parseOpenRouterCatalogue([{ id: 'fixture/new-model', supported_parameters: ['tools'], context_length: 200000, architecture: { input_modalities: ['text', 'image'] } }]).get('fixture/new-model');
		const overrides = JSON.parse(JSON.stringify({ openRouter: { 'fixture/new-model': { _discoveredCapabilities: caps } } })) as OverridesOfModel;
		const result = getModelCapabilities('openRouter', 'fixture/new-model', overrides);
		assert.strictEqual(result.specialToolFormat, 'openai-style');
		assert.strictEqual(result.contextWindow, 200000);
		assert.strictEqual(result.supportsVision, true);
	});
	test('negative tools metadata survives persistence and explicit user overrides win', () => {
		const caps = parseOpenRouterCatalogue([{ id: 'anthropic/claude-sonnet-4', supported_parameters: [] }]).get('anthropic/claude-sonnet-4');
		const overrides = JSON.parse(JSON.stringify({ openRouter: { 'anthropic/claude-sonnet-4': { _discoveredCapabilities: caps } } })) as OverridesOfModel;
		assert.strictEqual(getModelCapabilities('openRouter', 'anthropic/claude-sonnet-4', overrides).specialToolFormat, undefined);
		overrides.openRouter['anthropic/claude-sonnet-4'] = { ...overrides.openRouter['anthropic/claude-sonnet-4'], specialToolFormat: 'openai-style', contextWindow: 12345 };
		assert.strictEqual(getModelCapabilities('openRouter', 'anthropic/claude-sonnet-4', overrides).specialToolFormat, 'openai-style');
		assert.strictEqual(getModelCapabilities('openRouter', 'anthropic/claude-sonnet-4', overrides).contextWindow, 12345);
	});
	test('ignores invalid identifiers and malformed numeric metadata', () => {
		const result = parseOpenRouterCatalogue([null, {}, { id: '' }, { id: 'bad\nname' }, { id: 'valid', context_length: -2 }]);
		assert.strictEqual(result.size, 1);
		assert.strictEqual(result.get('valid')?.contextWindow, undefined);
	});
});
