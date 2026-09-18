/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS,
	COMPUTER_USE_OBSERVATION_DENY_ALL,
	COMPUTER_USE_OBSERVATION_MAX_GRANT_MS,
	COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS,
	COMPUTER_USE_OBSERVATION_MODES,
	COMPUTER_USE_OBSERVATION_OPT_IN_VERSION,
	COMPUTER_USE_OBSERVATION_REFUSALS,
	ComputerUseObservationClearScope,
	ComputerUseObservationPolicy,
	ComputerUseObservationRecord,
	ComputerUseObservationRule,
	asObservableAppId,
	clearObservationHistory,
	createObservationRule,
	decideObservation,
	describeObservationRefusal,
	isObservationEnabled,
	isObservationOptedIn,
	pruneObservationHistory,
	resolveObservationRetentionMs,
	revokeObservationRules,
	sanitizeObservationPolicy,
} from '../../common/computerUseObservation.js';

suite('ComputerUse - ambient observation policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** A fixed "now", so every boundary below is exact rather than nearly. */
	const NOW = 1_800_000_000_000;

	const figma = { id: 'com.figma.Desktop', name: 'Figma' };
	const notes = { id: 'com.apple.Notes', name: 'Notes' };
	const self = { id: 'dev.v3code.code', name: 'V3Code' };

	/** A rule granting `mode` for `app`, granted an hour ago and lasting four. */
	function rule(
		app: { readonly id: string; readonly name?: string },
		mode: 'denied' | 'axTree' | 'axTreeAndScreenshots',
	): ComputerUseObservationRule {
		const created = createObservationRule({
			app,
			mode,
			grantedAt: NOW - 60 * 60 * 1000,
			durationMs: 4 * 60 * 60 * 1000,
		});
		if (created === undefined) {
			throw new Error('fixture rule must be constructible');
		}
		return created;
	}

	/** A fully opted-in, enabled policy carrying the given rules. */
	function policy(rules: readonly ComputerUseObservationRule[]): ComputerUseObservationPolicy {
		return {
			optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION,
			enabled: true,
			retentionMs: COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS,
			rules,
		};
	}

	// -----------------------------------------------------------------------------------------
	// Default deny
	// -----------------------------------------------------------------------------------------

	test('nothing is observed without an opt-in, a master switch, a retention window and a rule', () => {
		const granted = rule(figma, 'axTreeAndScreenshots');
		const full = policy([granted]);
		assert.deepStrictEqual(
			[
				decideObservation(undefined, figma, NOW),
				decideObservation(COMPUTER_USE_OBSERVATION_DENY_ALL, figma, NOW),
				decideObservation({ ...full, optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION - 1 }, figma, NOW),
				decideObservation({ ...full, enabled: false }, figma, NOW),
				decideObservation({ ...full, retentionMs: undefined }, figma, NOW),
				decideObservation({ ...full, rules: [] }, figma, NOW),
				decideObservation(full, notes, NOW),
				decideObservation(full, figma, NOW),
			],
			[
				{ permitted: false, reason: 'notOptedIn' },
				{ permitted: false, reason: 'notOptedIn' },
				{ permitted: false, reason: 'optInVersionStale' },
				{ permitted: false, reason: 'masterSwitchOff' },
				{ permitted: false, reason: 'retentionWindowInvalid' },
				{ permitted: false, reason: 'noRuleForApplication' },
				{ permitted: false, reason: 'noRuleForApplication' },
				{
					permitted: true,
					mode: 'axTreeAndScreenshots',
					permittedUntil: granted.expiresAt,
					discardBefore: NOW - COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS,
				},
			],
		);
	});

	test('a truthy-but-not-true master switch does not enable anything', () => {
		const full = policy([rule(figma, 'axTree')]);
		const coerced = { ...full, enabled: 'true' as unknown as boolean };
		assert.deepStrictEqual(
			[isObservationEnabled(coerced), decideObservation(coerced, figma, NOW)],
			[false, { permitted: false, reason: 'masterSwitchOff' }],
		);
	});

	test('the enablement predicates are false for anything but a current opt-in', () => {
		assert.deepStrictEqual(
			[
				isObservationOptedIn(undefined),
				isObservationOptedIn({ optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION }),
				isObservationEnabled({ optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION }),
				isObservationEnabled({ optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION, enabled: true }),
				isObservationEnabled({ enabled: true }),
			],
			[false, true, false, true, false],
		);
	});

	// -----------------------------------------------------------------------------------------
	// V3Code itself
	// -----------------------------------------------------------------------------------------

	test('V3Code can never be named by a rule, nor observed if one is smuggled in', () => {
		// The branded appId makes a self rule unwritable in TypeScript, so the only way to build one
		// is the cast a corrupt policy blob would effectively perform.
		const smuggled = {
			appId: 'dev.v3code.code',
			mode: 'axTreeAndScreenshots',
			grantedAt: NOW - 1000,
			expiresAt: NOW + 1_000_000,
		} as unknown as ComputerUseObservationRule;

		assert.deepStrictEqual(
			[
				asObservableAppId(self),
				asObservableAppId({ id: 'V3Code' }),
				asObservableAppId({ id: 'code-oss-dev' }),
				asObservableAppId({ id: '   ' }),
				createObservationRule({ app: self, mode: 'axTree', grantedAt: NOW, durationMs: 1000 }),
				decideObservation(policy([smuggled]), self, NOW),
				sanitizeObservationPolicy({ ...policy([]), rules: [smuggled] }).rules,
			],
			[
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ permitted: false, reason: 'selfApplication' },
				[],
			],
		);
	});

	// -----------------------------------------------------------------------------------------
	// Rules
	// -----------------------------------------------------------------------------------------

	test('an explicit denial beats a grant sitting beside it', () => {
		const denied = rule(figma, 'denied');
		const wide = rule(figma, 'axTreeAndScreenshots');
		assert.deepStrictEqual(
			[
				decideObservation(policy([wide, denied]), figma, NOW),
				decideObservation(policy([denied, wide]), figma, NOW),
			],
			[
				{ permitted: false, reason: 'ruleDenies' },
				{ permitted: false, reason: 'ruleDenies' },
			],
		);
	});

	test('the narrowest matching grant wins, whatever order the rules are in', () => {
		const narrow = rule(figma, 'axTree');
		const wide = rule(figma, 'axTreeAndScreenshots');
		const decisions = [
			decideObservation(policy([wide, narrow]), figma, NOW),
			decideObservation(policy([narrow, wide]), figma, NOW),
		];
		assert.deepStrictEqual(
			decisions.map(decision => (decision.permitted ? decision.mode : decision.reason)),
			['axTree', 'axTree'],
		);
	});

	test('rule lookup is case-insensitive but never fuzzy', () => {
		const granted = policy([rule({ id: 'COM.Figma.Desktop' }, 'axTree')]);
		assert.deepStrictEqual(
			[
				decideObservation(granted, { id: 'com.figma.desktop' }, NOW).permitted,
				decideObservation(granted, { id: '  com.figma.Desktop  ' }, NOW).permitted,
				// A prefix must not inherit the grant, or one app's approval covers another's.
				decideObservation(granted, { id: 'com.figma' }, NOW).permitted,
				decideObservation(granted, { id: 'com.figma.Desktop.helper' }, NOW).permitted,
			],
			[true, true, false, false],
		);
	});

	test('a grant expires, and its boundary is exact', () => {
		const granted = rule(figma, 'axTree');
		const at = (nowMs: number) => decideObservation(policy([granted]), figma, nowMs);
		assert.deepStrictEqual(
			[
				at(granted.expiresAt - 1).permitted,
				at(granted.expiresAt).permitted,
				at(granted.expiresAt + 1).permitted,
				at(granted.expiresAt).permitted ? undefined : 'ruleExpired',
			],
			[true, false, false, 'ruleExpired'],
		);
	});

	test('an over-long grant is clamped rather than honoured', () => {
		const greedy = createObservationRule({
			app: figma,
			mode: 'axTree',
			grantedAt: NOW,
			durationMs: 365 * 24 * 60 * 60 * 1000,
		});
		if (greedy === undefined) {
			throw new Error('a clampable grant must still be constructible');
		}
		const decision = decideObservation(policy([greedy]), figma, NOW + 1);
		assert.deepStrictEqual(
			[greedy.expiresAt - greedy.grantedAt, decision.permitted ? decision.permittedUntil : decision.reason],
			[COMPUTER_USE_OBSERVATION_MAX_GRANT_MS, NOW + COMPUTER_USE_OBSERVATION_MAX_GRANT_MS],
		);
	});

	test('a rule with unusable fields denies instead of being skipped', () => {
		const good = rule(figma, 'axTree');
		const badMode = { ...good, mode: 'everything' as unknown as 'axTree' };
		const futureGrant = { ...good, grantedAt: NOW + 60_000, expiresAt: NOW + 120_000 };
		const nonIntegerExpiry = { ...good, expiresAt: Number.NaN };
		assert.deepStrictEqual(
			[
				decideObservation(policy([badMode, good]), figma, NOW),
				decideObservation(policy([futureGrant]), figma, NOW),
				decideObservation(policy([nonIntegerExpiry]), figma, NOW),
				decideObservation(policy([null as unknown as ComputerUseObservationRule]), figma, NOW),
			],
			[
				{ permitted: false, reason: 'malformedRule' },
				{ permitted: false, reason: 'malformedRule' },
				{ permitted: false, reason: 'malformedRule' },
				{ permitted: false, reason: 'noRuleForApplication' },
			],
		);
	});

	test('createObservationRule refuses unusable input', () => {
		assert.deepStrictEqual(
			[
				createObservationRule({ app: figma, mode: 'sneak' as unknown as 'axTree', grantedAt: NOW, durationMs: 1000 }),
				createObservationRule({ app: figma, mode: 'axTree', grantedAt: Number.NaN, durationMs: 1000 }),
				createObservationRule({ app: figma, mode: 'axTree', grantedAt: NOW, durationMs: 0 }),
				createObservationRule({ app: figma, mode: 'axTree', grantedAt: NOW, durationMs: -5 }),
				createObservationRule({ app: { id: '' }, mode: 'axTree', grantedAt: NOW, durationMs: 1000 }),
			],
			[undefined, undefined, undefined, undefined, undefined],
		);
	});

	// -----------------------------------------------------------------------------------------
	// Pause, clock, retention window
	// -----------------------------------------------------------------------------------------

	test('a pause suspends observation, and an unreadable pause is treated as an active one', () => {
		const base = policy([rule(figma, 'axTree')]);
		assert.deepStrictEqual(
			[
				decideObservation({ ...base, pausedUntil: NOW + 1 }, figma, NOW).permitted,
				decideObservation({ ...base, pausedUntil: NOW }, figma, NOW).permitted,
				decideObservation({ ...base, pausedUntil: Number.NaN }, figma, NOW),
			],
			[false, true, { permitted: false, reason: 'paused' }],
		);
	});

	test('an unusable clock reading refuses before anything else is considered', () => {
		const base = policy([rule(figma, 'axTree')]);
		assert.deepStrictEqual(
			[Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5].map(now => decideObservation(base, figma, now)),
			[
				{ permitted: false, reason: 'invalidClock' },
				{ permitted: false, reason: 'invalidClock' },
				{ permitted: false, reason: 'invalidClock' },
				{ permitted: false, reason: 'invalidClock' },
			],
		);
	});

	test('the retention window must be a positive integer inside the hard ceiling', () => {
		const resolve = (retentionMs: unknown) =>
			resolveObservationRetentionMs({ retentionMs: retentionMs as number });
		assert.deepStrictEqual(
			[
				resolveObservationRetentionMs(undefined),
				resolve(undefined),
				resolve(0),
				resolve(-1),
				resolve(1.5),
				resolve('3600000'),
				resolve(COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS),
				resolve(COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS + 1),
				resolve(COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS),
			],
			[
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				COMPUTER_USE_OBSERVATION_MAX_RETENTION_MS,
				undefined,
				COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS,
			],
		);
	});

	// -----------------------------------------------------------------------------------------
	// History
	// -----------------------------------------------------------------------------------------

	test('retention pruning keeps only what is inside the window, and drops everything without one', () => {
		const records: readonly ComputerUseObservationRecord[] = [
			{ appId: 'com.figma.desktop', capturedAt: NOW - COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS - 1 },
			{ appId: 'com.figma.desktop', capturedAt: NOW - COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS },
			{ appId: 'com.figma.desktop', capturedAt: NOW - COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS + 1 },
			{ appId: 'com.apple.notes', capturedAt: NOW },
			{ appId: 'com.apple.notes', capturedAt: Number.NaN },
		];
		const withWindow = policy([]);
		assert.deepStrictEqual(
			[
				pruneObservationHistory(records, withWindow, NOW).map(r => r.capturedAt),
				pruneObservationHistory(records, { ...withWindow, retentionMs: undefined }, NOW),
				pruneObservationHistory(records, undefined, NOW),
				pruneObservationHistory(records, withWindow, Number.NaN),
			],
			[
				// The record exactly on the boundary is dropped: ties go to deleting.
				[NOW - COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS + 1, NOW],
				[],
				[],
				[],
			],
		);
	});

	test('clearing history covers everything, one app, or an inclusive time range', () => {
		const records: readonly ComputerUseObservationRecord[] = [
			{ appId: 'com.figma.desktop', capturedAt: 100 },
			{ appId: 'com.figma.desktop', capturedAt: 200 },
			{ appId: 'com.apple.notes', capturedAt: 300 },
			{ appId: 'com.apple.notes', capturedAt: 400 },
		];
		const surviving = (scope: ComputerUseObservationClearScope) =>
			clearObservationHistory(records, scope).map(r => `${r.appId}@${r.capturedAt}`);
		assert.deepStrictEqual(
			[
				surviving({ kind: 'all' }),
				surviving({ kind: 'app', appId: 'COM.Figma.Desktop' }),
				surviving({ kind: 'app', appId: 'com.unknown.App' }),
				surviving({ kind: 'timeRange', fromMs: 200, toMs: 300 }),
				surviving({ kind: 'timeRange', fromMs: 0, toMs: 0 }),
				// An inverted or unusable range clears everything, never nothing.
				surviving({ kind: 'timeRange', fromMs: 400, toMs: 100 }),
				surviving({ kind: 'timeRange', fromMs: Number.NaN, toMs: 500 }),
			],
			[
				[],
				['com.apple.notes@300', 'com.apple.notes@400'],
				['com.figma.desktop@100', 'com.figma.desktop@200', 'com.apple.notes@300', 'com.apple.notes@400'],
				['com.figma.desktop@100', 'com.apple.notes@400'],
				['com.figma.desktop@100', 'com.figma.desktop@200', 'com.apple.notes@300', 'com.apple.notes@400'],
				[],
				[],
			],
		);
	});

	test('revoking an application drops its rules and leaves the others alone', () => {
		const before = policy([rule(figma, 'axTree'), rule(notes, 'axTreeAndScreenshots')]);
		const after = revokeObservationRules(before, 'COM.Figma.Desktop');
		assert.deepStrictEqual(
			[
				after.rules?.map(r => r.appId),
				after.enabled,
				decideObservation(after, figma, NOW),
				decideObservation(after, notes, NOW).permitted,
			],
			[
				['com.apple.notes'],
				true,
				{ permitted: false, reason: 'noRuleForApplication' },
				true,
			],
		);
	});

	// -----------------------------------------------------------------------------------------
	// Sanitization
	// -----------------------------------------------------------------------------------------

	test('sanitizing junk yields a policy that permits nothing', () => {
		const results = [undefined, null, 42, 'policy', [], { rules: 'nope' }].map(raw => {
			const sanitized = sanitizeObservationPolicy(raw);
			return [sanitized.optInVersion, sanitized.enabled, sanitized.retentionMs, sanitized.rules?.length];
		});
		assert.deepStrictEqual(results, [
			[undefined, undefined, undefined, undefined],
			[undefined, undefined, undefined, undefined],
			[undefined, undefined, undefined, undefined],
			[undefined, undefined, undefined, undefined],
			[undefined, false, undefined, 0],
			[undefined, false, undefined, 0],
		]);
	});

	test('sanitizing keeps only affirmatively valid rules, and re-clamps their expiry', () => {
		const sanitized = sanitizeObservationPolicy({
			optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION,
			enabled: true,
			retentionMs: COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS,
			pausedUntil: 'soon',
			rules: [
				{ appId: 'com.figma.Desktop', mode: 'axTree', grantedAt: NOW, expiresAt: NOW + 1000 },
				// Expiry a year out: clamped back to the grant ceiling.
				{ appId: 'com.apple.Notes', mode: 'axTree', grantedAt: NOW, expiresAt: NOW + 31_536_000_000 },
				{ appId: 'dev.v3code.code', mode: 'axTree', grantedAt: NOW, expiresAt: NOW + 1000 },
				{ appId: 'com.bad.Mode', mode: 'everything', grantedAt: NOW, expiresAt: NOW + 1000 },
				{ appId: 'com.bad.Time', mode: 'axTree', grantedAt: 'now', expiresAt: NOW + 1000 },
				{ appId: 42, mode: 'axTree', grantedAt: NOW, expiresAt: NOW + 1000 },
				null,
			],
		});
		assert.deepStrictEqual(sanitized, {
			optInVersion: COMPUTER_USE_OBSERVATION_OPT_IN_VERSION,
			enabled: true,
			retentionMs: COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS,
			pausedUntil: undefined,
			rules: [
				{ appId: 'com.figma.desktop', mode: 'axTree', grantedAt: NOW, expiresAt: NOW + 1000 },
				{
					appId: 'com.apple.notes',
					mode: 'axTree',
					grantedAt: NOW,
					expiresAt: NOW + COMPUTER_USE_OBSERVATION_MAX_GRANT_MS,
				},
			],
		});
	});

	test('a sanitized round trip through storage still permits what it permitted', () => {
		const granted = rule(figma, 'axTreeAndScreenshots');
		const round = sanitizeObservationPolicy(JSON.parse(JSON.stringify(policy([granted]))));
		assert.deepStrictEqual(decideObservation(round, figma, NOW), {
			permitted: true,
			mode: 'axTreeAndScreenshots',
			permittedUntil: granted.expiresAt,
			discardBefore: NOW - COMPUTER_USE_OBSERVATION_DEFAULT_RETENTION_MS,
		});
	});

	// -----------------------------------------------------------------------------------------
	// Vocabulary completeness
	// -----------------------------------------------------------------------------------------

	test('every refusal reason has a description and every mode is ranked', () => {
		assert.deepStrictEqual(
			[
				COMPUTER_USE_OBSERVATION_REFUSALS.length,
				COMPUTER_USE_OBSERVATION_REFUSALS.filter(reason => describeObservationRefusal(reason).length > 0).length,
				new Set(COMPUTER_USE_OBSERVATION_REFUSALS.map(describeObservationRefusal)).size,
				COMPUTER_USE_OBSERVATION_MODES,
			],
			[11, 11, 11, ['denied', 'axTree', 'axTreeAndScreenshots']],
		);
	});

	test('the deny-all policy is frozen so it cannot be turned into a grant', () => {
		assert.deepStrictEqual(
			[Object.isFrozen(COMPUTER_USE_OBSERVATION_DENY_ALL), isObservationEnabled(COMPUTER_USE_OBSERVATION_DENY_ALL)],
			[true, false],
		);
	});
});
