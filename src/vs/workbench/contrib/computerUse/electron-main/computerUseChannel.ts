/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Main-process end of the computer-use feature: owns the native helper process and speaks the
 * newline-delimited JSON protocol declared in `common/computerUseTypes.ts`.
 *
 * The helper lives in the main process rather than the renderer for three reasons: it must be
 * spawned from a stable path the OS has granted Accessibility and Screen Recording to, exactly one
 * helper may exist per application run, and screenshots must not cross the sandbox twice.
 *
 * Every call resolves with a {@link ComputerUseResponse} envelope — success or a typed error. The
 * channel never rejects, because an IPC rejection loses the error code the caller branches on. Use
 * `isComputerUseSuccess` on the result.
 */

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	COMPUTER_USE_DEFAULT_FORCE_ACCESSIBILITY_TIMEOUT_MS,
	COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS,
	COMPUTER_USE_PROTOCOL_VERSION,
	ComputerUseError,
	ComputerUseMethod,
	ComputerUseMethods,
	ComputerUseParamsFor,
	ComputerUsePingResult,
	ComputerUseRequest,
	ComputerUseResponse,
	ComputerUseStatusResult,
	createComputerUseError,
	isComputerUseSuccess,
} from '../common/computerUseTypes.js';
import {
	COMPUTER_USE_HELPER_PATH,
	COMPUTER_USE_HELPER_PATH_SETTING,
	ComputerUseHelperInstaller,
} from './computerUseHelperInstaller.js';

export { COMPUTER_USE_CHANNEL_NAME } from '../common/computerUseTypes.js';

/** Log prefix shared with the installer so helper problems are greppable as one story. */
const LOG_PREFIX = '[v3code-computerUse]';

/** Envelope id used for failures raised before a request reached the helper. */
const NO_REQUEST_ID = 0;

/**
 * Headroom added on top of a wait the *caller* chose, before the channel gives up on it.
 *
 * Needed because two methods are deliberately slow by request: `settle` waits for the UI to stop
 * moving and `forceElectronAccessibility` polls for a tree to appear, and both accept a caller-supplied
 * budget. A fixed channel timeout smaller than that budget produces the worst possible failure — the
 * channel reports `timeout` while the helper is still dutifully waiting, so the caller sees a broken
 * feature instead of a slow one, and the helper's answer arrives later and is dropped.
 */
const CALLER_WAIT_SLACK_MS = 2_000;

/**
 * Ceiling on any budget derived from caller-supplied parameters.
 *
 * The params come from the renderer, which is not a hostile input, but an arithmetic slip there must
 * not be able to pin a request in {@link ComputerUseChannel._pending} for an hour.
 */
const MAX_DERIVED_BUDGET_MS = 60_000;

/**
 * A method's budget: a constant, or a function of the request's own parameters.
 *
 * The function form exists only for methods that let the caller choose how long to wait; everything
 * else is a constant, because a budget the caller can influence is a budget that can be got wrong.
 */
type ComputerUseMethodBudget<M extends ComputerUseMethod> =
	| number
	| ((params: ComputerUseParamsFor<M> | undefined) => number);

/**
 * Per-method budgets.
 *
 * Declared as a total mapped type so adding a method to {@link ComputerUseMethods} fails to compile
 * until it has been given a budget — an unbudgeted method would hang a tool call forever.
 */
