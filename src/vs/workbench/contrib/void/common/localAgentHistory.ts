/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Metadata key persisted by the native chat model for a local agent turn. */
export const LOCAL_AGENT_TRANSCRIPT_METADATA_KEY = 'v3codeLocalAgentTranscript';

const LOCAL_AGENT_TRANSCRIPT_VERSION = 1;
const MAX_EXCHANGES = 12;
const MAX_TOOL_CALLS_PER_EXCHANGE = 6;
const MAX_TRANSCRIPT_CHARS = 48_000;
const MAX_ASSISTANT_CHARS = 5_000;
const MAX_TOOL_RESULT_CHARS = 3_000;
const MAX_PARAMS_CHARS = 2_500;
const MAX_CONTINUATION_CHARS = 1_500;

export interface ILocalAgentTranscriptToolCall {
	readonly id: string;
	readonly name: string;
	readonly paramsJson: string;
}

export interface ILocalAgentTranscriptToolResult {
	readonly id: string;
	readonly name: string;
	readonly content: string;
}

export interface ILocalAgentTranscriptExchange {
	readonly assistant: {
		readonly content: string;
		readonly reasoning: string | null;
		readonly geminiParts?: import('./sendLLMMessageTypes.js').GeminiResponsePart[];
		readonly toolCalls: readonly ILocalAgentTranscriptToolCall[];
	};
	readonly tools: readonly ILocalAgentTranscriptToolResult[];
	readonly continuation?: string;
}

export interface ILocalAgentTranscript {
	readonly version: 1;
	readonly exchanges: readonly ILocalAgentTranscriptExchange[];
}

export type LocalAgentTranscriptMessage =
	| { role: 'assistant'; content: string; reasoning: string | null; geminiParts?: import('./sendLLMMessageTypes.js').GeminiResponsePart[]; geminiCallIds?: string[] }
	| { role: 'tool'; content: string; id: string; name: string; rawParams: Record<string, unknown> }
	| { role: 'user'; content: string };

/** Keep both the beginning and end of large tool output: file headers and terminal failures are often at opposite ends. */
function boundedText(value: string | null | undefined, maxChars: number): string {
	const text = value ?? '';
	if (text.length <= maxChars) {
		return text;
	}
	const marker = '\n… local transcript truncated …\n';
	const remaining = Math.max(0, maxChars - marker.length);
	const head = Math.ceil(remaining / 2);
	return text.slice(0, head) + marker + text.slice(-(remaining - head));
}

/** Serialize tool parameters into bounded JSON without allowing non-serializable values into chat metadata. */
function boundedParamsJson(params: Record<string, unknown> | undefined): string {
	let json = '{}';
	try {
		json = JSON.stringify(params ?? {}) ?? '{}';
	} catch {
		return '{"_serializationError":"Tool parameters could not be serialized"}';
	}
	if (json.length <= MAX_PARAMS_CHARS) {
		return json;
	}
	return JSON.stringify({
		_truncated: true,
		preview: boundedText(json, MAX_PARAMS_CHARS - 40),
	});
}

function parseParamsJson(paramsJson: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(paramsJson);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}

function isTranscript(value: unknown): value is ILocalAgentTranscript {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const transcript = value as { version?: unknown; exchanges?: unknown };
	return transcript.version === LOCAL_AGENT_TRANSCRIPT_VERSION && Array.isArray(transcript.exchanges);
}

/** Read a persisted local transcript defensively; malformed or future-version metadata is ignored. */
export function localAgentTranscriptFromMetadata(metadata: Readonly<Record<string, unknown>> | undefined): ILocalAgentTranscript | undefined {
	const candidate = metadata?.[LOCAL_AGENT_TRANSCRIPT_METADATA_KEY];
	return isTranscript(candidate) ? candidate : undefined;
}

