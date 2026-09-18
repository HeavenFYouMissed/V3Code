/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * The renderer-side gate in front of the native computer-use helper.
 *
 * Every computer-use call in V3Code goes through {@link IComputerUseService}. Nothing else may hold
 * the channel, because the value of this file is that there is exactly one place where the pre-flight
 * checks live and therefore exactly one place that can be audited. There are two:
 *
 * 1. Computer use is enabled and its one-time consent has been recorded.
 * 2. The frontmost application is resolved *now*, from the OS, and is not on the user's exclusion list.
 *
 * Step 2 is the important one, and the "now" is why. Resolving the frontmost application per action —
 * rather than once per session, or from a parameter the model supplies — is what makes "the agent acted
 * on the wrong window" structurally impossible rather than merely unlikely. No path from a tool to the
 * channel skips it.
 *
 * What is deliberately *not* here: any per-application permission model. Enabling computer use is the
 * user telling the agent it may drive their machine, and asking again per application re-litigates a
 * settled question while creating a refusal the model cannot resolve on its own. The exclusion list is
 * an escape hatch for specific applications, not a gate everything must pass.
 *
 * The safety work that remains is visibility rather than prohibition: the overlay, a working Escape, and
 * two-phase commit for irreversible actions. Those keep the user's judgement in the loop; a category ban
 * would only have moved the decision away from them.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ComputerUseAppTier, classifyComputerUseApp, isSelfApp } from '../common/computerUseAppTiers.js';
import {
	ComputerUseAxDelta,
	ComputerUseAxDeltaAssessment,
	assessAxDelta,
	diffAxTrees,
	pruneAxTree,
} from '../common/computerUseAxDiff.js';
import { ComputerUseCoordinateSpace, clampToDisplay, createCoordinateSpace, imagePointToPhysical } from '../common/computerUseCoordinates.js';
import { COMPUTER_USE_CHANNEL_NAME, IComputerUseConsentService } from '../common/computerUseConsent.js';
import {
	COMPUTER_USE_PROTOCOL_VERSION,
	COMPUTER_USE_SETTLE_AFTER_METHODS,
	COMPUTER_USE_SETTLE_BEFORE_METHODS,
	ComputerUseApp,
	ComputerUseAxNode,
	ComputerUseAxTreeDiffResult,
	ComputerUseAxTreeParams,
	ComputerUseAxTreeResult,
	ComputerUseCaptureParams,
	ComputerUseCaptureResult,
	ComputerUseTarget,
	ComputerUseError,
	ComputerUseErrorCode,
	ComputerUseForceAccessibilityParams,
	ComputerUseForceAccessibilityResult,
	ComputerUseFrontmostApp,
	ComputerUseMethod,
	ComputerUseParamsFor,
	ComputerUseResponse,
	ComputerUseResultFor,
	ComputerUseSettleParams,
	ComputerUseSettleResult,
	ComputerUseStatusResult,
	createComputerUseError,
	isComputerUseSuccess,
	isMutatingComputerUseMethod,
} from '../common/computerUseTypes.js';
import { IVoidSettingsService } from '../../void/common/voidSettingsService.js';
import { IComputerUseExclusionStore } from './computerUseExclusionStore.js';
import { ComputerUseCancelOverlay } from './computerUseCancelOverlay.js';

/**
 * How long a {@link ComputerUsePreparedAction} stays committable.
 *
 * Short, because the preview describes the screen as it was: committing a two-minute-old plan means
 * acting on a machine the user has since moved on from.
 */
export const COMPUTER_USE_PREPARED_ACTION_TTL_MS = 60_000;

/**
 * How many per-application accessibility baselines are kept for incremental reads.
 *
 * Small on purpose. A baseline is only useful for the application the agent is currently working in,
 * and each one is a whole pruned accessibility tree; keeping one per process the agent has ever looked
 * at would be a slow leak whose size depends on how long the session ran. Evicted least-recently-read
 * first, and a miss costs one full read rather than a wrong answer.
 */
export const COMPUTER_USE_MAX_AX_BASELINES = 8;

/**
 * How long "this application is quiescent" stays believable without being re-checked.
 *
 * The claim is only ever *wrong* in one direction: an application that started moving again without
 * V3Code doing anything — a notification sliding in, a page finishing a load, the user themselves.
 * Skipping a wait on an application that really is idle costs nothing, because the wait would have
 * returned immediately; skipping one on an application that quietly started animating hands the model a
 * snapshot of something in motion.
 *
 * Ten seconds is chosen against the two intervals that matter rather than against animation length: it
 * comfortably covers a chain of tool calls inside one agent turn, where the saving is real, and it
 * expires across a model round trip, where re-checking is nearly free and the machine has had time to
 * change under us.
 */
export const COMPUTER_USE_SETTLED_CLAIM_TTL_MS = 10_000;

/**
 * An `Error` carrying a structured {@link ComputerUseError}.
 *
 * Thrown rather than returned so a caller cannot forget to check a result, while the machine-readable
 * `code` survives for callers that want to branch on it.
 */
export class ComputerUseFailure extends Error {
	constructor(readonly computerUseError: ComputerUseError) {
		super(computerUseError.message);
		this.name = 'ComputerUseFailure';
	}
}

/** True when a caught value is a {@link ComputerUseFailure}, so `code` can be read safely. */
export function isComputerUseFailure(candidate: unknown): candidate is ComputerUseFailure {
	return candidate instanceof ComputerUseFailure;
}

/**
 * The outcome of the pre-flight gate.
 *
 * Reaching this at all means the action is permitted: consent is recorded and the frontmost application
 * is not excluded. There is no per-action verdict to carry, because there is no per-action decision —
 * enabling computer use was the decision.
 */
export interface ComputerUseGateResult {
	/** The application that was frontmost at the moment the gate ran. */
	readonly app: ComputerUseFrontmostApp;
	/**
	 * How V3Code classifies it. Informational: it reaches the model through `computer_list_apps` and it
	 * decides whether V3Code stays out of its own screenshots. It permits and forbids nothing.
	 */
	readonly tier: ComputerUseAppTier;
}

/**
 * A gated, previewed action awaiting commitment.
 *
 * Two-phase commit exists so approval for an irreversible action sits *in the protocol* — between
 * two separate calls, against a token the model did not mint — rather than in a prompt the model can
 * talk its way past. {@link IComputerUseService.commit} re-runs the frontmost check, so a window
 * change between the phases fails the commit instead of redirecting the action.
 */
export interface ComputerUsePreparedAction<M extends ComputerUseMethod = ComputerUseMethod> {
	/** Opaque handle. Only a token minted by {@link IComputerUseService.prepare} can be committed. */
	readonly token: string;
	readonly method: M;
	readonly params: ComputerUseParamsFor<M>;
	/** The frontmost application at prepare time; the commit requires the same one. */
	readonly app: ComputerUseFrontmostApp;
	readonly tier: ComputerUseAppTier;
	/** Localized, human-readable description of exactly what committing will do. */
	readonly preview: string;
	/** Epoch milliseconds after which the commit is refused as stale. */
	readonly expiresAt: number;
}

