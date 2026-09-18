/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Ambient observation: the tier where V3Code samples an application on a timer rather than because a
 * tool call asked it to.
 *
 * This is the most privacy-sensitive code in the feature, and it is arranged so that **every bug fails
 * towards not capturing**. Five structural properties carry that claim, and a reviewer should be able
 * to verify each one by reading this file:
 *
 * 1. **There is exactly one function that can produce permission, and one type that carries it.**
 *    {@link ComputerUseObservationService._authorize} is the only place that constructs an
 *    {@link ObservationAuthorization}, and that class is not exported, so no other module — and no
 *    other method here — can fabricate one. Every function that touches the helper takes an
 *    authorization as a parameter. "Is capture reachable before opt-in?" is therefore answerable by
 *    the compiler rather than by reading call graphs: nothing can call the sampling path without an
 *    object only the gate can mint.
 * 2. **Four independent things must all be true.** The `enableComputerUseObservation` setting, the
 *    ambient-observation consent dialog (which is *not* the computer-use one), a recorded opt-in in
 *    the policy, and a live per-application rule. Any one of them absent denies. `undefined` reads as
 *    off at every one of them.
 * 3. **Permission is re-checked at every await boundary, and again at the write.** A grant revoked
 *    while a sample is in flight loses: {@link ComputerUseObservationService._sampleOnce} re-authorizes
 *    before it reads anything, and {@link IComputerUseObservationStore.appendSample} re-runs the policy
 *    decision at the moment of persistence.
 * 4. **A hard stop is synchronous and retroactive.** {@link ComputerUseObservationService.hardStop}
 *    bumps a retention epoch *before* it awaits anything. Every in-flight sample compares its own epoch
 *    after each await and throws away everything it is holding — including a raster frame that has
 *    already come back over the pipe — rather than persisting it.
 * 5. **Only the frontmost application is ever read.** A session for Figma samples nothing while Mail is
 *    in front. The helper is happy to walk a background process, but the frontmost-app gate in
 *    `computerUseService` is keyed on what is in front, so reading a background pid would be capture
 *    that never passed a gate. Skipping instead is both safer and a better privacy story.
 *
 * What is *not* here: any storage of its own. Samples go to
 * `browser/computerUseObservationStore.ts`, and summaries go to V3Code's existing memory service via
 * {@link IComputerUseObservationMemorySink}. Raster frames go nowhere at all — they are looked at to
 * produce a one-line summary and released with the stack frame that received them.
 */

import { disposableTimeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { IMemoryService, MemoryFactTarget, UpsertFactInput } from '../../void/browser/memoryService.js';
import { IVoidSettingsService } from '../../void/common/voidSettingsService.js';
import { countAxNodes, pruneAxTree } from '../common/computerUseAxDiff.js';
import {
	COMPUTER_USE_OBSERVATION_MAX_GRANT_MS,
	ComputerUseObservableAppId,
	ComputerUseObservationClearScope,
	ComputerUseObservationRefusal,
	asObservableAppId,
	describeObservationRefusal,
} from '../common/computerUseObservation.js';
import {
	ComputerUseApp,
	ComputerUseAxNode,
	ComputerUseMethod,
	ComputerUseParamsFor,
	ComputerUseResultFor,
} from '../common/computerUseTypes.js';
import { IComputerUseService } from './computerUseService.js';
import {
	ComputerUseObservationIndicator,
	ComputerUseObservationIndicatorState,
} from './computerUseObservationIndicator.js';
import {
	ComputerUseObservationSample,
	IComputerUseObservationStore,
} from './computerUseObservationStore.js';

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/**
 * The global setting that arms ambient observation.
 *
 * Deliberately *not* `enableComputerUse`. Consent to let an agent drive the machine on request is not
 * consent to have it watch continuously, and one switch for both would mean the narrower capability
 * silently bought the broader one. The setting is added to `voidSettingsTypes.ts` by the integration
 * phase; until then the read resolves to `undefined`, which is off — the correct direction.
 */
export const COMPUTER_USE_OBSERVATION_SETTING_NAME = 'enableComputerUseObservation';

/** Default seconds between samples. Slow on purpose: ambient context, not a video feed. */
export const COMPUTER_USE_OBSERVATION_DEFAULT_INTERVAL_MS = 15_000;

/**
 * Floor on the sampling interval.
 *
 * A caller asking for 100 ms is asking for a screen recorder, and the honest answer is to refuse the
 * rate rather than to grant it and hope retention saves us.
 */
export const COMPUTER_USE_OBSERVATION_MIN_INTERVAL_MS = 2_000;

/** Ceiling on the sampling interval, so a session cannot be started and then effectively never sample. */
export const COMPUTER_USE_OBSERVATION_MAX_INTERVAL_MS = 10 * 60 * 1000;

/** Default lifetime of a per-application grant when the caller does not specify one. */
export const COMPUTER_USE_OBSERVATION_DEFAULT_GRANT_MS = 30 * 60 * 1000;

/** Default suspension length for the indicator's Pause button. */
export const COMPUTER_USE_OBSERVATION_DEFAULT_PAUSE_MS = 15 * 60 * 1000;

/** How often the helper's reported sessions are reconciled against the policy. */
export const COMPUTER_USE_OBSERVATION_RECONCILE_INTERVAL_MS = 60_000;

/** Screenshot long-edge budget for observation frames. Smaller than an interactive capture: nothing clicks on these. */
export const COMPUTER_USE_OBSERVATION_MAX_LONG_EDGE = 768;

/** Consecutive sampling failures after which a session gives up rather than retrying forever. */
export const COMPUTER_USE_OBSERVATION_MAX_CONSECUTIVE_ERRORS = 3;

/**
 * `meta.origin` stamped on every memory fact this service writes.
 *
 * Present so observation-derived facts are distinguishable from facts the user or the agent asserted.
 * A fact that came from watching the screen should be weighted — and revocable — differently from one
 * somebody actually said.
 */
export const COMPUTER_USE_OBSERVATION_MEMORY_ORIGIN = 'computerUse.observation';

/** Longest window title or element label folded into a summary line. */
const SUMMARY_FIELD_MAX_LENGTH = 60;

// ---------------------------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------------------------

/**
 * The narrow slice of `IComputerUseService` ambient observation is permitted to use.
 *
 * Narrow on two counts. It keeps the core logic testable with no workbench, and it makes visible that
 * observation has no channel of its own: every helper call it makes goes through the one gated
 * `invoke`, so the frontmost-app tier check in `computerUseService.ts` still runs for each sample.
 */
export interface IComputerUseObservationHost {
	/** True when the helper is installed, consented to, and enabled. */
	readonly isAvailable: boolean;
	/** The single gated entry point to the helper. */
	invoke<M extends ComputerUseMethod>(method: M, params: ComputerUseParamsFor<M>): Promise<ComputerUseResultFor<M>>;
}

export const IComputerUseObservationConsentService = createDecorator<IComputerUseObservationConsentService>('computerUseObservationConsentService');

/**
 * The second consent gate — the one that covers being watched, not being driven.
 *
 * **The decorator is declared here, in `browser`, while the implementation and its `registerSingleton`
 * live in `electron-browser/computerUseObservationConsent.ts`**, because the dialog needs a real modal
 * and `browser` may not import `electron-browser`. That split is exactly the arrangement that has bitten
 * this branch once already: the registration side only runs if the implementation module is pulled into
 * the bundle. The integration phase MUST add `import './computerUseObservationConsent.js';` to
 * `electron-browser/computerUse.contribution.ts` or the first injection of this service throws "no
 * service" at runtime despite type-checking perfectly.
 */
export interface IComputerUseObservationConsentService {
	readonly _serviceBrand: undefined;

	/** Fires whenever {@link hasAccepted} would answer differently. */
	readonly onDidChangeConsent: Event<boolean>;

	/** True when the current ambient-observation consent version has been accepted. Synchronous. */
	hasAccepted(): boolean;

	/** Resolves true once consent exists, prompting if it does not. Concurrent callers share one dialog. */
	ensureAccepted(): Promise<boolean>;

	/** Drops the stored acceptance. The observation service treats this as a full withdrawal. */
	revoke(): void;
}

/**
 * Where observation summaries are durably kept.
 *
 * Shaped to fit `IMemoryService.upsertFact` exactly, because that is the service used — V3Code's
 * existing three-layer memory store, the same one `remember` writes to. No new store is introduced by
 * this tier.
 */
export interface IComputerUseObservationMemorySink {
	/** True when the memory store is usable. False means summaries are skipped, not buffered. */
	readonly isAvailable: boolean;
	/** Writes or reinforces one fact. Resolves null when the store declined. */
	upsertFact(fact: UpsertFactInput, target?: MemoryFactTarget): Promise<{ readonly id: string } | null>;
}

/** The logging surface, narrowed so `ILogService` satisfies it structurally. */
export interface IComputerUseObservationLog {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/**
 * Time and timers, injected.
 *
 * Every clock reading and every delay in this service goes through here, so the tests exercise the
 * retention and expiry boundaries exactly rather than approximately.
 */
export interface IComputerUseObservationClock {
	now(): number;
	/** Schedules `callback` once. Disposing the result must guarantee the callback never runs. */
	schedule(callback: () => void, delayMs: number): IDisposable;
}

/** The real clock. */
export const computerUseObservationSystemClock: IComputerUseObservationClock = {
	now: () => Date.now(),
	schedule: (callback, delayMs) => disposableTimeout(callback, delayMs),
};

/** The always-visible indicator, as the service uses it. */
export interface IComputerUseObservationIndicatorSurface extends IDisposable {
	readonly onDidRequestStop: Event<void>;
	readonly onDidRequestPause: Event<void>;
	show(state: ComputerUseObservationIndicatorState): void;
	hide(): void;
}

/** Everything {@link ComputerUseObservationService} needs, with no decorators, so tests can supply it. */
export interface ComputerUseObservationDependencies {
	readonly store: IComputerUseObservationStore;
	readonly host: IComputerUseObservationHost;
	readonly consent: IComputerUseObservationConsentService;
	/** Undefined in an environment with no memory store; summarization is then skipped. */
	readonly memory: IComputerUseObservationMemorySink | undefined;
	/** Reads {@link COMPUTER_USE_OBSERVATION_SETTING_NAME}. Must answer false for `undefined`. */
	readonly isSettingEnabled: () => boolean;
	/** Fires when the setting may have changed. */
	readonly onDidChangeSetting: Event<void>;
	readonly clock: IComputerUseObservationClock;
	readonly log: IComputerUseObservationLog;
	/** Asks the user to approve one application for observation. Resolves false when declined. */
	readonly confirmApplication: (
		app: ComputerUseApp,
		mode: 'axTree' | 'axTreeAndScreenshots',
		durationMs: number,
	) => Promise<boolean>;
	/** Creates the indicator. Undefined in a headless environment, which then has no banner. */
	readonly createIndicator: (() => IComputerUseObservationIndicatorSurface) | undefined;
}

// ---------------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------------

/** One live observation session, as the service reports it. */
export interface ComputerUseObservationSession {
	readonly app: ComputerUseApp;
	readonly mode: 'axTree' | 'axTreeAndScreenshots';
	readonly startedAt: number;
	/** Epoch milliseconds at which the session stops itself, from the authorizing decision. */
	readonly permittedUntil: number;
	readonly intervalMs: number;
	/** Samples actually retained. */
	readonly samples: number;
	/** Ticks that took no sample because the application was not in front. */
	readonly skipped: number;
}

/**
 * Why a start was refused.
 *
 * The policy engine's own refusals pass through unchanged, so the reason a user sees is the reason the
 * engine gave rather than a re-derived guess.
 */
export type ComputerUseObservationBlock =
	/** {@link COMPUTER_USE_OBSERVATION_SETTING_NAME} is off or absent. */
	| 'settingDisabled'
	/** The ambient-observation consent dialog has not been accepted. */
	| 'consentMissing'
	/** The computer-use helper is not available at all. */
	| 'helperUnavailable'
	/** A session for this application is already running. */
	| 'alreadyObserving'
	/** The helper refused the request, or did not report the session back. */
	| 'helperRefused'
	/** The requested sampling interval is outside the permitted band. */
	| 'intervalOutOfRange'
	| ComputerUseObservationRefusal;

/** The outcome of {@link IComputerUseObservationService.start}. */
export type ComputerUseObservationStartOutcome =
	| { readonly started: true; readonly session: ComputerUseObservationSession }
	| { readonly started: false; readonly blocked: ComputerUseObservationBlock };

/** A localized explanation of a start refusal, for a notification or a tool result. */
export function describeObservationBlock(blocked: ComputerUseObservationBlock): string {
	switch (blocked) {
		case 'settingDisabled':
			return localize(
				'computerUse.observation.block.setting',
				"Ambient observation is turned off. Enable it in V3Code settings; it is separate from computer use and off by default."
			);
		case 'consentMissing':
			return localize(
				'computerUse.observation.block.consent',
				"Ambient observation needs its own one-time permission, which has not been given."
			);
		case 'helperUnavailable':
			return localize(
				'computerUse.observation.block.helper',
				"The computer-use helper is not available, so nothing can be observed."
			);
		case 'alreadyObserving':
			return localize('computerUse.observation.block.already', "This application is already being observed.");
		case 'helperRefused':
			return localize(
				'computerUse.observation.block.helperRefused',
				"The computer-use helper did not start observing, so nothing is being recorded."
			);
		case 'intervalOutOfRange':
			return localize(
				'computerUse.observation.block.interval',
				"That sampling interval is not permitted. Ambient observation samples slowly by design."
			);
		default:
			// The policy engine owns this wording; localizing at the call site is exactly what its own
			// documentation asks for, since it deliberately does not depend on `vs/nls`.
			return describeObservationRefusal(blocked);
	}
}

export const IComputerUseObservationService = createDecorator<IComputerUseObservationService>('computerUseObservationService');

/** Starts, supervises, and stops ambient observation, and folds what it sees into durable memory. */
export interface IComputerUseObservationService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the set of running sessions, or their sample counts, change. */
	readonly onDidChangeSessions: Event<void>;

	/** Fires when {@link isAvailable} would answer differently. */
	readonly onDidChangeAvailability: Event<boolean>;

	/** True when {@link COMPUTER_USE_OBSERVATION_SETTING_NAME} is explicitly on. */
	readonly isSettingEnabled: boolean;

	/** True when the ambient-observation opt-in is recorded at the current version. */
	readonly isOptedIn: boolean;

	/**
	 * True when observation *could* be started for some application: setting on, consent accepted,
	 * opt-in recorded, master switch on, retention window usable, helper available.
	 *
	 * Says nothing about any particular application — a rule is still required.
	 */
	readonly isAvailable: boolean;

	/** True while at least one session is running. */
	readonly isObserving: boolean;

	/** True while the policy suspends observation. */
	readonly isPaused: boolean;

	readonly sessions: readonly ComputerUseObservationSession[];

	/**
	 * Prompts for the ambient-observation consent and records the opt-in on acceptance.
	 *
	 * Both halves are required and both are checked later: the consent key and the policy's
	 * `optInVersion`. Resolves false when declined, having recorded nothing.
	 */
	requestOptIn(): Promise<boolean>;

	/** Withdraws the opt-in, stops everything, and deletes the retained history. */
	revokeOptIn(): Promise<void>;

	/**
	 * Asks the user to approve one application, and stores the resulting rule.
	 *
	 * Refuses outright for V3Code itself, without prompting: there is no answer the user could give
	 * that would make self-observation permitted.
	 */
	requestApplication(
		app: ComputerUseApp,
		mode: 'axTree' | 'axTreeAndScreenshots',
		durationMs?: number,
	): Promise<boolean>;

	/** Removes an application's rule and stops any session for it. */
	revokeApplication(appId: string): Promise<void>;

	/** Gates, starts the helper session, and begins sampling. Never throws; refusals are returned. */
	start(app: ComputerUseApp, options?: { readonly intervalMs?: number }): Promise<ComputerUseObservationStartOutcome>;

	/** Stops one session and summarizes what it collected. */
	stop(appId: string): Promise<void>;

	/**
	 * Stops everything immediately and guarantees nothing in flight is retained.
	 *
	 * Synchronous in its effect: the retention epoch is bumped before the first await, so any sample
	 * already holding a frame discards it instead of persisting it.
	 */
	hardStop(reason: string): Promise<void>;

	/** Suspends observation for a while, stopping every session. Grants are untouched. */
	pause(durationMs?: number): Promise<void>;

	/** Lifts a suspension. Does not restart sessions — restarting is always explicit. */
	resume(): Promise<void>;

	/**
	 * Compares the helper's live sessions against the policy and stops anything not permitted.
	 *
	 * The backstop for a lost `observeStop`: a revoked grant takes effect here even if the revocation's
	 * own stop never reached the helper.
	 */
	reconcile(): Promise<void>;

	/** The retained history, newest first, pruned to the retention window. */
	listHistory(): readonly ComputerUseObservationSample[];

	/** Deletes history by application, by time range, or entirely. Returns how many records went. */
	clearHistory(scope: ComputerUseObservationClearScope): Promise<number>;

	/** Folds not-yet-summarized samples into memory facts. Returns how many facts were written. */
	summarizeIntoMemory(): Promise<number>;
}

// ---------------------------------------------------------------------------------------------
// Internal permission token
// ---------------------------------------------------------------------------------------------

/**
 * Proof that every ambient-observation gate passed.
 *
 * **Not exported, and constructed in exactly one place.** That is the whole mechanism behind "no
 * capture path is reachable before opt-in": every function below that reads anything from the machine
 * requires one of these as a parameter, and the only expression in the program that can produce one is
 * inside {@link ComputerUseObservationService._authorize}. A future contributor who adds a new sampling
 * path cannot forget the gate, because there is no way to obtain the argument without passing it.
 */
class ObservationAuthorization {
	constructor(
		/** The application, as the OS reported it at authorization time. */
		readonly app: ComputerUseApp,
		/** Canonical identifier, proven not to be V3Code by the branded type. */
		readonly appId: ComputerUseObservableAppId,
		readonly mode: 'axTree' | 'axTreeAndScreenshots',
		/** Epoch milliseconds at which permission lapses. */
		readonly permittedUntil: number,
		/** Epoch milliseconds before which samples must already have been discarded. */
		readonly discardBefore: number,
		/** Retention epoch this authorization belongs to; a hard stop invalidates it. */
		readonly epoch: number,
	) { }
}

/**
 * Thrown to unwind a sample that must not complete.
 *
 * A distinct type so the catch site can tell "we deliberately abandoned this" from "the helper broke",
 * and log accordingly. Not exported: nothing outside this module can be in a position to raise it.
 */
class ObservationAborted extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'ObservationAborted';
	}
}

