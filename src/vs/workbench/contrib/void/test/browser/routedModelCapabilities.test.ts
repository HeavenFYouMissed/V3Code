/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities } from '../../common/modelCapabilities.js';
import { defaultOverridesOfModel } from '../../common/voidSettingsTypes.js';
import { ChatAgentLocation, ChatModeKind } from '../../../chat/common/constants.js';
import { filterModelsForSession } from '../../../chat/browser/widget/input/chatModelSelectionLogic.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../chat/common/languageModels.js';

suite('Routed model tool capabilities', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('curated tool models survive the native agent picker filter', () => {
		for (const modelName of ['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'qwen/qwen3-235b-a22b', 'anthropic/claude-3.7-sonnet', 'anthropic/claude-3.5-sonnet', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash']) {
			const caps = getModelCapabilities('openRouter', modelName, undefined);
			assert.strictEqual(caps.specialToolFormat, 'openai-style', modelName);
			const entry = { identifier: modelName, metadata: { isUserSelectable: true, capabilities: { toolCalling: !!caps.specialToolFormat, agentMode: !!caps.specialToolFormat } } } as ILanguageModelChatMetadataAndIdentifier;
			assert.deepStrictEqual(filterModelsForSession([entry], 'local', ChatModeKind.Agent, ChatAgentLocation.Chat), [entry]);
		}
	});

	test('custom routed names use gateway tools without changing direct provider metadata', () => {
		assert.strictEqual(getModelCapabilities('openRouter', 'anthropic/claude-sonnet-5', undefined).specialToolFormat, 'openai-style');
		assert.strictEqual(getModelCapabilities('anthropic', 'claude-sonnet-5', undefined).specialToolFormat, 'anthropic-style');
	});

	test('unknown and reasoning-only entries do not gain invented tool support', () => {
		for (const modelName of ['fixture/text-only', 'deepseek/deepseek-r1']) {
			assert.strictEqual(getModelCapabilities('openRouter', modelName, undefined).specialToolFormat, undefined);
		}
	});

	test('explicit tool overrides remain authoritative', () => {
		assert.strictEqual(getModelCapabilities('openRouter', 'anthropic/claude-opus-4', { ...defaultOverridesOfModel, openRouter: { 'anthropic/claude-opus-4': { specialToolFormat: undefined } } }).specialToolFormat, undefined);
	});

	test('custom endpoint slots retain tool-capable defaults', () => {
		for (const provider of ['openAICompatible', 'openAICompatible2', 'openAICompatible3'] as const) {
			assert.strictEqual(getModelCapabilities(provider, 'fixture/custom-chat', undefined).specialToolFormat, 'openai-style');
		}
	});
});
