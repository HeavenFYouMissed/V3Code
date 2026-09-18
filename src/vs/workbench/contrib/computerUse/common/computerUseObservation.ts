/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { classifyComputerUseApp } from './computerUseAppTiers.js';

/**
 * The rules engine for ambient observation — the tier where V3Code samples an application's screen
 * and accessibility tree on a timer rather than because a tool call asked it to.
 *
 * **Policy only.** Nothing here captures anything, schedules anything, reads a clock, or touches
 * storage. It answers one question — *may we observe this application right now, and if not, why
 * not* — as a pure function of a policy document, an application identity, and a timestamp the
 * caller supplies. Capture lives in the helper; persistence lives in a service; both consult this.
 *
 * **How every bug fails towards "we did not capture".** Continuous background capture of the user's
 * screen is the highest-consequence thing this feature can do, so the design is arranged so that no
 * single mistake can turn it on:
 *
 * - **Default deny by construction.** {@link decideObservation} has exactly one `permitted: true`
 *   return, at the very end of a chain of guards. Every guard denies. There is no `else` that
 *   permits, no default mode, and no fallback value for a missing field.
 * - **Every persisted field is optional and must be affirmatively valid.** A truncated write, a
 *   policy blob from a future version, a hand-edited settings file with a typo — all of these leave
 *   fields `undefined`, and `undefined` never satisfies a guard. In particular the retention window
 *   has *no default*: an unreadable retention means refuse, not "use an hour".
 * - **Booleans are compared to `true`, never coerced.** A policy whose `enabled` was persisted as
 *   the string `"false"` is not truthy-checked into a grant.
 * - **Grants expire and are clamped.** A rule without a valid `expiresAt` in the future is dead, and
 *   an over-long grant is silently shortened to
 *   {@link COMPUTER_USE_OBSERVATION_MAX_GRANT_MS} rather than honoured.
 * - **V3Code cannot be named.** Rules key on {@link ComputerUseObservableAppId}, a branded type that
 *   only {@link asObservableAppId} can produce and which it refuses to produce for V3Code. A plain
 *   string does not type-check, so a rule observing V3Code cannot be *written*; and
 *   {@link decideObservation} re-classifies the application anyway, so it could not be *honoured* if
 *   one were smuggled in through `JSON.parse`.
 * - **The history helpers err towards deleting.** An invalid retention window prunes everything; a
 *   malformed clear range clears everything; boundaries are inclusive on the delete side. Losing a
 *   sample is a bug worth having; keeping one the user asked to be rid of is not.
 */

// ---------------------------------------------------------------------------------------------
// Versioning and storage
// ---------------------------------------------------------------------------------------------

/**
 * Bumped when the wording of the ambient-observation opt-in changes materially.
 *
 * Stored inside the policy rather than beside it so a policy carried forward from an older build
 * fails the version check and denies until the user opts in again. Silently honouring a narrower
 * past acceptance as consent for a broader capability is exactly the mistake this prevents.
 */
export const COMPUTER_USE_OBSERVATION_OPT_IN_VERSION = 1;

/**
 * Application-scoped key holding the serialized {@link ComputerUseObservationPolicy}.
 *
 * Deliberately separate from the computer-use consent key: consent to drive the machine on request
 * is not consent to watch it continuously, and conflating the two would let one prompt buy both.
 */
export const COMPUTER_USE_OBSERVATION_STORAGE_KEY = 'v3code.computerUse.observation.policy';

/** Hard ceiling on how long samples may be kept, whatever the policy asks for. */
export const COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Suggested retention for the settings UI to write into a fresh policy.
 *
 * A *suggestion*, never a fallback: {@link decideObservation} refuses when retention is unreadable
 * instead of substituting this. A default applied at decision time is a default that survives
 * corruption, which is the opposite of what is wanted here.
 */
export const COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS = 60 * 60 * 1000;

/**
 * Hard ceiling on the lifetime of a single per-application grant.
 *
 * Ambient observation should be something the user turns on for a stretch of work, not a permission
 * they grant once and forget they granted. Grants longer than this are clamped down to it.
 */
export const COMPUTER_USE_OBSERVATION_MAX_GRANT_MS = 8 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Application identity
// ---------------------------------------------------------------------------------------------

/**
 * An application identifier proven not to be V3Code itself.
 *
 * Branded so the only way to obtain one is {@link asObservableAppId}, which refuses V3Code. The
 * brand makes "a rule that observes V3Code" a compile error rather than a code review finding.
 */
