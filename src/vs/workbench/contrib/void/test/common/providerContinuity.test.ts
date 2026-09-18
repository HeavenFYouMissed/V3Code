/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { isAgentHostEnabled } from '../../../../../platform/agentHost/common/agentService.js';
import { defaultModelsOfProvider, getModelCapabilities } from '../../common/modelCapabilities.js';
import { defaultOverridesOfModel, isProviderTemporarilyDisabled, nonlocalProviderNames } from '../../common/voidSettingsTypes.js';
import { prepareGeminiMessages, prepareMessages_anthropic_tools, prepareMessages_openai_tools, SimpleLLMMessage } from '../../common/llmMessageConverters.js';
import { AnthropicLLMChatMessage, GeminiResponsePart } from '../../common/sendLLMMessageTypes.js';
import { LOCAL_AGENT_TRANSCRIPT_METADATA_KEY, LocalAgentTranscriptRecorder, reconstructLocalAgentTranscript } from '../../common/localAgentHistory.js';

suite('provider continuity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('desktop host agrees before and after schema registration; explicit disable wins', () => {
		assert.strictEqual(isAgentHostEnabled(new TestConfigurationService()), !isWeb);
		assert.strictEqual(isAgentHostEnabled(new TestConfigurationService({ chat: { agentHost: { enabled: false } } })), false);
		assert.strictEqual(isAgentHostEnabled(new TestConfigurationService({ chat: { agentHost: { enabled: true } } })), !isWeb);
	});
	test('new subscription model is explicit, with vision and its own context window', () => {
		assert.ok(defaultModelsOfProvider.grokPlan.includes('grok-4.6'));
		const model = getModelCapabilities('grokPlan', 'grok-4.6', defaultOverridesOfModel);
		assert.strictEqual(model.contextWindow, 500_000);
		assert.strictEqual(model.supportsVision, true);
	});
	test('retired plan is hidden and blocked while API-key access remains', () => {
		assert.strictEqual(isProviderTemporarilyDisabled('geminiPlan'), true);
		assert.ok(!nonlocalProviderNames.includes('geminiPlan'));
		assert.strictEqual(isProviderTemporarilyDisabled('gemini'), false);
	});

	const parts: GeminiResponsePart[] = [
		{ text: 'Inspecting', thoughtSignature: 'text-signature' },
		{ functionCall: { id: 'a', name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'signed-call' },
		{ functionCall: { id: 'b', name: 'read_file', args: { path: 'b.ts' } } },
		{ thoughtSignature: 'final-signature' },
	];
	const messages: SimpleLLMMessage[] = [
		{ role: 'assistant', content: 'Inspecting', reasoning: null, anthropicReasoning: null, geminiParts: parts, geminiCallIds: ['a', 'b'] },
		{ role: 'tool', name: 'read_file', id: 'a', content: 'one', rawParams: {} },
		{ role: 'tool', name: 'read_file', id: 'b', content: 'denied', rawParams: {} },
	];
	test('signed parallel parts retain ordering and matching results', () => {
		const wire = prepareGeminiMessages(prepareMessages_anthropic_tools(messages, false, true) as AnthropicLLMChatMessage[]);
		assert.deepStrictEqual(wire[0].parts, parts);
		assert.strictEqual(wire[1].parts.length, 2);
		assert.ok(JSON.stringify(wire[1]).includes('denied'));
	});
	test('opaque response metadata never leaks into other provider wires', () => {
		assert.ok(!JSON.stringify(prepareMessages_anthropic_tools(messages, false)).includes('signed-call'));
		assert.ok(!JSON.stringify(prepareMessages_openai_tools(messages)).includes('signed-call'));
	});
	test('reordered results retain their original call ids', () => {
		const wire = prepareGeminiMessages(prepareMessages_anthropic_tools([messages[0], messages[2], messages[1]], false, true) as AnthropicLLMChatMessage[]);
		assert.deepStrictEqual(wire[1].parts, [
			{ functionResponse: { id: 'a', name: 'read_file', response: { output: 'one' } } },
			{ functionResponse: { id: 'b', name: 'read_file', response: { output: 'denied' } } },
		]);
	});
	test('idless repeated calls retain explicit internal associations when results reorder', () => {
		const idless = parts.map(part => part.functionCall ? { ...part, functionCall: { ...part.functionCall, id: undefined } } : part);
		const wire = prepareGeminiMessages(prepareMessages_anthropic_tools([
			{ ...messages[0], geminiParts: idless } as SimpleLLMMessage, messages[2], messages[1],
		], false, true) as AnthropicLLMChatMessage[]);
		assert.deepStrictEqual(wire[0].parts, idless);
		assert.deepStrictEqual(wire[1].parts, [
			{ functionResponse: { name: 'read_file', response: { output: 'one' } } },
			{ functionResponse: { name: 'read_file', response: { output: 'denied' } } },
		]);
	});
	test('saved native transcript replays signed parts after JSON round trip', () => {
		const recorder = new LocalAgentTranscriptRecorder();
		recorder.recordAssistant({ content: 'Inspecting', reasoning: null, geminiParts: parts, toolCalls: [{ id: 'a', name: 'read_file' }, { id: 'b', name: 'read_file' }] });
		recorder.recordToolResult({ id: 'a', name: 'read_file', content: 'one' });
		recorder.recordToolResult({ id: 'b', name: 'read_file', content: 'denied' });
		const replay = reconstructLocalAgentTranscript(JSON.parse(JSON.stringify({ [LOCAL_AGENT_TRANSCRIPT_METADATA_KEY]: recorder.metadataValue() })))!;
		assert.strictEqual(replay.length, 3);
		assert.deepStrictEqual(replay[0].role === 'assistant' && replay[0].geminiParts, parts);
	});
	test('interrupted signed exchange is never replayed with an orphaned call', () => {
		const recorder = new LocalAgentTranscriptRecorder();
		recorder.recordAssistant({ content: '', reasoning: null, geminiParts: parts, toolCalls: [{ id: 'a', name: 'read_file' }] });
		assert.strictEqual(reconstructLocalAgentTranscript({ [LOCAL_AGENT_TRANSCRIPT_METADATA_KEY]: recorder.metadataValue() }), undefined);
	});
	test('calls without wire ids do not receive invented response ids', () => {
		const unsignedIdParts = [{ functionCall: { name: 'read_file', args: {} }, thoughtSignature: 's' }];
		const wire = prepareGeminiMessages(prepareMessages_anthropic_tools([
			{ ...messages[0], geminiParts: unsignedIdParts } as SimpleLLMMessage,
			messages[1],
		], false, true) as AnthropicLLMChatMessage[]);
		assert.ok(!JSON.stringify(wire[1]).includes('"id"'));
	});
});
