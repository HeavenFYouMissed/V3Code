/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Persistence for ambient observation: the policy document, and the bounded history of samples.
 *
 * The policy *engine* is `common/computerUseObservation.ts` and is not reimplemented here. This
 * module is the only thing that reads or writes the two storage keys it owns, and it is the single
 * choke point every recorded sample must pass through.
 *
 * **Three properties a reviewer should be able to check by reading this file alone.**
 *
 * 1. **A sample cannot be stored unless the live policy permits it, at the moment of the write.**
 *    {@link ComputerUseObservationStore.appendSample} re-runs `decideObservation` against the
 *    freshly-read policy and refuses on any refusal. It is not enough that the caller decided it was
 *    allowed a moment ago: a grant revoked mid-sample must lose, and the only way to guarantee that
 *    is to ask again at the write.
 * 2. **Nothing pixel-shaped is ever persisted.** {@link ComputerUseObservationSample} has no field
 *    that can hold image bytes, an accessibility node, or a label harvested from one. It holds a
 *    short derived summary and counts. A screenshot is a thing the summarizer looked at, never a
 *    thing this store keeps — see {@link ComputerUseObservationSample.usedScreenshot}.
 * 3. **Turning observation off destroys the history.** {@link ComputerUseObservationStore.revokeOptIn}
 *    wipes both keys. Leaving a trove of samples behind after the user withdrew the permission that
 *    produced them would make the off switch a lie.
 *
 * Persistence sits behind {@link IComputerUseObservationStorage} so all of the above is unit-testable
 * with no workbench, exactly as `computerUseExclusionStore.ts` does it.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS,
	COMPUTER_USE_OBSERVATION_DENY_ALL,
	COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS,
	COMPUTER_USE_OBSERVATION_MODES,
	COMPUTER_USE_OBSERVATION_OPT_IN_VERSION,
	COMPUTER_USE_OBSERVATION_STORAGE_KEY,
	ComputerUseObservationClearScope,
	ComputerUseObservationDecision,
	ComputerUseObservationMode,
	ComputerUseObservationPolicy,
	ComputerUseObservationRecord,
	ComputerUseObservationRule,
	clearObservationHistory,
	createObservationRule,
	decideObservation,
	isObservationEnabled,
	isObservationOptedIn,
	pruneObservationHistory,
	resolveObservationRetentionMs,
	revokeObservationRules,
	sanitizeObservationPolicy,
} from '../common/computerUseObservation.js';

/**
 * Application-scoped key holding the JSON array of {@link ComputerUseObservationSample}.
 *
 * Owned exclusively by this module, and deliberately separate from the policy key: clearing the
 * history must not be able to disturb the permission, and revoking the permission must be able to
 * delete the history without rewriting it first.
 */
export const COMPUTER_USE_OBSERVATION_HISTORY_STORAGE_KEY = 'v3code.computerUse.observation.history';

/**
 * Hard cap on retained samples, independent of the time-based retention window.
 *
 * A second, orthogonal bound so a pathologically short sampling interval cannot turn an hour of
 * retention into tens of thousands of rows. Time is the promise the user was made; this is the one
 * the machine needs.
 */
export const COMPUTER_USE_OBSERVATION_HISTORY_MAX_RECORDS = 500;

/** Longest a persisted summary may be. Truncated rather than rejected, since a long one is still useful. */
export const COMPUTER_USE_OBSERVATION_SUMMARY_MAX_LENGTH = 240;

/**
 * One retained ambient-observation sample.
 *
 * Note what is *absent*: no image bytes, no accessibility nodes, no element labels, no window text.
 * Ambient observation retains a derived, bounded description of what an application looked like, and
 * that is all it is able to retain, because there is nowhere here to put anything else.
 */
export interface ComputerUseObservationSample extends ComputerUseObservationRecord {
	/** Canonical application identifier, as produced by `asObservableAppId`. */
	readonly appId: string;
	/** Display name at capture time, so history can be listed back to the user without a lookup. */
	readonly appName: string;
	/** Epoch milliseconds the sample was taken. */
	readonly capturedAt: number;
	/** The mode that authorized this sample. Never `denied`. */
	readonly mode: 'axTree' | 'axTreeAndScreenshots';
	/** Short derived description. Bounded by {@link COMPUTER_USE_OBSERVATION_SUMMARY_MAX_LENGTH}. */
	readonly summary: string;
	/** Nodes in the pruned tree the summary was derived from, as a rough density signal. */
	readonly nodeCount: number;
	/**
	 * True when a raster frame was looked at to produce {@link summary}.
	 *
	 * A record of what the summarizer *saw*, not of anything kept. The frame is released before the
	 * sample reaches this store and there is no field it could survive in.
	 */
	readonly usedScreenshot: boolean;
	/** Id of the memory fact this sample has been folded into, once it has. */
	readonly factId?: string;
}

