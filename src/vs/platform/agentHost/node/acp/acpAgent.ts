/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type * as acp from '@agentclientprotocol/sdk';
import { SequencerByKey } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { hasKey } from '../../../../base/common/types.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IFileService } from '../../../files/common/files.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { IProductService } from '../../../product/common/productService.js';
import { IAgentHostCheckpointService } from '../../common/agentHostCheckpointService.js';
import { createSchema, platformSessionSchema } from '../../common/agentHostSchema.js';
import { AgentSession, type AgentProvider, type AgentSignal, type IAgent, type IAgentCreateSessionConfig, type IAgentCreateSessionResult, type IAgentDescriptor, type IAgentModelInfo, type IAgentResolveSessionConfigParams, type IAgentSessionConfigCompletionsParams, type IAgentSessionMetadata } from '../../common/agentService.js';
import type { ISyncedCustomization } from '../../common/agentPluginManager.js';
import { EXTERNAL_AGENTS_SESSIONS_DIRNAME, providerIdForExternalAgent, type IExternalAgentEntry, type IExternalAgentLaunch } from '../../common/externalAgentCatalogue.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { SessionConfigKey } from '../../common/sessionConfigKeys.js';
import type { CompletionsParams, CompletionsResult, ResolveSessionConfigResult, SessionConfigCompletionsResult } from '../../common/state/protocol/commands.js';
import { completeAcpCommands } from './acpCommands.js';
import { editorBriefing, editorMcpServers } from './acpEditorContext.js';
import type { MessageAttachment, ModelSelection, ProtectedResourceMetadata } from '../../common/state/protocol/state.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { MessageAttachmentKind, ToolCallStatus, type CustomizationRef, type Turn, type UserMessage } from '../../common/state/sessionState.js';
import { IAgentHostGitService } from '../agentHostGitService.js';
import { resolveGitProject } from '../copilot/copilotGitProject.js';
import { AcpLaunchError, type IAcpProcessExit } from './acpProcess.js';
import { IAcpSdkService } from './acpSdkService.js';
import { AcpAuthRequiredError, AcpLiveSession, AcpStartupError } from './acpSession.js';
import { AcpTranscriptStore, type IAcpSessionRecord } from './acpTranscriptStore.js';

/** Model id reported when the agent has not exposed a model selector. */
export const ACP_DEFAULT_MODEL_ID = 'agent-default';

function describeExit(exit: IAcpProcessExit | undefined): string {
	if (!exit) {
		return 'exit status unknown';
	}
	return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? 'null'}`;
}

/** Result of probing whether an entry can be launched on this machine. */
export interface IExternalAgentProbe {
	readonly launch: IExternalAgentLaunch | undefined;
	/** Human-readable status, shown as the provider description. */
	readonly status: string;
	readonly ok: boolean;
}

/**
 * One agent-host provider per enabled external agent. The agent runs as a
 * subprocess speaking the Agent Client Protocol; this class adapts it to
 * the host's {@link IAgent} contract and persists a transcript mirror so
 * sessions survive host restarts.
 *
 * Boundaries (disclosed, not hidden): the subprocess has the same OS
 * permissions as the host. The host only sees and approves the calls the
 * agent routes through the protocol (`session/request_permission`,
 * `fs/*`). Terminal, elicitation and MCP passthrough are not advertised.
 */
export class AcpAgent extends Disposable implements IAgent {

	readonly id: AgentProvider;

	private readonly _onDidSessionProgress = this._register(new Emitter<AgentSignal>());
	readonly onDidSessionProgress: Event<AgentSignal> = this._onDidSessionProgress.event;

	private readonly _models = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models = this._models;

	private readonly _transcripts: AcpTranscriptStore;
	private readonly _live = new Map<string, { session: AcpLiveSession; disposables: DisposableStore }>();
	private readonly _records = new Map<string, IAcpSessionRecord>();
	private readonly _sequencer = new SequencerByKey<string>();
	private _modelConfigId: string | undefined;
	private readonly _authRequests = new Map<string, { sessionId: string; resolve: (approved: boolean) => void }>();

