/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Pure history -> provider-wire converters for native function-calling models. Extracted from
// convertToLLMMessageService.ts so they can be unit-tested headlessly (no DI / no editor services).
//
// RC-1 (see AGENT_PIPELINE_AUDIT.md): the old converters paired each tool result with the
// PRECEDING message by array index and only attached the FIRST tool call to an assistant. That
// produced orphaned tool results (Anthropic 400 -> chat drops) whenever the assistant turn was
// text-less (the normal case for native function calling) or whenever the agent emitted parallel
// tool calls. These versions track the owning assistant BY REFERENCE, aggregate all parallel tool
// calls onto it, and never emit a tool result without a matching tool call.

import { AnthropicLLMChatMessage, AnthropicReasoning, GeminiLLMChatMessage, OpenAILLMChatMessage, RawToolParamsObj } from './sendLLMMessageTypes.js';
import { ToolName } from './toolsServiceTypes.js';
import { LLM_EMPTY_TEXT_PLACEHOLDER } from './chatMessageContent.js';

export type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
	/** Base64 image payloads from tools such as screenshot_page (vision models only). */
	images?: Array<{ data: string; mimeType: string }>;
} | {
	role: 'user';
	content: string;
	images?: Array<{ data: string; mimeType: string }>;
} | {
	role: 'assistant';
	geminiParts?: import('./sendLLMMessageTypes.js').GeminiResponsePart[];
	geminiCallIds?: string[];
	content: string;
	anthropicReasoning: AnthropicReasoning[] | null;
	reasoning: string | null;
}

export type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage

type AnthropicAssistantBlock = AnthropicReasoning | { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, any>; id: string }
type AnthropicToolResultContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
type AnthropicToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string | AnthropicToolResultContentBlock[] }

type GeminiUserPart = (GeminiLLMChatMessage & { role: 'user' })['parts'][0]
type GeminiModelPart = (GeminiLLMChatMessage & { role: 'model' })['parts'][0]


// convert messages as if about to send to openai
/*
reference - https://platform.openai.com/docs/guides/function-calling#function-calling-steps
openai MESSAGE (role=assistant): "tool_calls":[{ "type":"function", "id":"call_123", "function":{ "name":..., "arguments":... }}]
openai RESPONSE (role=tool): { "role":"tool", "tool_call_id": id, "content": str(result) }
*/
export const prepareMessages_openai_tools = (messages: SimpleLLMMessage[], options?: { omitReasoningContent?: boolean }): AnthropicOrOpenAILLMMessage[] => {

	const newMessages: OpenAILLMChatMessage[] = [];

	// RC-1: pair tool results with the assistant that called them BY REFERENCE, never by array index.
	// (Indexing newMessages[i-1] drifts the instant an orphaned tool is skipped, which then dropped
	// every subsequent tool pair.) `lastAssistant` is the assistant turn that owns the current run of
	// tool calls; it is reset on any user turn (a tool can only answer the immediately-preceding
	// assistant/tool run). Consecutive tool messages (parallel tool calls) all aggregate onto it.
	let lastAssistant: (OpenAILLMChatMessage & { role: 'assistant' }) | undefined = undefined

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		if (currMsg.role !== 'tool') {
			if (currMsg.role === 'assistant' && !options?.omitReasoningContent && currMsg.reasoning != null && currMsg.reasoning !== '') {
				// Some OAI-compat thinking models require prior reasoning_content echoed back.
				// DeepSeek v4 returns 400 if reasoning_content is resent on a non-thinking call — omit via omitReasoningContent.
				const m = { role: 'assistant', content: currMsg.content, reasoning_content: currMsg.reasoning } as (OpenAILLMChatMessage & { role: 'assistant' })
				newMessages.push(m)
				lastAssistant = m
			} else if (currMsg.role === 'user' && currMsg.images && currMsg.images.length > 0) {
				// Multimodal user message with images -- use content array format
				const contentParts: any[] = [{ type: 'text', text: currMsg.content }];
				for (const img of currMsg.images) {
					contentParts.push({
						type: 'image_url',
						image_url: { url: `data:${img.mimeType};base64,${img.data}` }
					});
				}
				newMessages.push({ role: 'user', content: contentParts } as any);
				lastAssistant = undefined
			} else if (currMsg.role === 'assistant') {
				const m = { role: 'assistant', content: currMsg.content } as (OpenAILLMChatMessage & { role: 'assistant' })
				newMessages.push(m)
				lastAssistant = m
			} else {
				newMessages.push({ role: 'user', content: currMsg.content })
				lastAssistant = undefined
			}
			continue
		}

		// Tool result. Attach the tool CALL to the owning assistant; if there is none (text-less tool
		// turn that wasn't persisted, or a mid-stream abort), synthesize a minimal placeholder
		// assistant so the result is faithfully paired instead of silently dropped (RC-1).
		if (!lastAssistant) {
			lastAssistant = { role: 'assistant', content: LLM_EMPTY_TEXT_PLACEHOLDER }
			newMessages.push(lastAssistant)
		}
		if (!lastAssistant.tool_calls) { lastAssistant.tool_calls = [] }
		lastAssistant.tool_calls.push({
			type: 'function',
			id: currMsg.id,
			function: {
				name: currMsg.name,
				arguments: JSON.stringify(currMsg.rawParams)
			}
		})

		// add the tool result (always immediately after its assistant / sibling tool results)
		newMessages.push({
			role: 'tool',
			tool_call_id: currMsg.id,
			content: currMsg.content,
		})
		// OpenAI tool messages are text-only — attach tool images as a follow-up user multimodal turn.
		if (currMsg.images && currMsg.images.length > 0) {
			const contentParts: any[] = [{ type: 'text', text: currMsg.content || `Visual output from tool ${currMsg.name}:` }];
			for (const img of currMsg.images) {
				contentParts.push({
					type: 'image_url',
					image_url: { url: `data:${img.mimeType};base64,${img.data}` },
				});
			}
			newMessages.push({ role: 'user', content: contentParts } as any);
			lastAssistant = undefined;
		}
	}
	return newMessages

}