/**
 * The only persistence surface the store touches.
 *
 * `readPolicy` returns `unknown` on purpose: sanitization is the store's job and must not be
 * skippable by a storage implementation that thinks it already did it.
 */
export interface IComputerUseObservationStorage {
	/** The raw persisted policy blob, or `undefined` when nothing is stored. */
	readPolicy(): unknown;
	writePolicy(policy: ComputerUseObservationPolicy): void;
	/** Removes the policy entirely, so the next read is indistinguishable from a fresh profile. */
	clearPolicy(): void;
	/** All persisted samples. Empty when nothing is stored or the payload is corrupt. */
	readHistory(): readonly ComputerUseObservationSample[];
	writeHistory(records: readonly ComputerUseObservationSample[]): void;
}

/** Case-insensitive identity for an application id, matching the policy engine's normalization. */
function normalizeAppId(appId: string): string {
	return appId.trim().toLowerCase();
}

/** True when an unknown value is a well-formed {@link ComputerUseObservationSample}. */
function isObservationSample(candidate: unknown): candidate is ComputerUseObservationSample {
	if (typeof candidate !== 'object' || candidate === null) {
		return false;
	}
	const record = candidate as Partial<Record<keyof ComputerUseObservationSample, unknown>>;
	return (
		typeof record.appId === 'string' && record.appId.length > 0 &&
		typeof record.appName === 'string' &&
		typeof record.capturedAt === 'number' && Number.isFinite(record.capturedAt) && record.capturedAt >= 0 &&
		(record.mode === 'axTree' || record.mode === 'axTreeAndScreenshots') &&
		typeof record.summary === 'string' &&
		typeof record.nodeCount === 'number' && Number.isFinite(record.nodeCount) &&
		typeof record.usedScreenshot === 'boolean' &&
		(record.factId === undefined || typeof record.factId === 'string')
	);
}

/**
 * {@link IComputerUseObservationStorage} backed by `IStorageService` at application scope.
 *
 * Application scope rather than workspace scope for the same reason as the approval store: the
 * permission is about a native application on this machine and has nothing to do with which folder is
 * open. A corrupt payload reads as "no policy" and "no history", which denies and deletes — the two
 * safe directions.
 */
export class StorageServiceComputerUseObservationStorage implements IComputerUseObservationStorage {

	constructor(private readonly storageService: IStorageService) { }

	readPolicy(): unknown {
		const raw = this.storageService.get(COMPUTER_USE_OBSERVATION_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return undefined;
		}
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return undefined;
		}
	}

	writePolicy(policy: ComputerUseObservationPolicy): void {
		this.storageService.store(
			COMPUTER_USE_OBSERVATION_STORAGE_KEY,
			JSON.stringify(policy),
			StorageScope.APPLICATION,
			StorageTarget.USER,
		);
	}

	clearPolicy(): void {
		this.storageService.remove(COMPUTER_USE_OBSERVATION_STORAGE_KEY, StorageScope.APPLICATION);
	}

	readHistory(): readonly ComputerUseObservationSample[] {
		const raw = this.storageService.get(COMPUTER_USE_OBSERVATION_HISTORY_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter(isObservationSample);
		} catch {
			return [];
		}
	}

	writeHistory(records: readonly ComputerUseObservationSample[]): void {
		if (records.length === 0) {
			this.storageService.remove(COMPUTER_USE_OBSERVATION_HISTORY_STORAGE_KEY, StorageScope.APPLICATION);
			return;
		}
		this.storageService.store(
			COMPUTER_USE_OBSERVATION_HISTORY_STORAGE_KEY,
			JSON.stringify(records),
			StorageScope.APPLICATION,
			StorageTarget.USER,
		);
	}
}

/** An in-memory {@link IComputerUseObservationStorage}, for tests and for a profile with no storage. */
export class InMemoryComputerUseObservationStorage implements IComputerUseObservationStorage {

	private _policy: unknown;
	private _history: readonly ComputerUseObservationSample[] = [];

	readPolicy(): unknown {
		return this._policy;
	}

	writePolicy(policy: ComputerUseObservationPolicy): void {
		// Round-tripped through JSON so a test sees exactly what a real profile would see on reload,
		// including the loss of `undefined` members.
		this._policy = JSON.parse(JSON.stringify(policy)) as unknown;
	}