	constructor(
		private _entry: IExternalAgentEntry,
		private readonly _probe: IExternalAgentProbe,
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IProductService private readonly _productService: IProductService,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@IAgentHostCheckpointService private readonly _checkpointService: IAgentHostCheckpointService,
		@IAcpSdkService private readonly _sdkService: IAcpSdkService,
	) {
		super();
		this.id = providerIdForExternalAgent(_entry.id);
		const root = joinPath(environmentService.appSettingsHome, 'globalStorage', EXTERNAL_AGENTS_SESSIONS_DIRNAME, this.id);
		this._transcripts = new AcpTranscriptStore(root, _fileService, _logService);
		this._models.set([{ provider: this.id, id: ACP_DEFAULT_MODEL_ID, name: `${_entry.name} default`, supportsVision: false }], undefined);
	}

	get entry(): IExternalAgentEntry {
		return this._entry;
	}

	updateEntry(entry: IExternalAgentEntry): void { this._entry = entry; }

	async completions(params: CompletionsParams): Promise<CompletionsResult> {
		const session = URI.parse(params.channel);
		const id = AgentSession.id(session);
		const active = this._live.get(id)?.session;
		if (active && !active.exited) { return completeAcpCommands(active.availableCommands, params); }
		return this._sequencer.queue(id, async () => {
			const record = await this._record(id);
			if (!record) { return { items: [] }; }
			try {
				const live = await this._ensureLive(record, session);
				return completeAcpCommands(live.session.availableCommands, params);
			} catch (err) {
				this._logService.warn(`[ACP:${this.id}] command discovery failed`, err);
				return { items: [] };
			}
		});
	}

	get probe(): IExternalAgentProbe {
		return this._probe;
	}

	getDescriptor(): IAgentDescriptor {
		return { provider: this.id, displayName: this._entry.name, description: this._probe.status };
	}

	getProtectedResources(): ProtectedResourceMetadata[] {
		return [];
	}

	async authenticate(): Promise<boolean> {
		return false;
	}

	getCustomizations(): readonly CustomizationRef[] {
		return [];
	}

	async setClientCustomizations(): Promise<ISyncedCustomization[]> {
		return [];
	}

	setClientTools(): void { }

	onClientToolCallComplete(): void { }

	setCustomizationEnabled(): void { }

	respondToUserInputRequest(): void { }

	// ---- sessions -------------------------------------------------------------

	private async _record(sessionId: string): Promise<IAcpSessionRecord | undefined> {
		const cached = this._records.get(sessionId);
		if (cached) {
			return cached;
		}
		const record = await this._transcripts.read(sessionId);
		if (record) {
			this._records.set(sessionId, record);
		}
		return record;
	}

	private _metadata(record: IAcpSessionRecord): IAgentSessionMetadata {
		const session = AgentSession.uri(this.id, record.sessionId);
		return {
			session,
			startTime: record.createdAt,
			modifiedTime: record.modifiedAt,
			project: record.project ? { uri: URI.parse(record.project.uri), displayName: record.project.displayName } : undefined,
			summary: record.title,
			workingDirectory: URI.file(record.cwd),
			model: record.modelId ? { id: record.modelId } : undefined,
		};
	}

	async listSessions(): Promise<IAgentSessionMetadata[]> {
		const records = await this._transcripts.list();
		for (const record of records) {
			if (!this._records.has(record.sessionId)) {
				this._records.set(record.sessionId, record);
			}
		}
		return [...this._records.values()].map(r => this._metadata(r));
	}

	async getSessionMetadata(session: URI): Promise<IAgentSessionMetadata | undefined> {
		const record = await this._record(AgentSession.id(session));
		return record ? this._metadata(record) : undefined;
	}

	async createSession(config: IAgentCreateSessionConfig = {}): Promise<IAgentCreateSessionResult> {
		if (config.fork) {
			throw new Error('Forking sessions is not supported for external agents');
		}
		const sessionId = config.session ? AgentSession.id(config.session) : generateUuid();
		const session = AgentSession.uri(this.id, sessionId);
		const existing = await this._record(sessionId);
		if (existing) {
			return { session, workingDirectory: URI.file(existing.cwd), project: this._metadata(existing).project };
		}
		if (!config.workingDirectory) {
			throw new Error('A working directory is required to start an external agent session');
		}
		const cwd = config.workingDirectory.fsPath;
		const project = await resolveGitProject(config.workingDirectory, this._gitService).catch(() => undefined);
		const record = this._transcripts.create(sessionId, cwd, project ? { uri: project.uri.toString(), displayName: project.displayName } : undefined, config.model?.id);
		this._records.set(sessionId, record);
		await this._transcripts.write(record);
		// Baseline git checkpoint so per-turn diffs capture everything the
		// agent changes on disk, not only writes routed through the host.
		this._checkpointService.captureBaseline(session, config.workingDirectory).catch(err => {
			this._logService.warn(`[ACP:${sessionId}] baseline checkpoint capture failed: ${err instanceof Error ? err.message : String(err)}`);
		});
		return { session, workingDirectory: config.workingDirectory, project };
	}

