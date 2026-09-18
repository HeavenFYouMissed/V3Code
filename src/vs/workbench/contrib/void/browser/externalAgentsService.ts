/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AgentHostEnabledSettingId, IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { EXTERNAL_AGENTS_CATALOGUE_FILENAME, emptyExternalAgentCatalogue, externalAgentIdFromProvider, isValidExternalAgentId, mapRegistryToExternalAgentEntries, mergeRegistryEntries, normalizeExternalAgentId, parseExternalAgentCatalogue, providerIdForExternalAgent, removeExternalAgent, serializeExternalAgentCatalogue, setExternalAgentEnabled, upsertExternalAgent, type IExternalAgentCatalogue, type IExternalAgentEntry } from '../../../../platform/agentHost/common/externalAgentCatalogue.js';
import type { RootState } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { EXTERNAL_AGENTS_SETTINGS_TAB, IExternalAgentsService, type IExternalAgentCustomInput, type IExternalAgentHostStatus, type IExternalAgentsState } from '../common/externalAgentsService.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from './voidSettingsPane.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { stageExternalAgentSetup } from './externalAgentSetup.js';

const REGISTRY_FETCH_TIMEOUT_MS = 20_000;

/**
 * Renderer-side owner of the external agent catalogue. The file lives next
 * to the agent host's own config (`globalStorage/external-agents.json`);
 * the host watches it and registers a provider per enabled entry, and the
 * host's root state tells this service which ones are actually live.
 */