// convert messages as if about to send to anthropic
/*
anthropic MESSAGE (role=assistant): content: [{type:text,...}, {type:tool_use, id, name, input}]
anthropic RESPONSE (role=user): content: [{type:tool_result, tool_use_id, content}]
*/
export const prepareMessages_anthropic_tools = (messages: SimpleLLMMessage[], supportsAnthropicReasoning: boolean, preserveGeminiParts = false): AnthropicOrOpenAILLMMessage[] => {
	// RC-1: build a FRESH array (the old version mutated `messages` in place and paired tool results
	// with newMessages[i-1] — which orphaned every parallel tool call past the first and, worse,
	// pushed a tool_result with NO matching tool_use whenever the assistant turn was text-less,
	// producing an Anthropic 400 that dropped the whole chat). Here we track the owning assistant by
	// reference, aggregate all parallel `tool_use` blocks onto it, and emit the matching `tool_result`
	// blocks as ONE following user message (Anthropic's canonical parallel-tool shape).
	const newMessages: AnthropicLLMChatMessage[] = []
	let lastAssistant: (AnthropicLLMChatMessage & { role: 'assistant' }) | undefined = undefined
	let pendingToolResults: AnthropicToolResultBlock[] = []

	const flushToolResults = () => {
		if (pendingToolResults.length) {
			newMessages.push({ role: 'user', content: pendingToolResults })
			pendingToolResults = []
		}
	}

	for (let i = 0; i < messages.length; i += 1) {
		const currMsg = messages[i]

		// add anthropic reasoning
		if (currMsg.role === 'assistant') {
			flushToolResults() // close any open tool-result run before starting a new assistant turn
			let m: (AnthropicLLMChatMessage & { role: 'assistant' })
			if (currMsg.anthropicReasoning && supportsAnthropicReasoning) {
				const content = currMsg.content
				m = {
					role: 'assistant',
					content: content ? [...currMsg.anthropicReasoning, { type: 'text' as const, text: content }] : [...currMsg.anthropicReasoning]
				}
			}
			else {
				m = {
					role: 'assistant',
					content: currMsg.content,
					// strip away anthropicReasoning
				}
			}
			if (preserveGeminiParts && currMsg.geminiParts) {
				m.geminiParts = currMsg.geminiParts;
				m.geminiCallIds = currMsg.geminiCallIds;
			}
			newMessages.push(m)
			lastAssistant = m
			continue
		}

		if (currMsg.role === 'user') {
			flushToolResults()
			if (currMsg.images && currMsg.images.length > 0) {
				// Multimodal user message: text + image blocks (Anthropic base64 format)
				const contentParts: any[] = []
				if (currMsg.content) contentParts.push({ type: 'text', text: currMsg.content })
				for (const img of currMsg.images) {
					contentParts.push({
						type: 'image',
						source: { type: 'base64', media_type: img.mimeType, data: img.data },
					})
				}
				newMessages.push({ role: 'user', content: contentParts as any })
			} else {
				newMessages.push({ role: 'user', content: currMsg.content })
			}
			lastAssistant = undefined
			continue
		}

		if (currMsg.role === 'tool') {
			// Attach the tool_use to the owning assistant. If there is none (text-less tool turn that
			// wasn't persisted, or a mid-stream abort), synthesize a minimal placeholder assistant so
			// the result is faithfully paired instead of producing an orphaned tool_result (400).
			if (!lastAssistant) {
				lastAssistant = { role: 'assistant', content: [] }
				newMessages.push(lastAssistant)
			}
			if (typeof lastAssistant.content === 'string') {
				lastAssistant.content = lastAssistant.content.trim()
					? [{ type: 'text', text: lastAssistant.content }]
					: []
			}
			(lastAssistant.content as AnthropicAssistantBlock[]).push({ type: 'tool_use', id: currMsg.id, name: currMsg.name, input: currMsg.rawParams })
			if (currMsg.images && currMsg.images.length > 0) {
				const blocks: AnthropicToolResultContentBlock[] = [];
				if (currMsg.content) {
					blocks.push({ type: 'text', text: currMsg.content });
				}
				for (const img of currMsg.images) {
					blocks.push({
						type: 'image',
						source: { type: 'base64', media_type: img.mimeType, data: img.data },
					});
				}
				pendingToolResults.push({ type: 'tool_result', tool_use_id: currMsg.id, content: blocks });
			} else {
				pendingToolResults.push({ type: 'tool_result', tool_use_id: currMsg.id, content: currMsg.content });
			}
			continue
		}

	}

	flushToolResults()
	return newMessages
}