/** Reconstruct the exact assistant/tool/control order that upstream chat history removes from response parts. */
export function reconstructLocalAgentTranscript(metadata: Readonly<Record<string, unknown>> | undefined): LocalAgentTranscriptMessage[] | undefined {
	const transcript = localAgentTranscriptFromMetadata(metadata);
	if (!transcript) {
		return undefined;
	}
	const messages: LocalAgentTranscriptMessage[] = [];
	for (const exchange of transcript.exchanges.slice(-MAX_EXCHANGES)) {
		if (!exchange || typeof exchange !== 'object' || !exchange.assistant || !Array.isArray(exchange.assistant.toolCalls) || !Array.isArray(exchange.tools)) {
			continue;
		}
		if (exchange.assistant.geminiParts) {
			// An interrupted signed exchange cannot be repaired by dropping individual
			// calls or inventing results. Replay only complete exchanges.
			if (!Array.isArray(exchange.assistant.geminiParts) || exchange.assistant.geminiParts.some(part => !part || typeof part !== 'object')
				|| exchange.assistant.toolCalls.some(call => !exchange.tools.some(result => result.id === call.id))) {
				continue;
			}
		}
		messages.push({
			role: 'assistant',
			content: typeof exchange.assistant.content === 'string' ? exchange.assistant.content : '',
			// Old metadata may contain completed hidden reasoning. It is UI/history data rather
			// than durable task state, so never replay it into a future model request.
			reasoning: null,
			...(exchange.assistant.geminiParts ? { geminiParts: exchange.assistant.geminiParts, geminiCallIds: exchange.assistant.toolCalls.map(call => call.id) } : {}),
		});
		const callsById = new Map(exchange.assistant.toolCalls.map(call => [call.id, call]));
		for (const result of exchange.tools) {
			if (!result || typeof result.id !== 'string' || typeof result.name !== 'string' || typeof result.content !== 'string') {
				continue;
			}
			const call = callsById.get(result.id);
			messages.push({
				role: 'tool',
				id: result.id,
				name: result.name,
				content: result.content,
				rawParams: call && typeof call.paramsJson === 'string' ? parseParamsJson(call.paramsJson) : {},
			});
		}
		if (typeof exchange.continuation === 'string' && exchange.continuation) {
			messages.push({ role: 'user', content: exchange.continuation });
		}
	}
	return messages.length > 0 ? messages : undefined;
}

/**
 * Captures one local user turn as bounded, JSON-safe exchanges. Persisting this in
 * IChatAgentResult.metadata keeps tool calls, tool outputs, and ask_user answers available after
 * the native chat model deliberately strips tool-invocation response parts from agent history.
 */
export class LocalAgentTranscriptRecorder {
	private readonly exchanges: Array<{
		assistant: { content: string; reasoning: string | null; geminiParts?: import('./sendLLMMessageTypes.js').GeminiResponsePart[]; toolCalls: ILocalAgentTranscriptToolCall[] };
		tools: ILocalAgentTranscriptToolResult[];
		continuation?: string;
	}> = [];

	recordAssistant(input: {
		content: string;
		reasoning: string | null;
		geminiParts?: import('./sendLLMMessageTypes.js').GeminiResponsePart[];
		toolCalls: readonly { id: string; name: string; rawParams?: Record<string, unknown> }[];
	}): void {
		this.exchanges.push({
			assistant: {
				content: boundedText(input.content, MAX_ASSISTANT_CHARS),
				...(input.geminiParts ? { geminiParts: input.geminiParts } : {}),
				// Provider reasoning is needed only while the current tool loop is active. Persisting
				// it made every later turn reread dead branches and superseded guesses.
				reasoning: null,
				toolCalls: (input.geminiParts ? input.toolCalls : input.toolCalls.slice(0, MAX_TOOL_CALLS_PER_EXCHANGE)).map(call => ({
					id: call.id,
					name: call.name,
					paramsJson: boundedParamsJson(call.rawParams),
				})),
			},
			tools: [],
		});
		this.trim();
	}

	recordToolResult(input: { id: string; name: string; content: string }): void {
		const exchange = this.exchanges[this.exchanges.length - 1];
		if (!exchange || (!exchange.assistant.geminiParts && exchange.tools.length >= MAX_TOOL_CALLS_PER_EXCHANGE)) {
			return;
		}
		exchange.tools.push({
			id: input.id,
			name: input.name,
			content: boundedText(input.content, MAX_TOOL_RESULT_CHARS),
		});
		this.trim();
	}

	recordContinuation(content: string): void {
		const exchange = this.exchanges[this.exchanges.length - 1];
		if (!exchange) {
			return;
		}
		exchange.continuation = boundedText(content, MAX_CONTINUATION_CHARS);
		this.trim();
	}

	metadataValue(): ILocalAgentTranscript | undefined {
		if (this.exchanges.length === 0) {
			return undefined;
		}
		return {
			version: LOCAL_AGENT_TRANSCRIPT_VERSION,
			exchanges: this.exchanges.map(exchange => ({
				assistant: {
					content: exchange.assistant.content,
					...(exchange.assistant.geminiParts ? { geminiParts: exchange.assistant.geminiParts } : {}),
					reasoning: exchange.assistant.reasoning,
					toolCalls: exchange.assistant.toolCalls.map(call => ({ ...call })),
				},
				tools: exchange.tools.map(result => ({ ...result })),
				...(exchange.continuation ? { continuation: exchange.continuation } : {}),
			})),
		};
	}

	private trim(): void {
		while (this.exchanges.length > MAX_EXCHANGES) {
			this.exchanges.shift();
		}
		while (this.exchanges.length > 1 && JSON.stringify(this.metadataValue()).length > MAX_TRANSCRIPT_CHARS) {
			this.exchanges.shift();
		}
	}
}
