/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ChatAgentLocation, CollapsedToolsDisplayMode } from '../../../chat/common/constants.js';
import type { IChatResponseViewModel } from '../../../chat/common/model/chatViewModel.js';
import { getV3CollapsedToolsDisplayMode, getV3CollapsedToolsDisplayModeForResponse, v3DensityToCollapsedToolsMode } from '../../browser/v3codeConversationDensity.js';

suite('V3Code conversation density', () => {
	test('maps explicit density values to native grouping modes', () => {
		assert.strictEqual(v3DensityToCollapsedToolsMode('compact-all-grouped'), CollapsedToolsDisplayMode.Always);
		assert.strictEqual(v3DensityToCollapsedToolsMode('default'), CollapsedToolsDisplayMode.WithThinking);
		assert.strictEqual(v3DensityToCollapsedToolsMode('detailed'), CollapsedToolsDisplayMode.Off);
	});

	test('groups panel tools when the setting is missing', () => {
		const configurationService = new TestConfigurationService();
		assert.strictEqual(
			getV3CollapsedToolsDisplayMode(configurationService),
			CollapsedToolsDisplayMode.Always,
		);
	});

	test('restores grouping for profiles that persisted the old panel default', () => {
		const configurationService = new TestConfigurationService({
			'v3code.agent.conversationDensity': 'default',
		});
		assert.strictEqual(
			getV3CollapsedToolsDisplayMode(configurationService),
			CollapsedToolsDisplayMode.Always,
		);
	});

	test('keeps editor density independent from the panel', () => {
		const configurationService = new TestConfigurationService({
			'v3code.agent.conversationDensity': 'compact-all-grouped',
			'v3code.agent.editorConversationDensity': 'detailed',
		});
		assert.strictEqual(
			getV3CollapsedToolsDisplayMode(configurationService, ChatAgentLocation.EditorInline),
			CollapsedToolsDisplayMode.Off,
		);
	});

	test('uses detailed fallback only for inline code-editor chat', () => {
		const configurationService = new TestConfigurationService();
		assert.strictEqual(
			getV3CollapsedToolsDisplayMode(configurationService, ChatAgentLocation.EditorInline),
			CollapsedToolsDisplayMode.Off,
		);
	});

	test('every V3Code response bypasses the native rolling group; other rows keep the panel default', () => {
		const configurationService = new TestConfigurationService();
		const response = (modeName: string) => ({
			session: { model: { initialLocation: ChatAgentLocation.Chat } },
			model: { request: { modeInfo: { modeName } } },
		}) as unknown as IChatResponseViewModel;
		// The shared transcript owns grouping in every mode this editor renders, so all of them
		// hand tool grouping over instead of entering the native rolling thinking group.
		assert.strictEqual(getV3CollapsedToolsDisplayModeForResponse(configurationService, response('debug')), CollapsedToolsDisplayMode.Off);
		assert.strictEqual(getV3CollapsedToolsDisplayModeForResponse(configurationService, response('Debug')), CollapsedToolsDisplayMode.Off);
		assert.strictEqual(getV3CollapsedToolsDisplayModeForResponse(configurationService, response('agent')), CollapsedToolsDisplayMode.Off);
		assert.strictEqual(getV3CollapsedToolsDisplayModeForResponse(configurationService, response('plan')), CollapsedToolsDisplayMode.Off);
		assert.strictEqual(getV3CollapsedToolsDisplayModeForResponse(configurationService, response('multitask')), CollapsedToolsDisplayMode.Off);
		// A row this editor did not render keeps the native behaviour untouched.
		assert.strictEqual(getV3CollapsedToolsDisplayModeForResponse(configurationService, response('copilot-agent')), CollapsedToolsDisplayMode.Always);
		assert.strictEqual(getV3CollapsedToolsDisplayModeForResponse(configurationService, undefined), CollapsedToolsDisplayMode.Always);
	});

	test('maps explicit editor default and panel detailed independently', () => {
		const configurationService = new TestConfigurationService({
			'v3code.agent.conversationDensity': 'detailed',
			'v3code.agent.editorConversationDensity': 'default',
		});
		assert.strictEqual(
			getV3CollapsedToolsDisplayMode(configurationService, ChatAgentLocation.Chat),
			CollapsedToolsDisplayMode.Off,
		);
		assert.strictEqual(
			getV3CollapsedToolsDisplayMode(configurationService, ChatAgentLocation.EditorInline),
			CollapsedToolsDisplayMode.WithThinking,
		);
	});
});
