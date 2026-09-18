/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  Minimal stateless MCP endpoint (streamable-HTTP, JSON response mode).
 *  Hand-rolled JSON-RPC to keep P0 dependency-free; swapping to the Cloudflare
 *  Agents SDK `createMcpHandler` is a P1 hardening task. One MCP URL per
 *  workspace: /v1/ws/:id/mcp — the bearer token scopes the workspace.
 *--------------------------------------------------------------------------------------*/

export interface McpToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	invoke(args: any): Promise<unknown>;
}

const PROTOCOL_VERSION = '2025-06-18';

export async function handleMcp(request: Request, tools: McpToolDef[], serverName: string): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('method not allowed', { status: 405 });
	}
	let rpc: any;
	try { rpc = await request.json(); } catch {
		return rpcError(null, -32700, 'parse error');
	}
	const id = rpc?.id ?? null;
	switch (rpc?.method) {
		case 'initialize':
			return rpcResult(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: serverName, version: '0.0.1' },
			});
		case 'notifications/initialized':
		case 'notifications/cancelled':
			return new Response(null, { status: 202 });
		case 'ping':
			return rpcResult(id, {});
		case 'tools/list':
			return rpcResult(id, {
				tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
			});
		case 'tools/call': {
			const tool = tools.find(t => t.name === rpc?.params?.name);
			if (!tool) return rpcError(id, -32602, `unknown tool: ${rpc?.params?.name}`);
			try {
				const result = await tool.invoke(rpc?.params?.arguments ?? {});
				return rpcResult(id, {
					content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
				});
			} catch (err: any) {
				return rpcResult(id, {
					content: [{ type: 'text', text: `error: ${err?.message ?? String(err)}` }],
					isError: true,
				});
			}
		}
		default:
			return rpcError(id, -32601, `method not found: ${rpc?.method}`);
	}
}

function rpcResult(id: unknown, result: unknown): Response {
	return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
		headers: { 'content-type': 'application/json' },
	});
}

function rpcError(id: unknown, code: number, message: string): Response {
	return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
		status: 200, headers: { 'content-type': 'application/json' },
	});
}
