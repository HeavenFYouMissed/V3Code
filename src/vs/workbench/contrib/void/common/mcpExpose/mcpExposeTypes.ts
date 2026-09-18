/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Shared contracts for "V3Code as an MCP server" — exposing the editor's
// built-in intelligence tools (semantic_search, the LSP context bridge, memory)
// to external agents (Claude Code, etc.) over a local HTTP/MCP endpoint.
//
// IMPORTANT: this file is imported by BOTH the main process
// (electron-main/v3codeMcpServerChannel.ts) and the renderer
// (browser/mcpExposeContribution.ts). Keep it dependency-free (pure types +
// consts) so it never drags renderer-only or node-only code across the boundary.

import type { ToolInputSchema } from '../prompt/toolContract.js';

/**
 * Control channel (a main-process IServerChannel). The renderer calls this to
 * (a) announce itself — which hands the main process the renderer's IPC ctx so
 * it can route tool calls back — and (b) trigger the HTTP server to start.
 */
export const V3CODE_MCP_EXPOSE_CHANNEL = 'void-channel-mcpExpose';

/**
 * Callback channel registered BY the renderer (via IMainProcessService.registerChannel)
 * and called INTO by the main-process MCP server. This is where the real tool
 * execution happens, because that's where IToolsService / the LSP bridge / the
 * semantic index actually live. Mirrors the McpGatewayToolBroker pattern.
 */
export const V3CODE_MCP_TOOLHOST_CHANNEL = 'void-channel-toolHost';

/** Default loopback port for the MCP endpoint. Falls back to the next free port. */
export const V3CODE_MCP_DEFAULT_PORT = 7333;

/** A single tool advertised over MCP (JSON-Schema input, like the MCP `Tool` type). */
export interface ExposedToolDescriptor {
	name: string;
	description: string;
	inputSchema: ToolInputSchema;
}