	async resolveSessionConfig(params: IAgentResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
		const schema = createSchema({
			[SessionConfigKey.AutoApprove]: platformSessionSchema.definition[SessionConfigKey.AutoApprove],
			[SessionConfigKey.Permissions]: platformSessionSchema.definition[SessionConfigKey.Permissions],
		});
		const values = schema.validateOrDefault(params.config, { [SessionConfigKey.AutoApprove]: 'default' as const });
		return { schema: schema.toProtocol(), values };
	}

	async sessionConfigCompletions(_params: IAgentSessionConfigCompletionsParams): Promise<SessionConfigCompletionsResult> {
		return { items: [] };
	}

	async getSessionMessages(session: URI): Promise<readonly Turn[]> {
		const record = await this._record(AgentSession.id(session));
		return record?.turns ?? [];
	}

	async disposeSession(session: URI): Promise<void> {
		const sessionId = AgentSession.id(session);
		this._cancelAuthentication(sessionId);
		await this._sequencer.queue(sessionId, async () => {
			this._stopLive(sessionId);
			this._records.delete(sessionId);
			await this._transcripts.delete(sessionId);
		});
	}

	async truncateSession(session: URI, turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(session);
		const record = await this._record(sessionId);
		if (!record) {
			return;
		}
		const index = turnId ? record.turns.findIndex(t => t.id === turnId) : 0;
		record.turns = index >= 0 ? record.turns.slice(0, index) : record.turns;
		await this._transcripts.write(record);
	}

	async onArchivedChanged(): Promise<void> { }

	async abortSession(session: URI): Promise<void> {
		this._cancelAuthentication(AgentSession.id(session));
		await this._live.get(AgentSession.id(session))?.session.cancel();
	}

	async changeModel(session: URI, model: ModelSelection): Promise<void> {
		const sessionId = AgentSession.id(session);
		const record = await this._record(sessionId);
		if (record) {
			record.modelId = model.id;
			await this._transcripts.write(record);
		}
		const live = this._live.get(sessionId)?.session;
		if (live && this._modelConfigId && model.id !== ACP_DEFAULT_MODEL_ID) {
			await live.setConfigOption(this._modelConfigId, model.id);
		}
	}

	respondToPermissionRequest(toolCallId: string, approved: boolean): void {
		const auth = this._authRequests.get(toolCallId);
		if (auth) { auth.resolve(approved); return; }
		for (const { session } of this._live.values()) {
			if (session.respondPermission(toolCallId, approved)) {
				return;
			}
		}
		this._logService.trace(`[ACP:${this.id}] no pending permission for ${toolCallId}`);
	}

	async sendMessage(session: URI, prompt: string, attachments?: readonly MessageAttachment[], turnId?: string): Promise<void> {
		const sessionId = AgentSession.id(session);
		const tid = turnId ?? generateUuid();
		await this._sequencer.queue(sessionId, async () => {
			const record = await this._record(sessionId);
			if (!record) {
				this._error(session, tid, 'acp_unknown_session', 'This session no longer exists.');
				return;
			}
			let live: AcpLiveSession;
			let preamble: string | undefined;
			try {
				const started = await this._ensureLive(record, session, tid);
				live = started.session;
				preamble = started.preamble;
			} catch (err) {
				this._error(session, tid, 'acp_start_failed', this._describeStartError(err));
				return;
			}
			const userMessage: UserMessage = { text: prompt, attachments: attachments ? [...attachments] : undefined };
			const blocks = this._toContentBlocks(prompt, attachments ?? [], live.info.capabilities.promptCapabilities);
			try {
				const result = await live.prompt(tid, userMessage, blocks, preamble);
				record.turns.push(result.turn);
				if (!record.title) {
					record.title = prompt.trim().replace(/\s+/g, ' ').slice(0, 120) || undefined;
				}
				await this._transcripts.write(record);
			} catch (err) {
				const message = live.exited
					? `The agent exited while answering (${describeExit(live.exitInfo)}).${live.stderrTail ? `\n\n${live.stderrTail}` : ''}`
					: err instanceof Error ? err.message : String(err);
				this._error(session, tid, 'acp_prompt_failed', message);
				if (live.exited) {
					this._stopLive(sessionId);
				}
			}
		});
	}