/** Mutable per-session bookkeeping. */
class ObservationSessionRecord {

	/** The next scheduled sample, or undefined between a fire and its reschedule. */
	timer: IDisposable | undefined;

	samples = 0;
	skipped = 0;
	consecutiveErrors = 0;

	constructor(
		readonly app: ComputerUseApp,
		readonly appId: ComputerUseObservableAppId,
		readonly mode: 'axTree' | 'axTreeAndScreenshots',
		readonly startedAt: number,
		readonly permittedUntil: number,
		readonly intervalMs: number,
	) { }

	toSession(): ComputerUseObservationSession {
		return {
			app: this.app,
			mode: this.mode,
			startedAt: this.startedAt,
			permittedUntil: this.permittedUntil,
			intervalMs: this.intervalMs,
			samples: this.samples,
			skipped: this.skipped,
		};
	}

	dispose(): void {
		this.timer?.dispose();
		this.timer = undefined;
	}
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

/** @inheritdoc */
export class ComputerUseObservationService extends Disposable implements IComputerUseObservationService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	readonly onDidChangeSessions: Event<void> = this._onDidChangeSessions.event;

	private readonly _onDidChangeAvailability = this._register(new Emitter<boolean>());
	readonly onDidChangeAvailability: Event<boolean> = this._onDidChangeAvailability.event;

