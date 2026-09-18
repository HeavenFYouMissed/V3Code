/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { parse as parseJsonc } from '../../../../../base/common/json.js';
import { Mutable } from '../../../../../base/common/types.js';
import { URI } from '../../../../../base/common/uri.js';
import { INativeMcpDiscoveryData } from '../../../../../platform/mcp/common/nativeMcpDiscoveryHelper.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { DiscoverySource } from '../mcpConfiguration.js';
import { McpServerDefinition, McpServerLaunch, McpServerTransportType } from '../mcpTypes.js';
import { ClaudeDesktopMpcDiscoveryAdapter } from './nativeMcpDiscoveryAdapters.js';

/** File name of the legacy V3Code MCP config, relative to the product data folder. */
const V3CODE_MCP_CONFIG_FILE = 'mcp.json';

interface IV3CodeMcpConfigEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string | number | null>;
	url?: string;
	headers?: Record<string, string>;
}

/** V3Code already owns these tools natively; importing its own loopback bridge
 * only creates a duplicate self-connection in the MCP registry. */
export function isV3CodeLoopbackSelfDefinition(definition: McpServerDefinition): boolean {
	if (definition.label.toLowerCase() !== 'v3code' || definition.launch.type !== McpServerTransportType.HTTP) { return false; }
	return /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(definition.launch.uri.authority.toLowerCase());
}

/**
 * V3Code's config is the Claude Desktop shape plus `headers` on HTTP entries, which
 * `claudeConfigToServerDefinition` discards. Converting here keeps those headers, and
 * deliberately emits no `oauth` block: upstream discovers auth reactively from the
 * server's 401, which is what gives these servers the sign-in flow they never had.
 */
export async function v3codeConfigToServerDefinition(idPrefix: string, contents: VSBuffer, cwd?: URI): Promise<McpServerDefinition[] | undefined> {
	// Tolerant jsonc parse: a trailing comma or comment in ~/.v3code/mcp.json must not
	// silently vaporize every configured server (raw JSON.parse did exactly that).
	const parsed: { mcpServers?: Record<string, IV3CodeMcpConfigEntry> } | undefined = parseJsonc(contents.toString());
	if (parsed === undefined) {
		return;
	}

	if (!parsed?.mcpServers || typeof parsed.mcpServers !== 'object') {
		return;
	}

	const definitions = await Promise.all(Object.entries(parsed.mcpServers).map(async ([name, server]): Promise<Mutable<McpServerDefinition> | undefined> => {
		let launch: McpServerLaunch;
		if (server.url) {
			let uri: URI;
			try {
				uri = URI.parse(server.url);
			} catch {
				return undefined;
			}

			launch = {
				type: McpServerTransportType.HTTP,
				uri,
				headers: Object.entries(server.headers || {}),
			};
		} else if (server.command) {
			launch = {
				type: McpServerTransportType.Stdio,
				args: server.args || [],
				command: server.command,
				env: server.env || {},
				envFile: undefined,
				cwd: cwd?.fsPath,
				sandbox: undefined,
			};
		} else {
			return undefined;
		}

		return {
			id: `${idPrefix}.${name}`,
			label: name,
			launch,
			cacheNonce: await McpServerLaunch.hash(launch),
		};
	}));

	return definitions.filter((d): d is Mutable<McpServerDefinition> => !!d && !isV3CodeLoopbackSelfDefinition(d));
}

/**
 * Discovers servers from V3Code's own `~/.v3code/mcp.json`. Routing them through
 * upstream's registry is what grants them the extension host's OAuth handling; the
 * file format is unchanged so existing user configs keep working across the upgrade.
 */
export class V3CodeMcpDiscoveryAdapter extends ClaudeDesktopMpcDiscoveryAdapter {
	public override readonly discoverySource: DiscoverySource = DiscoverySource.V3Code;

	constructor(
		remoteAuthority: string | null,
		@IProductService private readonly _productService: IProductService,
	) {
		super(remoteAuthority);
		this.id = `v3code.${this.remoteAuthority}`;
	}

	override getFilePath({ homedir }: INativeMcpDiscoveryData): URI | undefined {
		return URI.joinPath(homedir, this._productService.dataFolderName, V3CODE_MCP_CONFIG_FILE);
	}

	override adaptFile(contents: VSBuffer, { homedir }: INativeMcpDiscoveryData): Promise<McpServerDefinition[] | undefined> {
		return v3codeConfigToServerDefinition(this.id, contents, homedir);
	}
}