export type ComputerUseObservableAppId = string & { readonly _observableAppIdBrand: undefined };

/**
 * Canonicalizes an application identifier for rule lookup.
 *
 * Case and surrounding whitespace only. Nothing fuzzy: fragment or prefix matching would let a grant
 * for one application quietly cover another that happens to share a prefix, which is a
 * confused-deputy waiting to happen. Tier *classification* matches on fragments precisely because
 * over-matching there is restrictive; over-matching here would be permissive.
 */
function normalizeAppId(id: string): string {
	return id.trim().toLowerCase();
}

/**
 * Returns a branded, observable identifier for an application, or `undefined` when it must never be
 * observed.
 *
 * Refuses V3Code itself — via the shared tier classifier, so there is one definition of "self" and
 * not a second copy to drift — and refuses an empty identifier, because an empty rule key would
 * match an application whose identity the helper failed to report.
 */
export function asObservableAppId(app: { readonly id: string; readonly name?: string }): ComputerUseObservableAppId | undefined {
	const normalized = normalizeAppId(app.id);
	if (normalized.length === 0) {
		return undefined;
	}
	if (classifyComputerUseApp(app) === 'self') {
		return undefined;
	}
	return normalized as ComputerUseObservableAppId;
}

// ---------------------------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------------------------

/**
 * What a rule permits.
 *
 * `denied` exists so a user can pin an application as never-observed and have that beat every other
 * rule, including a broader one added later. Absence of a rule already denies; an explicit `denied`
 * is a statement that survives the user granting something else.
 */
export type ComputerUseObservationMode = 'denied' | 'axTree' | 'axTreeAndScreenshots';

/** Every mode, for exhaustive iteration in tests and settings UI. */
export const COMPUTER_USE_OBSERVATION_MODES: readonly ComputerUseObservationMode[] = [
	'denied',
	'axTree',
	'axTreeAndScreenshots',
];

/**
 * How permissive each mode is. Used to pick the *narrowest* of several matching rules.
 *
 * Narrowest rather than newest or broadest: if two rules disagree, the answer the user is least
 * likely to be surprised by is the smaller one.
 */
const MODE_RANK: Readonly<Record<ComputerUseObservationMode, number>> = {
	denied: 0,
	axTree: 1,
	axTreeAndScreenshots: 2,
};

/**
 * A per-application observation grant.
 *
 * Every field is required and every field is checked at decision time. `expiresAt` in particular is
 * not optional: a grant with no end is a grant nobody remembers making.
 */
export interface ComputerUseObservationRule {
	/** Canonical identifier of the application, obtainable only from {@link asObservableAppId}. */
	readonly appId: ComputerUseObservableAppId;
	readonly mode: ComputerUseObservationMode;
	/** Epoch milliseconds at which the user granted this. */
	readonly grantedAt: number;
	/** Epoch milliseconds after which the grant is dead. Clamped against {@link COMPUTER_USE_OBSERVATION_MAX_GRANT_MS}. */
	readonly expiresAt: number;
}

/**
 * The whole persisted observation policy.
 *
 * Every field is optional *on purpose*. This is the shape that comes back out of storage, where
 * anything may be missing, stale, or wrong, and the type should force the reader to prove validity
 * rather than let it assume the writer got it right.
 */
export interface ComputerUseObservationPolicy {
	/** Must equal {@link COMPUTER_USE_OBSERVATION_OPT_IN_VERSION}. Absent means never opted in. */
	readonly optInVersion?: number;
	/** Master switch. Must be exactly `true`; anything else denies. */
	readonly enabled?: boolean;
	/** How long samples may be kept, in milliseconds. No default — see the module comment. */
	readonly retentionMs?: number;
	/** Epoch milliseconds until which observation is suspended, for a "pause for now" affordance. */
	readonly pausedUntil?: number;
	readonly rules?: readonly ComputerUseObservationRule[];
}

/**
 * The policy that permits nothing.
 *
 * The correct value to use whenever a policy could not be read, and the correct starting point for a
 * new profile. Frozen so a caller cannot mutate the shared deny-all into a grant.
 */
export const COMPUTER_USE_OBSERVATION_DENY_ALL: ComputerUseObservationPolicy = Object.freeze({});

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

