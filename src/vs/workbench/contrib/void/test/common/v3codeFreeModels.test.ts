/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { defaultModelsOfProvider, getModelCapabilities } from '../../common/modelCapabilities.js';
import { isV3CodeFreeModelId, isV3CodeFreeTransientError, V3CODE_FREE_AUTO_MODEL, V3CODE_FREE_ROTATION, V3CODE_FREE_VISION_MODEL } from '../../common/v3codeFreeModels.js';

suite('V3Code free model rotation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the picker and transport share one current roster', () => {
		assert.deepStrictEqual(defaultModelsOfProvider['v3code-free'], [V3CODE_FREE_AUTO_MODEL, ...V3CODE_FREE_ROTATION]);
		const currentModels: readonly string[] = V3CODE_FREE_ROTATION;
		// The 2026-09-12 adds: the Responses-protocol muse-spark pair, plus nemotron-3-ultra
		// restored after its upstream NVIDIA capacity 502s cleared.
		assert.ok(currentModels.includes('muse-spark-1.3-contributor-free'));
		assert.ok(currentModels.includes('muse-spark-1.2-contributor-free'));
		assert.ok(currentModels.includes('nemotron-3-ultra-free'));
		// Stale ids that never answered must not creep back in.
		assert.ok(!currentModels.includes('ling-3.0-flash-free'));
		assert.ok(!currentModels.includes('north-mini-code-free'));
		assert.ok(!currentModels.includes('deepseek-v4-flash-free'));
	});

	test('ids the live gateway rejects are not in the rotation', () => {
		// `hy3-free` 401s with "Model hy3-free is not supported" and is absent from
		// GET /zen/v1/models entirely, so while it sat in the rotation it was a guaranteed-dead
		// slot that burned a failover attempt every turn. `deepseek-v4-flash-free` is the subtler
		// trap: the gateway STILL advertises it, but every request returns 400 "Model is
		// unavailable" — a catalogue listing is never evidence that an id is usable.
		const rotation: readonly string[] = V3CODE_FREE_ROTATION;
		for (const deadId of ['hy3-free', 'deepseek-v4-flash-free', 'laguna-s-2.1-free']) {
			assert.ok(!rotation.includes(deadId), `${deadId} does not answer and must stay out of the rotation`);
		}
	});

	test('a rotation change never strips an id of its own capability record', () => {
		// `nemotron-3-ultra-free` is the worked example: rotated OUT on 2026-09-04 (upstream NVIDIA
		// capacity 502s) and back IN on 2026-09-12, with its record unchanged across both moves, so
		// a user who had already selected it never dropped to the conservative stand-in.
		const restored = getModelCapabilities('v3code-free', 'nemotron-3-ultra-free', undefined);
		assert.strictEqual(restored.recognizedModelName, 'nemotron-3-ultra-free');
		assert.strictEqual(restored.cost.input, 0);

		// A genuinely unknown free id must still degrade to that conservative stand-in rather than
		// borrowing a real model's limits — the fallback has to stay a fallback.
		const phantom = getModelCapabilities('v3code-free', 'some-retired-free', undefined);
		assert.strictEqual(phantom.recognizedModelName, 'nemotron-3.5-lightning-free');
	});

	test('free membership is not a bare -free suffix test', () => {
		// `big-pickle` is a genuinely free Zen id with no suffix. A bare endsWith('-free') hid it
		// from the picker AND made the capability fallback refuse it.
		assert.strictEqual(isV3CodeFreeModelId('big-pickle'), true);
		assert.strictEqual(isV3CodeFreeModelId(V3CODE_FREE_AUTO_MODEL), true);
		assert.strictEqual(isV3CodeFreeModelId('mimo-v2.5-free'), true);
		// Paid Zen catalogue ids must still be refused — routing one here bills the gateway owner.
		assert.strictEqual(isV3CodeFreeModelId('claude-opus-5'), false);
		assert.strictEqual(isV3CodeFreeModelId('gpt-5.5'), false);
		assert.strictEqual(isV3CodeFreeModelId('kimi-k3'), false);
	});

	test('every rotation member resolves to its own capability record, not the fallback', () => {
		// This is what a phantom id looks like from the inside: it "works" in the type system and
		// silently resolves through modelOptionsFallback to another model's limits.
		for (const modelName of V3CODE_FREE_ROTATION) {
			assert.strictEqual(
				getModelCapabilities('v3code-free', modelName, undefined).recognizedModelName,
				modelName,
				`${modelName} has no capability record of its own`,
			);
		}
	});

	test('every rotation member has native tools and zero-cost capabilities', () => {
		for (const modelName of V3CODE_FREE_ROTATION) {
			const capabilities = getModelCapabilities('v3code-free', modelName, undefined);
			assert.strictEqual(capabilities.specialToolFormat, 'openai-style', modelName);
			assert.strictEqual(capabilities.cost.input, 0, modelName);
			assert.strictEqual(capabilities.cost.output, 0, modelName);
		}
		assert.strictEqual(getModelCapabilities('v3code-free', V3CODE_FREE_VISION_MODEL, undefined).supportsVision, true);
	});

	test('retired-model and capacity errors rotate instead of becoming bad-key errors', () => {
		for (const message of [
			'Free (no key) — Beta: Model is not supported.',
			'Free (no key) request failed (401). Try again.',
			'Error from provider (Console): Model is unavailable.',
			'Rate limit exceeded. Please try again later.',
			'Bad gateway (502)',
		]) {
			assert.strictEqual(isV3CodeFreeTransientError(message), true, message);
		}
		assert.strictEqual(isV3CodeFreeTransientError('Tool arguments were malformed.'), false);
	});
});
