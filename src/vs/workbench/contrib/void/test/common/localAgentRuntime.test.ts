/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	isLocalAgentProvider,
	localNarrationNeedsRecovery,
	localAgentRuntimeLimits,
	localModelParameterBillions,
	shouldSuppressLocalAskUser,
	V3CodeLocalAgentRuntime,
} from '../../common/localAgentRuntime.js';

suite('V3Code local agent runtime', () => {
	test('recognizes local providers and common parameter tags', () => {
		assert.strictEqual(isLocalAgentProvider('ollama'), true);
		assert.strictEqual(isLocalAgentProvider('anthropic'), false);
		assert.strictEqual(localModelParameterBillions('qwen3:4b'), 4);
		assert.strictEqual(localModelParameterBillions('qwen3-coder:30b-a3b'), 30);
		assert.strictEqual(localModelParameterBillions('custom-model'), undefined);
	});

	test('keeps 4B bounded, 8B sequential, and large local models fully capable', () => {
		assert.deepStrictEqual(localAgentRuntimeLimits('gemma3:4b'), {
			profile: 'compact', maxIterations: 12, mistakeLimit: 2, parallelReadOnly: false,
		});
		assert.deepStrictEqual(localAgentRuntimeLimits('qwen3:8b'), {
			profile: 'standard', maxIterations: 20, mistakeLimit: 3, parallelReadOnly: false,
		});
		assert.deepStrictEqual(localAgentRuntimeLimits('qwen3-coder:30b-a3b'), {
			profile: 'large', maxIterations: 40, mistakeLimit: 3, parallelReadOnly: true,
		});
	});

	test('permits one reasoning-only recovery and one unfinished-narration recovery', () => {
		const runtime = new V3CodeLocalAgentRuntime('qwen3:4b');
		assert.strictEqual(runtime.useNarrationContinuation, true);
		assert.strictEqual(runtime.shouldRecoverEmptyTurn(true), true);
		assert.strictEqual(runtime.shouldRecoverEmptyTurn(true), false);
		assert.strictEqual(runtime.shouldRecoverEmptyTurn(false), false);
		assert.strictEqual(localNarrationNeedsRecovery("I'll build it now."), true);
		assert.strictEqual(runtime.shouldRecoverNarration("I'll build it now."), true);
		assert.strictEqual(runtime.shouldRecoverNarration('Next I will write the file.'), false);
		assert.strictEqual(localNarrationNeedsRecovery('The calculator is built and verified.'), false);
		assert.strictEqual(localNarrationNeedsRecovery('Would you like me to build it?'), false);
	});

	test('honors autonomous intent and allows only one successful ask_user answer per task turn', () => {
		assert.strictEqual(shouldSuppressLocalAskUser("Build it and don't ask me anything."), true);
		assert.strictEqual(shouldSuppressLocalAskUser('You decide everything and just build it.'), true);
		assert.strictEqual(shouldSuppressLocalAskUser('Which framework should I pick?'), false);
		assert.strictEqual(shouldSuppressLocalAskUser('How should I choose between React and Vue?'), false);

		const runtime = new V3CodeLocalAgentRuntime('qwen3:8b');
		assert.strictEqual(runtime.beforeAskUser().block, false);
		runtime.recordAskUserResult('The user dismissed the question without picking an option.', false);
		assert.strictEqual(runtime.beforeAskUser().block, false, 'dismissal does not consume the successful-ask limit');
		runtime.recordAskUserResult('The user chose: Plain HTML', false);
		const blocked = runtime.beforeAskUser();
		assert.strictEqual(blocked.block, true);
		assert.match(blocked.reminder ?? '', /already answered one question/i);
	});

	test('warns at three identical batches and blocks the fifth', () => {
		const runtime = new V3CodeLocalAgentRuntime('qwen3:8b');
		assert.deepStrictEqual(runtime.beforeToolBatch(['read_file:{a:1}']), { block: false });
		assert.deepStrictEqual(runtime.beforeToolBatch(['read_file:{a:1}']), { block: false });
		const soft = runtime.beforeToolBatch(['read_file:{a:1}']);
		assert.strictEqual(soft.block, false);
		assert.match(soft.reminder ?? '', /three times/i);
		assert.strictEqual(runtime.beforeToolBatch(['read_file:{a:1}']).block, false);
		assert.strictEqual(runtime.beforeToolBatch(['read_file:{a:1}']).block, true);
	});

	test('blocks further compact-model tools after two failed batches', () => {
		const runtime = new V3CodeLocalAgentRuntime('gemma3:4b');
		const first = runtime.afterToolBatch([{ isError: true }]);
		assert.strictEqual(first.blockFurtherTools, false);
		const second = runtime.afterToolBatch([{ isError: true }]);
		assert.strictEqual(second.blockFurtherTools, true);
		assert.strictEqual(runtime.beforeToolBatch(['edit_file:{}']).block, true);
	});
});