	private _error(session: URI, turnId: string, errorType: string, message: string): void {
		this._onDidSessionProgress.fire({ kind: 'action', session, action: { type: ActionType.SessionError, turnId, error: { errorType, message } } });
	}

	private _describeStartError(err: unknown): string {
		const name = this._entry.name;
		if (err instanceof AcpLaunchError) {
			return err.kind === 'not-found'
				? `Cannot start ${name}: the command "${err.command}" was not found on your PATH. Install it, or change the launch command in Settings > Agents.`
				: `Cannot start ${name}: ${err.message}`;
		}
		if (err instanceof AcpAuthRequiredError) {
			const methods = err.authMethods.map(m => m.name).filter(Boolean);
			return methods.length
				? `${name} needs you to sign in first (${methods.join(', ')}). Complete the sign-in with the agent's own tooling, then send your message again.`
				: `${name} needs you to sign in first. Complete the sign-in with the agent's own tooling, then send your message again.`;
		}
		if (err instanceof AcpStartupError) {
			return err.stderrTail ? `${err.message}\n\n${err.stderrTail}` : err.message;
		}
		return err instanceof Error ? err.message : String(err);
	}

	private async _ensureLive(record: IAcpSessionRecord, session: URI, turnId?: string): Promise<{ session: AcpLiveSession; preamble?: string }> {
		const existing = this._live.get(record.sessionId);
		if (existing && !existing.session.exited) {
			return { session: existing.session };
		}
		if (existing) {
			this._stopLive(record.sessionId);
		}
		const launch = this._probe.launch;
		if (!launch) {
			throw new AcpLaunchError('not-found', '', `${this._entry.name} has no launch command for this platform.`);
		}
		const sdk = await this._sdkService.load();
		const memoryIndex = this._entry.memoryIndex !== false;
		const browserAccess = this._entry.browserAccess === true;
		const mcpServers = editorMcpServers(this.environmentService.appRoot, process.execPath, process.env.VSCODE_PID, record.cwd, memoryIndex, browserAccess, this._entry.id);
		const live = await AcpLiveSession.start(sdk, {
			sessionUri: session,
			command: launch.command,
			args: launch.args,
			cwd: record.cwd,
			env: { ...process.env, ...(launch.env ?? {}) },
			clientInfo: { name: this._productService.applicationName, title: this._productService.nameLong, version: this._productService.version },
			resumeSessionId: record.acpSessionId,
			mcpServers,
			briefing: editorBriefing(record.cwd, memoryIndex, browserAccess, mcpServers.length > 0),
			requestAuthentication: turnId ? method => this._requestAuthentication(session, turnId, method) : undefined,
		}, this._instantiationService, this._fileService, this._sessionDataService, this._logService).catch(err => {
			this._cancelAuthentication(record.sessionId);
			throw err;
		});

		const disposables = new DisposableStore();
		disposables.add(live);
		disposables.add(live.onDidSignal(signal => this._onDidSessionProgress.fire(signal)));
		disposables.add(live.onDidChangeConfigOptions(options => this._applyConfigOptions(options)));
		disposables.add(live.onDidExit(() => {
			if (this._live.get(record.sessionId)?.session === live && !live.isPromptActive) {
				this._stopLive(record.sessionId);
			}
		}));
		this._live.set(record.sessionId, { session: live, disposables });

		this._applyConfigOptions(live.info.configOptions);
		let preamble: string | undefined;
		if (record.acpSessionId && !live.info.resumed && record.turns.length > 0) {
			preamble = '_This agent could not restore the earlier conversation, so it starts fresh from this message._\n\n';
		}
		if (record.acpSessionId !== live.info.acpSessionId) {
			record.acpSessionId = live.info.acpSessionId;
			await this._transcripts.write(record);
		}
		if (record.modelId && record.modelId !== ACP_DEFAULT_MODEL_ID && this._modelConfigId) {
			await live.setConfigOption(this._modelConfigId, record.modelId).catch(err => this._logService.warn(`[ACP:${this.id}] could not apply model ${record.modelId}`, err));
		}
		return { session: live, preamble };
	}

