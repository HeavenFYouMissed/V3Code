/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * MCPUpstreamFacade — implements V3Code's IMCPService on top of upstream VS Code's MCP registry.
 *
 * V3Code's own MCP stack has no authentication of any kind. Upstream's does: the extension host
 * reacts to a 401 by walking WWW-Authenticate -> protected resource metadata -> authorization
 * server metadata -> dynamic client registration -> PKCE, and stores the token in the OS keychain.
 * That machinery only ever runs for servers that live in upstream's registry, so routing V3Code's
 * tool list through this facade is what lets an OAuth'd server's tools reach the model.
 */

import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IAuthenticationQueryService } from '../../../services/authentication/common/authenticationQuery.js';
import { IDynamicAuthenticationProviderStorageService } from '../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { IWorkbenchMcpManagementService } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { ContributionEnablementState, isContributionEnabled } from '../../chat/common/enablement.js';
import { McpCommandIds } from '../../mcp/common/mcpCommandIds.js';
import { IMcpServer, IMcpService, IMcpTool, McpConnectionState } from '../../mcp/common/mcpTypes.js';
import { MCP } from '../../mcp/common/modelContextProtocol.js';
import { CatalogInput } from '../common/mcpCatalog.js';
import { CATALOG_INSTALL_MAP_STORAGE_KEY, CatalogInstallMap, decideInstallName, parseCatalogInstallMap, resolveServerForName, serializeCatalogInstallMap } from '../common/mcpCatalogIdentity.js';
import { normalizeMcpEntryPlaceholders } from '../common/mcpPlaceholderNormalization.js';
import { IMCPService } from '../common/mcpService.js';
import { MCPConfigFileEntryJSON, MCPServer, MCPServerOfName, MCPTool, MCPToolCallParams, RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { InternalToolInfo } from '../common/prompt/prompts.js';
import { toolInputSchemaFromUnknown } from '../common/prompt/toolContract.js';

type MCPServiceState = {
	mcpServerOfName: MCPServerOfName;
	error: string | undefined;
};

type MCPServerWithEnablement = MCPServer & {
	readonly isEnabled: boolean;
};

/** Everything the settings/marketplace UI needs to render a row, including a "Sign in" affordance. */
export interface IMCPUpstreamServerInfo {
	readonly serverId: string;
	readonly label: string;
	readonly connectionState: McpConnectionState;
	/** True when upstream stopped the server because auth (or another prompt) needs the user. */
	readonly needsUserInteraction: boolean;
	readonly isEnabled: boolean;
	readonly toolNames: readonly string[];
	readonly errorMessage: string | undefined;
}

/** Image mime types V3Code's tool-result union accepts; upstream types this as a bare string. */
type V3CodeImageMimeType = Extract<RawMCPToolCall, { event: 'image' }>['image']['mimeType'];

export class MCPUpstreamFacade extends Disposable implements IMCPService {
	_serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event;

	private _state: MCPServiceState = { mcpServerOfName: {}, error: undefined };
	private _upstreamServers: readonly IMCPUpstreamServerInfo[] = [];
	private _autostartRequested = false;

	get state(): MCPServiceState {
		return this._state;
	}

	constructor(
		@IMcpService private readonly upstreamMcpService: IMcpService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IAuthenticationQueryService private readonly authenticationQueryService: IAuthenticationQueryService,
		@IDynamicAuthenticationProviderStorageService private readonly dynamicAuthStorageService: IDynamicAuthenticationProviderStorageService,
	) {
		super();

		// Reading each server's connectionState/tools inside the autorun is what subscribes us to
		// them: a server that finishes OAuth and only then publishes tools must re-fire this event,
		// otherwise the agent's advertised tool list stays frozen at the pre-auth (empty) snapshot.
		this._register(autorun(reader => {
			const servers = this.upstreamMcpService.servers.read(reader);

			const mcpServerOfName: MCPServerOfName = {};
			const infos: IMCPUpstreamServerInfo[] = [];
			const stateOfDefinitionId = new Map<string, MCPServerWithEnablement>();

			for (const server of servers) {
				const connectionState = server.connectionState.read(reader);
				const tools = server.tools.read(reader);
				const enablement = server.enablement.read(reader);
				const isEnabled = isContributionEnabled(enablement);

				const v3State = this._toV3CodeServer(connectionState, tools, isEnabled);
				stateOfDefinitionId.set(server.definition.id, v3State);
				mcpServerOfName[server.definition.label] = v3State;
				infos.push({
					serverId: server.definition.id,
					label: server.definition.label,
					connectionState,
					needsUserInteraction: connectionState.state === McpConnectionState.Kind.Stopped
						&& connectionState.reason === 'needs-user-interaction',
					isEnabled,
					toolNames: tools.map(tool => tool.referenceName),
					errorMessage: connectionState.state === McpConnectionState.Kind.Error ? connectionState.message : undefined,
				});
			}

			// Label collisions: the key holds the server actions would resolve to, and each
			// catalog id overlays its mapped install — so a card's DISPLAY (looked up by
			// catalog id) always shows the server its buttons act on, suffixed installs
			// included.
			const installMap = this._readInstallMap();
			for (const server of this._preferredServersByLabel(servers)) {
				const state = stateOfDefinitionId.get(server.definition.id);
				if (state) {
					mcpServerOfName[server.definition.label] = state;
				}
			}
			for (const [catalogId, record] of Object.entries(installMap)) {
				const state = stateOfDefinitionId.get(record.serverDefinitionId);
				if (state) {
					mcpServerOfName[catalogId] = state;
				}
			}

			this._state = { mcpServerOfName, error: undefined };
			this._upstreamServers = infos;
			this._onDidChangeState.fire();
		}));
	}

	// --- reads -------------------------------------------------------------------------------

	getMCPTools(): InternalToolInfo[] | undefined {
		// The first tool-list request of a session mirrors upstream's first-chat-request
		// autostart trigger (V3Code's agent bypasses chatServiceImpl, so nothing else
		// calls it). Honors the chat.mcp.autostart setting; the default (Never) is a no-op.
		if (!this._autostartRequested) {
			this._autostartRequested = true;
			try {
				this.upstreamMcpService.autostart();
			} catch (error) {
				this.logService.error('[v3code-mcp] autostart failed', error);
			}
		}

		const allTools: InternalToolInfo[] = [];
		for (const server of this._preferredServersByLabel(this._readServers())) {
			// A disabled server's cached tools must never reach the model.
			if (!isContributionEnabled(this._readEnablement(server))) {
				continue;
			}
			const serverName = server.definition.label;
			for (const tool of this._readTools(server)) {
				allTools.push({
					name: tool.referenceName,
					description: tool.definition.description || '',
					params: this._transformInputSchemaToParams(tool.definition.inputSchema),
					inputSchema: toolInputSchemaFromUnknown(tool.definition.inputSchema),
					mcpServerName: serverName,
				});
			}
		}
		if (allTools.length === 0) { return undefined; }
		return allTools;
	}

	/** Per-server connection/auth/tool status for the UI. Never throws; may be empty mid-startup. */
	getUpstreamServers(): readonly IMCPUpstreamServerInfo[] {
		return this._upstreamServers;
	}

	async getMcpConfigServerNames(): Promise<string[]> {
		return this._readServers().map(server => server.definition.label);
	}

	stringifyResult(result: RawMCPToolCall): string {
		if (result.event === 'text') { return result.text; }
		if (result.event === 'image') { return `[Image: ${result.image.mimeType}]`; }
		if (result.event === 'audio') { return `[Audio content]`; }
		if (result.event === 'resource') { return `[Resource content]`; }
		return JSON.stringify(result);
	}

	// --- writes ------------------------------------------------------------------------------

	async revealMCPConfigFile(): Promise<void> {
		try {
			await this.commandService.executeCommand(McpCommandIds.OpenUserMcp);
		} catch (error) {
			this.logService.error('[v3code-mcp] failed to open the MCP config file', error);
		}
	}

	async toggleServerIsOn(serverName: string, isOn: boolean): Promise<void> {
		const server = this._findServer(serverName);
		if (!server) { return; }

		this.upstreamMcpService.enablementModel.setEnabled(
			server.definition.id,
			isOn ? ContributionEnablementState.EnabledProfile : ContributionEnablementState.DisabledProfile,
		);

		try {
			if (isOn) {
				// Starting here is what surfaces the OAuth prompt for an HTTP server that has never
				// been authorized: the 401 only happens once someone actually connects.
				await server.start();
			} else {
				await server.stop();
			}
		} catch (error) {
			this.logService.error(`[v3code-mcp] failed to ${isOn ? 'start' : 'stop'} MCP server "${serverName}"`, error);
		}
	}

	/**
	 * Starts a server so upstream can run its auth handshake. Named for the settings tab's
	 * capability probe (`OptionalMcpMethods.signInToServer`) — its "Sign in" button on a server
	 * reporting `needs-user-interaction` calls exactly this.
	 */
	async signInToServer(serverName: string): Promise<void> {
		return this.reauthenticateServer(serverName);
	}

	/**
	 * Restarts a hosted server's authentication handshake even when the runtime
	 * currently reports it as running. This recovers from copying or cancelling
	 * the first authorization URL: start() alone is a no-op on a running server.
	 */
	async reauthenticateServer(serverName: string): Promise<void> {
		const server = this._findServer(serverName);
		if (!server) {
			throw new Error(localize('v3code.mcp.noSuchServer', 'MCP server "{0}" is not available.', serverName));
		}
		try {
			await server.stop();
			const state = await server.start({ promptType: 'all-untrusted' });
			this._assertStarted(state, serverName);
		} catch (error) {
			this.logService.error(`[v3code-mcp] re-authentication failed for MCP server "${serverName}"`, error);
			throw error;
		}
	}

	/**
	 * A genuinely fresh sign-in: stop/start alone reuses the cached client registration
	 * and sessions, which cannot recover from authorize-time failures (the Canva class —
	 * the provider's error renders in the browser and the editor only sees a cancel).
	 * This wipes account access, sessions, and the dynamic provider's registration so
	 * the next start rediscovers and re-registers from scratch.
	 */
	async resetServerAuth(serverName: string): Promise<void> {
		const server = this._findServer(serverName);
		if (!server) {
			throw new Error(localize('v3code.mcp.noSuchServer', 'MCP server "{0}" is not available.', serverName));
		}
		try {
			await server.stop();

			// Providers this server actually signed in with: revoke access, drop sessions,
			// and tear the dynamic registration down ONLY when no sibling still uses the
			// provider — dynamic providers are shared per authorization server, and a
			// fresh sign-in for one server must not silently sign its siblings out of
			// their registration.
			const handledProviders = new Set<string>();
			for (const [providerId, accountName] of this.authenticationQueryService.mcpServer(server.definition.id).getAllAccountPreferences()) {
				handledProviders.add(providerId);
				const accountQuery = this.authenticationQueryService.provider(providerId).account(accountName);
				const usedByOthers = accountQuery.entities().getEntityCount().total > 1;
				accountQuery.mcpServer(server.definition.id).setAccessAllowed(false, server.definition.label);
				const accounts = await this.authenticationService.getAccounts(providerId);
				const account = accounts.find(a => a.label === accountName);
				if (account) {
					const sessions = await this.authenticationService.getSessions(providerId, undefined, { account });
					for (const session of sessions) {
						await this.authenticationService.removeSession(providerId, session.id);
					}
				}
				if (!usedByOthers && this.authenticationService.isDynamicAuthenticationProvider(providerId)) {
					this.authenticationService.unregisterAuthenticationProvider(providerId);
					await this.dynamicAuthStorageService.removeDynamicProvider(providerId);
				}
			}

			// The motivating failure records NO account preference: sign-in that dies at
			// the authorize step (invalid_client) leaves only a cached client registration
			// with zero sessions. Sweep those orphans so the next attempt re-discovers and
			// re-registers from scratch instead of replaying the broken registration.
			for (const provider of this.dynamicAuthStorageService.getInteractedProviders()) {
				if (handledProviders.has(provider.providerId) || !this.authenticationService.isDynamicAuthenticationProvider(provider.providerId)) {
					continue;
				}
				try {
					const sessions = await this.authenticationService.getSessions(provider.providerId);
					if (sessions.length === 0) {
						this.authenticationService.unregisterAuthenticationProvider(provider.providerId);
						await this.dynamicAuthStorageService.removeDynamicProvider(provider.providerId);
					}
				} catch (error) {
					this.logService.warn(`[v3code-mcp] could not inspect dynamic auth provider "${provider.providerId}" during fresh sign-in`, error);
				}
			}

			const state = await server.start({ promptType: 'all-untrusted' });
			this._assertStarted(state, serverName);
		} catch (error) {
			this.logService.error(`[v3code-mcp] fresh sign-in failed for MCP server "${serverName}"`, error);
			throw error;
		}
	}

	/**
	 * Removes a server from upstream's registry. Also part of the settings tab's capability
	 * probe (`OptionalMcpMethods.uninstallMcpServer`) — without it the tab can only point the
	 * user at mcp.json.
	 */
	async uninstallMcpServer(serverName: string): Promise<void> {
		const map = this._readInstallMap();
		const installedName = map[serverName]?.installedName ?? serverName;
		const installed = await this.mcpManagementService.getInstalled();
		const matches = installed.filter(s => s.name === installedName);
		if (matches.length === 0) {
			// Not an upstream install — a legacy ~/.v3code/mcp.json server matched by
			// name. A silent no-op leaves it configured and connected; open the file
			// that actually defines it so removal is one visible edit away.
			this.logService.info(`[v3code-mcp] "${serverName}" is not an installed server; opening the MCP config file that defines it.`);
			await this.revealMCPConfigFile();
			return;
		}
		if (matches.length > 1) {
			this.logService.warn(`[v3code-mcp] "${installedName}" is installed in more than one scope; removing the first match.`);
		}
		await this.mcpManagementService.uninstall(matches[0]);

		// Drop every mapping that pointed at the removed install so a later reinstall
		// records a fresh identity instead of resolving to a dead definition id.
		let changed = false;
		for (const [catalogId, record] of Object.entries(map)) {
			if (record.installedName === installedName) {
				delete map[catalogId];
				changed = true;
			}
		}
		if (changed) {
			this._storeInstallMap(map);
		}
	}

	async installMcpServer(serverName: string, rawEntry: MCPConfigFileEntryJSON, requiredInputs?: readonly CatalogInput[]): Promise<void> {
		// Published configs carry bare ${VAR} placeholders. Rewrite them into ${input:...}
		// prompts (secrets password-masked, stored encrypted) BEFORE anything is persisted:
		// upstream resolves inputs ahead of any network contact, and the registry's launch
		// gate refuses whatever still carries a placeholder.
		const { entry, inputs, notices } = normalizeMcpEntryPlaceholders(rawEntry, requiredInputs);
		for (const notice of notices) {
			this.logService.info(`[MCP install ${serverName}] ${notice}`);
		}

		// Installing through upstream's management service (rather than V3Code's ~/.v3code/mcp.json)
		// is what puts the server in the registry the ext-host auth flow watches. A
		// user-supplied pre-registered client id rides along in the remote config —
		// mainThreadMcp resolves it ahead of dynamic registration, which is the only
		// sign-in path providers like Slack/Google Drive accept.
		const config = entry.url !== undefined
			? {
				type: McpServerType.REMOTE as const, url: String(entry.url), headers: entry.headers,
				...(entry.oauth?.clientId ? { oauth: { clientId: entry.oauth.clientId } } : {}),
			}
			: { type: McpServerType.LOCAL as const, command: entry.command ?? '', args: entry.args as string[] | undefined, env: entry.env };

		// Name collisions never overwrite someone's existing server: an equivalent config is
		// adopted in place, a different one installs under a suffixed name.
		const installed = await this.mcpManagementService.getInstalled();
		const decision = decideInstallName(
			serverName,
			installed.map(s => ({ name: s.name, config: { url: (s.config as { url?: string }).url, command: (s.config as { command?: string }).command, args: (s.config as { args?: readonly string[] }).args } })),
			{ url: entry.url !== undefined ? String(entry.url) : undefined, command: entry.command, args: entry.args },
		);
		if (decision.kind === 'adopt') {
			// Adoption reuses the NAME, never the raw config: the existing entry may be a
			// hand-pasted published config still carrying bare placeholders — persisting the
			// normalized equivalent (same endpoint/command) plus its prompt definitions is
			// what makes it connectable at all.
			this.logService.info(`[MCP install ${serverName}] taking over the existing equivalent server "${decision.name}" with the normalized configuration.`);
		} else if (decision.kind === 'suffixed') {
			this.logService.info(`[MCP install ${serverName}] name is taken by a different configuration; installing as "${decision.name}".`);
		}
		await this.mcpManagementService.install({ name: decision.name, config, inputs: inputs.length > 0 ? [...inputs] : undefined });

		// Installing a definition alone does not contact the server. That used to leave hosted
		// connectors half-installed and forced a second Sign in click. Wait for upstream discovery,
		// then start immediately: OAuth servers open their browser flow, while local stdio servers
		// simply launch. Upstream owns PKCE, callback handling, and keychain persistence.
		const server = await this._waitForServer(decision.name);
		if (!server) {
			throw new Error(localize(
				'v3code.mcp.install.discoveryTimeout',
				'MCP server "{0}" was installed but did not appear in the server registry. Reload the window and try again.',
				decision.name,
			));
		}

		// Record exactly which server this catalog id owns; every later action
		// (toggle, sign-in, disconnect) resolves through this map first.
		const map = this._readInstallMap();
		map[serverName] = { serverDefinitionId: server.definition.id, installedName: decision.name };
		this._storeInstallMap(map);

		this.upstreamMcpService.enablementModel.setEnabled(
			server.definition.id,
			ContributionEnablementState.EnabledProfile,
		);
		const state = await server.start({ promptType: 'all-untrusted' });
		this._assertStarted(state, decision.name);
	}

	async callMCPTool(toolData: MCPToolCallParams): Promise<{ result: RawMCPToolCall }> {
		const server = this._findServer(toolData.serverName);
		if (!server) {
			throw new Error(localize('v3code.mcp.noSuchServer', 'MCP server "{0}" is not available.', toolData.serverName));
		}

		const tool = this._readTools(server).find(t => t.referenceName === toolData.toolName);
		if (!tool) {
			throw new Error(localize('v3code.mcp.noSuchTool', 'MCP server "{0}" does not publish a tool named "{1}".', toolData.serverName, toolData.toolName));
		}

		const callResult = await tool.call(toolData.params ?? {});
		const result = this._toRawToolCall(toolData.serverName, toolData.toolName, callResult);
		if (result.event === 'error') {
			throw new Error(`Error: ${result.text}`);
		}
		return { result };
	}

	// --- mapping helpers ---------------------------------------------------------------------

	private _readServers(): readonly IMcpServer[] {
		try {
			return this.upstreamMcpService.servers.get();
		} catch (error) {
			this.logService.error('[v3code-mcp] failed to read the upstream MCP server list', error);
			return [];
		}
	}

	private _readEnablement(server: IMcpServer): ContributionEnablementState {
		try {
			return server.enablement.get();
		} catch (error) {
			this.logService.error(`[v3code-mcp] failed to read enablement for MCP server "${server.definition.label}"`, error);
			return ContributionEnablementState.DisabledProfile;
		}
	}

	private _readTools(server: IMcpServer): readonly IMcpTool[] {
		try {
			return server.tools.get();
		} catch (error) {
			this.logService.error(`[v3code-mcp] failed to read tools for MCP server "${server.definition.label}"`, error);
			return [];
		}
	}

	/**
	 * start() reports refusals as a plain Stopped state, not an error: the launch gate,
	 * a declined trust prompt, and a cancelled input prompt all land here. Reporting
	 * success for a server that never started is the dishonesty this lane removes.
	 */
	private _assertStarted(state: McpConnectionState, serverName: string): void {
		if (state.state === McpConnectionState.Kind.Error) {
			throw new Error(state.message);
		}
		if (state.state === McpConnectionState.Kind.Stopped && state.reason !== 'needs-user-interaction') {
			throw new Error(localize(
				'v3code.mcp.startDeclined',
				'MCP server "{0}" did not start. A prompt may have been declined, or the configuration needs attention - check the server output for details.',
				serverName,
			));
		}
	}

	/**
	 * One winner per label: when servers collide on a label, only the one _findServer
	 * would act on gets advertised — a tool offered under a name that callMCPTool
	 * refuses is worse than one server staying hidden.
	 */
	private _preferredServersByLabel(servers: readonly IMcpServer[]): IMcpServer[] {
		const map = this._readInstallMap();
		const byLabel = new Map<string, IMcpServer>();
		for (const server of servers) {
			const key = server.definition.label.toLowerCase();
			if (byLabel.has(key)) { continue; }
			const { server: winner } = resolveServerForName(servers, server.definition.label, map);
			byLabel.set(key, winner ?? server);
		}
		return [...byLabel.values()];
	}

	installedServerNameFor(catalogId: string): string | undefined {
		return this._readInstallMap()[catalogId]?.installedName;
	}

	private _readInstallMap(): CatalogInstallMap {
		return parseCatalogInstallMap(this.storageService.get(CATALOG_INSTALL_MAP_STORAGE_KEY, StorageScope.PROFILE));
	}

	private _storeInstallMap(map: CatalogInstallMap): void {
		this.storageService.store(CATALOG_INSTALL_MAP_STORAGE_KEY, serializeCatalogInstallMap(map), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	/**
	 * Install-map first, then exact definition id, then exact label. An ambiguous label
	 * (upstream install and legacy ~/.v3code/mcp.json server sharing a name) resolves to
	 * nothing — acting on the wrong same-named server is worse than an error.
	 */
	private _findServer(serverName: string): IMcpServer | undefined {
		const { server, via } = resolveServerForName(this._readServers(), serverName, this._readInstallMap());
		if (via === 'ambiguous-label') {
			this.logService.warn(`[v3code-mcp] "${serverName}" matches more than one configured server; refusing to guess. Disconnect or rename one of them.`);
		}
		return server;
	}

	private async _waitForServer(serverName: string, timeoutMs = 5000): Promise<IMcpServer | undefined> {
		const deadline = Date.now() + timeoutMs;
		let server = this._findServer(serverName);
		while (!server && Date.now() < deadline) {
			await timeout(50);
			server = this._findServer(serverName);
		}
		return server;
	}

	private _toV3CodeServer(connectionState: McpConnectionState, tools: readonly IMcpTool[], isEnabled: boolean): MCPServerWithEnablement {
		if (connectionState.state === McpConnectionState.Kind.Error) {
			return { status: 'error', error: connectionState.message, isEnabled };
		}

		const mappedTools: MCPTool[] = tools.map(tool => ({
			name: tool.referenceName,
			description: tool.definition.description,
			inputSchema: tool.definition.inputSchema as Record<string, unknown> | undefined,
		}));

		if (connectionState.state === McpConnectionState.Kind.Starting) {
			return { status: 'loading', tools: mappedTools, isEnabled };
		}
		if (connectionState.state === McpConnectionState.Kind.Running) {
			return { status: 'success', tools: mappedTools, isEnabled };
		}
		if (connectionState.state === McpConnectionState.Kind.Stopped && connectionState.reason === 'needs-user-interaction') {
			return { status: 'needs-user-interaction', tools: mappedTools, isEnabled };
		}
		// Stopped with cached tools is genuinely usable — a tool call starts the server
		// on demand and tokens refresh silently — but it is NOT "Connected". Truthfully:
		// ready, connects on first use.
		if (isEnabled && mappedTools.length > 0) {
			return { status: 'ready', tools: mappedTools, isEnabled };
		}
		return { status: 'offline', tools: mappedTools, isEnabled };
	}

	private _transformInputSchemaToParams(inputSchema?: MCP.Tool['inputSchema']): { [paramName: string]: { description: string } } {
		const params: { [paramName: string]: { description: string } } = {};
		const properties = inputSchema?.properties;
		if (!properties || typeof properties !== 'object') { return params; }

		const required = new Set(Array.isArray(inputSchema?.required) ? inputSchema.required : []);

		for (const paramName of Object.keys(properties)) {
			const property = (properties as Record<string, unknown>)[paramName];
			if (!property || typeof property !== 'object') { continue; }

			const { description, type } = property as { description?: unknown; type?: unknown };
			const parts: string[] = [];
			if (typeof description === 'string' && description) { parts.push(description); }
			if (typeof type === 'string' && type) { parts.push(`(type: ${type})`); }
			if (required.has(paramName)) { parts.push('(required)'); }

			params[paramName] = { description: parts.join(' ') };
		}
		return params;
	}

	private _toRawToolCall(serverName: string, toolName: string, result: MCP.CallToolResult): RawMCPToolCall {
		const content = Array.isArray(result?.content) ? result.content : [];
		const texts: string[] = [];
		for (const block of content) {
			if (block?.type === 'text' && typeof block.text === 'string') { texts.push(block.text); }
		}

		if (result?.isError) {
			return {
				event: 'error',
				serverName,
				toolName,
				text: texts.join('\n') || localize('v3code.mcp.toolError', 'The MCP tool reported an error.'),
			};
		}

		if (texts.length > 0) {
			return { event: 'text', serverName, toolName, text: texts.join('\n') };
		}

		// A structured-only result still has to reach the model as something readable.
		if (result?.structuredContent) {
			return { event: 'text', serverName, toolName, text: JSON.stringify(result.structuredContent, null, 2) };
		}

		for (const block of content) {
			if (block?.type === 'image') {
				return {
					event: 'image',
					serverName,
					toolName,
					image: { data: block.data, mimeType: block.mimeType as V3CodeImageMimeType },
				};
			}
			if (block?.type === 'audio') {
				return { event: 'audio', serverName, toolName };
			}
			if (block?.type === 'resource' || block?.type === 'resource_link') {
				return { event: 'resource', serverName, toolName };
			}
		}

		return { event: 'text', serverName, toolName, text: '' };
	}
}

// Eager, like the legacy registration it replaces: chat builds its tool list at startup, and a
// lazily created facade would leave MCP tools out of the first request of every session.
registerSingleton(IMCPService, MCPUpstreamFacade, InstantiationType.Eager);