const METHOD_BUDGETS_MS: { readonly [M in ComputerUseMethod]: ComputerUseMethodBudget<M> } = {
	ping: 5_000,
	status: 5_000,
	capture: 20_000,
	click: 10_000,
	type: 20_000,
	key: 10_000,
	scroll: 10_000,
	cursorPosition: 5_000,
	frontmostApp: 5_000,
	listApps: 10_000,
	axTree: 20_000,
	cancel: 5_000,

	// --- protocol version 3 ------------------------------------------------------------------

	// Both are caller-paced, so both are derived rather than flat. A drag glides for `durationMs` and a
	// hover deliberately waits `settleMs` for whatever the hover reveals; budgeting either at a constant
	// would cut off exactly the long, deliberate gesture the parameter exists to request.
	drag: params => budgetForCallerWait(params?.durationMs, 250),
	mouseMove: params => budgetForCallerWait(params?.settleMs, 0),

	clipboardRead: 5_000,
	clipboardWrite: 5_000,

	// A cold launch is genuinely slow — a large application on a busy machine can take several seconds
	// before it owns the foreground — and the helper is already waiting up to `waitMs` for exactly that.
	openApplication: params => budgetForCallerWait(params?.waitMs, 5_000),

	// --- protocol version 2 ------------------------------------------------------------------

	// The same full accessibility walk `axTree` performs — the helper does not diff, it annotates —
	// so it gets the same budget. Anything smaller would make the incremental read time out on
	// exactly the large applications it exists to make affordable.
	axTreeDiff: 20_000,

	// Caller-controlled: `timeoutMs`, defaulting to 1500 ms, plus slack. Never a flat constant, because
	// a caller that legitimately raises the budget to outlast a slow transition would otherwise be cut
	// off by the channel at the old value.
	settle: params => budgetForCallerWait(params?.timeoutMs, COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS),

	// Caller-controlled in the same way. The helper sets the platform flag and then *polls* for a tree
	// to populate, so the wait is the point of the method rather than an accident of load.
	forceElectronAccessibility: params => budgetForCallerWait(
		params?.timeoutMs,
		COMPUTER_USE_DEFAULT_FORCE_ACCESSIBILITY_TIMEOUT_MS,
	),

	// Bounds the start *handshake*, not the session: `observeStart` returns as soon as the timer is
	// armed, and the session's own lifetime is governed by `stopAtMs`. Generous because arming may
	// include taking the first sample.
	observeStart: 10_000,
	observeStop: 5_000,
	observeStatus: 5_000,
};

/**
 * Budget for a method whose wait the caller chose: the requested wait plus {@link CALLER_WAIT_SLACK_MS}.
 *
 * A non-positive or absent request falls back to the contract's own default, so the channel and the
 * helper agree on the same number without the renderer having to restate it.
 */
function budgetForCallerWait(requestedMs: number | undefined, defaultMs: number): number {
	const requested = typeof requestedMs === 'number' && requestedMs > 0 ? requestedMs : defaultMs;
	return Math.min(MAX_DERIVED_BUDGET_MS, requested + CALLER_WAIT_SLACK_MS);
}

/**
 * Cap on concurrent requests.
 *
 * Small on purpose: the agent loop is read-then-act, so more than a couple in flight means a caller
 * is looping without awaiting, and an unbounded map is a leak with a screenshot attached.
 */
const MAX_PENDING_REQUESTS = 32;

/**
 * Cap on a single unterminated protocol line.
 *
 * A base64 screenshot is legitimately megabytes, so the bound is generous; exceeding it means the
 * helper is writing something that is not our protocol, and the stream is unrecoverable.
 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** One in-flight request awaiting its response line. */
interface IPendingRequest {
	readonly method: ComputerUseMethod;
	readonly settle: (response: ComputerUseResponse) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Argument shape for every channel call.
 *
 * `helperBinaryPath` lets the renderer forward the workspace-resolved value of
 * {@link COMPUTER_USE_HELPER_PATH_SETTING}, which the main process's configuration service does not
 * see for folder-scoped settings. When absent, the main-process value is used.
 */
export interface IComputerUseCallArgument<M extends ComputerUseMethod = ComputerUseMethod> {
	readonly params?: ComputerUseParamsFor<M>;
	readonly helperBinaryPath?: string;
}

/**
 * Owns the helper process and translates channel calls into protocol requests.
 *
 * Lifecycle: the helper is spawned lazily on the first call that needs it, health-checked with
 * `ping`, and reused for the rest of the session. A spawn failure, a protocol-version mismatch or a
 * parse failure trips a session kill-switch: one actionable log line, then every later call returns
 * the same typed error without touching the process again.
 */
export class ComputerUseChannel extends Disposable implements IServerChannel {

	/** The live helper, or `undefined` before the first spawn and after an exit. */
	private _helper: ChildProcessWithoutNullStreams | undefined;

	/** Kills the helper on dispose or on replacement. */
	private readonly _helperLifetime = this._register(new MutableDisposable());