/**
 * One helper call's result together with the implicit settle that ran around it.
 *
 * `unsettled` exists because {@link ComputerUseSettleResult.settled} being false is information the
 * *model* needs, not a detail the service may absorb: an observation taken while the UI was still
 * moving describes a state that no longer exists, and a model told nothing will act on it confidently.
 * Reported per call rather than read off the service afterwards so it cannot be attributed to the
 * wrong invocation.
 */
export interface ComputerUseInvocationOutcome<M extends ComputerUseMethod = ComputerUseMethod> {
	readonly result: ComputerUseResultFor<M>;
	/**
	 * The implicit settle for this call, present only when it did **not** reach a settled state.
	 *
	 * Absent both when no implicit settle applied to the method and when one ran and succeeded — in
	 * neither case is there anything for the caller to warn about.
	 */
	readonly unsettled?: ComputerUseSettleResult;
}

/**
 * How an incremental accessibility read was answered.
 *
 * Only `delta` and `unchanged` mean the caller may show a change set. Every `full*` mode means the
 * caller **must** present {@link ComputerUseAxReading.tree} in full: a patch is only intelligible
 * against a baseline the model still remembers, so showing one of these as a delta would ask the model
 * to reconstruct the present from a past it cannot see.
 */
export type ComputerUseAxReadingMode =
	/** A usefully small change set against the caller's previous read. */
	| 'delta'
	/** Nothing observable changed. The cheapest answer, and the common one in a read-act-read loop. */
	| 'unchanged'
	/** No baseline was held for this application, so there was nothing to compare against. */
	| 'fullNoBaseline'
	/**
	 * The helper declined to vouch that refs from the baseline generation still mean the same elements
	 * — the application restarted, a `cancel` interrupted a walk, or the baseline is older than the
	 * helper's own history.
	 */
	| 'fullBaselineExpired'
	/** The read landed on a different application than the baseline came from. */
	| 'fullAppChanged'
	/** A delta was computed and rejected by {@link assessAxDelta} as no cheaper than the tree. */
	| 'fullTooManyChanges';

/** The outcome of an incremental accessibility read. */
export interface ComputerUseAxReading {
	readonly mode: ComputerUseAxReadingMode;
	/**
	 * The tree the helper returned.
	 *
	 * Empty when `mode` is `unchanged` — the helper answers that case without walking anything.
	 */
	readonly tree: ComputerUseAxTreeResult;
	/** The computed delta. Present for `delta` and for `fullTooManyChanges`, absent otherwise. */
	readonly delta?: ComputerUseAxDelta;
	/** The size verdict behind `mode`. Present exactly when `delta` is. */
	readonly assessment?: ComputerUseAxDeltaAssessment;
	/** As {@link ComputerUseInvocationOutcome.unsettled}. */
	readonly unsettled?: ComputerUseSettleResult;
}

export const IComputerUseService = createDecorator<IComputerUseService>('computerUseService');

/**
 * The single entry point for driving the machine.
 *
 * Every method that reaches the helper rejects with a {@link ComputerUseFailure} on refusal; none of
 * them return an error-shaped result.
 */
export interface IComputerUseService {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when {@link isAvailable} would give a different answer.
	 *
	 * The tool contribution listens to this to register or revoke the computer-use tools, so the model
	 * never sees a tool it is not permitted to call.
	 */
	readonly onDidChangeAvailability: Event<boolean>;

	/** Fires true when an action starts and false when the last one finishes. */
	readonly onDidChangeActing: Event<boolean>;

	/** True while at least one action is in flight. */
	readonly isActing: boolean;

	/**
	 * True only when ALL of the following hold: the helper is installed with a matching protocol
	 * version, machine-wide consent has been accepted, and the `enableComputerUse` global setting is
	 * on.
	 *
	 * Synchronous and cached so tool registration can read it without awaiting. It is `false` until the
	 * first helper probe resolves, at which point {@link onDidChangeAvailability} fires — so a listener
	 * that re-reads this on the event always converges on the right answer.
	 */
	readonly isAvailable: boolean;

	/**
	 * Why {@link isAvailable} is false, or `undefined` when it is true.
	 *
	 * The three preconditions fail in ways that need completely different responses — install a
	 * build that has the helper, flip a setting, or recover a tripped session — but the only thing
	 * a caller could observe was a single `false`, which surfaced to the model as the generic
	 * "tool was not contributed". That reads as "this feature does not exist", and it caused the
	 * same wrong diagnosis twice: a shipped-but-unbuilt helper was reported as a missing feature.
	 */
	readonly unavailableReason: 'helper-missing' | 'setting-disabled' | 'tripped' | undefined;

	/**
	 * True when {@link isAvailable} holds *and* the OS has granted the input permission the helper
	 * needs to synthesize events (Accessibility trust on macOS, UIA on Windows).
	 *
	 * Split from {@link isAvailable} because the read half of the feature works with only Screen
	 * Recording granted. When this is false the mutating tools should not be registered at all: a tool
	 * the model cannot successfully call is worse than a tool that is absent.
	 */
	readonly isInputEnabled: boolean;

	/**
	 * Re-probes the helper and returns the resulting {@link isAvailable}.
	 *
	 * Fires {@link onDidChangeAvailability} if the answer changed. Callers that merely want the current
	 * answer should read {@link isAvailable} instead.
	 */
	checkAvailability(): Promise<boolean>;

	/**
	 * Raw helper and OS-permission state, for surfacing actionable guidance.
	 *
	 * Undefined when the helper could not be reached at all. Does not require consent, because the
	 * user needs to be able to see why the feature is off before agreeing to turn it on.
	 */
	getStatus(): Promise<ComputerUseStatusResult | undefined>;

	/** Prompts for machine-wide consent if it has not been given. Resolves false when declined. */
	ensureConsent(): Promise<boolean>;

	/** The frontmost application, gated by consent. Rejects with a {@link ComputerUseFailure}. */
	getFrontmostApp(): Promise<ComputerUseFrontmostApp>;

	/**
	 * Runs the full pre-flight gate without performing anything.
	 *
	 * Useful for a tool that wants to tell the model what it is about to be allowed to do, and for
	 * tests that assert the gate independently of the channel.
	 */
	gate(method: ComputerUseMethod): Promise<ComputerUseGateResult>;

	/**
	 * Gates and performs one helper method.
	 *
	 * `capture` always has V3Code's own process ids merged into `excludePids`, so the agent can neither
	 * observe nor recurse on its own UI.
	 *
	 * An implicit `settle` runs before an observation and after an action — see
	 * {@link invokeWithSettleReport} for the outcome of that wait, which this overload discards.
	 */
	invoke<M extends ComputerUseMethod>(method: M, params: ComputerUseParamsFor<M>): Promise<ComputerUseResultFor<M>>;

	/**
	 * {@link invoke}, plus whether the implicit settle around the call actually settled.
	 *
	 * Prefer this in a tool: a caller that drops the settle report cannot tell the model that its
	 * observation is provisional, which is the one thing the model most needs to know.
	 */
	invokeWithSettleReport<M extends ComputerUseMethod>(
		method: M,
		params: ComputerUseParamsFor<M>,
	): Promise<ComputerUseInvocationOutcome<M>>;