/** Machine-readable reason observation was refused. Callers branch on these; users read the description. */
export type ComputerUseObservationRefusal =
	/** No opt-in has ever been recorded. */
	| 'notOptedIn'
	/** An opt-in exists but predates the current {@link COMPUTER_USE_OBSERVATION_OPT_IN_VERSION}. */
	| 'optInVersionStale'
	/** Opted in, but ambient observation is switched off. */
	| 'masterSwitchOff'
	/** Temporarily suspended by {@link ComputerUseObservationPolicy.pausedUntil}. */
	| 'paused'
	/** The retention window is missing, not a positive integer, or beyond the hard ceiling. */
	| 'retentionWindowInvalid'
	/** The timestamp the caller supplied is not a usable clock reading. */
	| 'invalidClock'
	/** The application is V3Code itself, which is never observed. */
	| 'selfApplication'
	/** No rule names this application, so the default deny applies. */
	| 'noRuleForApplication'
	/** A rule names this application and denies it outright. */
	| 'ruleDenies'
	/** A rule names this application but its grant has lapsed. */
	| 'ruleExpired'
	/** A rule names this application but its fields are not usable. */
	| 'malformedRule';

/** Every refusal reason, for exhaustive iteration in tests and telemetry buckets. */
export const COMPUTER_USE_OBSERVATION_REFUSALS: readonly ComputerUseObservationRefusal[] = [
	'notOptedIn',
	'optInVersionStale',
	'masterSwitchOff',
	'paused',
	'retentionWindowInvalid',
	'invalidClock',
	'selfApplication',
	'noRuleForApplication',
	'ruleDenies',
	'ruleExpired',
	'malformedRule',
];

/**
 * A plain-English explanation of a refusal.
 *
 * Deliberately not localized here: this module stays free of `vs/nls` so it remains a pure,
 * dependency-light contract, exactly as `computerUseAppTiers` does. The caller localizes.
 */
export function describeObservationRefusal(reason: ComputerUseObservationRefusal): string {
	switch (reason) {
		case 'notOptedIn':
			return 'Ambient observation has not been turned on.';
		case 'optInVersionStale':
			return 'Ambient observation must be confirmed again because what it covers has changed.';
		case 'masterSwitchOff':
			return 'Ambient observation is switched off.';
		case 'paused':
			return 'Ambient observation is paused.';
		case 'retentionWindowInvalid':
			return 'Ambient observation has no usable retention window, so nothing may be recorded.';
		case 'invalidClock':
			return 'The current time could not be determined, so nothing may be recorded.';
		case 'selfApplication':
			return 'V3Code never observes itself.';
		case 'noRuleForApplication':
			return 'This application has not been approved for ambient observation.';
		case 'ruleDenies':
			return 'This application is explicitly excluded from ambient observation.';
		case 'ruleExpired':
			return 'Approval for observing this application has expired.';
		case 'malformedRule':
			return 'The stored approval for this application is unusable, so nothing may be recorded.';
	}
}

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