	/** Coalesces concurrent first calls onto one spawn. */
	private _starting: Promise<ComputerUseError | undefined> | undefined;

	/** Identity reported by the running helper's `ping`, for logs and `status`. */
	private _ping: ComputerUsePingResult | undefined;

	/** Set once the kill-switch trips; every later call returns it verbatim. */
	private _trippedError: ComputerUseError | undefined;

	private _nextRequestId = 1;
	private readonly _pending = new Map<number, IPendingRequest>();

	/** Decodes stdout incrementally so a chunk boundary cannot split a multi-byte character. */
	private _decoder = new StringDecoder('utf8');

	/** Bytes of a protocol line seen so far but not yet terminated by a newline. */
	private _lineBuffer = '';

	private readonly _installer: ComputerUseHelperInstaller;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._installer = this._register(new ComputerUseHelperInstaller(this.logService, environmentMainService));
		this._register(toDisposable(() => this._rejectAllPending(createComputerUseError(
			'cancelled',
			localize('computerUse.shutdown', "V3Code is shutting down, so the computer-use request was abandoned."),
		))));
	}

	/** The channel has no events; a listen attempt is a programming error. */
	listen<T>(_context: unknown, event: string): Event<T> {
		throw new Error(`${LOG_PREFIX} ComputerUseChannel has no events. Requested: ${event}`);
	}

	/**
	 * Handles one protocol method, named by `command`.
	 *
	 * `T` is always {@link ComputerUseResponse}; the generic exists only because `IServerChannel`
	 * declares it. Failures arrive as `{ ok: false, error }` rather than as rejections.
	 */
	async call<T>(_context: unknown, command: string, argument?: IComputerUseCallArgument): Promise<T> {
		const response = await this._dispatch(command, argument);
		return response as unknown as T;
	}

	/** Routes a command to the helper, or answers it locally. */
	private async _dispatch(command: string, argument?: IComputerUseCallArgument): Promise<ComputerUseResponse> {
		if (!this._isKnownMethod(command)) {
			return this._localFailure(createComputerUseError('internal', localize(
				'computerUse.unknownMethod',
				"'{0}' is not a computer-use method.",
				command,
			)));
		}

		const override = this._helperBinaryPath(argument);
		if (command === 'status') {
			return this._status(override);
		}

		const startError = await this._ensureHelper(override);
		if (startError) {
			return this._localFailure(startError);
		}

		if (command === 'cancel') {
			return this._cancel();
		}
		return this._request(command, argument?.params);
	}

	/**
	 * Answers `status` without ever failing.
	 *
	 * The whole point of `status` is to explain why computer use is unavailable, so a dead helper
	 * still produces a successful envelope reporting what is missing.
	 */
	private async _status(override: string | undefined): Promise<ComputerUseResponse<'status'>> {
		const startError = await this._ensureHelper(override);
		if (startError) {
			// Read `installed` AFTER the ensure attempt: _ensureHelper installs the bundled
			// helper as its first step, so a pre-ensure snapshot reports the state the machine
			// was in before this very call fixed it — status then claims "not installed" for a
			// helper that is on disk and merely failed a later stage (spawn/ping).
			const result: ComputerUseStatusResult = {
				installed: this._installer.isInstalled(override),
				protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
				accessibilityTrusted: false,
				screenRecordingGranted: false,
			};
			return { id: NO_REQUEST_ID, ok: true, result };
		}

		const response = await this._request('status', undefined);
		if (!isComputerUseSuccess(response)) {
			const result: ComputerUseStatusResult = {
				installed: true,
				protocolVersion: this._ping?.protocolVersion ?? COMPUTER_USE_PROTOCOL_VERSION,
				accessibilityTrusted: false,
				screenRecordingGranted: false,
			};
			return { id: response.id, ok: true, result };
		}
		return response;
	}

	/**
	 * Aborts the in-flight action.
	 *
	 * The helper is told first, so the native action actually stops, and only then are the local
	 * promises settled — otherwise a caller could start a new action while the old one is still
	 * moving the mouse. Responses to abandoned ids arrive later and are dropped.
	 */
	private async _cancel(): Promise<ComputerUseResponse<'cancel'>> {
		const abandoned = [...this._pending.keys()];
		const response = this._request('cancel', undefined);
		const cancelled = createComputerUseError('cancelled', localize(
			'computerUse.cancelled',
			"The computer-use action was cancelled.",
		));
		for (const id of abandoned) {
			this._settle(id, { id, ok: false, error: cancelled });
		}
		return response;
	}