	clearPolicy(): void {
		this._policy = undefined;
	}

	readHistory(): readonly ComputerUseObservationSample[] {
		return this._history;
	}

	writeHistory(records: readonly ComputerUseObservationSample[]): void {
		this._history = [...records];
	}
}

/** Why {@link IComputerUseObservationStore.appendSample} declined to keep a sample. */
export type ComputerUseObservationAppendRefusal =
	/** The live policy refuses this application right now. Carries the engine's own reason. */
	| 'policyDenies'
	/** The sample claims a mode broader than the policy currently grants. */
	| 'modeExceedsGrant'
	/** The sample is older than the retention window already permits, so it would be pruned anyway. */
	| 'outsideRetention'
	/** The sample itself is not well-formed. */
	| 'malformedSample';

/** Outcome of an attempt to keep a sample. */
export type ComputerUseObservationAppendResult =
	| { readonly kept: true; readonly sample: ComputerUseObservationSample }
	| { readonly kept: false; readonly refusal: ComputerUseObservationAppendRefusal };

export const IComputerUseObservationStore = createDecorator<IComputerUseObservationStore>('computerUseObservationStore');

/** Reads and writes the ambient-observation policy and the bounded sample history. */
export interface IComputerUseObservationStore {
	readonly _serviceBrand: undefined;

	/** Fires after any change to the policy, so UI showing grants or the master switch can re-render. */
	readonly onDidChangePolicy: Event<void>;

	/** Fires after any change to the retained history. */
	readonly onDidChangeHistory: Event<void>;

	/** The current policy, always the sanitized form. Never throws; a corrupt blob reads as deny-all. */
	getPolicy(): ComputerUseObservationPolicy;

	/** True when an opt-in of the current version is recorded. */
	isOptedIn(): boolean;

	/** True when opted in *and* the master switch is on. */
	isEnabled(): boolean;

	/** The retention window in force, or `undefined` when the policy authorizes none. */
	getRetentionMs(): number | undefined;

	/** The live decision for an application. The only correct way to ask "may we observe this". */
	decide(app: { readonly id: string; readonly name?: string }, nowMs: number): ComputerUseObservationDecision;

	/**
	 * Records the opt-in, switches observation on, and installs a retention window if none exists.
	 *
	 * Must only be called after the second consent dialog has actually been accepted. It does not
	 * grant any application anything: the master switch being on still permits nothing until a
	 * per-application rule exists, and a fresh opt-in starts from no rules and no history.
	 */
	recordOptIn(): void;

	/**
	 * Withdraws the opt-in and destroys everything it produced.
	 *
	 * Removes the policy *and* the history, so the off switch leaves nothing behind.
	 */
	revokeOptIn(): void;

	/** Flips the master switch without touching the opt-in or the per-application rules. */
	setEnabled(enabled: boolean): void;

	/** Sets the retention window. Returns false, changing nothing, for a value outside the hard bounds. */
	setRetentionMs(retentionMs: number): boolean;

	/** Suspends observation until an epoch-millisecond instant. */
	pauseUntil(untilMs: number): void;

	/** Clears any suspension. */
	resume(): void;

	/** Every rule currently held. */
	listRules(): readonly ComputerUseObservationRule[];

	/**
	 * Grants or denies one application, replacing any rule it already had.
	 *
	 * Returns the rule actually stored — clamped, canonicalized — or `undefined` when the request
	 * could not be honoured at all, which is what happens for V3Code itself.
	 */
	setRule(
		app: { readonly id: string; readonly name?: string },
		mode: ComputerUseObservationMode,
		grantedAt: number,
		durationMs: number,
	): ComputerUseObservationRule | undefined;

	/** Removes every rule for an application. Returns true when one was present. */
	revokeRule(appId: string): boolean;

	/**
	 * Keeps a sample, if and only if the live policy still permits its application.
	 *
	 * The single write path for observation history. Prunes and caps as a side effect, so a caller
	 * cannot forget to.
	 */
	appendSample(sample: ComputerUseObservationSample, nowMs: number): ComputerUseObservationAppendResult;

	/** The retained history, newest first, pruned to the retention window as a side effect. */
	listSamples(nowMs: number): readonly ComputerUseObservationSample[];

	/** Drops everything outside the retention window. Returns how many records went. */
	prune(nowMs: number): number;

	/** Drops everything in a scope — one application, a time range, or all of it. Returns how many went. */
	clear(scope: ComputerUseObservationClearScope): number;

	/** Marks samples as folded into a memory fact, so they are not summarized twice. */
	markSummarized(capturedAtValues: readonly number[], appId: string, factId: string): void;
}

