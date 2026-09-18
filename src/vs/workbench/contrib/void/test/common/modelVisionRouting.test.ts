/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities, defaultModelsOfProvider, modelOverrideKeys } from '../../common/modelCapabilities.js';
import { ImageDescribeMode, ModelSelection, OverridesOfModel } from '../../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../../common/voidSettingsService.js';
import { ILLMMessageService } from '../../common/sendLLMMessageService.js';
import { IConvertToLLMMessageService } from '../../browser/convertToLLMMessageService.js';
import { describeImagesForNonVisionModel, modelSupportsVision, VisionDescribeUserMessage } from '../../browser/v3codeVisionDescribe.js';
import { prepareMessages_openai_tools } from '../../common/llmMessageConverters.js';

suite('V3Code model vision routing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const overrideFor = (providerName: string, modelName: string, supportsVision: unknown) =>
		({ [providerName]: { [modelName]: { supportsVision } } }) as OverridesOfModel;

	test('current direct DeepSeek model and documented aliases support images without changing wire IDs', () => {
		assert.ok(defaultModelsOfProvider.deepseek.includes('deepseek-flash'));
		for (const modelName of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
			const caps = getModelCapabilities('deepseek', modelName, undefined);
			assert.strictEqual(caps.supportsVision, true, modelName);
			assert.strictEqual(caps.modelName, modelName);
			assert.strictEqual(caps.contextWindow, 1_000_000);
			assert.strictEqual(caps.specialToolFormat, 'openai-style');
			assert.strictEqual(modelSupportsVision('deepseek', modelName, undefined), true);
		}
	});

	test('older DeepSeek and third-party text checkpoints stay text-only', () => {
		for (const [providerName, modelName] of [
			['deepseek', 'deepseek-v4-pro'], ['deepseek', 'deepseek-reasoner'],
			['deepseek', 'deepseek-r1'], ['deepseek', 'deepseek-coder-v2'],
			['ollama', 'deepseek-v4-flash:latest'], ['openRouter', 'deepseek/deepseek-v4-flash'],
			['deepseek', 'deepseek-future-model'],
		] as const) {
			assert.notStrictEqual(getModelCapabilities(providerName, modelName, undefined).supportsVision, true, modelName);
			assert.strictEqual(modelSupportsVision(providerName, modelName, undefined), false, modelName);
		}
	});

	test('explicitly identified new model on compatible provider retains native vision', () => {
		assert.strictEqual(modelSupportsVision('openAICompatible', 'deepseek-flash', undefined), true);
		assert.strictEqual(modelSupportsVision('openRouter', 'deepseek/deepseek-flash', undefined), true);
	});

	test('both boolean overrides are accepted by the settings allowlist', () => {
		assert.ok(modelOverrideKeys.includes('supportsVision'));
		for (const supportsVision of [true, false]) {
			const parsed = JSON.parse(JSON.stringify({ supportsVision }));
			const saved = Object.fromEntries(modelOverrideKeys.filter(key => key in parsed).map(key => [key, parsed[key]]));
			assert.deepStrictEqual(saved, { supportsVision });
		}
	});

	for (const modelName of ['new-custom-model', 'deepseek-future-model']) {
		test(`explicit vision override wins over unknown/family fallback: ${modelName}`, () => {
			const overrides = overrideFor('openAICompatible', modelName, true);
			assert.strictEqual(getModelCapabilities('openAICompatible', modelName, overrides).supportsVision, true);
			assert.strictEqual(modelSupportsVision('openAICompatible', modelName, overrides), true);
		});
	}

	test('explicit false wins over native support and unknown-name vision heuristics', () => {
		assert.strictEqual(modelSupportsVision('deepseek', 'deepseek-flash', overrideFor('deepseek', 'deepseek-flash', false)), false);
		assert.strictEqual(modelSupportsVision('openAICompatible', 'llava-future', overrideFor('openAICompatible', 'llava-future', false)), false);
	});

	test('malformed stored values never grant vision or mutate stored overrides', () => {
		for (const value of ['true', 'false', 1, null, {}]) {
			const overrides = overrideFor('openAICompatible', 'unknown-model', value);
			assert.notStrictEqual(getModelCapabilities('openAICompatible', 'unknown-model', overrides).supportsVision, true);
			assert.strictEqual(modelSupportsVision('openAICompatible', 'unknown-model', overrides), false);
			assert.strictEqual(overrides.openAICompatible['unknown-model']?.supportsVision, value);
		}
	});

	test('overrides remain isolated to the exact provider and model', () => {
		const overrides = overrideFor('deepseek', 'deepseek-v4-pro', true);
		assert.strictEqual(modelSupportsVision('openAICompatible', 'deepseek-v4-pro', overrides), false);
		assert.strictEqual(modelSupportsVision('deepseek', 'deepseek-r1', overrides), false);
	});

	function fixture(mode: ImageDescribeMode, overrides?: OverridesOfModel, withVision = true) {
		let calls = 0;
		const settings = { state: {
			overridesOfModel: overrides,
			globalSettings: { imageDescribeMode: mode, visionDescribeModel: 'auto' },
			settingsOfProvider: { openAI: { models: withVision ? [{ modelName: 'gpt-4o', isHidden: false }] : [] } },
		} } as unknown as IVoidSettingsService;
		const llm = {
			sendLLMMessage: (params: { onFinalMessage: (result: { fullText: string }) => void }) => {
				calls++;
				queueMicrotask(() => params.onFinalMessage({ fullText: 'A red square.' }));
				return 'vision-description-test';
			},
		} as unknown as ILLMMessageService;
		const convert = { prepareLLMSimpleMessages: () => ({ messages: [] }) } as unknown as IConvertToLLMMessageService;
		const messages: VisionDescribeUserMessage[] = [{ role: 'user', content: 'What is this?', images: [{ data: 'cGl4ZWxz', mimeType: 'image/png' }] }];
		return { settings, llm, convert, messages, calls: () => calls };
	}

	for (const mode of ['manual', 'on_send', 'off'] as const) {
		test(`native DeepSeek preserves image bytes and bypasses transcription in ${mode} mode`, async () => {
			const f = fixture(mode, undefined, false);
			const original = structuredClone(f.messages);
			await describeImagesForNonVisionModel(f.messages, { providerName: 'deepseek', modelName: 'deepseek-flash' }, f.settings, f.llm, f.convert, CancellationToken.None,
				{ promptManualDescribe: async () => assert.fail('native vision must not ask for transcription') });
			assert.deepStrictEqual(f.messages, original);
			assert.strictEqual(f.calls(), 0);
			assert.deepStrictEqual(prepareMessages_openai_tools(f.messages)[0].content, [
				{ type: 'text', text: 'What is this?' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWxz' } },
			]);
		});
	}

	for (const mode of ['manual', 'on_send'] as const) {
		test(`text-only model retains the existing ${mode} transcription fallback`, async () => {
			const f = fixture(mode);
			let prompts = 0;
			await describeImagesForNonVisionModel(f.messages, { providerName: 'deepseek', modelName: 'deepseek-r1' }, f.settings, f.llm, f.convert, CancellationToken.None,
				{ promptManualDescribe: async () => { prompts++; return 'describe'; } });
			assert.strictEqual(f.calls(), 1);
			assert.strictEqual(prompts, mode === 'manual' ? 1 : 0);
			assert.deepStrictEqual(f.messages[0].images, []);
			assert.ok(f.messages[0].content.includes('[Image Description: A red square.]'));
		});
	}

	test('custom-model opt-in bypasses transcription; opt-out restores it', async () => {
		const model: ModelSelection = { providerName: 'openAICompatible', modelName: 'custom-vision' };
		for (const enabled of [true, false]) {
			const f = fixture('on_send', overrideFor(model.providerName, model.modelName, enabled));
			await describeImagesForNonVisionModel(f.messages, model, f.settings, f.llm, f.convert, CancellationToken.None);
			assert.strictEqual(f.calls(), enabled ? 0 : 1);
			assert.strictEqual(f.messages[0].images?.length, enabled ? 1 : 0);
		}
	});

	test('text-only model without a describer stays explicit, never receives raw images', async () => {
		const f = fixture('on_send', undefined, false);
		await describeImagesForNonVisionModel(f.messages, { providerName: 'deepseek', modelName: 'deepseek-r1' }, f.settings, f.llm, f.convert, CancellationToken.None);
		assert.strictEqual(f.calls(), 0);
		assert.deepStrictEqual(f.messages[0].images, []);
		assert.ok(f.messages[0].content.includes('no vision-capable model is configured'));
	});

	test('manual cancellation preserves the pending attachment and makes no model call', async () => {
		const f = fixture('manual');
		const result = await describeImagesForNonVisionModel(f.messages, { providerName: 'deepseek', modelName: 'deepseek-r1' }, f.settings, f.llm, f.convert, CancellationToken.None,
			{ promptManualDescribe: async () => 'cancel' });
		assert.strictEqual(result, 'cancelled');
		assert.strictEqual(f.messages[0].images?.length, 1);
		assert.strictEqual(f.calls(), 0);
	});
});