/** Stable stdio launch used by Codex, Claude Code, and other local MCP clients. */
export interface V3codeMcpBridgeLaunch {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export type V3codeMcpClientSetupStatus = 'missing' | 'current' | 'stale';

export interface V3codeMcpClientSetupResult {
	codex: {
		status: V3codeMcpClientSetupStatus;
		configPath: string;
	};
	bridge?: V3codeMcpBridgeLaunch;
}

export interface V3codeMcpInstallResult {
	status: 'installed';
	configPath: string;
	backupPath?: string;
	restartRequired: true;
}

export interface V3codeMcpExtensionResult {
	path: string;
}

/**
 * Directory holding one descriptor file per RUNNING V3Code instance, so an external
 * agent can discover every editor at once and pick which one to talk to. Shared by
 * dev and release builds on purpose — the per-instance file carries the identity, and
 * a single well-known path is what makes discovery possible at all.
 */
export const V3CODE_MCP_ENDPOINT_DIR = 'endpoints';

/** Legacy single-endpoint file. Still written (pointing at the newest instance) so pre-registry clients keep working. */
export const V3CODE_MCP_LEGACY_ENDPOINT_FILE = 'endpoint.json';

/** Optional owner-only bearer credential for clients that choose authenticated loopback MCP. */
export const V3CODE_MCP_TOKEN_FILE = 'mcp-token';

/** Release smoke and the Settings copy button both reject malformed credentials. */
export const V3CODE_MCP_TOKEN_PATTERN = /^[a-f0-9]{48}$/;

/**
 * Build the exact client configuration shown in Settings. Keeping this shared
 * with the authentication tests prevents the UI from silently copying a config
 * that the local server will reject.
 */
export function buildV3codeMcpClientConfig(url: string, token?: string): string {
	if (!/^https?:\/\//.test(url)) {
		throw new Error('V3Code MCP endpoint URL is invalid.');
	}
	if (token !== undefined && !V3CODE_MCP_TOKEN_PATTERN.test(token)) {
		throw new Error('V3Code MCP bearer token is invalid.');
	}
	return JSON.stringify({
		mcpServers: {
			v3code: {
				url,
				...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
			},
		},
	}, null, 2);
}

/** Portable JSON config for clients that accept a local stdio MCP server. */
export function buildV3codeMcpStdioClientConfig(bridge: V3codeMcpBridgeLaunch): string {
	validateBridgeLaunch(bridge);
	return JSON.stringify({
		mcpServers: {
			v3code: {
				command: bridge.command,
				args: bridge.args,
				...(bridge.env && Object.keys(bridge.env).length ? { env: bridge.env } : {}),
			},
		},
	}, null, 2);
}

/** Claude Code's add-json payload (the outer `mcpServers` wrapper is intentionally absent). */
export function buildV3codeClaudeCodeConfig(bridge: V3codeMcpBridgeLaunch): string {
	validateBridgeLaunch(bridge);
	return JSON.stringify({
		type: 'stdio',
		command: bridge.command,
		args: bridge.args,
		...(bridge.env && Object.keys(bridge.env).length ? { env: bridge.env } : {}),
	});
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

/** Canonical Codex config block. Using stdio avoids pinning Codex to one process port. */
export function buildV3codeCodexConfig(bridge: V3codeMcpBridgeLaunch): string {
	validateBridgeLaunch(bridge);
	const lines = [
		'[mcp_servers.v3code]',
		`command = ${tomlString(bridge.command)}`,
		`args = [${bridge.args.map(tomlString).join(', ')}]`,
	];
	if (bridge.env && Object.keys(bridge.env).length) {
		lines.push('', '[mcp_servers.v3code.env]');
		for (const [key, value] of Object.entries(bridge.env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { throw new Error(`Invalid MCP environment key: ${key}`); }
			lines.push(`${key} = ${tomlString(value)}`);
		}
	}
	return `${lines.join('\n')}\n`;
}

/** Replace only V3Code's Codex table(s), preserving every unrelated setting and server. */
export function upsertV3codeCodexConfig(existing: string, bridge: V3codeMcpBridgeLaunch): string {
	const lines = existing.replace(/\r\n/g, '\n').split('\n');
	const kept: string[] = [];
	let dropping = false;
	for (const line of lines) {
		const table = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
		if (table !== undefined) {
			dropping = table === 'mcp_servers.v3code' || table.startsWith('mcp_servers.v3code.');
		}
		if (!dropping) { kept.push(line); }
	}
	const prefix = kept.join('\n').trimEnd();
	return `${prefix ? `${prefix}\n\n` : ''}${buildV3codeCodexConfig(bridge)}`;
}

export function getV3codeCodexConfigStatus(existing: string, bridge: V3codeMcpBridgeLaunch): V3codeMcpClientSetupStatus {
	if (!/^\s*\[mcp_servers\.v3code\]\s*$/m.test(existing)) { return 'missing'; }
	return existing.includes(`command = ${tomlString(bridge.command)}`) &&
		bridge.args.every(arg => existing.includes(tomlString(arg))) &&
		Object.entries(bridge.env ?? {}).every(([key, value]) => existing.includes(`${key} = ${tomlString(value)}`))
		? 'current'
		: 'stale';
}

/** Manifest for Claude Desktop's installable local extension format (MCPB). */
export function buildV3codeMcpbManifest(version: string): string {
	return JSON.stringify({
		manifest_version: '0.3',
		name: 'v3code',
		display_name: 'V3Code',
		version,
		description: 'Connect Claude to the live V3Code editor for code intelligence, project memory, and agent actions.',
		author: { name: 'V3Code' },
		homepage: 'https://v3code.dev',
		documentation: 'https://v3code.dev',
		server: {
			type: 'node',
			entry_point: 'server/v3code-mcp-bridge.mjs',
			mcp_config: {
				command: 'node',
				args: ['${__dirname}/server/v3code-mcp-bridge.mjs'],
			},
		},
		compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=18.0.0' } },
		tools_generated: true,
	}, null, 2);
}

function validateBridgeLaunch(bridge: V3codeMcpBridgeLaunch): void {
	if (!bridge.command || !bridge.args.length || bridge.args.some(arg => !arg)) {
		throw new Error('V3Code MCP bridge launch is incomplete.');
	}
}

/** Which build an endpoint belongs to. `dev` = run from source (VSCODE_DEV), `release` = installed app. */
export type McpInstanceChannel = 'dev' | 'release';

/**
 * One running editor, as published to `~/.v3code/endpoints/<instanceId>.json`.
 *
 * Exists because two builds can run at once (installed app + dev build): a single
 * shared lockfile is last-writer-wins, so a client could silently connect to the wrong
 * editor with no way to tell. Every field here is for disambiguation — `name` is the
 * human label, `channel`/`release`/`appRoot` say WHICH build, `workspaces` says which project.
 */
export interface McpInstanceDescriptor extends Omit<McpExposeEndpoint, 'token'> {
	/** Stable for the life of the process, e.g. `dev-79462`. Also the descriptor's filename stem. */
	instanceId: string;
	/** Human label for a picker, e.g. `V3Code Dev · v3code-scratch`. */
	name: string;
	channel: McpInstanceChannel;
	/** product.json voidRelease (e.g. `0083`), when present. */
	release?: string;
	/** Exact 40-hex source revision baked into the running product. */
	commit?: string;
	/** Source/install root — the concrete way to tell two dev builds apart. */
	appRoot?: string;
	workspaces: string[];
	pid: number;
	startedAt: string;
	updatedAt: string;
	/** Stable stdio proxy. It discovers the correct live HTTP endpoint on every request. */
	bridge?: V3codeMcpBridgeLaunch;
}

/** Renderer -> main 'register' payload. */
export interface ToolHostRegisterPayload {
	workspaceRoots: string[];
	workspaceUris?: string[];
}

/** main -> renderer 'callTool' params. */
export interface ToolHostCallPayload {
	name: string;
	args: Record<string, unknown>;
	expectedRoots?: string[];
	/** Main-process verified opt-in bound to the authenticated notebook and window. */
	browserApproved?: boolean;
}

/** main -> renderer 'callTool' result (already serialized to LLM-safe text). */
export interface ToolHostCallResult {
	text: string;
	isError?: boolean;
	images?: { data: string; mimeType: string }[];
}

/** main 'register'/'getEndpoint' response — the live endpoint, for display/logging. */
export interface McpExposeEndpoint {
	url: string;
	port: number;
	token: string;
}