	/** Live sessions, keyed by canonical application id. */
	private readonly _sessions = new Map<string, ObservationSessionRecord>();

	/**
	 * Monotonic retention epoch.
	 *
	 * Incremented by {@link hardStop} before it awaits anything. Every authorization carries the epoch
	 * it was minted in, and the sampling path compares it after each await, so a stop that arrives while
	 * a frame is in flight causes that frame to be dropped rather than stored. A boolean flag would not
	 * do: observation can legitimately be stopped and started again, and a second start must not
	 * resurrect the first stop's in-flight work.
	 */
	private _retentionEpoch = 1;

	private readonly _indicator = this._register(new MutableDisposable<IComputerUseObservationIndicatorSurface>());

	/** The recurring reconciliation timer, live only while something is being observed. */
	private readonly _reconcileTimer = this._register(new MutableDisposable<IDisposable>());

	private _lastAvailability: boolean | undefined;

	constructor(private readonly deps: ComputerUseObservationDependencies) {
		super();

		this._register(this.deps.onDidChangeSetting(() => void this._onExternalStateChanged()));
		this._register(this.deps.consent.onDidChangeConsent(() => void this._onConsentChanged()));
		this._register(this.deps.store.onDidChangePolicy(() => void this._onExternalStateChanged()));

		// Retention is a promise about wall-clock time, not about uptime: a window reopened after the
		// window elapsed must not still be holding yesterday's samples.
		this.deps.store.prune(this.deps.clock.now());

		this._register(toDisposable(() => {
			for (const session of this._sessions.values()) {
				session.dispose();
			}
			this._sessions.clear();
		}));

		this._lastAvailability = this.isAvailable;
	}

	// -----------------------------------------------------------------------------------------
	// State
	// -----------------------------------------------------------------------------------------

	get isSettingEnabled(): boolean {
		// Compared to `true` by the provider, never coerced: a setting persisted as the string "false"
		// must not arm continuous screen capture.
		return this.deps.isSettingEnabled() === true;
	}

	get isOptedIn(): boolean {
		return this.deps.store.isOptedIn();
	}

	get isAvailable(): boolean {
		return (
			this.isSettingEnabled &&
			this.deps.consent.hasAccepted() &&
			this.deps.store.isEnabled() &&
			this.deps.store.getRetentionMs() !== undefined &&
			this.deps.host.isAvailable
		);
	}

	get isObserving(): boolean {
		return this._sessions.size > 0;
	}

	get isPaused(): boolean {
		const pausedUntil = this.deps.store.getPolicy().pausedUntil;
		return pausedUntil !== undefined && this.deps.clock.now() < pausedUntil;
	}

	get sessions(): readonly ComputerUseObservationSession[] {
		return [...this._sessions.values()].map(session => session.toSession());
	}

	// -----------------------------------------------------------------------------------------
	// Opt-in and grants
	// -----------------------------------------------------------------------------------------

	async requestOptIn(): Promise<boolean> {
		if (!this.isSettingEnabled) {
			// Refusing to prompt is deliberate. Prompting while the setting is off would let a single
			// dialog appear to turn the feature on, and the user would then not know which of the two
			// switches was actually responsible for capture happening.
			this.deps.log.info('[v3code-computer-use] ambient observation opt-in refused: the setting is off');
			return false;
		}
		if (!(await this.deps.consent.ensureAccepted())) {
			return false;
		}
		this.deps.store.recordOptIn();
		this._announceAvailability();
		return true;
	}

	async revokeOptIn(): Promise<void> {
		this.deps.consent.revoke();
		this.deps.store.revokeOptIn();
		await this.hardStop('the ambient-observation opt-in was withdrawn');
		this._announceAvailability();
	}

	async requestApplication(
		app: ComputerUseApp,
		mode: 'axTree' | 'axTreeAndScreenshots',
		durationMs: number = COMPUTER_USE_OBSERVATION_DEFAULT_GRANT_MS,
	): Promise<boolean> {
		// Checked before the dialog, not after: asking the user whether V3Code may watch itself implies
		// that yes is an available answer.
		const appId = asObservableAppId(app);
		if (appId === undefined) {
			this.deps.log.warn(`[v3code-computer-use] refused an observation grant for '${app.id}' — V3Code never observes itself`);
			return false;
		}
		if (!this.isSettingEnabled || !this.deps.store.isOptedIn()) {
			return false;
		}
		const clamped = Math.min(Math.max(1, Math.round(durationMs)), COMPUTER_USE_OBSERVATION_MAX_GRANT_MS);
		if (!(await this.deps.confirmApplication(app, mode, clamped))) {
			return false;
		}
		const rule = this.deps.store.setRule(app, mode, this.deps.clock.now(), clamped);
		if (rule === undefined) {
			return false;
		}
		this.deps.log.info(`[v3code-computer-use] ambient observation granted for ${app.name} (${rule.appId}) as '${rule.mode}' until ${new Date(rule.expiresAt).toISOString()}`);
		return true;
	}

	async revokeApplication(appId: string): Promise<void> {
		this.deps.store.revokeRule(appId);
		await this.stop(appId);
		// The policy change alone is enough for our own sessions, but the helper may be running one we
		// have lost track of, and a revocation that leaves capture running is the failure this exists to
		// prevent.
		await this.reconcile();
	}

	// -----------------------------------------------------------------------------------------
	// The gate
	// -----------------------------------------------------------------------------------------

