/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MCP_BROWSER_TOOLS } from '../common/mcpExpose/browserTools.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ExposedToolDescriptor, ToolHostCallResult } from '../common/mcpExpose/mcpExposeTypes.js';
import { LOCAL_COLLABORATION_NAMES, LOCAL_COLLABORATION_TOOLS } from '../common/mcpExpose/localCollaboration.js';

export interface McpToolHost {
	listCodeTools(): Promise<ExposedToolDescriptor[]>;
	localCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
	codeCall(name: string, args: Record<string, unknown>): Promise<ToolHostCallResult>;
}

/** Shared by the packaged editor and the real HTTP protocol tests; no Electron/UI dependency. */
export function createMcpToolProtocol(host: McpToolHost, authenticated: boolean, version: string, instructions: string): Server {
	const server = new Server({ name: 'v3code', version }, { capabilities: { tools: {} }, instructions });
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const codeTools = await host.listCodeTools().catch(() => []);
		return { tools: [...LOCAL_COLLABORATION_TOOLS, ...codeTools.map(tool => ({ ...tool, inputSchema: {
			...tool.inputSchema, properties: { ...tool.inputSchema.properties, session_token: { type: 'string' as const, description: 'Outside-agent notebook credential; pins this code request to its project.' } },
		} }))] };
	});
	server.setRequestHandler(CallToolRequestSchema, async request => {
		const name = request.params.name;
		const args = request.params.arguments ?? {};
		try {
			if (LOCAL_COLLABORATION_NAMES.has(name)) {
				if (!authenticated) { throw new Error('Local collaboration requires the authenticated V3Code bridge (bearer token). URL-only code tools remain available.'); }
				const value = await host.localCall(name, args);
				return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value, isError: value.isError === true };
			}
			if (MCP_BROWSER_TOOLS.has(name) && (!authenticated || typeof args.session_token !== 'string')) {
				throw new Error('Browser access requires an authenticated, workspace-bound V3Code connection.');
			}
			const result = await host.codeCall(name, args);
			return { content: [{ type: 'text' as const, text: result.text }, ...(result.images ?? []).map(image => ({ type: 'image' as const, ...image }))], isError: !!result.isError };
		} catch (error) {
			return { content: [{ type: 'text' as const, text: `Tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
		}
	});
	return server;
}