	/**
	 * Reads the accessibility tree as a change set against the last read of the same application.
	 *
	 * The service owns the baseline rather than the caller, because every read — whichever tool made it
	 * — must refresh it, and because both sides of a diff have to be pruned identically or a node
	 * dropped on one side reads as an insertion.
	 *
	 * Never fails merely because no baseline exists: it falls back to a full read and says so in
	 * {@link ComputerUseAxReading.mode}, so the model gets the answer it wanted this turn instead of an
	 * instruction to spend another one.
	 */
	readAxChanges(params: ComputerUseAxTreeParams): Promise<ComputerUseAxReading>;

	/**
	 * Waits until the target application's UI stops changing.
	 *
	 * Rarely needed explicitly: the service already settles before every observation and after every
	 * action. Call it when something asynchronous is still in flight — a save, a load, a progress
	 * sheet — and the automatic wait was not enough.
	 *
	 * Resolving with `settled: false` is a normal outcome, not a failure. The caller must surface it.
	 */
	settle(params?: ComputerUseSettleParams): Promise<ComputerUseSettleResult>;

	/**
	 * Asks a process to expose its accessibility tree, and waits for it to appear.
	 *
	 * Electron and Chromium applications report a single placeholder node until `AXManualAccessibility`
	 * is set, which is indistinguishable from a permission failure at the call site. The service calls
	 * this itself when an application is first approved, so the asynchronous population cost is paid
	 * once and off the critical path; it is exposed because a process that started later, or was
	 * approved before this shipped, still needs it.
	 */
	forceElectronAccessibility(params: ComputerUseForceAccessibilityParams): Promise<ComputerUseForceAccessibilityResult>;

	/**
	 * Phase one of a two-phase action: gate, describe, and hold — but do not act.
	 *
	 * Approval belongs between this and {@link commit}.
	 */
	prepare<M extends ComputerUseMethod>(method: M, params: ComputerUseParamsFor<M>): Promise<ComputerUsePreparedAction<M>>;

	/**
	 * Phase two: perform a previously prepared action.
	 *
	 * Rejects with `refStale` when the frontmost application changed, `timeout` when the token
	 * expired, and `internal` when the token was never minted here or was already used. Tokens are
	 * single-use.
	 */
	commit<M extends ComputerUseMethod>(prepared: ComputerUsePreparedAction<M>): Promise<ComputerUseResultFor<M>>;

	/** Drops a prepared action without performing it. Safe to call twice. */
	discard(prepared: ComputerUsePreparedAction): void;

	/**
	 * Prompts for a per-application grant, persisting it on approval.
	 *
	 * {@link invoke} and {@link prepare} call this themselves for mutating methods, so tools normally
	 * do not need to. Concurrent requests for the same application share one dialog.
	 */
	/**
	 * Aborts everything in flight, immediately.
	 *
	 * In-flight calls reject with `cancelled` before this resolves; the helper's own `cancel` is then
	 * sent best-effort. Prepared-but-uncommitted actions are dropped.
	 */
	cancel(): Promise<void>;
}

/**
 * One cached accessibility snapshot, kept as the baseline for the next incremental read.
 *
 * Immutable and replaced wholesale rather than mutated, so a reader that took a reference before a
 * concurrent read landed still diffs against a coherent snapshot.
 */
interface IComputerUseAxBaseline {
	/** Application identity, so a recycled process id cannot be mistaken for the same application. */
	readonly appId: string;
	readonly generation: number;
	/** Nodes as {@link pruneAxTree} left them — never the raw helper tree. */
	readonly nodes: readonly ComputerUseAxNode[];
}

/** @inheritdoc */
export class ComputerUseService extends Disposable implements IComputerUseService {

	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;

	private readonly _onDidChangeAvailability = this._register(new Emitter<boolean>());
	readonly onDidChangeAvailability: Event<boolean> = this._onDidChangeAvailability.event;

	private readonly _onDidChangeActing = this._register(new Emitter<boolean>());
	readonly onDidChangeActing: Event<boolean> = this._onDidChangeActing.event;

	/** Fired to unblock everything racing a cancellation. Not part of the public surface. */
	private readonly _onDidCancel = this._register(new Emitter<void>());

	/**
	 * Session kill switch.
	 *
	 * A spawn failure or protocol garbage means the helper is not going to start working later in the
	 * same session, and retrying it on every tool call turns one broken install into a stream of
	 * confusing failures. Logged exactly once, with the fix in the message.
	 */
	private _tripped = false;

	/** Cached helper probe. Cleared when the session trips so a reload re-probes. */
	private _helperProbe: Promise<boolean> | undefined;

	/** True once the probe has confirmed an installed helper on a matching protocol version. */
	private _helperOk = false;

	/**
	 * Last {@link ComputerUseStatusResult} the probe saw.
	 *
	 * Kept so {@link isInputEnabled} can be answered synchronously; OS permission state changes rarely
	 * and a stale `false` self-corrects on the next {@link checkAvailability}.
	 */
	private _lastStatus: ComputerUseStatusResult | undefined;

	/** Cached self process ids, resolved from `listApps` via the `self` tier. */
	private _selfPids: Promise<readonly number[]> | undefined;

	/**
	 * Coordinate space of the most recent capture served to the model.
	 *
	 * Point targets arrive in the image space of whatever screenshot the model was last looking at, so
	 * this is the only thing that can turn them back into screen coordinates.
	 */
	private _lastCaptureSpace: ComputerUseCoordinateSpace | undefined;

	/**
	 * Per-process accessibility baselines for incremental reads, least-recently-read first.
	 *
	 * Bounded by {@link COMPUTER_USE_MAX_AX_BASELINES}. Written on the way *in* from every accessibility
	 * read, already pruned, so both sides of a later diff went through the identical transformation.
	 */
	private readonly _axBaselines = new Map<number, IComputerUseAxBaseline>();

	/**
	 * When each process was last observed to be quiescent, keyed by process id.
	 *
	 * This is what makes the automatic settling cheap: a process already known quiescent is not waited on
	 * again, so a read-act-read loop pays for one settle per action rather than one before every
	 * observation *and* one after every action. Cleared outright the moment anything is dispatched,
	 * because a dispatched action is precisely what invalidates the claim.
	 *
	 * The claim also expires on its own after {@link COMPUTER_USE_SETTLED_CLAIM_TTL_MS}, because the user
	 * is driving this machine too and V3Code only knows about its own actions.
	 */
	private readonly _settledAtByPid = new Map<number, number>();

	/**
	 * Last reported `available|input` pair, so the change event only fires on a real change.
	 *
	 * Both halves are tracked because the tool contribution registers a different surface for each.
	 */
	private _lastAvailabilitySignature: string | undefined;

	/** Applications whose accessibility engine has already been nudged this session. */
	private readonly _accessibilityForced = new Set<string>();