	/**
	 * The only source of permission to observe.
	 *
	 * Returns an {@link ObservationAuthorization} or the reason it will not. Every guard denies; there
	 * is one construction of the authorization, at the end, after all of them. The policy engine is
	 * consulted rather than reimplemented, so opt-in version, master switch, pause, retention window,
	 * self-exclusion, and the per-application rule are all decided in one audited place.
	 */
	private _authorize(app: ComputerUseApp): ObservationAuthorization | ComputerUseObservationBlock {
		if (!this.isSettingEnabled) {
			return 'settingDisabled';
		}
		if (!this.deps.consent.hasAccepted()) {
			return 'consentMissing';
		}
		if (!this.deps.host.isAvailable) {
			return 'helperUnavailable';
		}

		const nowMs = this.deps.clock.now();
		const decision = this.deps.store.decide(app, nowMs);
		if (!decision.permitted) {
			return decision.reason;
		}

		// Belt and braces: the decision already refuses V3Code, and this refuses it again while
		// producing the branded id the authorization is required to carry. A self observation is
		// therefore two independent mistakes away rather than one.
		const appId = asObservableAppId(app);
		if (appId === undefined) {
			return 'selfApplication';
		}

		return new ObservationAuthorization(
			app,
			appId,
			decision.mode,
			decision.permittedUntil,
			decision.discardBefore,
			this._retentionEpoch,
		);
	}

	/**
	 * Throws when an authorization has been invalidated by a hard stop.
	 *
	 * Called after every await in the sampling path. Cheap, and the only thing standing between a
	 * stop-while-capturing and a retained frame.
	 */
	private _assertEpoch(authorization: ObservationAuthorization): void {
		if (authorization.epoch !== this._retentionEpoch) {
			throw new ObservationAborted('observation was stopped while a sample was in flight');
		}
	}

	// -----------------------------------------------------------------------------------------
	// Start and stop
	// -----------------------------------------------------------------------------------------

	async start(app: ComputerUseApp, options?: { readonly intervalMs?: number }): Promise<ComputerUseObservationStartOutcome> {
		const requestedInterval = options?.intervalMs ?? COMPUTER_USE_OBSERVATION_DEFAULT_INTERVAL_MS;
		if (
			!Number.isFinite(requestedInterval) ||
			requestedInterval < COMPUTER_USE_OBSERVATION_MIN_INTERVAL_MS ||
			requestedInterval > COMPUTER_USE_OBSERVATION_MAX_INTERVAL_MS
		) {
			return { started: false, blocked: 'intervalOutOfRange' };
		}
		const intervalMs = Math.round(requestedInterval);

		const authorization = this._authorize(app);
		if (!(authorization instanceof ObservationAuthorization)) {
			return { started: false, blocked: authorization };
		}
		if (this._sessions.has(authorization.appId)) {
			return { started: false, blocked: 'alreadyObserving' };
		}

		try {
			const status = await this.deps.host.invoke('observeStart', {
				pid: app.pid,
				appId: authorization.appId,
				intervalMs,
				// The whole safety story for the helper side: the session expires on its own even if
				// V3Code crashes, is force-quit, or loses the pipe.
				stopAtMs: authorization.permittedUntil,
				content: authorization.mode,
				maxLongEdge: COMPUTER_USE_OBSERVATION_MAX_LONG_EDGE,
			});
			// Self-verifying, as the protocol intends: the helper echoes its session list, so we never
			// assume a request took effect. A start we cannot see is treated as a start that did not
			// happen, which leaves us not observing rather than believing we are supervising something.
			if (!status.sessions.some(session => session.pid === app.pid)) {
				this.deps.log.warn(`[v3code-computer-use] helper did not report an observation session for pid ${app.pid} — treating the start as refused`);
				return { started: false, blocked: 'helperRefused' };
			}
		} catch (error: unknown) {
			this.deps.log.warn(`[v3code-computer-use] observeStart failed for ${app.name}: ${this._describe(error)}`);
			return { started: false, blocked: 'helperRefused' };
		}

		// Re-checked after the await. The user may have revoked while the helper was starting, and the
		// correct response is to stop the thing we just started rather than to sample once first.
		const stillAuthorized = this._authorize(app);
		if (!(stillAuthorized instanceof ObservationAuthorization) || stillAuthorized.epoch !== authorization.epoch) {
			await this._stopHelperSession(app.pid);
			return {
				started: false,
				blocked: stillAuthorized instanceof ObservationAuthorization ? 'helperRefused' : stillAuthorized,
			};
		}

		const record = new ObservationSessionRecord(
			app,
			authorization.appId,
			authorization.mode,
			this.deps.clock.now(),
			authorization.permittedUntil,
			intervalMs,
		);
		this._sessions.set(authorization.appId, record);
		this.deps.log.info(`[v3code-computer-use] ambient observation started for ${app.name} (${authorization.appId}) as '${authorization.mode}' every ${intervalMs}ms until ${new Date(authorization.permittedUntil).toISOString()}`);

		this._ensureIndicator();
		this._refreshIndicator();
		this._scheduleSample(record);
		this._scheduleReconcile();
		this._onDidChangeSessions.fire();
		return { started: true, session: record.toSession() };
	}

	async stop(appId: string): Promise<void> {
		const key = appId.trim().toLowerCase();
		const record = this._sessions.get(key);
		if (!record) {
			return;
		}
		record.dispose();
		this._sessions.delete(key);
		this.deps.log.info(`[v3code-computer-use] ambient observation stopped for ${record.app.name} after ${record.samples} samples`);
		await this._stopHelperSession(record.app.pid);
		await this.summarizeIntoMemory();
		this._afterSessionSetChanged();
	}

	async hardStop(reason: string): Promise<void> {
		// FIRST, and synchronously, before any await: everything already in flight is now invalid, and
		// bumping the epoch is what makes that true retroactively rather than eventually.
		this._retentionEpoch++;

		const stopped = [...this._sessions.values()];
		for (const record of stopped) {
			record.dispose();
		}
		this._sessions.clear();
		this._reconcileTimer.clear();
		this._indicator.value?.hide();
		if (stopped.length > 0) {
			this.deps.log.info(`[v3code-computer-use] ambient observation hard-stopped (${stopped.length} session(s)) — ${reason}`);
		}
		this._onDidChangeSessions.fire();

		// Best effort, and after the local teardown: the user's stop must not wait on the helper, and a
		// helper that never hears about it still expires on its own `stopAtMs`.
		await this._stopHelperSession(undefined);
	}

	async pause(durationMs: number = COMPUTER_USE_OBSERVATION_DEFAULT_PAUSE_MS): Promise<void> {
		const clamped = Math.max(1, Math.round(durationMs));
		this.deps.store.pauseUntil(this.deps.clock.now() + clamped);
		// The policy alone would deny the next sample, but "paused" must mean nothing is running now,
		// not that nothing more will be recorded soon.
		await this.hardStop('ambient observation was paused');
	}

	async resume(): Promise<void> {
		this.deps.store.resume();
		// Deliberately does not restart anything. Resuming a suspension is not the same as asking to be
		// watched again, and silently resuming capture on a timer the user has forgotten about is the
		// failure mode this whole tier is written against.
		this._announceAvailability();
	}