/**
 * Observation bookkeeping, free of any workbench dependency.
 *
 * Construct with an {@link IComputerUseObservationStorage}; the workbench binding is
 * {@link WorkbenchComputerUseObservationStore} below.
 */
export class ComputerUseObservationStore extends Disposable implements IComputerUseObservationStore {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePolicy = this._register(new Emitter<void>());
	readonly onDidChangePolicy: Event<void> = this._onDidChangePolicy.event;

	private readonly _onDidChangeHistory = this._register(new Emitter<void>());
	readonly onDidChangeHistory: Event<void> = this._onDidChangeHistory.event;

	/** Sanitized mirror of the persisted policy, so reads never re-parse. */
	private _policy: ComputerUseObservationPolicy;

	/** Mirror of the persisted history. */
	private _history: ComputerUseObservationSample[];

	constructor(private readonly storage: IComputerUseObservationStorage) {
		super();
		this._policy = sanitizeObservationPolicy(this.storage.readPolicy());
		this._history = [...this.storage.readHistory()];
	}

	getPolicy(): ComputerUseObservationPolicy {
		return this._policy;
	}

	isOptedIn(): boolean {
		return isObservationOptedIn(this._policy);
	}

	isEnabled(): boolean {
		return isObservationEnabled(this._policy);
	}

	getRetentionMs(): number | undefined {
		return resolveObservationRetentionMs(this._policy);
	}

	decide(app: { readonly id: string; readonly name?: string }, nowMs: number): ComputerUseObservationDecision {
		return decideObservation(this._policy, app, nowMs);
	}

	recordOptIn(): void {
		const retentionMs = resolveObservationRetentionMs(this._policy) ?? COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS;
		if (this._history.length > 0) {
			// A previous opt-in's samples must not reappear under a new one. They were retained under a
			// permission that has since been withdrawn, whatever the reason it was withdrawn.
			this._history = [];
			this.storage.writeHistory([]);
			this._onDidChangeHistory.fire();
		}
		this._writePolicy({
			...this._policy,
			optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION,
			enabled: true,
			retentionMs,
			// A fresh opt-in must not inherit a suspension from a previous one, and must not inherit
			// grants either: agreeing to the capability is not agreeing to any particular application.
			pausedUntil: undefined,
			rules: [],
		});
	}

	revokeOptIn(): void {
		this._policy = COMPUTER_USE_OBSERVATION_DENY_ALL;
		this.storage.clearPolicy();
		const hadHistory = this._history.length > 0;
		this._history = [];
		this.storage.writeHistory([]);
		this._onDidChangePolicy.fire();
		if (hadHistory) {
			this._onDidChangeHistory.fire();
		}
	}

	setEnabled(enabled: boolean): void {
		this._writePolicy({ ...this._policy, enabled: enabled === true });
	}

	setRetentionMs(retentionMs: number): boolean {
		if (!Number.isInteger(retentionMs) || retentionMs <= 0 || retentionMs > COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS) {
			return false;
		}
		this._writePolicy({ ...this._policy, retentionMs });
		return true;
	}

	pauseUntil(untilMs: number): void {
		this._writePolicy({ ...this._policy, pausedUntil: untilMs });
	}

	resume(): void {
		this._writePolicy({ ...this._policy, pausedUntil: undefined });
	}

	listRules(): readonly ComputerUseObservationRule[] {
		return this._policy.rules ?? [];
	}

	setRule(
		app: { readonly id: string; readonly name?: string },
		mode: ComputerUseObservationMode,
		grantedAt: number,
		durationMs: number,
	): ComputerUseObservationRule | undefined {
		if (!COMPUTER_USE_OBSERVATION_MODES.includes(mode)) {
			return undefined;
		}
		const rule = createObservationRule({ app, mode, grantedAt, durationMs });
		if (rule === undefined) {
			return undefined;
		}
		// Revoke first so a re-grant replaces rather than accumulates: two rules for one application
		// would make the narrowest-wins tie-break decide which of the user's two answers counted.
		const withoutApp = revokeObservationRules(this._policy, rule.appId);
		this._writePolicy({ ...withoutApp, rules: [...(withoutApp.rules ?? []), rule] });
		return rule;
	}

	revokeRule(appId: string): boolean {
		const before = this._policy.rules ?? [];
		const next = revokeObservationRules(this._policy, appId);
		if ((next.rules ?? []).length === before.length) {
			return false;
		}
		this._writePolicy(next);
		return true;
	}

