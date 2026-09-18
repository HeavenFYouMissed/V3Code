/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { InternalToolInfo } from '../../common/prompt/prompts.js';
import { RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';

export interface LocalTextToolCall {
	name: string;
	rawParams: RawToolParamsObj;
}
export interface LocalTextToolExtraction {
	text: string;
	toolCalls: LocalTextToolCall[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;

function parseArguments(value: unknown): RawToolParamsObj | undefined {
	if (typeof value === 'string') {
		try { value = JSON.parse(value); }
		catch { return undefined; }
	}
	const record = asRecord(value);
	return record as RawToolParamsObj | undefined;
}

function normalizeJsonCalls(value: unknown, allowedNames: ReadonlySet<string>): LocalTextToolCall[] {
	if (Array.isArray(value)) {
		return value.flatMap(item => normalizeJsonCalls(item, allowedNames));
	}
	const record = asRecord(value);
	if (!record) { return []; }

	if (Array.isArray(record.tool_calls)) {
		return normalizeJsonCalls(record.tool_calls, allowedNames);
	}
	const fn = asRecord(record.function);
	const nameValue = fn?.name ?? record.name ?? record.tool ?? record.tool_name;
	if (typeof nameValue !== 'string' || !allowedNames.has(nameValue)) { return []; }
	const argumentsValue = fn?.arguments ?? record.arguments ?? record.parameters ?? record.input ?? record.args ?? {};
	const rawParams = parseArguments(argumentsValue);
	return rawParams ? [{ name: nameValue, rawParams }] : [];
}

function continueStyleCall(block: string, allowedNames: ReadonlySet<string>): LocalTextToolCall[] {
	const name = block.match(/^\s*TOOL_NAME:\s*([^\s]+)\s*$/mi)?.[1];
	if (!name || !allowedNames.has(name)) { return []; }
	const rawParams: RawToolParamsObj = {};
	const argumentPattern = /^\s*BEGIN_ARG:\s*([^\s]+)\s*\r?\n([\s\S]*?)^\s*END_ARG\s*$/gmi;
	for (const match of block.matchAll(argumentPattern)) {
		rawParams[match[1]] = match[2].replace(/^\s*\r?\n/, '').replace(/\r?\n\s*$/, '');
	}
	return Object.keys(rawParams).length > 0 ? [{ name, rawParams }] : [];
}

/**
 * Strict, opt-in text fallback for local models which cannot use Ollama's native tool channel.
 * Ordinary prose is never scanned for arbitrary JSON: a call must occupy the whole response or
 * be inside an explicit `tool`/`json` fence or `<tool_call>` wrapper, and its name must exist in
 * the already-filtered V3Code allowlist.
 */
export function extractLocalTextToolCalls(text: string, allowedTools: readonly InternalToolInfo[]): LocalTextToolExtraction | undefined {
	const allowedNames = new Set(allowedTools.map(tool => tool.name));
	const candidates: Array<{ raw: string; start: number; end: number; continueStyle: boolean }> = [];

	const wrappedPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
	for (const match of text.matchAll(wrappedPattern)) {
		if (match.index === undefined) { continue; }
		candidates.push({ raw: match[1], start: match.index, end: match.index + match[0].length, continueStyle: false });
	}
	const fencedPattern = /```(tool|json)\s*\r?\n([\s\S]*?)```/gi;
	for (const match of text.matchAll(fencedPattern)) {
		if (match.index === undefined) { continue; }
		candidates.push({ raw: match[2], start: match.index, end: match.index + match[0].length, continueStyle: match[1].toLowerCase() === 'tool' });
	}

	const trimmed = text.trim();
	if (candidates.length === 0 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
		const start = text.indexOf(trimmed);
		candidates.push({ raw: trimmed, start, end: start + trimmed.length, continueStyle: false });
	}

	for (const candidate of candidates) {
		let toolCalls = candidate.continueStyle ? continueStyleCall(candidate.raw, allowedNames) : [];
		if (toolCalls.length === 0) {
			try { toolCalls = normalizeJsonCalls(JSON.parse(candidate.raw), allowedNames); }
			catch { continue; }
		}
		if (toolCalls.length === 0) { continue; }
		const visibleText = `${text.slice(0, candidate.start)}${text.slice(candidate.end)}`.trim();
		return { text: visibleText, toolCalls };
	}
	return undefined;
}

/** Compact Continue-style protocol used only when `/api/show` says native tools are absent. */
export function localTextToolFallbackPrompt(tools: readonly InternalToolInfo[]): string {
	const definitions = tools.map(tool => {
		const params = Object.keys(tool.params).join(', ');
		return `- ${tool.name}(${params})`;
	}).join('\n');
	return `\n\n<local_tool_fallback>\nThis model does not expose Ollama native tool calling. You still have real tools. To call ONE tool, output only this exact fenced format:\n\`\`\`tool\nTOOL_NAME: tool_name\nBEGIN_ARG: parameter_name\nparameter value\nEND_ARG\n\`\`\`\nAvailable tools:\n${definitions}\nDo not describe a future tool call in prose. Either emit the fenced call or give the final answer.\n</local_tool_fallback>`;
}