	// -----------------------------------------------------------------------------------------
	// Sampling
	// -----------------------------------------------------------------------------------------

	/** Queues the next sample for a session, replacing any pending one. */
	private _scheduleSample(record: ObservationSessionRecord): void {
		record.timer?.dispose();
		const timer = this.deps.clock.schedule(() => {
			// A one-shot timer that has fired still holds a registration; disposing it here is what keeps
			// a long observation session from accumulating one dead disposable per sample.
			timer.dispose();
			if (record.timer === timer) {
				record.timer = undefined;
			}
			void this._sampleOnce(record);
		}, record.intervalMs);
		record.timer = timer;
	}

	/**
	 * Takes one sample, or declines to.
	 *
	 * Structured so that every early exit leaves nothing recorded: authorization is re-derived from the
	 * live policy first, the frontmost application must still be the observed one, and the epoch is
	 * re-checked after every await.
	 */
	private async _sampleOnce(record: ObservationSessionRecord): Promise<void> {
		if (!this._sessions.has(record.appId)) {
			return;
		}

		const authorization = this._authorize(record.app);
		if (!(authorization instanceof ObservationAuthorization)) {
			this.deps.log.info(`[v3code-computer-use] ambient observation for ${record.app.name} stopped: ${describeObservationBlock(authorization)}`);
			await this.stop(record.appId);
			return;
		}
		if (authorization.mode !== record.mode) {
			// The grant narrowed under us — screenshots were withdrawn, say. Restarting under the new
			// mode is the user's call, not ours; the safe move is to stop.
			this.deps.log.info(`[v3code-computer-use] ambient observation for ${record.app.name} stopped: the granted mode changed`);
			await this.stop(record.appId);
			return;
		}

		try {
			const kept = await this._collect(record, authorization);
			record.consecutiveErrors = 0;
			if (kept) {
				record.samples++;
			} else {
				record.skipped++;
			}
			this._refreshIndicator();
			this._onDidChangeSessions.fire();
		} catch (error: unknown) {
			if (error instanceof ObservationAborted) {
				// A hard stop won the race. Nothing was retained, which is the point, and there is
				// nothing left to reschedule.
				this.deps.log.info(`[v3code-computer-use] discarded an in-flight observation sample for ${record.app.name}: ${error.message}`);
				return;
			}
			record.consecutiveErrors++;
			this.deps.log.warn(`[v3code-computer-use] observation sample failed for ${record.app.name} (${record.consecutiveErrors}): ${this._describe(error)}`);
			if (record.consecutiveErrors >= COMPUTER_USE_OBSERVATION_MAX_CONSECUTIVE_ERRORS) {
				this.deps.log.warn(`[v3code-computer-use] giving up on ambient observation for ${record.app.name} after repeated failures`);
				await this.stop(record.appId);
				return;
			}
		}

		// Only reschedule while the session is still live: `stop` and `hardStop` both remove it, and a
		// reschedule after either would resurrect capture the user asked to end.
		if (this._sessions.get(record.appId) === record) {
			this._scheduleSample(record);
		}
	}

	/**
	 * Reads the application once and persists at most one sample. Returns whether one was kept.
	 *
	 * Requires an {@link ObservationAuthorization}: this is the function that touches the machine, and
	 * it cannot be called without the gate having produced permission.
	 */
	private async _collect(record: ObservationSessionRecord, authorization: ObservationAuthorization): Promise<boolean> {
		// Unreachable by construction — an authorization cannot exist unless both of these held a moment
		// ago — and asserted anyway, loudly, because "no capture path is reachable before opt-in" is a
		// claim this file makes and an assertion is the only form of that claim which survives someone
		// refactoring the call graph without reading the comment above it.
		if (!this.deps.consent.hasAccepted() || !this.deps.store.isOptedIn()) {
			throw new ObservationAborted('reached the capture path without a recorded ambient-observation opt-in');
		}

		// Every helper call below goes through the gated `invoke`, so the frontmost-app tier check runs
		// per sample exactly as it does for a tool call.
		const frontmost = await this.deps.host.invoke('frontmostApp', undefined);
		this._assertEpoch(authorization);

		if (frontmost.id.trim().toLowerCase() !== authorization.appId) {
			// The granted application is not in front, so there is nothing here we are allowed to look
			// at. Reading the observed pid anyway would be capture that never passed the frontmost gate,
			// and it would also mean a background application could be watched without ever being
			// visible to the user — the exact shape of the thing this tier must not become.
			return false;
		}

		// Plain `axTree`, deliberately, and not the service's `readAxChanges`: that method owns a single
		// per-pid baseline shared with the interactive tools, and every read replaces it. An observation
		// sampling every fifteen seconds would keep resetting the baseline the model's own read-act-read
		// loop is diffing against, so ambient observation would silently degrade the tier it sits beside.
		// Ambient sampling wants an absolute description anyway; it has no previous turn to diff against.
		const tree = await this.deps.host.invoke('axTree', { pid: authorization.app.pid });
		this._assertEpoch(authorization);

		const pruned = pruneAxTree(tree.nodes);
		const nodeCount = countAxNodes(pruned);
		let usedScreenshot = false;

		if (authorization.mode === 'axTreeAndScreenshots') {
			// The frame is read into a local, summarized, and dropped when this scope ends. Its base64
			// payload is never assigned to a field, never returned, and never handed to the store —
			// `ComputerUseObservationSample` has nowhere to put it. `capture` also always excludes
			// V3Code's own pids, added by the gated service.
			const frame = await this.deps.host.invoke('capture', { maxLongEdge: COMPUTER_USE_OBSERVATION_MAX_LONG_EDGE });
			// After the await, so a hard stop during the capture drops the frame instead of describing it.
			this._assertEpoch(authorization);
			usedScreenshot = frame.width > 0 && frame.height > 0;
		}

		const capturedAt = this.deps.clock.now();
		const sample: ComputerUseObservationSample = {
			appId: authorization.appId,
			appName: authorization.app.name,
			capturedAt,
			mode: authorization.mode,
			summary: summarizeObservation(frontmost.title, pruned, nodeCount),
			nodeCount,
			usedScreenshot,
		};

		// Last gate, and the one that cannot be skipped: the store re-runs the policy decision at the
		// moment of the write.
		this._assertEpoch(authorization);
		const outcome = this.deps.store.appendSample(sample, capturedAt);
		if (!outcome.kept) {
			this.deps.log.info(`[v3code-computer-use] observation sample for ${record.app.name} was not retained: ${outcome.refusal}`);
			return false;
		}
		return true;
	}

	// -----------------------------------------------------------------------------------------
	// Reconciliation
	// -----------------------------------------------------------------------------------------