class ExternalAgentsService extends Disposable implements IExternalAgentsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IExternalAgentsState>());
	readonly onDidChangeState: Event<IExternalAgentsState> = this._onDidChangeState.event;

	private readonly _resource: URI;
	private _catalogue: IExternalAgentCatalogue = emptyExternalAgentCatalogue();
	private _hosted = new Map<string, IExternalAgentHostStatus>();
	private _refreshing = false;
	private _lastRefreshAt: number | undefined;
	private _lastError: string | undefined;
	private _writeChain: Promise<void> = Promise.resolve();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IRequestService private readonly _requestService: IRequestService,
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IWorkspaceTrustRequestService private readonly _trustRequestService: IWorkspaceTrustRequestService,
		@ICommandService private readonly _commandService: ICommandService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
		super();
		// `userRoamingDataHome` is the app settings home under the user-data
		// scheme, so this resolves to the same file the agent host reads from disk.
		this._resource = joinPath(environmentService.userRoamingDataHome, 'globalStorage', EXTERNAL_AGENTS_CATALOGUE_FILENAME);

		// Watch the folder: the file may not exist yet and a watch on a missing path never fires.
		this._register(this._fileService.watch(dirname(this._resource)));
		this._register(this._fileService.onDidFilesChange(e => {
			if (e.contains(this._resource)) {
				void this._load();
			}
		}));
		void this._load();

		this._register(this._agentHostService.rootState.onDidChange(root => this._applyRootState(root)));
		const initial = this._agentHostService.rootState.verifiedValue;
		if (initial) {
			this._applyRootState(initial);
		}
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AgentHostEnabledSettingId)) {
				this._fire();
			}
		}));
	}

	get state(): IExternalAgentsState {
		return {
			catalogue: this._catalogue,
			hosted: this._hosted,
			hostEnabled: this._configurationService.getValue<boolean>(AgentHostEnabledSettingId) !== false,
			refreshing: this._refreshing,
			lastRefreshAt: this._lastRefreshAt,
			lastError: this._lastError,
		};
	}

	private _fire(): void {
		this._onDidChangeState.fire(this.state);
	}

	private _applyRootState(root: RootState): void {
		const next = new Map<string, IExternalAgentHostStatus>();
		for (const agent of root.agents) {
			const id = externalAgentIdFromProvider(agent.provider);
			if (id) {
				next.set(id, { provider: agent.provider, displayName: agent.displayName, description: agent.description, modelCount: agent.models.length });
			}
		}
		this._hosted = next;
		this._fire();
	}

	private async _load(): Promise<void> {
		let text: string | undefined;
		try {
			text = (await this._fileService.readFile(this._resource)).value.toString();
		} catch (err) {
			if (!(err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this._logService.warn('[ExternalAgents] failed to read catalogue', err);
			}
		}
		this._catalogue = parseExternalAgentCatalogue(text);
		this._fire();
	}

	/** Serializes writes so two quick toggles never race on the file. */
	private _update(mutate: (catalogue: IExternalAgentCatalogue) => IExternalAgentCatalogue): Promise<void> {
		this._writeChain = this._writeChain.then(async () => {
			const next = mutate(this._catalogue);
			this._catalogue = next;
			this._fire();
			await this._fileService.writeFile(this._resource, VSBuffer.fromString(serializeExternalAgentCatalogue(next)));
		}).catch(err => {
			this._logService.error('[ExternalAgents] failed to write catalogue', err);
			this._lastError = localize('externalAgents.writeFailed', "Could not save the agents list: {0}", err instanceof Error ? err.message : String(err));
			this._fire();
		});
		return this._writeChain;
	}

	private async _requireTrust(): Promise<boolean> {
		const trusted = await this._trustRequestService.requestWorkspaceTrust({
			message: localize('externalAgents.trust', "External agents run as local processes with your user permissions and can read and change files in this workspace. Trust this workspace to continue."),
		});
		return trusted === true;
	}

	async setEnabled(id: string, enabled: boolean): Promise<boolean> {
		if (!this._catalogue.agents.some(a => a.id === id)) {
			return false;
		}
		if (enabled && !(await this._requireTrust())) {
			return false;
		}
		await this._update(c => setExternalAgentEnabled(c, id, enabled));
		return true;
	}

	async setEditorAccess(id: string, capability: 'memoryIndex' | 'browserAccess', enabled: boolean): Promise<void> {
		if (enabled && !(await this._requireTrust())) { return; }
		await this._update(c => ({ ...c, agents: c.agents.map(entry => entry.id === id ? { ...entry, [capability]: enabled } : entry) }));
	}

	async addCustom(input: IExternalAgentCustomInput): Promise<IExternalAgentEntry> {
		const name = input.name.trim();
		const command = input.command.trim();
		if (!name) {
			throw new Error(localize('externalAgents.nameRequired', "A name is required."));
		}
		if (!command) {
			throw new Error(localize('externalAgents.commandRequired', "A launch command is required."));
		}
		let id = normalizeExternalAgentId(name);
		if (!id || !isValidExternalAgentId(id)) {
			throw new Error(localize('externalAgents.badName', "Use letters, digits, dots or dashes in the name."));
		}
		const taken = new Set(this._catalogue.agents.map(a => a.id));
		let candidate = id;
		for (let i = 2; taken.has(candidate); i++) {
			candidate = `${id}-${i}`;
		}
		id = candidate;
		const entry: IExternalAgentEntry = {
			id,
			name,
			description: input.description?.trim() || undefined,
			source: 'custom',
			distribution: { command: { command, args: [...input.args], env: input.env && Object.keys(input.env).length ? input.env : undefined } },
		};
		await this._update(c => upsertExternalAgent(c, entry));
		return entry;
	}

	async remove(id: string): Promise<void> {
		await this._update(c => removeExternalAgent(c, id));
	}

	async setRegistryUrl(url: string): Promise<void> {
		await this._update(c => ({ ...c, registryUrl: url.trim() }));
	}

	async refreshFromRegistry(): Promise<void> {
		const url = this._catalogue.registryUrl.trim();
		if (!url) {
			this._lastError = localize('externalAgents.noRegistry', "No registry URL is set.");
			this._fire();
			return;
		}
		if (this._refreshing) {
			return;
		}
		this._refreshing = true;
		this._lastError = undefined;
		this._fire();
		try {
			const context = await this._requestService.request({ type: 'GET', url, timeout: REGISTRY_FETCH_TIMEOUT_MS, headers: { 'Accept': 'application/json' }, callSite: 'v3code.externalAgents.registry' }, CancellationToken.None);
			if (context.res.statusCode !== undefined && context.res.statusCode >= 400) {
				throw new Error(localize('externalAgents.httpError', "The registry answered with HTTP {0}.", context.res.statusCode));
			}
			const json = await asJson<unknown>(context);
			const entries = mapRegistryToExternalAgentEntries(json);
			if (entries.length === 0) {
				throw new Error(localize('externalAgents.emptyRegistry', "The registry did not contain any usable agents."));
			}
			await this._update(c => mergeRegistryEntries(c, entries));
			this._lastRefreshAt = Date.now();
		} catch (err) {
			this._lastError = err instanceof Error ? err.message : String(err);
			this._logService.warn('[ExternalAgents] registry refresh failed', err);
		} finally {
			this._refreshing = false;
			this._fire();
		}
	}

	async openChat(id: string, position: 'sidebar' | 'editor' = 'sidebar', preserveEditor = false): Promise<boolean> {
		const entry = this._catalogue.agents.find(a => a.id === id);
		if (!entry) {
			return false;
		}
		if (!this.state.hostEnabled) {
			this._notificationService.notify({ severity: Severity.Warning, message: localize('externalAgents.hostOff', "The local agent host is turned off. Enable \"{0}\" and restart to use external agents.", AgentHostEnabledSettingId) });
			return false;
		}
		if (!this._catalogue.enabledIds.includes(id)) {
			this._notificationService.notify({ severity: Severity.Info, message: localize('externalAgents.notEnabled', "{0} is not enabled. Turn it on under Settings > Agents.", entry.name) });
			return false;
		}
		if (!this._hosted.has(id)) {
			this._notificationService.notify({ severity: Severity.Warning, message: localize('externalAgents.notHosted', "{0} is not available yet. The agent host has not registered it; check Settings > Agents for its status.", entry.name) });
			return false;
		}
		if (!(await this._requireTrust())) {
			return false;
		}
		await this._commandService.executeCommand(`workbench.action.chat.openNewChatSessionInPlace.agent-host-${providerIdForExternalAgent(id)}`, position, !preserveEditor);
		return true;
	}

	async openSetupDocs(id: string): Promise<void> {
		const website = this._catalogue.agents.find(a => a.id === id)?.website;
		if (!website) { return; }
		const uri = URI.parse(website);
		if (uri.scheme !== 'https' && uri.scheme !== 'http') { return; }
		await this._openerService.open(uri, { openExternal: true, allowCommands: false });
	}

	async openSetupTerminal(id: string): Promise<void> {
		const entry = this._catalogue.agents.find(a => a.id === id);
		if (!entry || !(await this._requireTrust())) { return; }
		// Interactive entrypoints are explicit integration data, never the ACP stdio launcher.
		const interactiveCommand = entry.id === 'claude-acp' ? 'claude' : entry.id === 'v3code-terminal' ? 'v3code' : undefined;
		const choice = await this._quickInputService.pick([
			...(interactiveCommand ? [{ id: 'launch', label: localize('externalAgents.setupLaunch', "Launch {0} in terminal", entry.name), description: localize('externalAgents.setupLaunchDescription', "Runs {0}; finish sign-in or model setup there", interactiveCommand) }] : []),
			...(entry.id === 'claude-acp' ? [{ id: 'install', label: localize('externalAgents.setupInstallClaude', "Install or update Claude Code using npm"), description: 'Runs npm install -g @anthropic-ai/claude-code; requires Node.js/npm' }] : []),
			...(entry.website && /^https?:\/\//i.test(entry.website) ? [{ id: 'docs', label: localize('externalAgents.setupReadDocs', "Open installation and sign-in instructions"), description: entry.name }] : []),
			{ id: 'command', label: localize('externalAgents.setupEnterCommand', "Stage an install or sign-in command"), description: localize('externalAgents.setupEnterCommandDescription', "Review it here, then press Enter in the terminal to run it") },
			{ id: 'shell', label: localize('externalAgents.setupOpenShell', "Open an empty setup terminal"), description: localize('externalAgents.setupOpenShellDescription', "Nothing is installed or started automatically") },
		], { title: localize('externalAgents.setupTitle', "Set up {0}", entry.name) });
		if (!choice) { return; }
		if (choice.id === 'docs') { await this.openSetupDocs(id); return; }
		if (choice.id === 'launch' || choice.id === 'install') {
			const command = choice.id === 'install' ? 'npm install -g @anthropic-ai/claude-code' : interactiveCommand;
			if (!command) { return; }
			try {
				const terminal = await this._terminalService.createTerminal({ location: TerminalLocation.Panel, config: { name: localize('externalAgents.setupTerminal', "Agent setup: {0}", entry.name) } });
				this._terminalService.setActiveInstance(terminal);
				await this._terminalService.revealActiveTerminal();
				await terminal.sendText(command, true);
				if (choice.id === 'install') {
					this._notificationService.info(localize('externalAgents.setupInstallStarted', "Installation started in the terminal. When it succeeds, choose Launch {0} in terminal to sign in. If npm is unavailable, use Setup docs for the native installer.", entry.name));
				}
			} catch (error) {
				this._notificationService.error(localize('externalAgents.setupLaunchFailed', "Could not start setup: {0}", error instanceof Error ? error.message : String(error)));
			}
			return;
		}
		const command = choice.id === 'shell' ? '' : await this._quickInputService.input({
			title: localize('externalAgents.setupTitle', "Set up {0}", entry.name),
			prompt: localize('externalAgents.setupPrompt', "Enter the interactive install/sign-in command from the agent's documentation. Do not paste keys here. ACP stdio commands are not interactive setup commands. Nothing runs until you press Enter in the terminal."),
			value: entry.distribution.command?.command === 'v3code' ? 'v3code' : '',
			validateInput: async value => !value.trim() ? localize('externalAgents.setupCommandRequired', "Enter a command from the setup documentation, or press Escape to go back.") : /[\x00-\x1f\x7f]/.test(value) ? localize('externalAgents.setupSingleLine', "Enter a single-line command without control characters.") : undefined,
		});
		if (command === undefined) { return; }
		try {
			await stageExternalAgentSetup(command, async () => {
				const terminal = await this._terminalService.createTerminal({ location: TerminalLocation.Panel, config: { name: localize('externalAgents.setupTerminal', "Agent setup: {0}", entry.name) } });
				this._terminalService.setActiveInstance(terminal);
				await this._terminalService.revealActiveTerminal();
				return terminal;
			});
			this._notificationService.info(command.trim()
				? localize('externalAgents.setupStaged', "{0}: command staged in the setup terminal. Press Enter there to run it; complete sign-in there, then open a new agent chat.", entry.name)
				: localize('externalAgents.setupShellOpened', "{0}: empty setup terminal opened. Run the install/sign-in command from Setup docs there, then open a new agent chat. Nothing has been installed yet.", entry.name));
		} catch (err) {
			this._notificationService.error(localize('externalAgents.setupFailed', "Could not open setup terminal: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	async openSettings(): Promise<void> {
		await this._commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID, EXTERNAL_AGENTS_SETTINGS_TAB);
	}
}

registerSingleton(IExternalAgentsService, ExternalAgentsService, InstantiationType.Delayed);
