/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createSdkMcpServer, McpServerConfig, tool } from '@anthropic-ai/claude-agent-sdk';
import * as vscode from 'vscode';
import { z } from 'zod';
import { IClaudeMcpServerContributor, registerClaudeMcpServerContributor } from '../../common/claudeMcpServerRegistry';

/**
 * Exposes V3Code's native (LSP-backed) Context Bridge tools to the Claude Agent SDK session as
 * an in-process MCP server named `v3code` (tools surface to Claude as `mcp__v3code__<name>`).
 *
 * The tool LOGIC lives in the V3Code workbench renderer (`toolsService.callTool`), not here. This
 * contributor fetches the canonical tool schemas from the renderer and forwards each call back via
 * a workbench command, getting the already-formatted text. Nothing is written to disk and there is
 * no separate process or port — the bridge exists only while the editor is running.
 *
 * Keep this an explicit ALLOWLIST of read/context + note tools. Do NOT expose V3Code's mutators
 * (edit/create/delete/run_command/git_commit) or agent-control tools — Claude already has its own
 * Edit/Bash/Task/TodoWrite, and exposing duplicates creates unapproved write paths and recursion.
 */

// Mirror of V3CODE_INVOKE_NATIVE_TOOL_COMMAND_ID in
// src/vs/workbench/contrib/void/browser/v3codeToolAdapters.ts. The extension host cannot import
// workbench code, so the id is duplicated here; keep the two in sync.
const V3CODE_INVOKE_NATIVE_TOOL_COMMAND = '_v3code.contextBridge.invokeNativeTool';
const V3CODE_LIST_NATIVE_TOOL_CONTRACTS_COMMAND = '_v3code.contextBridge.listNativeToolContracts';

type McpTextResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function invokeNativeTool(name: string, args: Record<string, unknown>): Promise<McpTextResult> {
	try {
		const text = await vscode.commands.executeCommand<string>(V3CODE_INVOKE_NATIVE_TOOL_COMMAND, { name, params: args ?? {} });
		return { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text ?? null) }] };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { content: [{ type: 'text', text: `V3Code tool '${name}' failed: ${message}` }], isError: true };
	}
}

interface ToolJSONSchema {
	readonly type?: string | readonly string[];
	readonly description?: string;
	readonly enum?: readonly (string | number | boolean | null)[];
	readonly properties?: Readonly<Record<string, ToolJSONSchema>>;
	readonly required?: readonly string[];
	readonly items?: ToolJSONSchema;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
}

interface ToolSpec {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: ToolJSONSchema;
}

const CLAUDE_TOOL_NAMES = [
	'get_symbol_context',
	'get_file_context',
	'get_file_dependencies',
	'get_call_graph',
	'pack_context',
	'get_project_briefing',
	'find_text',
	'semantic_search',
	'remember',
	'forget',
	'list_notes',
] as const;

function zodSchemaOf(schema: ToolJSONSchema): z.ZodTypeAny {
	const type = Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') : schema.type;
	let result: z.ZodTypeAny;

	switch (type) {
		case 'boolean':
			result = z.boolean();
			break;
		case 'integer': {
			let numberSchema = z.number().int();
			if (schema.minimum !== undefined) { numberSchema = numberSchema.min(schema.minimum); }
			if (schema.maximum !== undefined) { numberSchema = numberSchema.max(schema.maximum); }
			result = numberSchema;
			break;
		}
		case 'number': {
			let numberSchema = z.number();
			if (schema.minimum !== undefined) { numberSchema = numberSchema.min(schema.minimum); }
			if (schema.maximum !== undefined) { numberSchema = numberSchema.max(schema.maximum); }
			result = numberSchema;
			break;
		}
		case 'array': {
			let arraySchema = z.array(zodSchemaOf(schema.items ?? {}));
			if (schema.minItems !== undefined) { arraySchema = arraySchema.min(schema.minItems); }
			if (schema.maxItems !== undefined) { arraySchema = arraySchema.max(schema.maxItems); }
			result = arraySchema;
			break;
		}
		case 'object':
			result = z.object(zodShapeOf(schema)).strict();
			break;
		default: {
			const values = schema.enum?.filter((value): value is string => typeof value === 'string');
			if (values && values.length > 0) {
				result = z.enum(values as [string, ...string[]]);
			} else {
				let stringSchema = z.string();
				if (schema.minLength !== undefined) { stringSchema = stringSchema.min(schema.minLength); }
				if (schema.maxLength !== undefined) { stringSchema = stringSchema.max(schema.maxLength); }
				result = stringSchema;
			}
		}
	}

	return schema.description ? result.describe(schema.description) : result;
}

function zodShapeOf(schema: ToolJSONSchema): z.ZodRawShape {
	const required = new Set(schema.required ?? []);
	return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, property]) => {
		const validator = zodSchemaOf(property);
		return [name, required.has(name) ? validator : validator.optional()];
	}));
}

async function getToolSpecs(): Promise<readonly ToolSpec[]> {
	const specs = await vscode.commands.executeCommand<ToolSpec[]>(V3CODE_LIST_NATIVE_TOOL_CONTRACTS_COMMAND, { names: CLAUDE_TOOL_NAMES });
	if (!Array.isArray(specs) || specs.length !== CLAUDE_TOOL_NAMES.length) {
		throw new Error(`V3Code native tool contracts unavailable: expected ${CLAUDE_TOOL_NAMES.length}, received ${specs?.length ?? 0}.`);
	}
	return specs;
}

class V3CodeNativeToolsMcpServerContributor implements IClaudeMcpServerContributor {

	async getMcpServers(): Promise<Record<string, McpServerConfig>> {
		const specs = await getToolSpecs();
		const tools = specs.map(spec =>
			tool(spec.name, spec.description, zodShapeOf(spec.inputSchema), async (args) => invokeNativeTool(spec.name, args as Record<string, unknown>))
		);

		const server = createSdkMcpServer({
			name: 'v3code',
			version: '0.0.1',
			tools,
		});

		return { v3code: server };
	}
}

registerClaudeMcpServerContributor(V3CodeNativeToolsMcpServerContributor);