	// -----------------------------------------------------------------------------------------
	// Helper lifecycle
	// -----------------------------------------------------------------------------------------

	/** Ensures a health-checked helper is running. Resolves with the reason it is not. */
	private async _ensureHelper(override: string | undefined): Promise<ComputerUseError | undefined> {
		if (this._trippedError) {
			return this._trippedError;
		}
		if (this._helper) {
			return undefined;
		}
		if (!this._starting) {
			this._starting = this._start(override).finally(() => { this._starting = undefined; });
		}
		return this._starting;
	}

	/** Installs if needed, spawns, then pings. Any failure trips the session kill-switch. */
	private async _start(override: string | undefined): Promise<ComputerUseError | undefined> {
		const outcome = await this._installer.ensureInstalled(override);
		if (!outcome.ok) {
			return this._trip(outcome.error);
		}

		const binary = outcome.installation.path;
		// Probe before spawning: `existsSync` produces a message naming the path, where a failed
		// spawn produces an errno the user cannot act on.
		if (!existsSync(binary)) {
			return this._trip(createComputerUseError('helperMissing', localize(
				'computerUse.binaryMissing',
				"The computer-use helper is not present at {0}.",
				binary,
			)));
		}

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(binary, ['serve', `--protocol-version=${COMPUTER_USE_PROTOCOL_VERSION}`], {
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			return this._trip(createComputerUseError('helperMissing', localize(
				'computerUse.spawnFailed',
				"Could not start the computer-use helper at {0}: {1}",
				binary,
				error instanceof Error ? error.message : String(error),
			)));
		}

		this._attach(child);

		// Health check. This also establishes that we are talking to a helper and not, say, a shell
		// script that happens to occupy the path.
		const response = await this._request('ping', undefined, child);
		if (!isComputerUseSuccess(response)) {
			this._killHelper();
			return this._trip(response.error);
		}
		if (response.result.protocolVersion !== COMPUTER_USE_PROTOCOL_VERSION) {
			this._killHelper();
			return this._trip(createComputerUseError('helperVersionMismatch', localize(
				'computerUse.versionMismatch',
				"The computer-use helper at {0} speaks protocol version {1}, but this build of V3Code speaks version {2}. This is almost always a stale helper left in {3} by an earlier version of V3Code: delete it and restart V3Code so the bundled helper is reinstalled.",
				response.result.helperVersion ? `${binary} (build ${response.result.helperVersion})` : binary,
				String(response.result.protocolVersion),
				String(COMPUTER_USE_PROTOCOL_VERSION),
				COMPUTER_USE_HELPER_PATH,
			)));
		}

		this._helper = child;
		this._ping = response.result;
		this.logService.info(`${LOG_PREFIX} helper ready: ${binary} (build ${response.result.helperVersion}, protocol ${response.result.protocolVersion})`);
		return undefined;
	}

	/** Wires stdout framing, stderr logging and exit handling, and registers the kill. */
	private _attach(child: ChildProcessWithoutNullStreams): void {
		this._decoder = new StringDecoder('utf8');
		this._lineBuffer = '';

		child.stdout.on('data', (chunk: Buffer) => this._onStdout(chunk));
		// Helper diagnostics must never reach our stdout, which on Windows is the protocol stream of
		// the process that spawned us.
		child.stderr.on('data', (chunk: Buffer) => {
			const text = String(chunk).trim();
			if (text) {
				this.logService.trace(`${LOG_PREFIX} helper stderr: ${text}`);
			}
		});
		child.on('error', error => {
			this.logService.warn(`${LOG_PREFIX} helper process error: ${error instanceof Error ? error.message : String(error)}`);
		});
		child.on('exit', (code, signal) => {
			if (this._helper === child) {
				this._helper = undefined;
				this._ping = undefined;
			}
			this._rejectAllPending(createComputerUseError('internal', localize(
				'computerUse.helperExited',
				"The computer-use helper exited (code {0}, signal {1}) before answering.",
				String(code ?? 'none'),
				String(signal ?? 'none'),
			), true));
		});

		this._helperLifetime.value = toDisposable(() => {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
		});
	}

	/** Terminates the helper and clears the cached identity. */
	private _killHelper(): void {
		this._helperLifetime.clear();
		this._helper = undefined;
		this._ping = undefined;
	}

	/**
	 * Disables computer use for the rest of the session, logging exactly one actionable line.
	 *
	 * Copied from `beastService`'s `_tripped` behaviour: a broken helper is retried on every tool
	 * call otherwise, which turns one problem into hundreds of log lines and seconds of latency per
	 * call. Degrading dark keeps the rest of the agent usable.
	 */
	private _trip(error: ComputerUseError): ComputerUseError {
		if (this._trippedError) {
			return this._trippedError;
		}
		this._trippedError = error;
		this._killHelper();
		this._rejectAllPending(error);
		this.logService.warn(`${LOG_PREFIX} ${localize(
			'computerUse.disabled',
			"Computer use is disabled for this session: {0} Install a signed helper at {1}, or point '{2}' at a locally built helper, then restart V3Code.",
			error.message,
			COMPUTER_USE_HELPER_PATH,
			COMPUTER_USE_HELPER_PATH_SETTING,
		)}`);
		return error;
	}

	// -----------------------------------------------------------------------------------------
	// Protocol
	// -----------------------------------------------------------------------------------------

	/** Writes one request line and awaits its response, within the method's budget. */
	private _request<M extends ComputerUseMethod>(
		method: M,
		params: ComputerUseParamsFor<M>,
		target?: ChildProcessWithoutNullStreams,
	): Promise<ComputerUseResponse<M>> {
		const child = target ?? this._helper;
		if (!child) {
			return Promise.resolve(this._localFailure(createComputerUseError('helperMissing', localize(
				'computerUse.notRunning',
				"The computer-use helper is not running.",
			), true)) as ComputerUseResponse<M>);
		}
		if (this._pending.size >= MAX_PENDING_REQUESTS) {
			return Promise.resolve(this._localFailure(createComputerUseError('internal', localize(
				'computerUse.tooManyPending',
				"Too many computer-use requests are already in flight ({0}). Await the previous action before starting another.",
				String(MAX_PENDING_REQUESTS),
			), true)) as ComputerUseResponse<M>);
		}

		const id = this._nextRequestId++;
		const request: ComputerUseRequest<M> = { id, method, params, protocolVersion: COMPUTER_USE_PROTOCOL_VERSION };
		// Resolved once and reused, so the timer and the message it produces can never disagree about
		// how long the caller was actually given.
		const budgetMs = this._budgetFor(method, params);

		return new Promise<ComputerUseResponse<M>>(resolve => {
			const timer = setTimeout(() => {
				this._settle(id, {
					id,
					ok: false,
					error: createComputerUseError('timeout', localize(
						'computerUse.timeout',
						"The computer-use helper did not answer '{0}' within {1}ms.",
						method,
						String(budgetMs),
					), true),
				});
			}, budgetMs);

			this._pending.set(id, {
				method,
				timer,
				settle: response => resolve(response as ComputerUseResponse<M>),
			});

			try {
				child.stdin.write(`${JSON.stringify(request)}\n`);
			} catch (error) {
				const failure = this._trip(createComputerUseError('internal', localize(
					'computerUse.writeFailed',
					"Could not write to the computer-use helper: {0}",
					error instanceof Error ? error.message : String(error),
				)));
				this._settle(id, { id, ok: false, error: failure });
			}
		});
	}

	/**
	 * Reassembles newline-delimited JSON from arbitrary chunk boundaries.
	 *
	 * A chunk can end mid-object, mid-line or mid-character, so the tail is carried over and the
	 * bytes are decoded incrementally rather than per chunk.
	 */
	private _onStdout(chunk: Buffer): void {
		this._lineBuffer += this._decoder.write(chunk);

		let newline = this._lineBuffer.indexOf('\n');
		while (newline !== -1) {
			const line = this._lineBuffer.slice(0, newline).trim();
			this._lineBuffer = this._lineBuffer.slice(newline + 1);
			if (line) {
				this._onLine(line);
			}
			newline = this._lineBuffer.indexOf('\n');
		}

		if (this._lineBuffer.length > MAX_LINE_BYTES) {
			this._lineBuffer = '';
			this._trip(createComputerUseError('internal', localize(
				'computerUse.lineTooLong',
				"The computer-use helper sent more than {0} bytes without ending a line, so the protocol stream cannot be trusted.",
				String(MAX_LINE_BYTES),
			)));
		}
	}

	/** Parses and routes one response line. A malformed line trips the session. */
	private _onLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			this._trip(createComputerUseError('internal', localize(
				'computerUse.parseFailed',
				"The computer-use helper wrote a line that is not valid JSON, so the protocol stream cannot be trusted: {0}",
				error instanceof Error ? error.message : String(error),
			)));
			return;
		}