	private _stopLive(sessionId: string): void {
		const entry = this._live.get(sessionId);
		if (entry) {
			this._live.delete(sessionId);
			entry.disposables.dispose();
		}
	}

	private _cancelAuthentication(sessionId: string): void {
		for (const request of this._authRequests.values()) {
			if (request.sessionId === sessionId) { request.resolve(false); }
		}
	}

	private _requestAuthentication(session: URI, turnId: string, method: acp.AuthMethod): Promise<boolean> {
		const toolCallId = generateUuid();
		const toolName = 'agent_sign_in';
		const displayName = `Sign in: ${method.name}`;
		return new Promise(resolve => {
			const finish = (approved: boolean) => {
				if (!this._authRequests.delete(toolCallId)) { return; }
				clearTimeout(timer);
				this._onDidSessionProgress.fire({ kind: 'action', session, action: { type: ActionType.SessionToolCallComplete, turnId, toolCallId, result: { success: approved, pastTenseMessage: approved ? 'Requested agent sign-in' : 'Sign-in cancelled', content: [] } } });
				resolve(approved);
			};
			const timer = setTimeout(() => finish(false), 300_000);
			this._authRequests.set(toolCallId, { sessionId: AgentSession.id(session), resolve: finish });
			this._onDidSessionProgress.fire({ kind: 'action', session, action: { type: ActionType.SessionToolCallStart, turnId, toolCallId, toolName, displayName } });
			this._onDidSessionProgress.fire({ kind: 'pending_confirmation', session, state: { status: ToolCallStatus.PendingConfirmation, toolCallId, toolName, displayName, confirmationTitle: 'Start agent sign-in?', invocationMessage: `${method.name}. The agent manages authentication outside this transcript; never paste credentials into chat.` } });
		});
	}

	/** Publishes the agent's model selector (if it exposes one) as host models. */
	private _applyConfigOptions(options: readonly acp.SessionConfigOption[]): void {
		const supportsVision = [...this._live.values()].some(entry => entry.session.info.capabilities.promptCapabilities?.image === true);
		// Image support belongs to the protocol capability, not the presence of a model picker.
		this._models.set(this._models.get().map(model => ({ ...model, supportsVision })), undefined);
		const model = options.find(o => o.type === 'select' && o.category === 'model');
		if (!model || model.type !== 'select') {
			return;
		}
		this._modelConfigId = model.id;
		const flat: { value: string; name: string }[] = [];
		for (const item of model.options) {
			if (hasKey(item, { group: true })) {
				flat.push(...item.options.map(o => ({ value: o.value, name: o.name })));
			} else {
				flat.push({ value: item.value, name: item.name });
			}
		}
		if (flat.length === 0) {
			return;
		}
		this._models.set(flat.map(o => ({ provider: this.id, id: o.value, name: o.name, supportsVision })), undefined);
	}

	private _toContentBlocks(prompt: string, attachments: readonly MessageAttachment[], capabilities: acp.PromptCapabilities | undefined): acp.ContentBlock[] {
		const blocks: acp.ContentBlock[] = [{ type: 'text', text: prompt }];
		for (const attachment of attachments) {
			switch (attachment.type) {
				case MessageAttachmentKind.Resource:
					blocks.push({ type: 'resource_link', uri: attachment.uri.toString(), name: attachment.label });
					break;
				case MessageAttachmentKind.EmbeddedResource:
					if (attachment.contentType.startsWith('image/')) {
						if (capabilities?.image) {
							blocks.push({ type: 'image', data: attachment.data, mimeType: attachment.contentType });
						}
					} else if (capabilities?.embeddedContext) {
						blocks.push({ type: 'resource', resource: { uri: attachment.label, text: attachment.data, mimeType: attachment.contentType } });
					} else {
						blocks.push({ type: 'text', text: `\n\n${attachment.label}:\n${attachment.data}` });
					}
					break;
				case MessageAttachmentKind.Simple:
					if (attachment.modelRepresentation) {
						blocks.push({ type: 'text', text: `\n\n${attachment.modelRepresentation}` });
					}
					break;
			}
		}
		return blocks;
	}

	// ---- lifecycle ------------------------------------------------------------

	async shutdown(): Promise<void> {
		for (const request of this._authRequests.values()) { request.resolve(false); }
		for (const sessionId of [...this._live.keys()]) {
			this._stopLive(sessionId);
		}
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}
}