/** True for a finite, non-negative integer millisecond timestamp. */
function isTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** True for a finite, positive integer duration. */
function isDuration(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/**
 * True when the user has opted in at the current version and left the master switch on.
 *
 * The master enablement predicate the rest of the feature gates on. It is false for an absent
 * policy, a policy from an older opt-in version, and any `enabled` that is not literally `true`.
 */
export function isObservationEnabled(policy: ComputerUseObservationPolicy | undefined): boolean {
	return (
		policy !== undefined &&
		policy.optInVersion === COMPUTER_USE_OBSERVATION_OPT_IN_VERSION &&
		policy.enabled === true
	);
}

/** True when an opt-in of the current version is recorded, regardless of the master switch. */
export function isObservationOptedIn(policy: ComputerUseObservationPolicy | undefined): boolean {
	return policy !== undefined && policy.optInVersion === COMPUTER_USE_OBSERVATION_OPT_IN_VERSION;
}

/**
 * The retention window a policy actually authorizes, or `undefined` when it authorizes none.
 *
 * Returns `undefined` — not a default — for a missing, non-integer, non-positive or over-long value,
 * so an unreadable policy cannot record anything. A value above the hard ceiling is rejected rather
 * than clamped, because a policy asking to keep screenshots for a year is more likely corrupt than
 * intentional and quietly honouring half of it would hide that.
 */
export function resolveObservationRetentionMs(policy: ComputerUseObservationPolicy | undefined): number | undefined {
	if (policy === undefined || !isDuration(policy.retentionMs)) {
		return undefined;
	}
	return policy.retentionMs <= COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS ? policy.retentionMs : undefined;
}

// ---------------------------------------------------------------------------------------------
// Rule construction and sanitization
// ---------------------------------------------------------------------------------------------

/**
 * Builds a rule, or returns `undefined` when the request cannot be honoured.
 *
 * The only supported way to create a {@link ComputerUseObservationRule}, because it is the only
 * place that can mint the branded `appId`. Refuses V3Code, an unknown mode, and unusable
 * timestamps; clamps an over-long duration down to {@link COMPUTER_USE_OBSERVATION_MAX_GRANT_MS}.
 */
export function createObservationRule(request: {
	readonly app: { readonly id: string; readonly name?: string };
	readonly mode: ComputerUseObservationMode;
	readonly grantedAt: number;
	readonly durationMs: number;
}): ComputerUseObservationRule | undefined {
	const appId = asObservableAppId(request.app);
	if (appId === undefined) {
		return undefined;
	}
	if (!COMPUTER_USE_OBSERVATION_MODES.includes(request.mode)) {
		return undefined;
	}
	if (!isTimestamp(request.grantedAt) || !isDuration(request.durationMs)) {
		return undefined;
	}
	const duration = Math.min(request.durationMs, COMPUTER_USE_OBSERVATION_MAX_GRANT_MS);
	return {
		appId,
		mode: request.mode,
		grantedAt: request.grantedAt,
		expiresAt: request.grantedAt + duration,
	};
}

/**
 * Rebuilds a policy from whatever came out of storage, keeping only what is affirmatively valid.
 *
 * The boundary where an untrusted blob becomes a typed policy, and therefore the boundary that must
 * assume the worst. Anything it cannot vouch for is dropped rather than repaired: a policy with one
 * unreadable rule loses that rule, and a policy that is not even an object becomes
 * {@link COMPUTER_USE_OBSERVATION_DENY_ALL}. Note that a rule naming V3Code is dropped here *as
 * well as* being rejected at decision time — two independent chances to fail closed.
 */
export function sanitizeObservationPolicy(raw: unknown): ComputerUseObservationPolicy {
	if (typeof raw !== 'object' || raw === null) {
		return COMPUTER_USE_OBSERVATION_DENY_ALL;
	}
	const candidate = raw as Partial<Record<keyof ComputerUseObservationPolicy, unknown>>;

	const rules: ComputerUseObservationRule[] = [];
	if (Array.isArray(candidate.rules)) {
		for (const entry of candidate.rules) {
			if (typeof entry !== 'object' || entry === null) {
				continue;
			}
			const rule = entry as Partial<Record<keyof ComputerUseObservationRule, unknown>>;
			if (typeof rule.appId !== 'string' || typeof rule.mode !== 'string') {
				continue;
			}
			if (!COMPUTER_USE_OBSERVATION_MODES.includes(rule.mode as ComputerUseObservationMode)) {
				continue;
			}
			if (!isTimestamp(rule.grantedAt) || !isTimestamp(rule.expiresAt)) {
				continue;
			}
			const appId = asObservableAppId({ id: rule.appId });
			if (appId === undefined) {
				continue;
			}
			rules.push({
				appId,
				mode: rule.mode as ComputerUseObservationMode,
				grantedAt: rule.grantedAt,
				// Re-clamp on read: a hand-edited or forward-dated expiry cannot outlive the ceiling.
				expiresAt: Math.min(rule.expiresAt, rule.grantedAt + COMPUTER_USE_OBSERVATION_MAX_GRANT_MS),
			});
		}
	}

	return {
		optInVersion: typeof candidate.optInVersion === 'number' && Number.isInteger(candidate.optInVersion)
			? candidate.optInVersion
			: undefined,
		enabled: candidate.enabled === true,
		retentionMs: isDuration(candidate.retentionMs) ? candidate.retentionMs : undefined,
		pausedUntil: isTimestamp(candidate.pausedUntil) ? candidate.pausedUntil : undefined,
		rules,
	};
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

/**
 * The outcome of {@link decideObservation}.
 *
 * A discriminated union rather than one interface with optional fields, so a caller physically
 * cannot read `mode` without having checked `permitted` — the compiler enforces the ordering that a
 * hand-written `if` would otherwise be free to get wrong.
 */
export type ComputerUseObservationDecision =
	| {
		readonly permitted: true;
		/** Never `denied`: a denying rule cannot produce a permitting decision. */
		readonly mode: 'axTree' | 'axTreeAndScreenshots';
		/** Epoch milliseconds at which permission lapses. Observation must stop by then, unasked. */
		readonly permittedUntil: number;
		/** Epoch milliseconds before which existing samples must already have been discarded. */
		readonly discardBefore: number;
	}
	| {
		readonly permitted: false;
		readonly reason: ComputerUseObservationRefusal;
	};

/**
 * Decides whether an application may be observed at a given moment.
 *
 * A chain of guards, every one of which denies, ending in the single permitting return. Order is
 * chosen so the reason returned is the most actionable one: global state before per-application
 * state, so a user who has not opted in is told that rather than being told this particular
 * application lacks a rule.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so the whole engine stays pure and every
 * boundary is testable without waiting for wall-clock time to pass.
 */
export function decideObservation(
	policy: ComputerUseObservationPolicy | undefined,
	app: { readonly id: string; readonly name?: string },
	nowMs: number,
): ComputerUseObservationDecision {
	if (!isTimestamp(nowMs)) {
		return { permitted: false, reason: 'invalidClock' };
	}
	if (!isObservationOptedIn(policy)) {
		return {
			permitted: false,
			reason: policy?.optInVersion === undefined ? 'notOptedIn' : 'optInVersionStale',
		};
	}
	if (!isObservationEnabled(policy)) {
		return { permitted: false, reason: 'masterSwitchOff' };
	}

	const retentionMs = resolveObservationRetentionMs(policy);
	if (retentionMs === undefined) {
		return { permitted: false, reason: 'retentionWindowInvalid' };
	}

	// Re-checked even though the branded appId already makes a self rule unwritable: a policy that
	// arrived through JSON.parse and skipped sanitization must still be refused here.
	if (classifyComputerUseApp(app) === 'self') {
		return { permitted: false, reason: 'selfApplication' };
	}
	const appId = asObservableAppId(app);
	if (appId === undefined) {
		return { permitted: false, reason: 'selfApplication' };
	}

	if (policy?.pausedUntil !== undefined) {
		if (!isTimestamp(policy.pausedUntil)) {
			// An unreadable pause is treated as an active one; the alternative is resuming capture
			// because a field was corrupt.
			return { permitted: false, reason: 'paused' };
		}
		if (nowMs < policy.pausedUntil) {
			return { permitted: false, reason: 'paused' };
		}
	}

	const rules = policy?.rules;
	if (!Array.isArray(rules)) {
		return { permitted: false, reason: 'noRuleForApplication' };
	}
	const matching: ComputerUseObservationRule[] = [];
	for (const rule of rules) {
		// Written against the possibility that this policy never went through
		// sanitizeObservationPolicy, because a policy that reached us some other way must still be
		// survivable rather than throw halfway through a decision.
		if (rule === null || rule === undefined || typeof rule.appId !== 'string') {
			continue;
		}
		if (rule.appId !== appId) {
			continue;
		}
		if (!COMPUTER_USE_OBSERVATION_MODES.includes(rule.mode)) {
			// A rule that names this application but whose mode we cannot interpret denies it. Skipping
			// it instead would let a corrupt narrow rule be replaced by an intact broad one.
			return { permitted: false, reason: 'malformedRule' };
		}
		matching.push(rule);
	}
	if (matching.length === 0) {
		return { permitted: false, reason: 'noRuleForApplication' };
	}

	// Narrowest matching rule wins, so an explicit `denied` beats any grant beside it.
	let narrowest = matching[0];
	for (const rule of matching) {
		if (MODE_RANK[rule.mode] < MODE_RANK[narrowest.mode]) {
			narrowest = rule;
		}
	}

	if (narrowest.mode === 'denied') {
		return { permitted: false, reason: 'ruleDenies' };
	}
	if (!isTimestamp(narrowest.grantedAt) || !isTimestamp(narrowest.expiresAt)) {
		return { permitted: false, reason: 'malformedRule' };
	}
	if (narrowest.grantedAt > nowMs) {
		// A grant dated in the future means the clock moved or the file was edited. Either way it is
		// not evidence that the user agreed to anything now.
		return { permitted: false, reason: 'malformedRule' };
	}

	const permittedUntil = Math.min(
		narrowest.expiresAt,
		narrowest.grantedAt + COMPUTER_USE_OBSERVATION_MAX_GRANT_MS,
	);
	if (permittedUntil <= nowMs) {
		return { permitted: false, reason: 'ruleExpired' };
	}

	return {
		permitted: true,
		mode: narrowest.mode,
		permittedUntil,
		discardBefore: nowMs - retentionMs,
	};
}

// ---------------------------------------------------------------------------------------------
// Retention and clearing
// ---------------------------------------------------------------------------------------------

/**
 * The minimum a stored observation must carry for retention and clearing to reason about it.
 *
 * The functions below are generic over anything satisfying this, so the payload — a screenshot, a
 * tree, a summary — never has to be described here.
 */
export interface ComputerUseObservationRecord {
	/** Canonical application identifier, as produced by {@link asObservableAppId}. */
	readonly appId: string;
	/** Epoch milliseconds at which the sample was taken. */
	readonly capturedAt: number;
}

/**
 * Drops everything the policy's retention window no longer covers.
 *
 * A record exactly on the boundary is dropped, and an unreadable retention window drops
 * *everything*. Both choices err towards deleting, which is the only direction a bug here is
 * tolerable in: a lost sample costs the agent some context, whereas a kept sample the user believed
 * expired is a broken promise.
 */
export function pruneObservationHistory<T extends ComputerUseObservationRecord>(
	records: readonly T[],
	policy: ComputerUseObservationPolicy | undefined,
	nowMs: number,
): readonly T[] {
	const retentionMs = resolveObservationRetentionMs(policy);
	if (retentionMs === undefined || !isTimestamp(nowMs)) {
		return [];
	}
	const cutoff = nowMs - retentionMs;
	return records.filter(record => isTimestamp(record.capturedAt) && record.capturedAt > cutoff);
}

/**
 * What a clear-history request covers.
 *
 * Three scopes because the three real requests are different: "forget that app", "forget the last
 * hour", and "forget all of it". Nothing narrower, because a per-sample delete implies a browsable
 * history UI that does not exist.
 */
export type ComputerUseObservationClearScope =
	/** Everything, unconditionally. */
	| { readonly kind: 'all' }
	/** Every sample of one application. */
	| { readonly kind: 'app'; readonly appId: string }
	/** Every sample captured within an inclusive epoch-millisecond range. */
	| { readonly kind: 'timeRange'; readonly fromMs: number; readonly toMs: number };

/**
 * True when a record falls inside a clear scope and must therefore be deleted.
 *
 * The time range is inclusive at both ends, and a range whose bounds are unusable — not numbers, or
 * inverted — matches *everything*. Both are the delete-more direction, on the same reasoning as
 * {@link pruneObservationHistory}: a user asking to clear history is better served by losing a
 * neighbouring sample than by keeping the one they meant.
 */
export function isObservationRecordInScope(
	record: ComputerUseObservationRecord,
	scope: ComputerUseObservationClearScope,
): boolean {
	switch (scope.kind) {
		case 'all':
			return true;
		case 'app':
			return normalizeAppId(record.appId) === normalizeAppId(scope.appId);
		case 'timeRange': {
			if (!isTimestamp(scope.fromMs) || !isTimestamp(scope.toMs) || scope.fromMs > scope.toMs) {
				return true;
			}
			if (!isTimestamp(record.capturedAt)) {
				return true;
			}
			return record.capturedAt >= scope.fromMs && record.capturedAt <= scope.toMs;
		}
	}
}

/**
 * Returns the records that survive a clear request.
 *
 * Phrased as "what survives" rather than "what to delete" so the caller's assignment is the whole
 * operation and a forgotten second step cannot leave deleted samples in place.
 */
export function clearObservationHistory<T extends ComputerUseObservationRecord>(
	records: readonly T[],
	scope: ComputerUseObservationClearScope,
): readonly T[] {
	return records.filter(record => !isObservationRecordInScope(record, scope));
}

/**
 * Removes every rule for an application, so a revocation cannot leave a stale grant behind.
 *
 * Returns a new policy; nothing here mutates. The master switch is untouched: revoking one
 * application is not a statement about the others.
 */
export function revokeObservationRules(
	policy: ComputerUseObservationPolicy,
	appId: string,
): ComputerUseObservationPolicy {
	const normalized = normalizeAppId(appId);
	return {
		...policy,
		rules: (policy.rules ?? []).filter(rule => rule.appId !== normalized),
	};
}
