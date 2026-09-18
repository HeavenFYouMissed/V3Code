/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { InternalToolInfo } from './prompts.js';
import { ToolInputSchema } from './toolContract.js';

export interface OpenAICompatibleToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: ToolInputSchema;
	};
}

/**
 * Provider-safe schema used by every model API.
 *
 * V3Code's canonical/MCP contract intentionally keeps richer JSON Schema, but
 * model providers accept different and frequently smaller schema dialects.
 * The pre-0093 contract was deliberately conservative: an object whose leaves
 * are description-bearing strings, with no top-level combinators or required
 * list. Keep that proven wire shape at the provider boundary so adding richer
 * MCP contracts cannot take every chat model down at once.
 */
export function providerInputSchemaOfTool(toolInfo: InternalToolInfo): ToolInputSchema {
	const properties: ToolInputSchema['properties'] = {};
	for (const [name, param] of Object.entries(toolInfo.params)) {
		properties[name] = { description: param.description, type: 'string' };
	}
	return { type: 'object', properties };
}

/** Convert V3Code's provider-safe contract into an OpenAI-compatible function tool. */
export function toOpenAICompatibleTool(toolInfo: InternalToolInfo): OpenAICompatibleToolDefinition {
	const { name, description } = toolInfo;

	return {
		type: 'function',
		function: {
			name,
			description,
			parameters: providerInputSchemaOfTool(toolInfo),
		},
	};
}
