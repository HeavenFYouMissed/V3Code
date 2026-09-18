/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'stream';
import { raceTimeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, type IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { hasKey } from '../../../../base/common/types.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../files/common/files.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import type { AgentSignal } from '../../common/agentService.js';
import type { ISessionDatabase, ISessionDataService } from '../../common/sessionDataService.js';
import { ToolResultContentType, type Turn, type UserMessage } from '../../common/state/sessionState.js';
import { FileEditTracker } from '../shared/fileEditTracker.js';
import { AcpProcess, type IAcpProcessExit } from './acpProcess.js';
import type { AcpSdkModule } from './acpSdkService.js';
import { AcpTurnTracker, mapSessionUpdate, mapStopReason, type IStopOutcome } from './acpUpdateMapper.js';

const INITIALIZE_TIMEOUT_MS = 20_000;
const NEW_SESSION_TIMEOUT_MS = 60_000;
const JSON_RPC_AUTH_REQUIRED = -32000;
const EXIT_SETTLE_MS = 1_000;

/** Thrown when the agent answers `session/new` with "authentication required". */
export class AcpAuthRequiredError extends Error {
	constructor(readonly authMethods: readonly acp.AuthMethod[]) {
		super('Authentication required');
		this.name = 'AcpAuthRequiredError';
	}
}

/** Thrown when the agent exits (or stops answering) during startup. */
export class AcpStartupError extends Error {
	constructor(message: string, readonly stderrTail: string, readonly exit?: IAcpProcessExit) {
		super(message);
		this.name = 'AcpStartupError';
	}
}

export interface IAcpSessionStartOptions {
	readonly sessionUri: URI;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly clientInfo: { name: string; title?: string; version: string };
	/** ACP session id from a previous run; loaded when the agent supports `loadSession`. */
	readonly resumeSessionId?: string;
	readonly mcpServers?: acp.McpServer[];
	readonly briefing?: string;
	readonly requestAuthentication?: (method: acp.AuthMethod) => Promise<boolean>;
}

export interface IAcpSessionInfo {
	readonly acpSessionId: string;
	readonly resumed: boolean;
	readonly agentInfo: acp.Implementation | undefined;
	readonly capabilities: acp.AgentCapabilities;
	readonly configOptions: readonly acp.SessionConfigOption[];
	readonly modes: acp.SessionModeState | undefined;
}

export interface IAcpPromptResult extends IStopOutcome {
	readonly turn: Turn;
}

function isRequestError(err: unknown): err is { code: number; message: string; data?: unknown } {
	return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'number';
}

/**
 * One live Agent Client Protocol session: a subprocess, an NDJSON
 * connection, the client-side request handlers the agent may call back
 * into (permissions, file reads/writes) and a per-turn tracker that turns
 * `session/update` notifications into host signals.
 *
 * Terminal and elicitation client methods are deliberately not registered:
 * the host does not advertise them in `clientCapabilities`, and an agent
 * that calls them anyway receives the SDK's method-not-found error.
 */
export class AcpLiveSession extends Disposable {

	static async start(
		sdk: AcpSdkModule,
		options: IAcpSessionStartOptions,
		instantiationService: IInstantiationService,
		fileService: IFileService,
		sessionDataService: ISessionDataService,
		logService: ILogService,
	): Promise<AcpLiveSession> {
		const process = await AcpProcess.spawn({ command: options.command, args: options.args, cwd: options.cwd, env: options.env }, logService);
		const session = new AcpLiveSession(sdk, process, options, instantiationService, fileService, sessionDataService, logService);
		try {
			await session._initialize();
			return session;
		} catch (err) {
			session.dispose();
			throw err;
		}
	}

	private readonly _onDidSignal = this._register(new Emitter<AgentSignal>());
	readonly onDidSignal: Event<AgentSignal> = this._onDidSignal.event;

	private readonly _onDidExit = this._register(new Emitter<IAcpProcessExit>());
	readonly onDidExit: Event<IAcpProcessExit> = this._onDidExit.event;

	private readonly _onDidChangeConfigOptions = this._register(new Emitter<readonly acp.SessionConfigOption[]>());
	readonly onDidChangeConfigOptions: Event<readonly acp.SessionConfigOption[]> = this._onDidChangeConfigOptions.event;

	private _connection: acp.ClientConnection | undefined;
	private _info: IAcpSessionInfo | undefined;
	private _tracker: AcpTurnTracker | undefined;
	private readonly _pendingPermissions = new Map<string, (approved: boolean) => void>();
	private _db: IReference<ISessionDatabase> | undefined;
	private _editTracker: FileEditTracker | undefined;
	private _configOptions: acp.SessionConfigOption[] = [];
	private _authMethods: readonly acp.AuthMethod[] = [];
	private _availableCommands: readonly acp.AvailableCommand[] = [];
	private _briefingSent = false;
	get availableCommands(): readonly acp.AvailableCommand[] { return this._availableCommands; }

	private constructor(
		private readonly _sdk: AcpSdkModule,
		private readonly _process: AcpProcess,
		private readonly _options: IAcpSessionStartOptions,
		private readonly _instantiationService: IInstantiationService,
		private readonly _fileService: IFileService,
		private readonly _sessionDataService: ISessionDataService,
		private readonly _logService: ILogService,
	) {
		super();
		this._register(_process);
		this._register(_process.onDidExit(exit => {
			this._logService.info(`[ACP:${this.sessionKey}] agent exited code=${exit.code} signal=${exit.signal}`);
			this._failPendingPermissions();
			this._onDidExit.fire(exit);
		}));
	}

	get sessionUri(): URI {
		return this._options.sessionUri;
	}

	private get sessionKey(): string {
		return this._options.sessionUri.path.slice(1);
	}

	get info(): IAcpSessionInfo {
		if (!this._info) {
			throw new Error('Session not initialized');
		}
		return this._info;
	}

	get isPromptActive(): boolean {
		return this._tracker !== undefined;
	}

	get exited(): boolean {
		return this._process.exited;
	}

	get stderrTail(): string {
		return this._process.stderrTail;
	}

	get exitInfo(): IAcpProcessExit | undefined {
		return this._process.exitInfo;
	}

	/** Resolves once the agent process has exited (also after {@link dispose}). */
	whenExited(): Promise<IAcpProcessExit> {
		return this._process.whenExited();
	}

	get configOptions(): readonly acp.SessionConfigOption[] {
		return this._configOptions;
	}

	// ---- startup --------------------------------------------------------------

	private async _initialize(): Promise<void> {
		const stream = this._sdk.ndJsonStream(
			Writable.toWeb(this._process.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(this._process.stdout) as ReadableStream<Uint8Array>,
		);
		const app = this._sdk.client({ name: this._options.clientInfo.name });
		app.onNotification('session/update', ({ params }) => this._handleUpdate(params));
		app.onRequest('session/request_permission', ({ params }) => this._handlePermission(params));
		app.onRequest('fs/read_text_file', ({ params }) => this._handleReadTextFile(params));
		app.onRequest('fs/write_text_file', ({ params }) => this._handleWriteTextFile(params));
		const connection = app.connect(stream);
		this._connection = connection;
		this._register({ dispose: () => connection.close() });

		const initialize = await this._startupRequest('initialize', INITIALIZE_TIMEOUT_MS, () =>
			connection.agent.request<acp.InitializeResponse, acp.InitializeRequest>('initialize', {
				protocolVersion: this._sdk.PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: false,
				},
				clientInfo: this._options.clientInfo,
			}));

		if (initialize.protocolVersion !== this._sdk.PROTOCOL_VERSION) {
			throw new AcpStartupError(`The agent speaks protocol version ${initialize.protocolVersion}; this client supports version ${this._sdk.PROTOCOL_VERSION}.`, this._process.stderrTail);
		}
		this._authMethods = initialize.authMethods ?? [];
		const capabilities: acp.AgentCapabilities = initialize.agentCapabilities ?? {};

		let acpSessionId: string | undefined;
		let resumed = false;
		let configOptions: readonly acp.SessionConfigOption[] = [];
		let modes: acp.SessionModeState | undefined;

		if (this._options.resumeSessionId && capabilities.loadSession) {
			try {
				const loaded = await this._startupRequest('session/load', NEW_SESSION_TIMEOUT_MS, () =>
					connection.agent.request('session/load', { sessionId: this._options.resumeSessionId!, cwd: this._options.cwd, mcpServers: this._options.mcpServers ?? [] }));
				acpSessionId = this._options.resumeSessionId;
				resumed = true;
				configOptions = loaded?.configOptions ?? [];
				modes = loaded?.modes ?? undefined;
			} catch (err) {
				if (err instanceof AcpStartupError) {
					throw err;
				}
				this._logService.warn(`[ACP:${this.sessionKey}] session/load failed; starting a new agent session instead`, err);
			}
		}

		if (!acpSessionId) {
			let created: acp.NewSessionResponse;
			try {
				created = await this._startupRequest('session/new', NEW_SESSION_TIMEOUT_MS, () =>
					connection.agent.request('session/new', { cwd: this._options.cwd, mcpServers: this._options.mcpServers ?? [] }));
			} catch (err) {
				if (isRequestError(err) && err.code === JSON_RPC_AUTH_REQUIRED) {
					const method = this._authMethods.find(method => !hasKey(method, { type: true }) || method.type !== 'terminal');
					if (!method || !this._options.requestAuthentication || !(await this._startupRequest('sign-in approval', 300_000, () => this._options.requestAuthentication!(method)))) {
						throw new AcpAuthRequiredError(this._authMethods);
					}
					// Terminal methods must never be passed to authenticate. Agent-managed
					// methods own their browser flow and credentials; chat only requests it.
					await this._startupRequest('authenticate', 300_000, () => connection.agent.request('authenticate', { methodId: method.id }));
					created = await this._startupRequest('session/new', NEW_SESSION_TIMEOUT_MS, () => connection.agent.request('session/new', { cwd: this._options.cwd, mcpServers: this._options.mcpServers ?? [] }));
				} else {
					throw err;
				}
			}
			acpSessionId = created.sessionId;
			configOptions = created.configOptions ?? [];
			modes = created.modes ?? undefined;
		}

		this._configOptions = [...configOptions];
		this._info = {
			acpSessionId,
			resumed,
			agentInfo: initialize.agentInfo ?? undefined,
			capabilities,
			configOptions: this._configOptions,
			modes,
		};
	}

	/**
	 * Runs one startup request against the agent. Three failure modes are
	 * folded into {@link AcpStartupError}, each carrying the stderr tail: the
	 * agent exits (before or after the connection closes), or it never
	 * answers within `ms`.
	 */
	private async _startupRequest<T>(what: string, ms: number, run: () => Promise<T>): Promise<T> {
		const exited = this._process.whenExited();
		const describe = (exit: IAcpProcessExit) => `The agent exited during ${what} (code ${exit.code ?? 'null'}${exit.signal ? `, signal ${exit.signal}` : ''}).`;
		const startupFailure = exited.then(exit => { throw new AcpStartupError(describe(exit), this._process.stderrTail, exit); });
		try {
			// A void response (allowed for session/load) is a valid answer, so
			// the timeout is tracked separately from the resolved value.
			let timedOut = false;
			const result = await raceTimeout(Promise.race([run(), startupFailure]), ms, () => { timedOut = true; });
			if (timedOut) {
				throw new AcpStartupError(`The agent did not answer ${what} within ${Math.round(ms / 1000)} seconds.`, this._process.stderrTail);
			}
			return result as T;
		} catch (err) {
			if (err instanceof AcpStartupError) {
				throw err;
			}
			// The stream can close before the exit event lands; give it a moment.
			const exit = this._process.exitInfo ?? await raceTimeout(exited, EXIT_SETTLE_MS);
			if (exit) {
				throw new AcpStartupError(describe(exit), this._process.stderrTail, exit);
			}
			throw err;
		}
	}

	// ---- prompting ------------------------------------------------------------

	/**
	 * Sends one prompt and resolves when the agent reports a stop reason.
	 * Signals are fired on {@link onDidSignal} while streaming; the result
	 * carries the turn snapshot for the transcript.
	 */
	async prompt(turnId: string, userMessage: UserMessage, blocks: acp.ContentBlock[], preamble?: string): Promise<IAcpPromptResult> {
		if (!this._briefingSent && this._options.briefing) {
			// Keep the user's command first so ACP slash-command parsing is unchanged.
			blocks = [...blocks, { type: 'text', text: this._options.briefing }];
			this._briefingSent = true;
		}
		if (this._tracker) {
			throw new Error('A prompt is already in progress for this session');
		}
		const tracker = new AcpTurnTracker(this._options.sessionUri, turnId, userMessage);
		this._tracker = tracker;
		try {
			if (preamble) {
				this._fire(tracker.appendMarkdown(preamble));
			}
			const response = await this._connection!.agent.request('session/prompt', { sessionId: this.info.acpSessionId, prompt: blocks });
			const outcome = mapStopReason(response.stopReason, tracker);
			this._fire(outcome.signals);
			return { ...outcome, turn: tracker.toTurn(outcome.turnState, outcome.error) };
		} finally {
			this._tracker = undefined;
			this._failPendingPermissions();
		}
	}

	async cancel(): Promise<void> {
		this._failPendingPermissions();
		if (!this._tracker || !this._connection || this._process.exited) {
			return;
		}
		try {
			await this._connection.agent.notify('session/cancel', { sessionId: this.info.acpSessionId });
		} catch (err) {
			this._logService.warn(`[ACP:${this.sessionKey}] session/cancel failed`, err);
		}
	}

	async setConfigOption(configId: string, value: string | boolean): Promise<void> {
		if (!this._connection) {
			return;
		}
		const request: acp.SetSessionConfigOptionRequest = typeof value === 'boolean'
			? { sessionId: this.info.acpSessionId, configId, type: 'boolean', value }
			: { sessionId: this.info.acpSessionId, configId, value };
		const response = await this._connection.agent.request('session/set_config_option', request);
		if (response?.configOptions) {
			this._configOptions = [...response.configOptions];
			this._onDidChangeConfigOptions.fire(this._configOptions);
		}
	}

	async setMode(modeId: string): Promise<void> {
		if (!this._connection) {
			return;
		}
		await this._connection.agent.request('session/set_mode', { sessionId: this.info.acpSessionId, modeId });
	}

	/** Answers an outstanding permission request. Returns `false` when none matched. */
	respondPermission(toolCallId: string, approved: boolean): boolean {
		const resolve = this._pendingPermissions.get(toolCallId);
		if (!resolve) {
			return false;
		}
		this._pendingPermissions.delete(toolCallId);
		resolve(approved);
		return true;
	}

	private _failPendingPermissions(): void {
		for (const resolve of this._pendingPermissions.values()) {
			resolve(false);
		}
		this._pendingPermissions.clear();
	}

	private _fire(signals: readonly AgentSignal[]): void {
		for (const signal of signals) {
			this._onDidSignal.fire(signal);
		}
	}

	// ---- agent → client ---------------------------------------------------

	private _handleUpdate(notification: acp.SessionNotification): void {
		const update = notification.update;
		if (this._info && notification.sessionId !== this._info.acpSessionId) { return; }
		if (update.sessionUpdate === 'available_commands_update') {
			this._availableCommands = update.availableCommands;
			return;
		}
		if (update.sessionUpdate === 'config_option_update') {
			this._configOptions = [...update.configOptions];
			this._onDidChangeConfigOptions.fire(this._configOptions);
			return;
		}
		const tracker = this._tracker;
		if (!tracker) {
			// Replays from `session/load` and updates outside a prompt have
			// no active turn to land in; the transcript already holds them.
			return;
		}
		try {
			this._fire(mapSessionUpdate(update, tracker));
		} catch (err) {
			this._logService.warn(`[ACP:${this.sessionKey}] failed to map ${update.sessionUpdate}`, err);
		}
	}

	private async _handlePermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		const tracker = this._tracker;
		if (!tracker) {
			return { outcome: { outcome: 'cancelled' } };
		}
		const { record, signals } = tracker.startToolCall(request.toolCall);
		if (request.toolCall.rawInput !== undefined) {
			record.rawInput = request.toolCall.rawInput;
		}
		if (request.toolCall.locations) {
			record.locations = [...request.toolCall.locations];
		}
		if (request.toolCall.kind) {
			record.kind = request.toolCall.kind;
		}
		if (request.toolCall.title) {
			record.title = request.toolCall.title;
		}
		this._fire(signals);
		const approved = await new Promise<boolean>(resolve => {
			this._pendingPermissions.set(record.toolCallId, resolve);
			this._fire(tracker.requestPermission(record, record.title));
		});
		tracker.permissionAnswered(record, approved);
		if (this._tracker !== tracker) {
			return { outcome: { outcome: 'cancelled' } };
		}
		const options = request.options;
		const pick = (kinds: readonly acp.PermissionOptionKind[]) => {
			for (const kind of kinds) {
				const option = options.find(o => o.kind === kind);
				if (option) {
					return option.optionId;
				}
			}
			return undefined;
		};
		// A boolean approval cannot authorize a persistent grant.
		const optionId = approved ? pick(['allow_once']) : pick(['reject_once', 'reject_always']);
		if (optionId === undefined) {
			return { outcome: { outcome: 'cancelled' } };
		}
		return { outcome: { outcome: 'selected', optionId } };
	}

	private async _handleReadTextFile(request: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
		await this._approveFileRequest(request.path, false);
		const uri = URI.file(request.path);
		let text: string;
		try {
			text = (await this._fileService.readFile(uri)).value.toString();
		} catch (err) {
			throw this._sdk.RequestError.resourceNotFound(request.path);
		}
		if (request.line === undefined || request.line === null) {
			if (request.limit !== undefined && request.limit !== null) {
				return { content: text.split('\n').slice(0, request.limit).join('\n') };
			}
			return { content: text };
		}
		const lines = text.split('\n');
		const start = Math.max(0, request.line - 1);
		const end = request.limit !== undefined && request.limit !== null ? start + request.limit : lines.length;
		return { content: lines.slice(start, end).join('\n') };
	}

	private async _handleWriteTextFile(request: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
		await this._approveFileRequest(request.path, true);
		const uri = URI.file(request.path);
		const editTracker = this._getEditTracker();
		await editTracker?.trackEditStart(request.path);
		await this._fileService.writeFile(uri, VSBuffer.fromString(request.content));
		await editTracker?.completeEdit(request.path);
		const tracker = this._tracker;
		if (!tracker) {
			return {};
		}
		let record = tracker.currentToolCall;
		const signals: AgentSignal[] = [];
		if (!record) {
			const started = tracker.startToolCall({ toolCallId: `acp-write-${Date.now()}`, title: `Write ${request.path}`, kind: 'edit', status: 'in_progress' });
			record = started.record;
			signals.push(...started.signals, ...tracker.readyToolCall(record));
		}
		const edit = await editTracker?.takeCompletedEdit(tracker.turnId, record.toolCallId, request.path).catch(err => {
			this._logService.warn(`[ACP:${this.sessionKey}] failed to record file edit for ${request.path}`, err);
			return undefined;
		});
		if (edit) {
			signals.push(...tracker.appendToolCallContent(record, edit));
		} else {
			signals.push(...tracker.appendToolCallContent(record, { type: ToolResultContentType.Text, text: `Wrote ${request.path}` }));
		}
		if (record.toolCallId.startsWith('acp-write-')) {
			signals.push(...tracker.completeToolCall(record, true));
		}
		this._fire(signals);
		return {};
	}

	private async _approveFileRequest(path: string, write: boolean): Promise<void> {
		const tracker = this._tracker;
		if (!tracker) {
			throw new this._sdk.RequestError(-32001, 'File access requires an active turn');
		}
		// Client filesystem requests are independent of tool notifications. Never
		// assume the external process already asked permission for this path.
		const { record, signals } = tracker.startToolCall({
			toolCallId: `acp-file-access-${generateUuid()}`,
			title: `${write ? 'Write' : 'Read'} ${path}`,
			kind: write ? 'edit' : 'read',
			locations: [{ path }],
			rawInput: { path },
		});
		this._fire(signals);
		const approved = await new Promise<boolean>(resolve => {
			this._pendingPermissions.set(record.toolCallId, resolve);
			this._fire(tracker.requestPermission(record, record.title));
		});
		tracker.permissionAnswered(record, approved);
		const allowed = approved && this._tracker === tracker;
		this._fire(tracker.completeToolCall(record, allowed));
		if (!allowed) {
			throw new this._sdk.RequestError(-32001, 'File access denied');
		}
	}

	private _getEditTracker(): FileEditTracker | undefined {
		if (this._editTracker) {
			return this._editTracker;
		}
		try {
			this._db = this._sessionDataService.openDatabase(this._options.sessionUri);
			this._register(this._db);
			this._editTracker = this._instantiationService.createInstance(FileEditTracker, this._options.sessionUri.toString(), this._db.object);
			return this._editTracker;
		} catch (err) {
			this._logService.warn(`[ACP:${this.sessionKey}] file-edit tracking unavailable`, err);
			return undefined;
		}
	}

	/** Stops the agent process (see {@link AcpProcess.dispose}) and releases every resource. */
	override dispose(): void {
		this._failPendingPermissions();
		super.dispose();
	}
}