	/** Keeps a reconciliation timer alive exactly while something is being observed. */
	private _scheduleReconcile(): void {
		if (this._sessions.size === 0) {
			this._reconcileTimer.clear();
			return;
		}
		this._reconcileTimer.value = this.deps.clock.schedule(() => {
			void this.reconcile().finally(() => this._scheduleReconcile());
		}, COMPUTER_USE_OBSERVATION_RECONCILE_INTERVAL_MS);
	}

	async reconcile(): Promise<void> {
		if (!this.isSettingEnabled || !this.deps.consent.hasAccepted() || !this.deps.store.isEnabled()) {
			await this.hardStop('ambient observation is no longer permitted');
			return;
		}
		if (!this.deps.host.isAvailable) {
			// Nothing can be asked of a helper that is not there, and nothing can be sampled either.
			await this.hardStop('the computer-use helper became unavailable');
			return;
		}

		let status: ComputerUseResultFor<'observeStatus'>;
		try {
			status = await this.deps.host.invoke('observeStatus', undefined);
		} catch (error: unknown) {
			// A status we cannot read is a supervision we cannot perform. Stopping is the only answer
			// that does not leave capture running unsupervised.
			this.deps.log.warn(`[v3code-computer-use] observeStatus failed, stopping ambient observation: ${this._describe(error)}`);
			await this.hardStop('the helper stopped reporting what it was observing');
			return;
		}

		const nowMs = this.deps.clock.now();
		for (const helperSession of status.sessions) {
			const key = helperSession.appId.trim().toLowerCase();
			const local = this._sessions.get(key);
			const decision = this.deps.store.decide({ id: helperSession.appId }, nowMs);
			if (local !== undefined && decision.permitted) {
				continue;
			}
			this.deps.log.warn(`[v3code-computer-use] stopping an unsanctioned observation session for '${helperSession.appId}' (pid ${helperSession.pid})`);
			await this._stopHelperSession(helperSession.pid);
			if (local) {
				local.dispose();
				this._sessions.delete(key);
			}
		}

		// A session we think we have but the helper does not is capture that has already ended; keeping
		// the record would make the indicator claim something untrue.
		for (const [key, record] of [...this._sessions.entries()]) {
			if (!status.sessions.some(session => session.appId.trim().toLowerCase() === key)) {
				record.dispose();
				this._sessions.delete(key);
			}
		}

		this.deps.store.prune(nowMs);
		this._afterSessionSetChanged();
	}

	// -----------------------------------------------------------------------------------------
	// History and memory
	// -----------------------------------------------------------------------------------------

	listHistory(): readonly ComputerUseObservationSample[] {
		return this.deps.store.listSamples(this.deps.clock.now());
	}

	async clearHistory(scope: ComputerUseObservationClearScope): Promise<number> {
		const dropped = this.deps.store.clear(scope);
		this.deps.log.info(`[v3code-computer-use] cleared ${dropped} observation record(s) (scope: ${scope.kind})`);
		return dropped;
	}

	async summarizeIntoMemory(): Promise<number> {
		const memory = this.deps.memory;
		if (!memory || !memory.isAvailable) {
			return 0;
		}
		const pending = this.deps.store
			.listSamples(this.deps.clock.now())
			.filter(sample => sample.factId === undefined);
		if (pending.length === 0) {
			return 0;
		}

		const byApp = new Map<string, ComputerUseObservationSample[]>();
		for (const sample of pending) {
			const group = byApp.get(sample.appId);
			if (group) {
				group.push(sample);
			} else {
				byApp.set(sample.appId, [sample]);
			}
		}

		let written = 0;
		for (const [appId, group] of byApp) {
			const ordered = [...group].sort((a, b) => a.capturedAt - b.capturedAt);
			const fact = await memory.upsertFact(
				{
					// `pattern` rather than a new kind: this is a recurring observation about how the user
					// works, and inventing a kind would mean touching the memory schema, which this tier
					// has no business doing.
					kind: 'pattern',
					subject: localize('computerUse.observation.factSubject', "Observed activity in {0}", ordered[0].appName),
					body: ordered.map(sample => `- ${new Date(sample.capturedAt).toISOString()} — ${sample.summary}`).join('\n'),
					// Low confidence and low priority on purpose: this was inferred from watching a screen,
					// not asserted by anyone, and it must not outrank something the user actually said.
					confidence: 0.35,
					priority: 2,
					source: [],
					meta: {
						origin: COMPUTER_USE_OBSERVATION_MEMORY_ORIGIN,
						appId,
						appName: ordered[0].appName,
						fromMs: ordered[0].capturedAt,
						toMs: ordered[ordered.length - 1].capturedAt,
						sampleCount: ordered.length,
						includedScreenshots: ordered.some(sample => sample.usedScreenshot),
					},
				},
				'workspace',
			);
			if (!fact) {
				continue;
			}
			this.deps.store.markSummarized(ordered.map(sample => sample.capturedAt), appId, fact.id);
			written++;
		}
		return written;
	}

	// -----------------------------------------------------------------------------------------
	// Reacting to the world
	// -----------------------------------------------------------------------------------------

	/** Setting or policy changed: stop anything that is no longer permitted. */
	private async _onExternalStateChanged(): Promise<void> {
		this._announceAvailability();
		if (this._sessions.size === 0) {
			return;
		}
		if (!this.isSettingEnabled || !this.deps.store.isEnabled()) {
			await this.hardStop('ambient observation was switched off');
			return;
		}
		for (const record of [...this._sessions.values()]) {
			if (!(this._authorize(record.app) instanceof ObservationAuthorization)) {
				await this.stop(record.appId);
			}
		}
		this._refreshIndicator();
	}

	/** Consent changed: a withdrawal is a full withdrawal, history included. */
	private async _onConsentChanged(): Promise<void> {
		if (this.deps.consent.hasAccepted()) {
			this._announceAvailability();
			return;
		}
		this.deps.store.revokeOptIn();
		await this.hardStop('ambient-observation consent was withdrawn');
		this._announceAvailability();
	}

	private _announceAvailability(): void {
		const available = this.isAvailable;
		if (available === this._lastAvailability) {
			return;
		}
		this._lastAvailability = available;
		this._onDidChangeAvailability.fire(available);
	}

	private _afterSessionSetChanged(): void {
		if (this._sessions.size === 0) {
			this._indicator.value?.hide();
			this._reconcileTimer.clear();
		} else {
			this._refreshIndicator();
		}
		this._onDidChangeSessions.fire();
	}

	// -----------------------------------------------------------------------------------------
	// Indicator
	// -----------------------------------------------------------------------------------------