// Gemini converter — consumes the ANTHROPIC-style output (gemini-style first runs the anthropic
// converter, then maps blocks to Gemini parts).
export const prepareGeminiMessages = (messages: AnthropicLLMChatMessage[]) => {
	// RC-1: Gemini pairs a functionResponse with its call by NAME. The old code tracked a single
	// `latestToolName` and stamped it onto EVERY tool_result in a user turn, so parallel tool calls
	// (and any result whose call wasn't the most recent) got mislabeled. Build a tool_use id -> name
	// map from the assistant turns (which always precede their results in array order) and look each
	// result up by its own tool_use_id.
	const toolNameById = new Map<string, ToolName>()
	const signedCallIds = new Map<string, string | undefined>();
	const signedCallOrder = new Map<string, number>();
	const messages2: GeminiLLMChatMessage[] = messages.map((m): GeminiLLMChatMessage | null => {
		if (m.role === 'assistant') {
			if (m.geminiParts) {
				// Keep the signed response exactly as emitted. The synthesized calls still
				// supply internal id-to-name pairing for matching results.
				if (Array.isArray(m.content)) {
					const calls = m.geminiParts.flatMap(part => part.functionCall ? [part.functionCall] : []);
					const callsByInternalId = new Map(calls.map((call, index) => [m.geminiCallIds?.[index] ?? call.id, call]));
					calls.forEach((call, index) => {
						const internalId = m.geminiCallIds?.[index] ?? call.id;
						if (internalId) { signedCallOrder.set(internalId, index); }
					});
					for (const block of m.content) {
						if (block.type === 'tool_use') {
							const call = callsByInternalId.get(block.id);
							if (!call) { throw new Error('Cannot safely pair a saved Gemini tool result. Start a new chat.'); }
							toolNameById.set(block.id, block.name as ToolName);
							signedCallIds.set(block.id, call.id);
						}
					}
				}
				return { role: 'model', parts: m.geminiParts };
			}
			if (typeof m.content === 'string') {
				return { role: 'model', parts: [{ text: m.content }] }
			}
			else {
				const parts: GeminiModelPart[] = m.content.map((c): GeminiModelPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_use') {
						toolNameById.set(c.id, c.name as ToolName)
						return { functionCall: { id: c.id, name: c.name as ToolName, args: c.input } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'model', parts, }
			}
		}
		else if (m.role === 'user') {
			if (typeof m.content === 'string') {
				return { role: 'user', parts: [{ text: m.content }] } satisfies GeminiLLMChatMessage
			}
			else {
				// Execution can prioritize slow tools. Restore original response order,
				// essential when repeated function names have no protocol-level ids.
				const results = m.content.filter(c => c.type === 'tool_result').sort((a, b) =>
					(signedCallOrder.get(a.tool_use_id) ?? Number.MAX_SAFE_INTEGER) - (signedCallOrder.get(b.tool_use_id) ?? Number.MAX_SAFE_INTEGER));
				let resultIndex = 0;
				const orderedContent = m.content.map(c => c.type === 'tool_result' ? results[resultIndex++] : c);
				const parts: GeminiUserPart[] = orderedContent.map((c): GeminiUserPart | null => {
					if (c.type === 'text') {
						return { text: c.text }
					}
					else if (c.type === 'tool_result') {
						const name = toolNameById.get(c.tool_use_id)
						if (!name) return null
						const output = typeof c.content === 'string'
							? c.content
							: c.content.map(block => block.type === 'text' ? block.text : '[image]').join('\n')
						const id = signedCallIds.has(c.tool_use_id) ? signedCallIds.get(c.tool_use_id) : c.tool_use_id;
						return { functionResponse: { ...(id ? { id } : {}), name, response: { output } } }
					}
					else if (c.type === 'image') {
						// Map Anthropic base64 image blocks to Gemini inlineData. Without this,
						// every image attached to a chat was silently dropped for all Gemini models
						// (vision-capable ones never even got the describe fallback).
						return { inlineData: { mimeType: c.source.media_type, data: c.source.data } }
					}
					else return null
				}).filter(m => !!m)
				return { role: 'user', parts, }
			}

		}
		else return null
	}).filter(m => !!m)

	return messages2
}