	appendSample(sample: ComputerUseObservationSample, nowMs: number): ComputerUseObservationAppendResult {
		if (!isObservationSample(sample)) {
			return { kept: false, refusal: 'malformedSample' };
		}

		// Asked again, here, at the write. The caller's earlier decision is not evidence: a grant the
		// user revoked while a sample was in flight must cause that sample to be dropped, and this is
		// the only place that can guarantee it.
		const decision = this.decide({ id: sample.appId, name: sample.appName }, nowMs);
		if (!decision.permitted) {
			return { kept: false, refusal: 'policyDenies' };
		}
		if (sample.mode === 'axTreeAndScreenshots' && decision.mode !== 'axTreeAndScreenshots') {
			return { kept: false, refusal: 'modeExceedsGrant' };
		}
		if (sample.capturedAt <= decision.discardBefore) {
			return { kept: false, refusal: 'outsideRetention' };
		}

		const normalized: ComputerUseObservationSample = {
			...sample,
			appId: normalizeAppId(sample.appId),
			summary: sample.summary.length > COMPUTER_USE_OBSERVATION_SUMMARY_MAX_LENGTH
				? `${sample.summary.slice(0, COMPUTER_USE_OBSERVATION_SUMMARY_MAX_LENGTH - 1)}…`
				: sample.summary,
			nodeCount: Math.max(0, Math.round(sample.nodeCount)),
		};

		const pruned = pruneObservationHistory([...this._history, normalized], this._policy, nowMs);
		// Newest-first before the cap, so the cap drops the oldest rather than an arbitrary slice.
		const capped = [...pruned]
			.sort((a, b) => b.capturedAt - a.capturedAt)
			.slice(0, COMPUTER_USE_OBSERVATION_HISTORY_MAX_RECORDS);
		this._history = capped;
		this.storage.writeHistory(this._history);
		this._onDidChangeHistory.fire();
		return { kept: true, sample: normalized };
	}

	listSamples(nowMs: number): readonly ComputerUseObservationSample[] {
		this.prune(nowMs);
		return [...this._history].sort((a, b) => b.capturedAt - a.capturedAt);
	}

	prune(nowMs: number): number {
		const survivors = pruneObservationHistory(this._history, this._policy, nowMs);
		const dropped = this._history.length - survivors.length;
		if (dropped === 0) {
			return 0;
		}
		this._history = [...survivors];
		this.storage.writeHistory(this._history);
		this._onDidChangeHistory.fire();
		return dropped;
	}

	clear(scope: ComputerUseObservationClearScope): number {
		const survivors = clearObservationHistory(this._history, scope);
		const dropped = this._history.length - survivors.length;
		if (dropped === 0) {
			return 0;
		}
		this._history = [...survivors];
		this.storage.writeHistory(this._history);
		this._onDidChangeHistory.fire();
		return dropped;
	}

	markSummarized(capturedAtValues: readonly number[], appId: string, factId: string): void {
		const wanted = new Set(capturedAtValues);
		const target = normalizeAppId(appId);
		let changed = false;
		this._history = this._history.map(record => {
			if (record.factId !== undefined || normalizeAppId(record.appId) !== target || !wanted.has(record.capturedAt)) {
				return record;
			}
			changed = true;
			return { ...record, factId };
		});
		if (!changed) {
			return;
		}
		this.storage.writeHistory(this._history);
		this._onDidChangeHistory.fire();
	}

	/** Sanitizes, persists, mirrors, and announces one policy change. The only policy write path. */
	private _writePolicy(next: ComputerUseObservationPolicy): void {
		// Sanitized on the way *out* as well as on the way in, so a caller cannot install a policy the
		// reader would have rejected and then be surprised that observation stopped.
		this._policy = sanitizeObservationPolicy(next);
		this.storage.writePolicy(this._policy);
		this._onDidChangePolicy.fire();
	}
}

/** The workbench binding: the same logic, persisted through `IStorageService`. */
export class WorkbenchComputerUseObservationStore extends ComputerUseObservationStore {
	constructor(
		@IStorageService storageService: IStorageService,
	) {
		super(new StorageServiceComputerUseObservationStorage(storageService));
	}
}

registerSingleton(IComputerUseObservationStore, WorkbenchComputerUseObservationStore, InstantiationType.Delayed);

/**
 * True when the store would permit *something* — opted in, switched on, and with a usable retention
 * window.
 *
 * Says nothing about any particular application; a caller must still take a permitting decision.
 * Exists so availability UI has one predicate to read instead of three.
 */
export function isObservationStoreArmed(store: IComputerUseObservationStore): boolean {
	return store.isEnabled() && store.getRetentionMs() !== undefined;
}