	private _ensureIndicator(): void {
		if (this._indicator.value || !this.deps.createIndicator) {
			return;
		}
		const indicator = this.deps.createIndicator();
		this._indicator.value = indicator;
		this._register(indicator.onDidRequestStop(() => void this.hardStop('the user pressed Stop watching')));
		this._register(indicator.onDidRequestPause(() => void this.pause()));
	}

	/** Pushes current state into the indicator. Never hides it while a session is live. */
	private _refreshIndicator(): void {
		const indicator = this._indicator.value;
		if (!indicator) {
			return;
		}
		if (this._sessions.size === 0) {
			indicator.hide();
			return;
		}
		const state: ComputerUseObservationIndicatorState = {
			nowMs: this.deps.clock.now(),
			pausedUntil: this.deps.store.getPolicy().pausedUntil,
			sessions: [...this._sessions.values()].map(record => ({
				appName: record.app.name,
				includesScreenshots: record.mode === 'axTreeAndScreenshots',
				samples: record.samples,
				permittedUntil: record.permittedUntil,
			})),
		};
		indicator.show(state);
	}

	// -----------------------------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------------------------

	/** Tells the helper to stop, best effort. A failure is logged and otherwise ignored. */
	private async _stopHelperSession(pid: number | undefined): Promise<void> {
		if (!this.deps.host.isAvailable) {
			return;
		}
		try {
			await this.deps.host.invoke('observeStop', pid === undefined ? {} : { pid });
		} catch (error: unknown) {
			// Survivable: the session's own `stopAtMs` is the backstop, and `reconcile` will try again.
			this.deps.log.warn(`[v3code-computer-use] observeStop could not be delivered: ${this._describe(error)}`);
		}
	}

	private _describe(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

// ---------------------------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------------------------

/** Collapses whitespace and strips control characters, so one sample is one line. */
function flatten(value: string | undefined): string {
	if (!value) {
		return '';
	}
	// eslint-disable-next-line no-control-regex
	const stripped = Array.from(value)
		.map(character => ((character.codePointAt(0) ?? 32) < 32 || character === '\u007f' ? ' ' : character))
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
	return stripped.length > SUMMARY_FIELD_MAX_LENGTH
		? `${stripped.slice(0, SUMMARY_FIELD_MAX_LENGTH - 1)}…`
		: stripped;
}

/** Depth-first search for the focused node, so the summary can say where the user actually is. */
function findFocused(nodes: readonly ComputerUseAxNode[]): ComputerUseAxNode | undefined {
	for (const node of nodes) {
		if (node.focused) {
			return node;
		}
		const nested = node.children ? findFocused(node.children) : undefined;
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

/**
 * Builds the one-line description that is the *only* thing ambient observation retains.
 *
 * Everything folded in here is content from an application the user explicitly approved for
 * observation, and it is therefore untrusted text: a window title can contain anything, including
 * instructions aimed at the agent. It is flattened to a single line and length-bounded so it cannot
 * forge structure in the memory body it will be embedded in, and any consumer must present it to a
 * model as data rather than as instructions.
 *
 * Exported for the tests, which assert the bound and the flattening rather than the exact wording.
 */
export function summarizeObservation(
	windowTitle: string | undefined,
	nodes: readonly ComputerUseAxNode[],
	nodeCount: number,
): string {
	const parts: string[] = [];
	const title = flatten(windowTitle);
	if (title.length > 0) {
		parts.push(localize('computerUse.observation.summary.window', "window \"{0}\"", title));
	}
	const focused = findFocused(nodes);
	if (focused) {
		const label = flatten(focused.label);
		parts.push(label.length > 0
			? localize('computerUse.observation.summary.focusLabelled', "focus on {0} \"{1}\"", flatten(focused.role), label)
			: localize('computerUse.observation.summary.focus', "focus on {0}", flatten(focused.role)));
	}
	parts.push(localize('computerUse.observation.summary.elements', "{0} elements", Math.max(0, Math.round(nodeCount))));
	return parts.join(', ');
}

// ---------------------------------------------------------------------------------------------
// Workbench binding
// ---------------------------------------------------------------------------------------------

/** The workbench binding: the same logic, wired to the real services. */
export class WorkbenchComputerUseObservationService extends ComputerUseObservationService {
	constructor(
		@IComputerUseObservationStore store: IComputerUseObservationStore,
		@IComputerUseService computerUseService: IComputerUseService,
		@IComputerUseObservationConsentService consentService: IComputerUseObservationConsentService,
		@IVoidSettingsService settingsService: IVoidSettingsService,
		@IMemoryService memoryService: IMemoryService,
		@IDialogService dialogService: IDialogService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super({
			store,
			host: computerUseService,
			consent: consentService,
			memory: memoryService,
			// `=== true`, never coerced: a setting imported as the string "false" must not arm continuous
			// screen capture. Read off `GlobalSettings` directly rather than through a widening cast, so
			// renaming the setting is a compile error here instead of observation silently reading as off.
			isSettingEnabled: () => settingsService.state.globalSettings.enableComputerUseObservation === true,
			onDidChangeSetting: settingsService.onDidChangeState,
			clock: computerUseObservationSystemClock,
			log: logService,
			confirmApplication: async (app, mode, durationMs) => {
				const minutes = Math.max(1, Math.round(durationMs / 60_000));
				const { confirmed } = await dialogService.confirm({
					type: Severity.Warning,
					message: localize('computerUse.observation.approve.title', "Let V3Code watch {0}?", app.name),
					detail: mode === 'axTreeAndScreenshots'
						? localize(
							'computerUse.observation.approve.detailFrames',
							"V3Code will read {0}'s on-screen contents and take screenshots of it on a timer, without being asked each time, for the next {1} minutes. Summaries are saved to V3Code's memory; the screenshots themselves are not kept. Only what is in front is ever read, and you can stop this at any time from the indicator.",
							app.name, minutes
						)
						: localize(
							'computerUse.observation.approve.detail',
							"V3Code will read {0}'s on-screen contents on a timer, without being asked each time, for the next {1} minutes. Summaries are saved to V3Code's memory. Only what is in front is ever read, and you can stop this at any time from the indicator.",
							app.name, minutes
						),
					primaryButton: localize('computerUse.observation.approve.allow', "Allow watching"),
					cancelButton: localize('computerUse.observation.approve.deny', "Don't allow"),
				});
				return confirmed;
			},
			createIndicator: () => instantiationService.createInstance(ComputerUseObservationIndicator),
		});
	}
}

registerSingleton(IComputerUseObservationService, WorkbenchComputerUseObservationService, InstantiationType.Delayed);