	/** Prepared-but-uncommitted actions, keyed by token. */
	private readonly _prepared = new Map<string, ComputerUsePreparedAction>();

	private _actingCount = 0;

	private readonly _overlay = this._register(new MutableDisposable<ComputerUseCancelOverlay>());

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IComputerUseConsentService private readonly consentService: IComputerUseConsentService,
		@IComputerUseExclusionStore private readonly exclusionStore: IComputerUseExclusionStore,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		// IDialogService is intentionally not injected any more: the only dialog this service owned was the
		// per-application approval prompt, which no longer exists.
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = mainProcessService.getChannel(COMPUTER_USE_CHANNEL_NAME);

		// Both inputs to availability can change at runtime: the user can flip the setting, and consent
		// is granted mid-session the first time a tool asks for it.
		this._register(this.settingsService.onDidChangeState(() => void this._refreshAvailability()));
		this._register(this.consentService.onDidChangeConsent(() => void this._refreshAvailability()));

		// Probe eagerly: `isAvailable` is synchronous and starts out false, so nothing would ever
		// register the tools if the first probe waited for someone to ask.
		void this._refreshAvailability();
	}

	// -----------------------------------------------------------------------------------------
	// Availability
	// -----------------------------------------------------------------------------------------

	get isActing(): boolean {
		return this._actingCount > 0;
	}

	/**
	 * Whether the computer-use tools should exist for the model to call.
	 *
	 * Deliberately does NOT require consent, and that is a bug fix rather than a relaxation. Consent
	 * gates *actions* — `gate()` still refuses everything until it is given. Gating tool *registration*
	 * on it as well produced a deadlock the moment this ran for the first time: no consent meant no
	 * tools were registered, the only thing that requests consent is a tool call, and a tool that does
	 * not exist cannot be called. The feature could never turn on, and it failed silently — the model
	 * simply never saw the tools and reported that computer use was unavailable.
	 *
	 * Registering an approval-gated tool before its approval exists is the normal shape: the model sees
	 * it, tries it, and the user is asked at that moment with a concrete action to say yes to, which is
	 * a far better prompt than one fired at settings time with no context.
	 */
	get isAvailable(): boolean {
		return !this._tripped && this._helperOk && this._isSettingEnabled();
	}

	get unavailableReason(): 'helper-missing' | 'setting-disabled' | 'tripped' | undefined {
		// The setting MUST be checked first: the probe only runs when the setting is enabled
		// (see _refreshAvailability), so with the setting off `_helperOk` is false because the
		// probe never ran — not because the helper is missing. Reporting 'helper-missing' in
		// that state sent two investigations chasing packaging ghosts on builds whose package
		// verifiably contained the helper.
		if (!this._isSettingEnabled()) { return 'setting-disabled'; }
		if (!this._helperOk) { return 'helper-missing'; }
		if (this._tripped) { return 'tripped'; }
		return undefined;
	}

	get isInputEnabled(): boolean {
		return this.isAvailable && this._lastStatus?.accessibilityTrusted === true;
	}

	async checkAvailability(): Promise<boolean> {
		await this._refreshAvailability();
		return this.isAvailable;
	}

	private _isSettingEnabled(): boolean {
		// Compared to `true` rather than coerced: a setting imported as the string "false" must not arm
		// control of the whole machine. Read off `GlobalSettings` directly — not through a widening cast —
		// so renaming the setting is a compile error here rather than a feature that silently reports
		// unavailable forever.
		return this.settingsService.state.globalSettings.enableComputerUse === true;
	}

	/**
	 * One-shot helper probe: installed, and speaking our protocol version.
	 *
	 * A version mismatch is treated as unavailable rather than as an error at call time, because a
	 * stale helper left in `~/.v3code/bin` after an app update otherwise fails in ways that look like
	 * feature bugs.
	 */
	private _probeHelper(): Promise<boolean> {
		if (!this._helperProbe) {
			this._helperProbe = this.channel.call<ComputerUseResponse<'status'>>('status', {})
				.then(response => {
					if (!isComputerUseSuccess(response)) {
						this.logService.info(`[v3code-computer-use] helper unavailable: ${response.error.message}`);
						return false;
					}
					const status = response.result;
					this._lastStatus = status;
					if (!status.installed) {
						this.logService.info('[v3code-computer-use] helper binary not found — install it to ~/.v3code/bin to enable computer use');
						return false;
					}
					if (status.protocolVersion !== COMPUTER_USE_PROTOCOL_VERSION) {
						this.logService.warn(`[v3code-computer-use] helper speaks protocol ${status.protocolVersion} but V3Code speaks ${COMPUTER_USE_PROTOCOL_VERSION} — replace the binary in ~/.v3code/bin`);
						return false;
					}
					return true;
				})
				.catch((error: unknown) => {
					this._trip(`status probe failed: ${this._describe(error)}`);
					return false;
				});
		}
		return this._helperProbe;
	}

	/** Recomputes availability and fires the event when either half of the answer actually changed. */
	private async _refreshAvailability(): Promise<void> {
		// Consent is deliberately not a precondition for probing — see {@link isAvailable}. The probe has
		// to run before consent exists, because the tools must be registered for a tool call to happen,
		// and a tool call is what asks for consent.
		if (!this._tripped && this._isSettingEnabled()) {
			// The probe's answer must be *recorded*, not merely awaited: `isAvailable` is synchronous and
			// reads `_helperOk`, so discarding this leaves the feature permanently unavailable — no tool is
			// ever registered, and every gate refuses — while type-checking and logging exactly as though it
			// worked.
			const helperOk = await this._probeHelper();
			// A trip that landed while the probe was in flight wins — it is a session kill switch, and the
			// probe's `true` describes a helper that has since been given up on.
			this._helperOk = helperOk && !this._tripped;
		}
		const signature = `${this.isAvailable}|${this.isInputEnabled}`;
		if (signature === this._lastAvailabilitySignature) {
			return;
		}
		this._lastAvailabilitySignature = signature;
		// Always say why, and say it whichever way the answer went.
		//
		// This exists because the first time the feature ran end to end it was unavailable and logged
		// nothing at all, so the only symptom was the model reporting that it had no computer-use tools.
		// Diagnosing that meant reading source. An unavailable feature must be able to explain itself in
		// one line, because "the tools are missing" is indistinguishable from a dozen unrelated causes.
		this.logService.info(`[v3code-computer-use] availability: ${this._describeAvailability()}`);
		this._onDidChangeAvailability.fire(this.isAvailable);
	}

	/** One line naming every precondition and whether it holds. */
	private _describeAvailability(): string {
		const parts = [
			`available=${this.isAvailable}`,
			`inputEnabled=${this.isInputEnabled}`,
			`setting(enableComputerUse)=${this._isSettingEnabled()}`,
			`helperOk=${this._helperOk}`,
			`tripped=${this._tripped}`,
			`consentAccepted=${this.consentService.hasAccepted()}`,
			`accessibilityTrusted=${this._lastStatus?.accessibilityTrusted ?? 'unknown'}`,
			`screenRecordingGranted=${this._lastStatus?.screenRecordingGranted ?? 'unknown'}`,
		];
		// Consent is listed but is NOT a precondition for availability — it gates actions, not tool
		// registration. Included so a reader can see the whole picture without inferring it.
		return parts.join(' ');
	}

	async getStatus(): Promise<ComputerUseStatusResult | undefined> {
		if (this._tripped) {
			return undefined;
		}
		try {
			const response = await this.channel.call<ComputerUseResponse<'status'>>('status', {});
			if (!isComputerUseSuccess(response)) {
				return undefined;
			}
			// Keep the synchronous `isInputEnabled` honest: a user who grants Accessibility trust in
			// System Settings and comes back should not have to reload the window.
			this._lastStatus = response.result;
			return response.result;
		} catch (error: unknown) {
			this._trip(`status failed: ${this._describe(error)}`);
			return undefined;
		}
	}

	async ensureConsent(): Promise<boolean> {
		const accepted = await this.consentService.ensureAccepted();
		await this._refreshAvailability();
		return accepted;
	}

	// -----------------------------------------------------------------------------------------
	// The gate
	// -----------------------------------------------------------------------------------------

	async gate(method: ComputerUseMethod): Promise<ComputerUseGateResult> {
		// 1. Machine-wide consent.
		if (!(await this.ensureConsent())) {
			throw this._fail('permissionDenied', localize(
				'computerUse.error.consentDeclined',
				"Computer use has not been enabled. The one-time permission dialog was declined."
			));
		}

		// 2. Who is actually in front, right now, from the OS.
		const app = await this._callChannel('frontmostApp', undefined);

		// 3. What kind of application that is. Informational — it reaches the model in `listApps` and it
		//    decides whether V3Code stays out of its own screenshots, and that is all it does.
		const tier = classifyComputerUseApp(app);

		// 4. The only per-application question: has the user put this one out of bounds?
		//
		//    There is no second consent here and no per-application prompt. Enabling computer use is the
		//    decision — the user has told the agent it may drive their machine — and asking again per
		//    application re-litigates a settled question while creating a failure the model cannot resolve
		//    on its own. So everything is permitted unless the user specifically excluded it.
		if (this.exclusionStore.isExcluded(app.id)) {
			throw this._fail('appNotApproved', localize(
				'computerUse.error.appExcluded',
				"{0} is excluded from computer use. Remove it from the exclusion list in Settings to allow this.",
				app.name
			), false);
		}

		this._forceAccessibilityOnce(app);
		return { app, tier };
	}

	async getFrontmostApp(): Promise<ComputerUseFrontmostApp> {
		const { app } = await this.gate('frontmostApp');
		return app;
	}

	// -----------------------------------------------------------------------------------------
	// First contact with an application
	// -----------------------------------------------------------------------------------------

	/**
	 * Turns a Chromium application's accessibility engine on, once per application per session.
	 *
	 * This used to hang off the per-application approval prompt. With that gone it hangs off first
	 * contact instead, which is the same moment for the same reason: the tree populates asynchronously,
	 * so paying the latency on the first action is the difference between one slow action and every
	 * `axTree` being slow. Electron apps expose nothing until asked, and that includes V3Code itself.
	 */
	private _forceAccessibilityOnce(app: ComputerUseApp): void {
		const key = app.id.trim().toLowerCase();
		if (this._accessibilityForced.has(key)) {
			return;
		}
		this._accessibilityForced.add(key);
		// Not awaited — an action must not wait on this — and never fatal, because most applications need
		// nothing done to them.
		void this._forceAccessibilityAfterApproval(app);
	}

	/**
	 * Best-effort accessibility enablement for a newly approved application.
	 *
	 * Swallows everything. A failure here costs the model one uninformative `axTree` and a log line,
	 * whereas surfacing it would turn "you approved an application" into "an error occurred".
	 */
	private async _forceAccessibilityAfterApproval(app: ComputerUseApp): Promise<void> {
		try {
			const result = await this.forceElectronAccessibility({ pid: app.pid });
			this.logService.trace(`[v3code-computer-use] forced accessibility for ${app.name} (pid ${app.pid}): applied=${result.applied} populated=${result.treePopulated} roots=${result.rootNodeCount} after ${result.waitedMs}ms`);
		} catch (error: unknown) {
			this.logService.trace(`[v3code-computer-use] could not force accessibility for ${app.name} (pid ${app.pid}): ${this._describe(error)}`);
		}
	}

	// -----------------------------------------------------------------------------------------
	// Invocation
	// -----------------------------------------------------------------------------------------

	async invoke<M extends ComputerUseMethod>(method: M, params: ComputerUseParamsFor<M>): Promise<ComputerUseResultFor<M>> {
		return (await this.invokeWithSettleReport(method, params)).result;
	}

	async invokeWithSettleReport<M extends ComputerUseMethod>(
		method: M,
		params: ComputerUseParamsFor<M>,
	): Promise<ComputerUseInvocationOutcome<M>> {
		const gateResult = await this.gate(method);
		return this._perform(method, params, gateResult);
	}

	// -----------------------------------------------------------------------------------------
	// Incremental reads
	// -----------------------------------------------------------------------------------------

	async readAxChanges(params: ComputerUseAxTreeParams): Promise<ComputerUseAxReading> {
		const gateResult = await this.gate('axTreeDiff');
		const pid = params.pid ?? gateResult.app.pid;
		// Taken before the read, because performing it replaces this very entry.
		const baseline = this._axBaselines.get(pid);

		if (!baseline) {
			// A plain full read is both cheaper and a different method, so it gets its own gate rather
			// than borrowing this one.
			const full = await this.invokeWithSettleReport('axTree', { pid: params.pid, maxDepth: params.maxDepth });
			return { mode: 'fullNoBaseline', tree: full.result, unsettled: full.unsettled };
		}

		const outcome = await this._perform(
			'axTreeDiff',
			{ pid: params.pid, maxDepth: params.maxDepth, sinceGeneration: baseline.generation },
			gateResult,
		);
		const tree: ComputerUseAxTreeDiffResult = outcome.result;
		const unsettled = outcome.unsettled;

		if (tree.app.pid !== pid || tree.app.id !== baseline.appId) {
			// The frontmost application changed between the gate and the walk, or a process id was
			// recycled. Diffing here would describe one application's tree as changes to another's.
			return { mode: 'fullAppChanged', tree, unsettled };
		}
		if (tree.unchanged) {
			return { mode: 'unchanged', tree, unsettled };
		}
		if (!tree.baselineComparable) {
			return { mode: 'fullBaselineExpired', tree, unsettled };
		}

		const delta = diffAxTrees(
			{ nodes: baseline.nodes, generation: baseline.generation },
			{ nodes: pruneAxTree(tree.nodes), generation: tree.generation },
		);
		const assessment = assessAxDelta(delta);
		if (assessment.reason === 'unchanged') {
			return { mode: 'unchanged', tree, delta, assessment, unsettled };
		}
		if (!assessment.useDelta) {
			// `assessAxDelta` says the patch is not easier to read than the tree. That is a correctness
			// verdict, not a hint — see its own documentation.
			return { mode: 'fullTooManyChanges', tree, delta, assessment, unsettled };
		}
		return { mode: 'delta', tree, delta, assessment, unsettled };
	}

	// -----------------------------------------------------------------------------------------
	// Settling and accessibility enablement
	// -----------------------------------------------------------------------------------------

	async settle(params?: ComputerUseSettleParams): Promise<ComputerUseSettleResult> {
		const gateResult = await this.gate('settle');
		const pid = params?.pid ?? gateResult.app.pid;
		const outcome = await this._perform('settle', { ...params, pid }, gateResult);
		this._noteSettled(pid, outcome.result);
		return outcome.result;
	}

	async forceElectronAccessibility(params: ComputerUseForceAccessibilityParams): Promise<ComputerUseForceAccessibilityResult> {
		const gateResult = await this.gate('forceElectronAccessibility');
		const outcome = await this._perform('forceElectronAccessibility', params, gateResult);
		// The tree is about to appear from nothing, so any baseline held for that process describes an
		// application that was switched off. Keeping it would report the whole tree as one addition and
		// call that a delta.
		this._axBaselines.delete(params.pid);
		return outcome.result;
	}

	async prepare<M extends ComputerUseMethod>(method: M, params: ComputerUseParamsFor<M>): Promise<ComputerUsePreparedAction<M>> {
		const { app, tier } = await this.gate(method);
		const preparedAction: ComputerUsePreparedAction<M> = {
			token: generateUuid(),
			method,
			params,
			app,
			tier,
			preview: this._previewOf(method, params, app),
			expiresAt: Date.now() + COMPUTER_USE_PREPARED_ACTION_TTL_MS,
		};
		this._prepared.set(preparedAction.token, preparedAction);
		return preparedAction;
	}

	async commit<M extends ComputerUseMethod>(prepared: ComputerUsePreparedAction<M>): Promise<ComputerUseResultFor<M>> {
		const held = this._prepared.get(prepared.token);
		if (!held) {
			throw this._fail('internal', localize(
				'computerUse.error.unknownToken',
				"This action was already performed, cancelled, or was never prepared. Prepare it again."
			), false);
		}
		// Single-use: consumed before anything can go wrong, so a failed commit cannot be retried
		// against a preview the user has already stopped looking at.
		this._prepared.delete(prepared.token);

		if (Date.now() > held.expiresAt) {
			throw this._fail('timeout', localize(
				'computerUse.error.preparedExpired',
				"This action expired before it was approved. Read the screen again and prepare it again."
			), true);
		}

		// The whole point of two-phase commit: re-verify who is in front, so a window change between
		// the phases fails rather than silently redirecting the action.
		const gateResult = await this.gate(held.method);
		const app = gateResult.app;
		if (app.id.trim().toLowerCase() !== held.app.id.trim().toLowerCase() || app.pid !== held.app.pid) {
			throw this._fail('refStale', localize(
				'computerUse.error.frontmostChanged',
				"The frontmost application changed from {0} to {1} before this action ran. Read the screen again.",
				held.app.name, app.name
			), true);
		}

		const outcome = await this._perform(held.method, held.params as ComputerUseParamsFor<M>, gateResult);
		return outcome.result as ComputerUseResultFor<M>;
	}

	discard(prepared: ComputerUsePreparedAction): void {
		this._prepared.delete(prepared.token);
	}

	/**
	 * Performs an already-gated method.
	 *
	 * Private on purpose: this is the only function that talks to {@link _callChannel} for a gated
	 * method, and it is unreachable without a {@link ComputerUseGateResult} to hand it.
	 */
	private async _perform<M extends ComputerUseMethod>(
		method: M,
		params: ComputerUseParamsFor<M>,
		gateResult: ComputerUseGateResult,
	): Promise<ComputerUseInvocationOutcome<M>> {
		const app = gateResult.app;
		// Before an observation: a snapshot of a still-animating window describes a state that is gone by
		// the time the model reads it, and every ref in it is then suspect.
		let unsettled = await this._settleImplicitly('before', method, params, gateResult);
		const effectiveParams = this._withPhysicalTargets(method, await this._withSelfExclusions(method, params));
		const mutating = isMutatingComputerUseMethod(method);

		if (!mutating) {
			// Raced too, so an Escape during a slow capture takes effect — but without the overlay, which
			// would flicker on every read of the read-then-act loop.
			const result = await this._raceCancellation(this._callChannel(method, effectiveParams));
			this._rememberCaptureSpace(method, result);
			this._rememberAxBaseline(method, result);
			return { result, unsettled };
		}

		this._beginActing(app, method, effectiveParams);
		try {
			const result = await this._raceCancellation(this._callChannel(method, effectiveParams));
			// Anything dispatched invalidates every quiescence claim: the settle that follows is what
			// re-establishes one, and until it does no observation may skip its own wait.
			this._settledAtByPid.clear();
			// After an action, so the *next* observation sees a finished transition. The overlay is still
			// up here on purpose — the action is not over until the UI stops moving, and Escape has to
			// remain clickable for the whole of it.
			unsettled = await this._settleImplicitly('after', method, params, gateResult) ?? unsettled;
			return { result, unsettled };
		} finally {
			this._endActing();
		}
	}

	/**
	 * Runs the implicit settle for a method, if it has one.
	 *
	 * Deliberately **not** a parameter the model can turn off. The failure this exists to fix — acting on
	 * or observing a window mid-transition — is only fixed if the wait happens without being asked for;
	 * see `COMPUTER_USE_SETTLE_AFTER_METHODS`, which is a contract rather than a hint.
	 *
	 * Three properties make it affordable to have on by default:
	 *
	 * - **Cheap.** Skipped outright for a process already known quiescent, so one action costs one
	 *   settle rather than one before every read and another after every action. The helper's own quiet
	 *   period is ~120 ms, so even an unskipped settle on an idle application is a fraction of the
	 *   accessibility walk that follows it.
	 * - **Cancellable.** It goes through {@link _raceCancellation} like everything else, so Escape
	 *   during the wait rejects the whole operation instead of being queued behind it.
	 * - **Never fatal.** A helper that cannot settle degrades to the pre-settle behaviour rather than
	 *   failing the read. The one exception is cancellation, which must propagate.
	 *
	 * Returns the result only when it did not settle, because that is the only case with anything to
	 * report.
	 */
	private async _settleImplicitly<M extends ComputerUseMethod>(
		phase: 'before' | 'after',
		method: M,
		params: ComputerUseParamsFor<M>,
		gateResult: ComputerUseGateResult,
	): Promise<ComputerUseSettleResult | undefined> {
		const applicable = phase === 'before' ? COMPUTER_USE_SETTLE_BEFORE_METHODS : COMPUTER_USE_SETTLE_AFTER_METHODS;
		if (!applicable.includes(method)) {
			return undefined;
		}
		// Only ever the application that just passed the gate. A caller reading some other process by pid
		// gets no implicit wait rather than a wait on a process whose tier was never checked.
		const pid = gateResult.app.pid;
		const named = (params as { readonly pid?: number } | undefined)?.pid;
		if (named !== undefined && named !== pid) {
			return undefined;
		}
		if (this._isKnownQuiescent(pid)) {
			return undefined;
		}
		// No separate check for the wait itself. It runs against the same frontmost application the
		// enclosing gate already cleared, and `settle` observes rather than acts — it waits for the tree to
		// stop changing and returns. There is nothing here a caller could reach that the gate would refuse.

		let result: ComputerUseSettleResult;
		try {
			result = await this._raceCancellation(this._callChannel('settle', { pid }));
		} catch (error: unknown) {
			if (isComputerUseFailure(error) && error.computerUseError.code === 'cancelled') {
				throw error;
			}
			// A helper too old to settle, an application with no accessibility notifications, a transient
			// internal failure: all of them mean "no wait happened", which is exactly how this behaved
			// before settling existed.
			this.logService.trace(`[v3code-computer-use] implicit settle (${phase} '${method}') skipped: ${this._describe(error)}`);
			return undefined;
		}

		this._noteSettled(pid, result);
		return result.settled ? undefined : result;
	}

	/** Records a settle outcome, so a successful one can be reused until it expires or something acts. */
	private _noteSettled(pid: number, result: ComputerUseSettleResult): void {
		if (result.settled) {
			this._settledAtByPid.set(pid, Date.now());
			return;
		}
		this._settledAtByPid.delete(pid);
		this.logService.trace(`[v3code-computer-use] pid ${pid} did not settle after ${result.waitedMs}ms (${result.reason})`);
	}

	/** Whether a still-believable quiescence claim is held for a process. */
	private _isKnownQuiescent(pid: number): boolean {
		const settledAt = this._settledAtByPid.get(pid);
		if (settledAt === undefined) {
			return false;
		}
		if (Date.now() - settledAt < COMPUTER_USE_SETTLED_CLAIM_TTL_MS) {
			return true;
		}
		this._settledAtByPid.delete(pid);
		return false;
	}

	/**
	 * Rewrites a `point` target from image pixels into physical screen pixels.
	 *
	 * The model only ever sees a downscaled screenshot, so the coordinates it replies with are in that
	 * image's space. The helper interprets `point` as a global physical coordinate and cannot convert
	 * for us — it has no idea which capture the model was looking at. Skipping this makes every point
	 * click land short by the downscale factor (roughly a third of the way across on a Retina display
	 * captured to a 1080 long edge), which reads as "the agent clicks the wrong thing" rather than as a
	 * unit error.
	 *
	 * `ref` targets are untouched: they are resolved by the helper and carry no coordinates.
	 */
	private _withPhysicalTargets<M extends ComputerUseMethod>(
		method: M,
		params: ComputerUseParamsFor<M>,
	): ComputerUseParamsFor<M> {
		const space = this._lastCaptureSpace;
		const withTarget = params as { target?: ComputerUseTarget } | undefined;
		const target = withTarget?.target;
		if (!target || target.kind !== 'point') {
			return params;
		}
		if (!space) {
			// No capture has been served yet, so there is no image space to convert from. Passing the
			// value through unchanged would silently mis-click; refusing says what to do instead.
			throw this._fail('targetNotFound', localize(
				'computerUse.error.pointWithoutCapture',
				"Coordinates can only be used after taking a screenshot, because they are relative to it. Take a screenshot first, or act on an element reference instead."
			), false);
		}
		const physical = clampToDisplay(imagePointToPhysical({ x: target.x, y: target.y }, space), space);
		return {
			...(params as object),
			target: { kind: 'point', x: Math.round(physical.x), y: Math.round(physical.y) },
		} as ComputerUseParamsFor<M>;
	}

	/**
	 * Records the coordinate space of a capture so later point targets can be converted.
	 *
	 * Derived from the display bounds the helper reports rather than from the scale alone, because the
	 * display's origin on the virtual desktop is what makes a point on a secondary monitor resolve to
	 * that monitor instead of the primary one.
	 */
	private _rememberCaptureSpace<M extends ComputerUseMethod>(method: M, result: ComputerUseResultFor<M>): void {
		if (method !== 'capture') {
			return;
		}
		const capture = result as ComputerUseCaptureResult;
		if (!capture?.display) {
			return;
		}
		this._lastCaptureSpace = createCoordinateSpace(
			{ width: capture.width, height: capture.height },
			{ displayId: capture.display.displayId, bounds: capture.display.bounds },
		);
	}

	/**
	 * Caches an accessibility read as the baseline for the next incremental one.
	 *
	 * Pruning happens **here**, on the way in, and never on the way out. Both sides of a diff have to
	 * have been through the identical transformation: a node pruned on one side and kept on the other
	 * reads as an insertion, which is the one thing a diff must never invent.
	 *
	 * Keyed on the process id the *helper* reported rather than the one the caller asked for, because a
	 * request that omits `pid` means "whatever is frontmost" and only the answer knows what that was.
	 */
	private _rememberAxBaseline<M extends ComputerUseMethod>(method: M, result: ComputerUseResultFor<M>): void {
		if (method !== 'axTree' && method !== 'axTreeDiff') {
			return;
		}
		const tree = result as ComputerUseAxTreeResult & { readonly unchanged?: boolean };
		if (!tree?.app) {
			return;
		}
		const pid = tree.app.pid;
		const previous = this._axBaselines.get(pid);
		// Deleting before setting is what makes the map least-recently-read-ordered, which is what the
		// eviction below depends on.
		this._axBaselines.delete(pid);

		if (tree.unchanged === true && tree.nodes.length === 0) {
			// `unchanged` is answered without walking anything, so there are no nodes to store — and the
			// ones already held are still current, because that is precisely what it means. Only the
			// generation moves forward. Dropping the baseline here would force a full read on the next
			// call, turning the cheapest possible answer into the most expensive one.
			if (previous && previous.appId === tree.app.id) {
				this._axBaselines.set(pid, { ...previous, generation: tree.generation });
			}
			return;
		}

		this._axBaselines.set(pid, {
			appId: tree.app.id,
			generation: tree.generation,
			nodes: pruneAxTree(tree.nodes),
		});
		while (this._axBaselines.size > COMPUTER_USE_MAX_AX_BASELINES) {
			const oldest = this._axBaselines.keys().next();
			if (oldest.done) {
				return;
			}
			this._axBaselines.delete(oldest.value);
		}
	}

	/**
	 * Merges V3Code's own process ids into a capture request.
	 *
	 * Unconditional: a caller cannot opt out, because a screenshot containing V3Code's own window
	 * feeds the agent its own output and produces feedback loops that look like the model has lost
	 * its mind.
	 */
	private async _withSelfExclusions<M extends ComputerUseMethod>(
		method: M,
		params: ComputerUseParamsFor<M>,
	): Promise<ComputerUseParamsFor<M>> {
		if (method !== 'capture') {
			return params;
		}
		const captureParams = (params ?? {}) as ComputerUseCaptureParams;
		const selfPids = await this._resolveSelfPids();
		const merged: ComputerUseCaptureParams = {
			...captureParams,
			excludePids: Array.from(new Set([...(captureParams.excludePids ?? []), ...selfPids])),
		};
		return merged as unknown as ComputerUseParamsFor<M>;
	}

	/**
	 * Resolves V3Code's process ids by asking the helper which running applications classify as `self`.
	 *
	 * Derived from `listApps` rather than read from the environment so this module stays in the
	 * `browser` layer, and so it picks up every V3Code process the OS actually attributes windows to.
	 */
	private _resolveSelfPids(): Promise<readonly number[]> {
		if (!this._selfPids) {
			this._selfPids = this._callChannel('listApps', undefined)
				.then(apps => apps.filter(isSelfApp).map(candidate => candidate.pid))
				.catch(() => []);
		}
		return this._selfPids;
	}

	/** A localized, concrete description of what committing an action would do. */
	private _previewOf<M extends ComputerUseMethod>(
		method: M,
		params: ComputerUseParamsFor<M>,
		app: ComputerUseFrontmostApp,
	): string {
		switch (method) {
			case 'click': {
				return localize('computerUse.preview.click', "Click in {0}", app.name);
			}
			case 'type': {
				const text = (params as { readonly text?: string } | undefined)?.text ?? '';
				const shown = text.length > 80 ? `${text.slice(0, 80)}…` : text;
				return localize('computerUse.preview.type', "Type \"{0}\" in {1}", shown, app.name);
			}
			case 'key': {
				const chord = (params as { readonly chord?: string } | undefined)?.chord ?? '';
				return localize('computerUse.preview.key', "Press {0} in {1}", chord, app.name);
			}
			case 'scroll': {
				return localize('computerUse.preview.scroll', "Scroll in {0}", app.name);
			}
			default: {
				return localize('computerUse.preview.generic', "Run '{0}' in {1}", method, app.name);
			}
		}
	}

	// -----------------------------------------------------------------------------------------
	// Cancellation and the overlay
	// -----------------------------------------------------------------------------------------

	async cancel(): Promise<void> {
		// Drop anything awaiting approval first: a cancel must not leave a committable token behind.
		this._prepared.clear();
		// A cancelled action stopped somewhere unknown, and a cancelled walk may have left the helper's
		// ref generation bumped, so neither "this application is quiescent" nor "this is what its tree
		// looked like" is still a claim we can make. The next read pays for a full tree, which is the
		// correct price for not knowing.
		this._settledAtByPid.clear();
		this._axBaselines.clear();
		// Reject in-flight work synchronously. Waiting for the helper's own acknowledgement first would
		// make Escape a request to stop soon rather than a stop.
		this._onDidCancel.fire();
		if (this._tripped) {
			return;
		}
		try {
			await this.channel.call<ComputerUseResponse<'cancel'>>('cancel', {});
		} catch (error: unknown) {
			// Best effort. The caller has already been unblocked; a failure to tell the helper is worth
			// a log line and nothing more.
			this.logService.warn(`[v3code-computer-use] cancel could not be delivered to the helper: ${this._describe(error)}`);
		}
	}

	/** Rejects as soon as {@link cancel} is called, whatever the underlying work is doing. */
	private async _raceCancellation<T>(work: Promise<T>): Promise<T> {
		const store = new DisposableStore();
		try {
			const cancelled = new Promise<never>((_resolve, reject) => {
				store.add(this._onDidCancel.event(() => reject(this._fail('cancelled', localize(
					'computerUse.error.cancelled',
					"Cancelled before the action completed."
				), false))));
			});
			return await Promise.race([work, cancelled]);
		} finally {
			store.dispose();
		}
	}

	private _beginActing<M extends ComputerUseMethod>(
		app: ComputerUseFrontmostApp,
		method: M,
		params: ComputerUseParamsFor<M>,
	): void {
		this._actingCount++;
		if (!this._overlay.value) {
			const overlay = this.instantiationService.createInstance(ComputerUseCancelOverlay);
			this._register(overlay.onDidRequestCancel(() => void this.cancel()));
			this._overlay.value = overlay;
		}
		this._overlay.value.show({ appName: app.name, detail: this._previewOf(method, params, app) });
		if (this._actingCount === 1) {
			this._onDidChangeActing.fire(true);
		}
	}

	private _endActing(): void {
		this._actingCount = Math.max(0, this._actingCount - 1);
		if (this._actingCount === 0) {
			this._overlay.value?.hide();
			this._onDidChangeActing.fire(false);
		}
	}

	// -----------------------------------------------------------------------------------------
	// Channel plumbing
	// -----------------------------------------------------------------------------------------

	/**
	 * Sends one request and unwraps the {@link ComputerUseResponse} envelope.
	 *
	 * An IPC-level rejection means the channel or the helper process is broken rather than the request
	 * being refused, so it trips the session; a well-formed error response does not.
	 */
	private async _callChannel<M extends ComputerUseMethod>(
		method: M,
		params: ComputerUseParamsFor<M>,
	): Promise<ComputerUseResultFor<M>> {
		if (this._tripped) {
			throw this._fail('helperMissing', localize(
				'computerUse.error.tripped',
				"Computer use is disabled for this session because the helper failed. Reload the window after fixing the install in ~/.v3code/bin."
			), false);
		}
		let response: ComputerUseResponse<M>;
		try {
			// Params are NESTED under an argument envelope, not spread — the channel carries
			// `helperBinaryPath` alongside them. Passing `params` bare type-checks (IChannel.call is
			// loosely typed) but silently delivers undefined params for every method.
			response = await this.channel.call<ComputerUseResponse<M>>(method, { params });
		} catch (error: unknown) {
			this._trip(`'${method}' failed at the channel: ${this._describe(error)}`);
			throw this._fail('internal', localize(
				'computerUse.error.channelFailed',
				"The computer-use helper could not be reached. See the V3Code log for details."
			), false);
		}
		if (!isComputerUseSuccess(response)) {
			throw new ComputerUseFailure(response.error);
		}
		return response.result;
	}

	/**
	 * Disables the feature for the rest of the session and logs, once, what to do about it.
	 *
	 * Modelled on the beast sidecar's kill switch: one actionable line beats a stream of identical
	 * failures on every subsequent tool call.
	 */
	private _trip(reason: string): void {
		if (this._tripped) {
			return;
		}
		this._tripped = true;
		this._helperOk = false;
		this._helperProbe = undefined;
		this._selfPids = undefined;
		this._prepared.clear();
		this._settledAtByPid.clear();
		this._axBaselines.clear();
		this.logService.error(`[v3code-computer-use] disabled for this session — ${reason}. Verify the helper in ~/.v3code/bin and reload the window.`);
		void this._refreshAvailability();
	}

	/** Builds a {@link ComputerUseFailure} for a refusal raised by the gate rather than by the helper. */
	private _fail(code: ComputerUseErrorCode, message: string, retryable?: boolean): ComputerUseFailure {
		return new ComputerUseFailure(createComputerUseError(code, message, retryable));
	}

	private _describe(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

registerSingleton(IComputerUseService, ComputerUseService, InstantiationType.Delayed);