		const response = this._asResponse(parsed);
		if (!response) {
			this._trip(createComputerUseError('internal', localize(
				'computerUse.badEnvelope',
				"The computer-use helper wrote a line that is not a protocol response: {0}",
				line.slice(0, 200),
			)));
			return;
		}

		if (!this._pending.has(response.id)) {
			// Late answer to a timed-out or cancelled request. Dropping it is correct; acting on it
			// would resolve a promise whose caller has already moved on.
			this.logService.trace(`${LOG_PREFIX} dropping response for unknown request ${response.id}`);
			return;
		}
		this._settle(response.id, response);
	}

	/** Validates the envelope shape without trusting the helper's typing. */
	private _asResponse(candidate: unknown): ComputerUseResponse | undefined {
		if (typeof candidate !== 'object' || candidate === null) {
			return undefined;
		}
		const envelope = candidate as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
		if (typeof envelope.id !== 'number' || typeof envelope.ok !== 'boolean') {
			return undefined;
		}
		if (envelope.ok) {
			// The result is shaped by the method, which this generic path cannot see; the caller's
			// `ComputerUseResultFor<M>` is the contract that gives it back its type.
			return { id: envelope.id, ok: true, result: envelope.result } as ComputerUseResponse;
		}
		const error = envelope.error as ComputerUseError | undefined;
		if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
			return undefined;
		}
		return { id: envelope.id, ok: false, error };
	}

	/** Resolves one pending request exactly once, clearing its timer. */
	private _settle(id: number, response: ComputerUseResponse): void {
		const pending = this._pending.get(id);
		if (!pending) {
			return;
		}
		this._pending.delete(id);
		clearTimeout(pending.timer);
		pending.settle(response);
	}

	/** Fails every pending request with the same error — used on exit, trip and shutdown. */
	private _rejectAllPending(error: ComputerUseError): void {
		for (const id of [...this._pending.keys()]) {
			this._settle(id, { id, ok: false, error });
		}
	}

	// -----------------------------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------------------------

	/** Narrows a command string to a protocol method. */
	private _isKnownMethod(command: string): command is ComputerUseMethod {
		return Object.prototype.hasOwnProperty.call(METHOD_BUDGETS_MS, command);
	}

	/** Resolves one request's budget, consulting its params for the caller-controlled waits. */
	private _budgetFor<M extends ComputerUseMethod>(method: M, params: ComputerUseParamsFor<M> | undefined): number {
		// The cast restates what the mapped type already says; TypeScript loses it through a generic key.
		const budget = METHOD_BUDGETS_MS[method] as ComputerUseMethodBudget<M>;
		return typeof budget === 'number' ? budget : budget(params);
	}

	/** The caller's override, else the main-process configuration value, else `undefined`. */
	private _helperBinaryPath(argument?: IComputerUseCallArgument): string | undefined {
		const fromCaller = argument?.helperBinaryPath?.trim();
		if (fromCaller) {
			return fromCaller;
		}
		return this.configurationService.getValue<string>(COMPUTER_USE_HELPER_PATH_SETTING)?.trim() || undefined;
	}

	/** Wraps a locally raised error in a response envelope with no request id. */
	private _localFailure(error: ComputerUseError): ComputerUseResponse {
		return { id: NO_REQUEST_ID, ok: false, error };
	}
}
