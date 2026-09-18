/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3Code account service — the editor half of the editor <-> v3code.dev auth loop.
 *
 * The editor ships free (guest / BYOK works with no account). Paid tiers are unlocked
 * by signing into the hub at v3code.dev. The loop:
 *
 *   1. signIn() / openPlans(tier) open v3code.dev/login with query params
 *      `source=editor`, `next=/editor/handoff`, and (for a plan card) `tier=<tier>`.
 *   2. After the user authenticates on the web, the hub handoff page mints a
 *      short-lived one-time code and deep-links back into the editor via the
 *      `v3code://auth/callback?code=<code>` protocol URL (handled by
 *      v3codeAuthUrlHandler and forwarded to completeSignIn).
 *   3. completeSignIn(code) exchanges the code at `${hubApiUrl}/api/editor/exchange`
 *      for a Supabase access token, stores it in ISecretStorageService, and calls
 *      refreshFromHub().
 *   4. refreshFromHub() reads `/api/profile` + `/api/billing/status` with the bearer
 *      token and updates the account state (display name + tier). The profile button
 *      and the Settings Account tab already render from that state.
 *
 * A missing/expired/invalid token always degrades cleanly back to the signed-out
 * guest state — nothing here can break the free BYOK path.
 *
 * Message preferences + privacy mode persist through IStorageService at APPLICATION
 * scope (machine-wide, survives workspace switches).
 */

import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, type AppResourcePath } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { HostedInferenceOverride } from './sendLLMMessageTypes.js';

/** Chrome-V brand mark — guest / no-photo fallback (never green/purple letter blobs). */
const V3_CHROME_AVATAR_URL = FileAccess.asBrowserUri(
	'vs/workbench/browser/parts/editor/media/v3code_logo_chrome.png' as AppResourcePath,
).toString(true);

export type V3CodeAccountStatus = 'signedOut' | 'signedIn';

/**
 * Paid tiers a plan card can request. These are the hub's billing/checkout keys
 * (starter/pro/power) — the value travels through to POST /api/billing/create-checkout,
 * which only understands those three. `power` is the top ("Max") tier.
 */
export type V3CodePlanTier = 'starter' | 'pro' | 'power';

/** One lane burn-bar of the hosted usage meter (mirrors hub /api/usage/summary classes). */
export interface IV3CodeCreditClass {
	readonly id: string;
	/** 0-100, this lane's share of the monthly plan usage. */
	readonly percentOfBudget: number;
	readonly events: number;
}

/**
 * On-demand overage opt-in (paid plans). Managed on the website; the editor
 * only mirrors the hub snapshot so it can soft-stop and deep-link correctly.
 */
export interface IV3CodeOverageState {
	readonly enabled: boolean;
	readonly capUsd: number;
	readonly accruedUsd: number;
}

/**
 * Monthly hosted usage meter (paid plans only). Percentages + a friendly
 * label ONLY — dollar and token values never reach a customer surface.
 */
export interface IV3CodeCreditState {
	readonly percentUsed: number;
	readonly remainingLabel: string;
	readonly classes: readonly IV3CodeCreditClass[];
	/** Present when the hub returned an overage block (even if disabled). */
	readonly overage?: IV3CodeOverageState;
}

export interface IV3CodeAccountState {
	readonly status: V3CodeAccountStatus;
	readonly displayName: string;
	/** Profile image (data URL or https) from hub /api/profile; null = letter fallback. */
	readonly avatarUrl: string | null;
	readonly tierLabel: string;
	/** Raw hub tier id ('free' | 'starter' | 'pro' | 'ultra'). */
	readonly tierId: string;
	/**
	 * True when the hub reports an active subscription OR trial (billing
	 * is_active). This is the LIVE entitlement paid features gate on — it
	 * self-revokes when the plan lapses, unlike a stored setting.
	 */
	readonly isPaid: boolean;
	/** 'hosted' when the account uses SuperClaw AI inference; 'byok' otherwise. */
	readonly inferenceMode: 'byok' | 'hosted' | null;
	/** Hosted token meter (null unless hosted + active plan — mirrors /api/profile). */
	readonly hostedTokensRemaining: number | null;
	readonly hostedTokensUsed: number | null;
	readonly hostedMonthlyLimit: number | null;
	/** Hosted usage meter — present only when the hub reports an active paid meter. */
	readonly credit?: IV3CodeCreditState;
	/**
	 * The stored login was refused and cannot recover on its own, but a trusted paid
	 * plan is still being honoured. The user keeps their plan on screen and is asked
	 * to sign in again, rather than being told everything is fine while every request
	 * fails. Cleared as soon as a renew or a fresh sign-in succeeds.
	 */
	readonly sessionExpired?: boolean;
}

export interface V3CodeCloudIndexRepository {
	repositoryLocator: string;
	displayName: string;
	provider: 'github' | 'gitlab' | 'bitbucket' | 'git';
	defaultBranch?: string;
	branchName?: string;
	shareable?: boolean;
}

export interface V3CodeCloudIndexSession {
	endpoint: string;
	workspaceId: string;
	readToken: string;
	writeToken?: string;
	syncMode: 'base-writer' | 'read-only';
	expiresAt: number;
	privacyMode: 'full' | 'vectors-only' | 'ephemeral';
	indexProfile: 'standard' | 'advanced';
	team: { id: string; name: string; kind: 'personal' | 'team' };
	repository: { id: string; displayName: string; locator: string };
}

const GUEST_STATE: IV3CodeAccountState = {
	status: 'signedOut', displayName: 'Guest', avatarUrl: null, tierLabel: 'Free', tierId: 'free', isPaid: false,
	inferenceMode: null, hostedTokensRemaining: null, hostedTokensUsed: null, hostedMonthlyLimit: null,
};

/** The four message-preference toggles shown in the Settings Account tab. */
export const v3codeMessagePrefKeys = ['productUpdates', 'releaseNotes', 'tipsAndTutorials', 'surveys'] as const;
export type V3CodeMessagePrefKey = typeof v3codeMessagePrefKeys[number];

export const displayInfoOfMessagePref: { [K in V3CodeMessagePrefKey]: { title: string; description: string } } = {
	productUpdates: { title: 'Product updates', description: 'New features and important product announcements.' },
	releaseNotes: { title: 'Release notes', description: 'Show release notes after updates.' },
	tipsAndTutorials: { title: 'Tips & tutorials', description: 'Occasional tips to get more out of V3Code.' },
	surveys: { title: 'Surveys & research', description: 'Invitations to short feedback surveys.' },
};

export interface IV3CodeAccountService {
	readonly _serviceBrand: undefined;

	/** Current account snapshot. Defaults to a signed-out guest until a hub session lands. */
	readonly state: IV3CodeAccountState;
	readonly onDidChangeState: Event<void>;

	/** Fires when a message pref or privacy mode changes (any key). */
	readonly onDidChangePrefs: Event<void>;

	/** Open the account management page (hub /account when signed in, else the login handoff). */
	manageAccount(): void;
	/**
	 * Open the account page focused on on-demand overage (included plan usage exhausted).
	 * Website owns the enable/cap UI; editor never flips overage locally.
	 */
	openOverageSettings(): void;
	/** Open the sign-in handoff (v3code.dev/login → editor deep-link). */
	signIn(): void;
	/** Clear the local hub session and fall back to guest. */
	signOut(): void;
	/** Open the plans/upgrade flow. When a tier is given, it is carried into checkout. */
	openPlans(tier?: V3CodePlanTier): void;
	/** Bounded post-checkout reconcile poll so a purchase activates in the editor promptly.
	 *  Started automatically by openPlans and the billing/complete deep link. */
	beginPurchaseActivationWatch(): void;

	/**
	 * True when the user is on a paid plan, the hub meter reports included usage
	 * exhausted (~100%), and on-demand overage is not enabled. Plan-lane sends
	 * must soft-stop and CTA to the website — never silent BYOK.
	 */
	isPlanCreditExhausted(): boolean;

	/** User-facing copy when a plan model is blocked for exhausted included usage. */
	planCreditExhaustedMessage(): string;

	/**
	 * Complete a sign-in started on the web: exchange the one-time code from the
	 * `v3code://auth/callback` deep-link for a session, then refresh from the hub.
	 * Resolves to true when a session was established.
	 */
	completeSignIn(code: string): Promise<boolean>;
	/** Re-read profile + entitlements from the hub using the stored token. */
	refreshFromHub(): Promise<void>;

	/** Nudge a fast (debounced) meter refresh after a hosted turn, so the % bars move in
	 *  near-real-time instead of waiting for the 10-min routine reconcile. */
	refreshUsageSoon(): void;

	/** Submit editor feedback/issue to the hub inbox (POST /api/feedback), so it lands in the
	 *  admin panel instead of an email. Returns true on success; false if signed out or the
	 *  request fails (caller falls back to mailto). */
	submitFeedback(payload: { category?: string; severity?: string; message: string; context?: Record<string, unknown> }): Promise<boolean>;

	/** The live hub access token, for authing hosted inference through the hub —
	 *  PAID plans only; undefined when signed out or on a free account (a free
	 *  account must never hold an inference-capable hub bearer). NEVER persisted
	 *  into provider settings; injected per request so it stays fresh (the token
	 *  auto-refreshes). */
	getAccessToken(): string | undefined;

	/** Provision an ephemeral paid-plan V3Index session for this Git identity.
	 *  The result is memory-only and expires after 15 minutes; cloud credentials
	 *  are never written to user/workspace configuration. */
	getCloudIndexSession(repository: V3CodeCloudIndexRepository): Promise<V3CodeCloudIndexSession | undefined>;

	/** Build the hosted-inference override for a paid request on the given canonical wire
	 *  model ("provider/model"), or undefined when the user is not eligible (signed out /
	 *  no active plan). The token is injected fresh per request, never persisted. */
	getHostedInferenceOverride(wireModel: string): HostedInferenceOverride | undefined;

	/** Silent, bounded, never-throws: make the hub session usable for a hosted send
	 *  RIGHT NOW — waits for the launch restore, renews a missing/stale access token,
	 *  and re-reads entitlement once if the state does not yet say paid. Call before
	 *  refusing a plan-model send so a paying user is never blocked by a token that
	 *  was simply mid-renew. */
	ensureHostedAccess(): Promise<void>;

	/** Called by the send path when a HOSTED (paid) request returns 401: the account token is
	 *  stale or revoked. Force-refresh it once. 'renewed' -> caller retries with the fresh token
	 *  (silent to the user); 'transient' -> keep the session, ask the user to retry; 'rejected' ->
	 *  the session is genuinely dead, so this CLEANLY SIGNS OUT rather than leave the user in the
	 *  "signed in but every key looks bad" limbo. */
	refreshForHostedSend(): Promise<'renewed' | 'transient' | 'rejected'>;

	getMessagePref(key: V3CodeMessagePrefKey): boolean;
	setMessagePref(key: V3CodeMessagePrefKey, value: boolean): void;

	getPrivacyMode(): boolean;
	setPrivacyMode(value: boolean): void;
}

export const IV3CodeAccountService = createDecorator<IV3CodeAccountService>('v3codeAccountService');

const STORAGE_PREFIX = 'v3code.account.pref.';
const PRIVACY_MODE_KEY = 'v3code.account.privacyMode';
/** OS-keychain-backed key for the hub access token. */
const TOKEN_SECRET_KEY = 'v3code.account.hubToken';
const REFRESH_TOKEN_SECRET_KEY = 'v3code.account.hubRefreshToken';

// Public Supabase project config (the anon key is DESIGNED to ship in clients — it is not a
// secret). Overridable via product.json (supabaseUrl / supabaseAnonKey). The editor refreshes
// its own access token directly against Supabase with these, exactly like a browser client, so
// a signed-in user stays signed in across restarts (refresh tokens don't expire — they rotate).
const FALLBACK_SUPABASE_URL = 'https://pbezbamyzmxrdblhxvot.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBiZXpiYW15em14cmRibGh4dm90Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNzI4MzUsImV4cCI6MjA4OTk0ODgzNX0.3gQFl5mXK0wYYwjZu15zJDSdgDCeKqT98_RkuIZFoa0';
// Supabase access tokens default to a 1h life; renew well inside that and let a 401 backstop
// cover the edge (e.g. the laptop slept past expiry).
const TOKEN_RENEW_INTERVAL_MS = 45 * 60 * 1000;
/** Persisted last-known entitlement so a paying user never flashes "Free" on launch. */
const CACHED_STATE_KEY = 'v3code.account.cachedState';
// When any window rotates the session it stamps this. Refresh tokens are single-use,
// and Supabase answers a reuse by revoking the whole family, so a sibling that rotated
// this recently is assumed to hold the only live token.
const ROTATION_STAMP_KEY = 'v3code.account.lastRotationAt';
const ROTATION_QUIET_MS = 15 * 1000;
// How long a hosted send trusts "the session is dead" before probing the network again.
const HOSTED_REFRESH_REJECT_COOLDOWN_MS = 30 * 1000;
/** How long a cached paid entitlement is trusted for optimistic display without a fresh verify. */
const CACHED_STATE_TRUST_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Self-healing entitlement reconcile. A paid user must NEVER be stranded on "Free" by a
// transient hub failure until they relaunch — so after the startup handshake we keep
// re-checking: a steady 10-min routine refresh, and a fast exponential backoff after any
// non-authoritative failure until the hub answers again.
const ROUTINE_REFRESH_MS = 10 * 60 * 1000; // 10 min steady-state reconcile
const RETRY_MIN_MS = 15 * 1000;            // first backoff step
const RETRY_MAX_MS = 5 * 60 * 1000;        // backoff cap
// After a hosted turn, re-read the meter fast so the % bars move near-live (the server already
// recorded the spend per request; this is display only). Debounced so a burst of turns coalesces.
const USAGE_REFRESH_DEBOUNCE_MS = 2500;

// Canonical hosts. product.json is the source of truth; these are only fallbacks and
// must stay consistent with it (single canonical login host: v3code.dev).
const FALLBACK_SIGN_IN_URL = 'https://app.v3code.dev/login';
const FALLBACK_PLANS_URL = 'https://app.v3code.dev/pricing';
const FALLBACK_HUB_API_URL = 'https://backend-production-fc598.up.railway.app';

/** Where the web login should send the user back so the editor can complete sign-in. */
const EDITOR_HANDOFF_PATH = '/editor/handoff';

/**
 * Human labels for the hub plan tiers (2026 free-first pricing — matches the hub
 * PLAN_LABELS). Backend/checkout ids stay starter/pro/power; only display changed:
 * starter = "Pro" $20, pro = "Power" $40, power = "Max" $100.
 */
const PLAN_LABELS: Record<string, string> = {
	free: 'Free',
	starter: 'Pro',
	pro: 'Power',
	power: 'Max',
	// hub-side alias for the top tier
	ultra: 'Max',
};

class V3CodeAccountService extends Disposable implements IV3CodeAccountService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidChangePrefs = this._register(new Emitter<void>());
	readonly onDidChangePrefs = this._onDidChangePrefs.event;

	private _state: IV3CodeAccountState = GUEST_STATE;
	/**
	 * Always surface a usable avatarUrl. Hub photo when present; otherwise the
	 * chrome V mark so Free/Guest never falls back to an ugly colored letter.
	 */
	get state(): IV3CodeAccountState {
		if (this._state.avatarUrl) {
			return this._state;
		}
		return { ...this._state, avatarUrl: V3_CHROME_AVATAR_URL };
	}

	getAccessToken(): string | undefined {
		// Hub inference bearer — paid plans only (mirrors getHostedInferenceOverride's
		// gate). A free account must never hold an inference-capable hub token.
		// Profile/billing/feedback calls use this._token internally and are unaffected.
		return this._state.status === 'signedIn' && this._state.isPaid ? this._token : undefined;
	}

	async getCloudIndexSession(repository: V3CodeCloudIndexRepository): Promise<V3CodeCloudIndexSession | undefined> {
		if (this.getPrivacyMode()) return undefined;
		await this.ensureHostedAccess();
		// Trials can use hosted inference, but Cloud Index is a paid-plan product.
		if (this._state.status !== 'signedIn' || !this._state.isPaid || this._state.tierId === 'free' || !this._token) {
			return undefined;
		}
		return this._requestCloudIndexSession(repository, true);
	}

	private async _requestCloudIndexSession(
		repository: V3CodeCloudIndexRepository,
		allowRenew: boolean,
	): Promise<V3CodeCloudIndexSession | undefined> {
		if (!this._token) return undefined;
		try {
			const context = await this.requestService.request({
				type: 'POST',
				url: `${this.hubApiUrl}/api/index/session`,
				headers: { Authorization: `Bearer ${this._token}`, 'Content-Type': 'application/json' },
				data: JSON.stringify(repository),
				callSite: 'v3code.account.cloudIndexSession',
			}, CancellationToken.None);
			const status = context.res.statusCode ?? 0;
			if (status === 401 && allowRenew) {
				const renew = await this._refreshAccessToken();
				return renew === 'renewed' ? this._requestCloudIndexSession(repository, false) : undefined;
			}
			if (status === 403) {
				this.logService.info('[v3code-account] cloud index is not included in the current plan');
				return undefined;
			}
			if (status < 200 || status >= 300) {
				throw new Error(`hub returned HTTP ${status}`);
			}

			const body = await asJson<{
				endpoint?: string;
				workspaceId?: string;
				readToken?: string;
				writeToken?: string;
				indexProfile?: string;
				privacyMode?: string;
				expiresAt?: string;
				team?: { id?: string; name?: string; kind?: string };
				repository?: { id?: string; display_name?: string; repository_locator?: string; privacy_mode?: string };
			}>(context);
			const expiresAt = Date.parse(body?.expiresAt ?? '');
			if (
				!body?.endpoint || !/^https:\/\//i.test(body.endpoint) ||
				!body.workspaceId || !/^[A-Za-z0-9_-]{1,64}$/.test(body.workspaceId) ||
				!body.readToken?.startsWith('v3s_') || (body.writeToken !== undefined && !body.writeToken?.startsWith('v3s_')) ||
				!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000 ||
				!body.team?.id || !body.team.name || (body.team.kind !== 'personal' && body.team.kind !== 'team') ||
				!body.repository?.id || !body.repository.display_name || !body.repository.repository_locator
			) {
				throw new Error('hub returned a malformed cloud index session');
			}
			const indexProfile = body.indexProfile === 'advanced' ? 'advanced' : 'standard';
			const privacyMode = body.privacyMode === 'ephemeral'
				? 'ephemeral'
				: body.privacyMode === 'vectors-only'
					? 'vectors-only'
					: body.repository.privacy_mode === 'vectors-only' ? 'vectors-only' : 'full';
			if ((indexProfile === 'advanced' && privacyMode !== 'ephemeral') || (indexProfile === 'standard' && privacyMode === 'ephemeral')) {
				throw new Error('hub returned an inconsistent cloud index profile');
			}
			return {
				endpoint: body.endpoint.replace(/\/+$/, ''),
				workspaceId: body.workspaceId,
				readToken: body.readToken,
				writeToken: body.writeToken,
				syncMode: body.writeToken ? 'base-writer' : 'read-only',
				expiresAt,
				privacyMode,
				indexProfile,
				team: { id: body.team.id, name: body.team.name, kind: body.team.kind },
				repository: {
					id: body.repository.id,
					displayName: body.repository.display_name,
					locator: body.repository.repository_locator,
				},
			};
		} catch (err) {
			this.logService.warn('[v3code-account] cloud index session provisioning failed', err);
			return undefined;
		}
	}

	getHostedInferenceOverride(wireModel: string): HostedInferenceOverride | undefined {
		// Gate on the LIVE entitlement (isPaid mirrors billing is_active), not a stored flag,
		// so a lapsed plan stops routing through the hub immediately.
		if (this._state.status !== 'signedIn' || !this._state.isPaid || !this._token) {
			return undefined;
		}
		return { endpoint: `${this.hubApiUrl}/api/inference/v1`, token: this._token, wireModel };
	}

	async ensureHostedAccess(): Promise<void> {
		try {
			// Never let a hung network call hang the send — validation is best-effort.
			await raceTimeout(this._ensureHostedAccess(), 8000);
		} catch (err) {
			this.logService.warn('[v3code-account] ensureHostedAccess failed', err);
		}
	}

	async refreshForHostedSend(): Promise<'renewed' | 'transient' | 'rejected'> {
		// Once the session is genuinely dead, the background features keep sending -
		// autocomplete and next-edit fire per keystroke, Turbo Draft on idle - and each
		// 401 asks for another renew. That turns typing into a network round trip per
		// character. Answer those locally for a short while; a real sign-in clears it
		// immediately via the 'renewed' branch below.
		if (this._hostedRefreshRejectedAt && Date.now() - this._hostedRefreshRejectedAt < HOSTED_REFRESH_REJECT_COOLDOWN_MS) {
			return 'rejected';
		}
		const result = await this._refreshAccessToken();
		if (result === 'renewed') {
			this._hostedRefreshRejectedAt = 0;
			// Token is fresh again; the retry picks it up immediately via getHostedInferenceOverride.
			// Re-confirm entitlement in the background — do not block the retry on it.
			void this.refreshFromHub();
		} else if (result === 'rejected') {
			// The refresh token itself was refused (revoked / signed out on another device) — the
			// session is genuinely dead. Sign out CLEANLY so the user gets a clear "sign in again"
			// state instead of the confusing "every key is bad / you're on Free" limbo.
			this._hostedRefreshRejectedAt = Date.now();
			this.logService.info('[v3code-account] hosted send: refresh token revoked -> clean sign-out');
			this.signOut();
		}
		return result;
	}

	private async _ensureHostedAccess(): Promise<void> {
		await this._sessionRestore;
		// Already good — the common case; costs nothing.
		if (this._token && this._state.status === 'signedIn' && this._state.isPaid) { return; }
		// Missing/expired access token but we hold (or a sibling window persisted) a
		// refresh token — mint a fresh one now instead of failing the user's send.
		if (!this._token) {
			await this._refreshAccessToken();
		}
		// Token exists but the state does not say paid yet (fresh sign-in, cache expiry,
		// or an earlier offline launch) — ask the hub who this user actually is.
		if (this._token && (this._state.status !== 'signedIn' || !this._state.isPaid)) {
			await this.refreshFromHub();
		}
	}

	private _token: string | undefined;

	// The rotation stamp this window wrote, so it never mistakes its own for a sibling's.
	private _lastOwnRotationStamp = 0;

	// When a hosted send last learned the session was dead, so the background features
	// stop paying a network round trip each to rediscover it.
	private _hostedRefreshRejectedAt = 0;

	// Self-healing reconcile timer + its current backoff step (see refreshFromHub).
	private _refreshTimer: ReturnType<typeof setTimeout> | undefined;
	// Debounced post-turn meter refresh (see refreshUsageSoon).
	private _usageRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private _refreshBackoffMs = 0;

	// Supabase session persistence: the rotating refresh token + the proactive-renew timer,
	// plus a guard so a 401 only triggers ONE renew+retry cycle (no recursion loop).
	private _refreshToken: string | undefined;
	private _tokenRenewTimer: ReturnType<typeof setTimeout> | undefined;
	private _renewedThisCall = false;
	// Single-flight guard so concurrent callers never double-spend the rotating refresh token.
	private _refreshInFlight: Promise<'renewed' | 'rejected' | 'transient'> | undefined;
	// Resolves when the launch-time session restore has settled (signed in OR guest),
	// so on-demand validation (ensureHostedAccess) never races the restore.
	private _sessionRestore: Promise<void> = Promise.resolve();

	constructor(
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService,
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		// Optimistic entitlement: show the last-known plan INSTANTLY so a paying user never
		// flashes "Free" while the (late, multi-round-trip) hub handshake is in flight. The
		// background refresh below reconciles; _restoreSession downgrades to guest if the
		// token is gone, and a real cancellation is caught by the 401 / is_active:false paths.
		this._hydrateCachedState();
		// Restore any prior hub session in the background.
		this._sessionRestore = this._restoreSession();
		// Secret writes are broadcast to every window. When a sibling rotates the session
		// or the user signs in anywhere, adopt it the moment it lands instead of finding
		// out only when our own token is refused - which is what made two windows fight
		// over one single-use token. This also heals a window that had already given up:
		// one sign-in anywhere brings all of them back.
		this._register(this.secretStorageService.onDidChangeSecret(key => {
			if (key !== REFRESH_TOKEN_SECRET_KEY && key !== TOKEN_SECRET_KEY) { return; }
			void (async () => {
				const adopted = await this._adoptStoredTokensIfNewer();
				if (adopted === 'none') { return; } // our own write, or nothing new
				if (this._state.sessionExpired) {
					this._state = { ...this._state, sessionExpired: false };
					this._onDidChangeState.fire();
				}
			})();
		}));
		this._register(toDisposable(() => {
			if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = undefined; }
			if (this._usageRefreshTimer) { clearTimeout(this._usageRefreshTimer); this._usageRefreshTimer = undefined; }
			if (this._tokenRenewTimer) { clearTimeout(this._tokenRenewTimer); this._tokenRenewTimer = undefined; }
			if (this._activationWatchTimer) { clearTimeout(this._activationWatchTimer); this._activationWatchTimer = undefined; }
			this._activationWatchUntil = 0; // a tick already past its setTimeout can't reschedule either
		}));
	}

	/** Schedule the next entitlement reconcile. On an authoritative success we settle into the
	 *  slow routine cadence; after any non-authoritative failure we back off exponentially and
	 *  keep retrying, so a transient hub outage self-heals without the user relaunching. */
	private _scheduleNextRefresh(authoritative: boolean): void {
		if (this._refreshTimer) { clearTimeout(this._refreshTimer); }
		let delay: number;
		if (authoritative) {
			this._refreshBackoffMs = 0;
			delay = ROUTINE_REFRESH_MS;
		} else {
			this._refreshBackoffMs = this._refreshBackoffMs ? Math.min(this._refreshBackoffMs * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
			delay = this._refreshBackoffMs;
		}
		this._refreshTimer = setTimeout(() => {
			this._refreshTimer = undefined;
			if (this._token) {
				void this.refreshFromHub();
			} else if (this._refreshToken) {
				// Holding a plan on an expired/absent access token — re-mint before reconciling.
				void this._refreshAccessToken().then(renew => {
					if (renew === 'renewed') { void this.refreshFromHub(); }
					else if (renew === 'rejected') { this._handleRejectedToken(); }
				});
			}
		}, delay);
	}

	/** Load the persisted entitlement into state synchronously (constructor-time) so the first
	 *  render shows the real plan, not the free default. No event: consumers read .state on first
	 *  touch, which is after this runs. */
	private _hydrateCachedState(): void {
		try {
			const raw = this.storageService.get(CACHED_STATE_KEY, StorageScope.APPLICATION);
			if (!raw) { return; }
			const cached = JSON.parse(raw) as Partial<IV3CodeAccountState> & { cachedAt?: number };
			if (cached?.status !== 'signedIn' || typeof cached.cachedAt !== 'number') { return; }
			if (Date.now() - cached.cachedAt > CACHED_STATE_TRUST_MS) { return; }
			this._state = {
				status: 'signedIn',
				displayName: cached.displayName ?? 'V3Code User',
				avatarUrl: (typeof cached.avatarUrl === 'string' && cached.avatarUrl.startsWith('https:')) ? cached.avatarUrl : null,
				tierLabel: cached.tierLabel ?? 'Free',
				tierId: cached.tierId ?? 'free',
				isPaid: cached.isPaid === true,
				inferenceMode: cached.inferenceMode ?? null,
				hostedTokensRemaining: null,
				hostedTokensUsed: null,
				hostedMonthlyLimit: null,
				credit: undefined,
			};
		} catch (err) {
			this.logService.warn('[v3code-account] failed to hydrate cached account state', err);
		}
	}

	/** Persist (or clear) the resolved entitlement for the next launch's optimistic render.
	 *  Meters/credit are intentionally NOT cached (staleness-sensitive). */
	private _persistState(): void {
		try {
			if (this._state.status !== 'signedIn') {
				this.storageService.remove(CACHED_STATE_KEY, StorageScope.APPLICATION);
				return;
			}
			const s = this._state;
			const payload = {
				status: s.status,
				displayName: s.displayName,
				avatarUrl: (typeof s.avatarUrl === 'string' && s.avatarUrl.startsWith('https:')) ? s.avatarUrl : null,
				tierLabel: s.tierLabel,
				tierId: s.tierId,
				isPaid: s.isPaid,
				inferenceMode: s.inferenceMode,
				cachedAt: Date.now(),
			};
			this.storageService.store(CACHED_STATE_KEY, JSON.stringify(payload), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (err) {
			this.logService.warn('[v3code-account] failed to persist cached account state', err);
		}
	}

	// ---- product.json-driven config (with safe fallbacks) --------------------------------

	/** Marketing site is v3code.dev; auth + billing live on app.v3code.dev. */
	private resolveHubWebUrl(raw: string, fallback: string): string {
		const url = raw || fallback;
		try {
			const parsed = new URL(url);
			if (parsed.hostname === 'v3code.dev' || parsed.hostname === 'www.v3code.dev') {
				parsed.hostname = 'app.v3code.dev';
			}
			return parsed.toString();
		} catch {
			return fallback;
		}
	}

	private get signInUrl(): string {
		const raw = (this.productService as { signInUrl?: string }).signInUrl ?? FALLBACK_SIGN_IN_URL;
		return this.resolveHubWebUrl(raw, FALLBACK_SIGN_IN_URL);
	}

	private get plansUrl(): string {
		const raw = (this.productService as { plansUrl?: string }).plansUrl ?? FALLBACK_PLANS_URL;
		return this.resolveHubWebUrl(raw, FALLBACK_PLANS_URL);
	}

	private get hubApiUrl(): string {
		const raw = (this.productService as { hubApiUrl?: string }).hubApiUrl ?? FALLBACK_HUB_API_URL;
		return raw.replace(/\/+$/, '');
	}

	/** Public Supabase project URL — the editor refreshes its access token against it directly. */
	private get supabaseUrl(): string {
		const raw = (this.productService as { supabaseUrl?: string }).supabaseUrl ?? FALLBACK_SUPABASE_URL;
		return raw.replace(/\/+$/, '');
	}

	/** Public Supabase anon key (safe to ship — it's meant to be a client key). */
	private get supabaseAnonKey(): string {
		return (this.productService as { supabaseAnonKey?: string }).supabaseAnonKey ?? FALLBACK_SUPABASE_ANON_KEY;
	}

	/** Origin of the web hub, derived from the login URL (e.g. https://v3code.dev). */
	private get hubWebOrigin(): string {
		try {
			return new URL(this.signInUrl).origin;
		} catch {
			return 'https://app.v3code.dev';
		}
	}

	// ---- outward navigation (editor -> web) ----------------------------------------------

	/**
	 * Build the login URL that starts the editor handoff. Carries `source=editor` so the
	 * hub routes to the handoff page, `next` for the post-login destination (defaults to
	 * the editor handoff; already-authenticated browsers pass straight through to it), and
	 * `tier` when the user is upgrading from a plan card.
	 */
	private buildLoginUrl(tier?: V3CodePlanTier, next: string = EDITOR_HANDOFF_PATH): string {
		const url = new URL(this.signInUrl);
		url.searchParams.set('source', 'editor');
		url.searchParams.set('next', next);
		if (tier) {
			url.searchParams.set('tier', tier);
		}
		return url.toString();
	}

	manageAccount(): void {
		if (this._state.status === 'signedIn') {
			void this.openerService.open(URI.parse(`${this.hubWebOrigin}/account`));
			return;
		}
		void this.openerService.open(URI.parse(this.buildLoginUrl()));
	}

	openOverageSettings(): void {
		if (this._state.status === 'signedIn') {
			// Website account page owns enable/cap; focus hint so deep-link lands on overage.
			void this.openerService.open(URI.parse(`${this.hubWebOrigin}/account?focus=overage`));
			return;
		}
		void this.openerService.open(URI.parse(this.buildLoginUrl()));
	}

	isPlanCreditExhausted(): boolean {
		if (this._state.status !== 'signedIn' || !this._state.isPaid) {
			return false;
		}
		const credit = this._state.credit;
		if (!credit) {
			// No meter yet — don't block; hub (when enforce is on) is the backstop.
			return false;
		}
		if (credit.overage?.enabled) {
			return false;
		}
		return credit.percentUsed >= 100;
	}

	planCreditExhaustedMessage(): string {
		return `You've used this month's included plan AI. Enable on-demand overage on your account (Settings → Account → Manage, or v3code.dev) to keep using plan models like V3Fast and V3Pro, upgrade your plan, or switch the composer to one of your own provider models (BYOK).`;
	}

	signIn(): void {
		void this.openerService.open(URI.parse(this.buildLoginUrl()));
	}

	openPlans(tier?: V3CodePlanTier): void {
		// ALWAYS route through the hub login page: the editor's token says nothing about the
		// BROWSER's session (different browser, cleared cookies), and opening pricing cold lets
		// a signed-in customer start an ANONYMOUS checkout that never attaches to their account.
		// For signed-in users `next` points straight at checkout — an authenticated browser
		// passes through the login page untouched; a cold one signs in first and lands on the
		// same checkout. (The plan cards always pass a tier, so the old signed-in `!tier` guard
		// meant every Upgrade click dead-ended on login with no destination.)
		let next: string | undefined;
		if (this._state.status === 'signedIn') {
			const dest = new URL(this.plansUrl);
			dest.searchParams.set('source', 'editor');
			if (tier) { dest.searchParams.set('tier', tier); }
			next = dest.pathname + dest.search;
		}
		void this.openerService.open(URI.parse(this.buildLoginUrl(tier, next)));
		// The purchase completes in the browser with nothing to tell the editor — without this
		// watch the app said "Free" for up to the 10-minute reconcile after the customer paid.
		this.beginPurchaseActivationWatch();
	}

	private _activationWatchUntil = 0;
	private _activationWatchTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bounded foreground poll after the plans page opens: reconcile every 10s for 3 minutes
	 *  (or until entitlement flips), so a completed purchase activates in the editor promptly. */
	beginPurchaseActivationWatch(): void {
		this._activationWatchUntil = Date.now() + 3 * 60_000;
		if (this._activationWatchTimer !== undefined) { return; } // extend the running watch, don't stack loops
		const scheduleNext = () => {
			// The pending-timer check also collapses overlapping loops: if begin() re-armed the
			// watch while a tick's refresh was still in flight, that refresh's finally lands here
			// and yields to the already-scheduled timer instead of starting a second loop.
			if (this._activationWatchTimer !== undefined) { return; }
			if (Date.now() > this._activationWatchUntil) { return; }
			this._activationWatchTimer = setTimeout(tick, 10_000);
		};
		const tick = () => {
			this._activationWatchTimer = undefined;
			if (Date.now() > this._activationWatchUntil) { return; }
			if (this._state.status === 'signedIn' && this._state.isPaid) { this._activationWatchUntil = 0; return; }
			// No token yet (user is still signing in / paying in the browser): WAIT, never poll.
			// refreshFromHub() with no token is destructive — it runs _handleRejectedToken(), whose
			// _clearToken() + _setGuest() can race the deep-link sign-in this watch exists to catch,
			// wiping the freshly stored session. The deep link / secret-storage listener brings the
			// session in on its own; this loop only reconciles ENTITLEMENT once a session exists.
			if (this._state.status !== 'signedIn' || !this._token) { scheduleNext(); return; }
			void this.refreshFromHub().finally(scheduleNext);
		};
		scheduleNext();
	}

	// ---- inward session (web -> editor) --------------------------------------------------

	private async _restoreSession(): Promise<void> {
		try {
			this._refreshToken = (await this.secretStorageService.get(REFRESH_TOKEN_SECRET_KEY)) || undefined;
			const stored = await this.secretStorageService.get(TOKEN_SECRET_KEY);
			this._token = stored || undefined;
			if (this._refreshToken) {
				// We hold a rotating (non-expiring) refresh token — mint a FRESH access token on
				// launch so a session never starts on a stale/expired one. Only an explicit
				// rejection of the refresh token itself signs the user out.
				const renew = await this._refreshAccessToken();
				if (renew === 'rejected') {
					// A refused refresh token means "re-authenticate", NOT "this user isn't paid".
					// Do NOT wipe a paying user's session over one refusal (a transient reuse race
					// or a sibling-window rotation routinely recovers) — hold the cached plan and
					// keep retrying. Only genuinely sign out when no trusted paid plan remains.
					this._handleRejectedToken();
					return;
				}
				// 'renewed' or 'transient' (offline) → proceed; refreshFromHub keeps the optimistic
				// cache if the network is down, and the 401 path renews once the token is usable.
				await this.refreshFromHub();
			} else if (this._token) {
				// Legacy build: access token only, no refresh token — use it until it 401s.
				await this.refreshFromHub();
			} else {
				// No tokens at all — a cached signed-in state without a token is invalid.
				this._setGuest();
			}
		} catch (err) {
			this.logService.warn('[v3code-account] failed to restore hub session', err);
		}
	}

	async completeSignIn(code: string): Promise<boolean> {
		const trimmed = code?.trim();
		if (!trimmed) {
			return false;
		}
		try {
			const context = await this.requestService.request({
				type: 'POST',
				url: `${this.hubApiUrl}/api/editor/exchange`,
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({ code: trimmed }),
				callSite: 'v3code.account.exchange',
			}, CancellationToken.None);

			const body = await asJson<{ access_token?: string; refresh_token?: string }>(context);
			const token = body?.access_token;
			if (!token) {
				this.logService.warn('[v3code-account] exchange returned no access_token');
				return false;
			}

			await this._storeTokens(token, body?.refresh_token);
			await this.refreshFromHub();
			return this._state.status === 'signedIn';
		} catch (err) {
			this.logService.error('[v3code-account] completeSignIn failed', err);
			return false;
		}
	}

	refreshUsageSoon(): void {
		if (this._state.status !== 'signedIn' || !this._token) {
			return;
		}
		// Coalesce a burst of turns into a single refresh shortly after they settle. The server
		// already metered each request; this only re-reads the meter so the UI catches up fast.
		if (this._usageRefreshTimer) {
			return;
		}
		this._usageRefreshTimer = setTimeout(() => {
			this._usageRefreshTimer = undefined;
			if (this._token) {
				void this.refreshFromHub();
			}
		}, USAGE_REFRESH_DEBOUNCE_MS);
	}

	async submitFeedback(payload: { category?: string; severity?: string; message: string; context?: Record<string, unknown> }): Promise<boolean> {
		if (this._state.status !== 'signedIn' || !this._token) {
			return false;
		}
		try {
			const context = await this.requestService.request({
				type: 'POST',
				url: `${this.hubApiUrl}/api/feedback`,
				headers: { Authorization: `Bearer ${this._token}`, 'Content-Type': 'application/json' },
				data: JSON.stringify(payload),
				callSite: 'v3code.account.feedback',
			}, CancellationToken.None);
			const status = context.res.statusCode ?? 0;
			return status >= 200 && status < 300;
		} catch (err) {
			this.logService.warn('[v3code-account] submitFeedback failed', err);
			return false;
		}
	}

	async refreshFromHub(): Promise<void> {
		if (!this._token) {
			// No usable access token. Don't wipe a paying user we can still vouch for — hold the
			// cached plan and let the reconcile re-mint from the refresh token. Only a truly
			// unrecoverable state (no refresh token, or trust lapsed) actually signs out.
			this._handleRejectedToken();
			return;
		}

		const authHeaders = { Authorization: `Bearer ${this._token}` };

		let profile: {
			display_name?: string | null;
			first_name?: string | null;
			email?: string | null;
			avatar_url?: string | null;
			inference_mode?: string | null;
			hosted_monthly_token_limit?: number | null;
			hosted_tokens_used_this_month?: number | null;
			hosted_tokens_remaining?: number | null;
		} | null = null;
		try {
			const profileCtx = await this.requestService.request({
				type: 'GET',
				url: `${this.hubApiUrl}/api/profile`,
				headers: authHeaders,
				callSite: 'v3code.account.profile',
			}, CancellationToken.None);

			if (profileCtx.res.statusCode === 401 || profileCtx.res.statusCode === 403) {
				// Access token expired — try ONE renew with the refresh token before giving up.
				// Only an actually-rejected refresh token (or no refresh token) signs the user out;
				// a transient failure keeps the session and lets the scheduled reconcile retry.
				if (!this._renewedThisCall) {
					const renew = await this._refreshAccessToken();
					if (renew === 'renewed') {
						this._renewedThisCall = true;
						try { await this.refreshFromHub(); } finally { this._renewedThisCall = false; }
						return;
					}
					if (renew === 'transient') { this._scheduleNextRefresh(false); return; }
				}
				// Refused renew: hold the plan instead of stranding a paying user on Free (see
				// _handleRejectedToken). Only a real, trust-expired session actually signs out.
				this._handleRejectedToken();
				return;
			}
			profile = await asJson(profileCtx);
		} catch (err) {
			// Network hiccup — keep whatever state we had (the optimistic cache) rather than
			// bouncing a signed-in user to guest, and retry soon so it reconciles by itself.
			this.logService.warn('[v3code-account] profile fetch failed (keeping current state)', err);
			this._scheduleNextRefresh(false);
			return;
		}

		let tier = 'free';
		let isPaid = false;
		// Authoritative = the hub cleanly answered what this user's plan IS. Only an authoritative
		// answer may move a user to Free. A network error, timeout, or non-2xx is NOT authoritative —
		// treating "couldn't reach billing" as "free" is the bug that strands paying users on Free
		// (and, worse, caches it). See the carry-forward below.
		let billingAuthoritative = false;
		try {
			const billingCtx = await this.requestService.request({
				type: 'GET',
				url: `${this.hubApiUrl}/api/billing/status`,
				headers: authHeaders,
				callSite: 'v3code.account.billing',
			}, CancellationToken.None);
			const code = billingCtx.res.statusCode ?? 0;
			if (code >= 200 && code < 300) {
				const billing = await asJson<{ subscription_tier?: string | null; is_active?: boolean }>(billingCtx);
				billingAuthoritative = true;
				// An active trial has is_active=true with no tier yet — still entitled.
				isPaid = billing?.is_active === true;
				if (billing?.is_active && billing.subscription_tier) {
					tier = billing.subscription_tier;
				}
			} else {
				// 401/403/5xx/etc — ambiguous (profile succeeded with this same token), never "free".
				this.logService.warn(`[v3code-account] billing status ${code} — treating as unknown, not free`);
			}
		} catch (err) {
			this.logService.warn('[v3code-account] billing fetch failed (treating as unknown, not free)', err);
		}

		// THE RULE: only the hub may downgrade someone to Free. If we could not authoritatively read
		// billing, carry the user's currently-known paid plan forward instead of dropping to Free —
		// the scheduled retry below reconciles once the hub is reachable again.
		if (!billingAuthoritative && this._state.status === 'signedIn' && this._state.isPaid) {
			tier = this._state.tierId;
			isPaid = this._state.isPaid;
		}

		const displayName =
			(profile?.display_name && profile.display_name.trim()) ||
			(profile?.first_name && profile.first_name.trim()) ||
			(profile?.email && profile.email.split('@')[0]) ||
			'V3Code User';

		const inferenceMode = profile?.inference_mode === 'hosted' ? 'hosted' : profile?.inference_mode === 'byok' ? 'byok' : null;
		const asCount = (v: number | null | undefined): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

		this._state = {
			status: 'signedIn',
			displayName,
			avatarUrl: (typeof profile?.avatar_url === 'string' && profile.avatar_url.trim().length > 0) ? profile.avatar_url : null,
			// An active entitlement with no named tier is a TRIAL — showing "Free" next to a live
			// paid meter read as a contradiction (and hid that the trial exists at all).
			tierLabel: (isPaid && tier === 'free') ? 'Trial' : (PLAN_LABELS[tier] ?? 'Free'),
			tierId: tier,
			isPaid,
			inferenceMode,
			hostedTokensRemaining: asCount(profile?.hosted_tokens_remaining),
			hostedTokensUsed: asCount(profile?.hosted_tokens_used_this_month),
			hostedMonthlyLimit: asCount(profile?.hosted_monthly_token_limit),
			credit: isPaid ? await this._fetchCredit(authHeaders) : undefined,
		};
		this._persistState();
		this._onDidChangeState.fire();
		// Keep reconciling: slow routine cadence when authoritative, fast backoff when billing was
		// unknown (so a carried-forward paid user converges to the truth without a relaunch).
		this._scheduleNextRefresh(billingAuthoritative);
	}

	/**
	 * Best-effort read of the hosted usage meter. Absent on free/BYOK accounts,
	 * older hubs (no `credit` block yet), or any error — never breaks sign-in
	 * or the token meter above.
	 */
	private async _fetchCredit(authHeaders: Record<string, string>): Promise<IV3CodeCreditState | undefined> {
		try {
			const usageCtx = await this.requestService.request({
				type: 'GET',
				url: `${this.hubApiUrl}/api/usage/summary`,
				headers: authHeaders,
				callSite: 'v3code.account.usage',
			}, CancellationToken.None);
			const summary = await asJson<{
				credit?: {
					active?: boolean;
					percent_used?: number;
					remaining_label?: string;
					classes?: { id?: string; percent_of_budget?: number; events?: number }[];
				};
				overage?: {
					enabled?: boolean;
					cap_usd?: number;
					accrued_usd?: number;
				};
			}>(usageCtx);
			const credit = summary?.credit;
			if (!credit || credit.active !== true) {
				return undefined;
			}
			const percentUsed = Number(credit.percent_used) || 0;
			// Hub historically capped the friendly label at "Almost at limit"; normalize at 100%.
			const remainingLabel = percentUsed >= 100
				? 'Out of included usage'
				: String(credit.remaining_label || 'Plenty left');
			const overageRaw = summary?.overage;
			const overage: IV3CodeOverageState | undefined = overageRaw
				? {
					enabled: overageRaw.enabled === true,
					capUsd: Number(overageRaw.cap_usd) || 0,
					accruedUsd: Number(overageRaw.accrued_usd) || 0,
				}
				: undefined;
			return {
				percentUsed,
				remainingLabel,
				classes: (credit.classes ?? []).map(cls => ({
					id: String(cls.id ?? ''),
					percentOfBudget: Number(cls.percent_of_budget) || 0,
					events: Number(cls.events) || 0,
				})),
				overage,
			};
		} catch (err) {
			// Transient failure: retain the LAST KNOWN meter instead of dropping it. Clearing it
			// made isPlanCreditExhausted() fail open — one usage-summary blip and an exhausted
			// account could keep burning through the soft-stop until the next successful read.
			this.logService.warn('[v3code-account] usage summary fetch failed (keeping last known meter)', err);
			return this._state.status === 'signedIn' ? this._state.credit : undefined;
		}
	}

	signOut(): void {
		void this._clearToken();
		this._setGuest();
	}

	private async _clearToken(): Promise<void> {
		this._token = undefined;
		this._refreshToken = undefined;
		if (this._tokenRenewTimer) { clearTimeout(this._tokenRenewTimer); this._tokenRenewTimer = undefined; }
		try {
			await this.secretStorageService.delete(TOKEN_SECRET_KEY);
			await this.secretStorageService.delete(REFRESH_TOKEN_SECRET_KEY);
		} catch (err) {
			this.logService.warn('[v3code-account] failed to clear hub tokens', err);
		}
	}

	/** Persist the access token (+ rotated refresh token) and schedule the next proactive renew. */
	private async _storeTokens(accessToken: string, refreshToken?: string): Promise<void> {
		this._token = accessToken;
		try {
			await this.secretStorageService.set(TOKEN_SECRET_KEY, accessToken);
			if (refreshToken) {
				this._refreshToken = refreshToken;
				await this.secretStorageService.set(REFRESH_TOKEN_SECRET_KEY, refreshToken);
			}
		} catch (err) {
			this.logService.warn('[v3code-account] failed to persist tokens', err);
		}
		// A working token clears any "sign in again" prompt, including one a sibling
		// window's rotation just made obsolete.
		if (this._state.sessionExpired) {
			this._state = { ...this._state, sessionExpired: false };
			this._onDidChangeState.fire();
		}
		// Tell every other window that the session just rotated, so none of them POSTs
		// the token we have now retired.
		this._lastOwnRotationStamp = Date.now();
		this.storageService.store(ROTATION_STAMP_KEY, this._lastOwnRotationStamp, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._scheduleTokenRenew();
	}

	/**
	 * Did a DIFFERENT window rotate the session in the last few seconds? Our own stamp
	 * is excluded, so this is only ever true when a sibling holds the live token.
	 */
	private _siblingRotatedRecently(): boolean {
		const stamp = this.storageService.getNumber(ROTATION_STAMP_KEY, StorageScope.APPLICATION);
		if (typeof stamp !== 'number' || stamp === this._lastOwnRotationStamp) { return false; }
		const age = Date.now() - stamp;
		return age >= 0 && age < ROTATION_QUIET_MS;
	}

	/**
	 * Multi-window safety valve. Refresh tokens are SINGLE-USE and rotate, but every
	 * editor window runs its own copy of this service with its own in-memory token.
	 * When a sibling window rotates the session first, our in-memory token is dead —
	 * using it reads as "revoked" and used to sign the user out of every window (and
	 * delete the sibling's perfectly valid tokens). Instead: re-read secret storage
	 * and ADOPT whatever a sibling persisted.
	 * - 'freshAccess'  → adopted a sibling's newly-minted access token (no network call needed).
	 * - 'newerRefresh' → adopted a sibling's rotated refresh token (renew with THAT one).
	 * - 'none'         → storage matches what we hold; no sibling interfered.
	 */
	private async _adoptStoredTokensIfNewer(): Promise<'freshAccess' | 'newerRefresh' | 'none'> {
		try {
			const storedRefresh = (await this.secretStorageService.get(REFRESH_TOKEN_SECRET_KEY)) || undefined;
			if (!storedRefresh || storedRefresh === this._refreshToken) { return 'none'; }
			this._refreshToken = storedRefresh;
			const storedAccess = (await this.secretStorageService.get(TOKEN_SECRET_KEY)) || undefined;
			if (storedAccess && storedAccess !== this._token) {
				this._token = storedAccess;
				this._scheduleTokenRenew();
				return 'freshAccess';
			}
			return 'newerRefresh';
		} catch {
			return 'none';
		}
	}

	/**
	 * Renew the access token directly against Supabase with the stored refresh token — the exact
	 * call a browser Supabase client makes. Refresh tokens don't expire (they rotate, single-use),
	 * so this keeps a signed-in user signed in for months across restarts.
	 * - 'renewed'   → got a fresh access (+ rotated refresh) token; stored + reschedule done.
	 * - 'rejected'  → the refresh token itself was refused (revoked / signed out elsewhere) — the
	 *                 ONLY outcome that should sign the editor out. Only returned after the
	 *                 sibling-rotation checks below have both come up empty.
	 * - 'transient' → network / 5xx; keep the session and try again shortly.
	 */
	private _refreshAccessToken(): Promise<'renewed' | 'rejected' | 'transient'> {
		// Single-flight: coalesce concurrent callers (renew timer, reconcile, send-path, launch
		// restore, sibling-window races) onto ONE in-flight renew. A second POST of a just-rotated
		// single-use refresh token can trip Supabase reuse-revocation and sign the user out — the
		// exact failure that strands paying users on "Free".
		if (this._refreshInFlight) { return this._refreshInFlight; }
		const inFlight = this._doRefreshAccessToken(0).finally(() => {
			if (this._refreshInFlight === inFlight) { this._refreshInFlight = undefined; }
		});
		this._refreshInFlight = inFlight;
		return inFlight;
	}

	private async _doRefreshAccessToken(depth = 0): Promise<'renewed' | 'rejected' | 'transient'> {
		// A sibling window may have already rotated the session — always start from
		// the freshest persisted tokens instead of burning a stale one.
		const adopted = await this._adoptStoredTokensIfNewer();
		if (adopted === 'freshAccess') { return 'renewed'; }
		if (!this._refreshToken) { return 'rejected'; }

		// Cross-window guard. `_refreshInFlight` only coalesces callers inside THIS
		// window; two windows still race to POST the same single-use token, and the
		// reuse revokes the family, so BOTH lose the session and each reports the other
		// as a revocation. If a sibling rotated a moment ago, let its write land and
		// adopt instead of burning a token that is probably already dead.
		if (depth === 0 && this._siblingRotatedRecently()) {
			await new Promise<void>(resolve => setTimeout(resolve, 1200));
			const siblingAdopt = await this._adoptStoredTokensIfNewer();
			if (siblingAdopt === 'freshAccess') { return 'renewed'; }
			if (siblingAdopt === 'newerRefresh') { return this._doRefreshAccessToken(depth + 1); }
			this.logService.trace('[v3code-account] sibling window is rotating — deferring this renew');
			return 'transient';
		}

		const usedRefreshToken = this._refreshToken;
		try {
			const ctx = await this.requestService.request({
				type: 'POST',
				url: `${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
				headers: { 'Content-Type': 'application/json', 'apikey': this.supabaseAnonKey },
				data: JSON.stringify({ refresh_token: usedRefreshToken }),
				callSite: 'v3code.account.tokenRefresh',
			}, CancellationToken.None);
			const code = ctx.res.statusCode ?? 0;
			if (code === 400 || code === 401 || code === 403) {
				// Refused: either genuinely revoked, or a sibling window rotated this token
				// while our request was in flight. Give the sibling a beat to persist its
				// rotation, then adopt. Only an UNCHANGED store is a real revocation.
				await new Promise<void>(resolve => setTimeout(resolve, 2000));
				const lateAdopt = await this._adoptStoredTokensIfNewer();
				if (lateAdopt === 'freshAccess') { return 'renewed'; }
				if (lateAdopt === 'newerRefresh' && depth === 0) { return this._doRefreshAccessToken(depth + 1); }
				this.logService.warn('[v3code-account] refresh token refused and no sibling rotation found — session revoked');
				return 'rejected';
			}
			if (code < 200 || code >= 300) {
				this.logService.warn(`[v3code-account] token refresh status ${code} — keeping session`);
				return 'transient';
			}
			const body = await asJson<{ access_token?: string; refresh_token?: string }>(ctx);
			if (!body?.access_token) { return 'transient'; }
			await this._storeTokens(body.access_token, body.refresh_token ?? this._refreshToken);
			return 'renewed';
		} catch (err) {
			this.logService.warn('[v3code-account] token refresh failed (network) — keeping session', err);
			return 'transient';
		}
	}

	/** Proactively renew the access token before it expires (or after an explicit delay). */
	private _scheduleTokenRenew(delayMs: number = TOKEN_RENEW_INTERVAL_MS): void {
		if (this._tokenRenewTimer) { clearTimeout(this._tokenRenewTimer); this._tokenRenewTimer = undefined; }
		if (!this._refreshToken) { return; }
		this._tokenRenewTimer = setTimeout(() => {
			this._tokenRenewTimer = undefined;
			void this._refreshAccessToken();
		}, delayMs);
	}

	/** True when a paid entitlement is cached/known and still inside its 7-day trust window. */
	private _hasTrustedPaidCache(): boolean {
		if (this._state.status !== 'signedIn' || !this._state.isPaid) { return false; }
		// The in-memory plan is paid; confirm the persisted cache hasn't aged out (covers a long
		// idle where the last authoritative verify is far in the past).
		try {
			const raw = this.storageService.get(CACHED_STATE_KEY, StorageScope.APPLICATION);
			if (raw) {
				const cached = JSON.parse(raw) as { isPaid?: boolean; cachedAt?: number };
				if (cached?.isPaid === true && typeof cached.cachedAt === 'number') {
					return Date.now() - cached.cachedAt <= CACHED_STATE_TRUST_MS;
				}
			}
		} catch { /* fall through */ }
		// Paid in memory but no cache record yet (verified live this session) — honor it.
		return true;
	}

	/**
	 * A refresh-token renew was refused. This is the ONLY involuntary path that used to sign a
	 * user out — and a single refusal (transient reuse race, sibling-window rotation, a Supabase
	 * blip) must never strand a paying user on "Free". So while a trusted paid plan is still
	 * cached: HOLD it on screen, keep the tokens (a sibling may rotate a fresh one), and keep
	 * retrying on a backoff. Only when no trusted paid plan remains do we do a real sign-out.
	 */
	private _handleRejectedToken(): void {
		// Only hold if we can still RECOVER (a refresh token to retry with) AND there is a trusted
		// paid plan to honor. Otherwise this is a genuine signed-out state and we sign out for real.
		if (this._refreshToken && this._hasTrustedPaidCache()) {
			// `_doRefreshAccessToken` only answers 'rejected' once the server refused the
			// token AND sibling adoption came up empty. A refused single-use token cannot
			// start working again by itself, so the fast backoff was re-asking a question
			// that already has a permanent answer, while the UI kept showing the plan as
			// healthy. Hold the plan - the user is still paying - but say so, and drop to
			// the routine cadence so a genuine false positive still heals on its own.
			this.logService.warn('[v3code-account] token renew refused — plan held, sign-in required');
			this._state = { ...this._state, sessionExpired: true };
			this._onDidChangeState.fire();
			this._scheduleNextRefresh(true);
			return;
		}
		void this._clearToken();
		this._setGuest();
	}

	private _setGuest(): void {
		// A real sign-out (no token / 401) stops the reconcile loop — nothing to retry.
		if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = undefined; }
		this._refreshBackoffMs = 0;
		this._state = GUEST_STATE;
		this._persistState(); // status !== 'signedIn' → clears the cached entitlement
		this._onDidChangeState.fire();
	}

	// ---- local preferences ---------------------------------------------------------------

	getMessagePref(key: V3CodeMessagePrefKey): boolean {
		return this.storageService.getBoolean(STORAGE_PREFIX + key, StorageScope.APPLICATION, true);
	}

	setMessagePref(key: V3CodeMessagePrefKey, value: boolean): void {
		this.storageService.store(STORAGE_PREFIX + key, value, StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChangePrefs.fire();
	}

	getPrivacyMode(): boolean {
		return this.storageService.getBoolean(PRIVACY_MODE_KEY, StorageScope.APPLICATION, false);
	}

	setPrivacyMode(value: boolean): void {
		this.storageService.store(PRIVACY_MODE_KEY, value, StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChangePrefs.fire();
	}
}

registerSingleton(IV3CodeAccountService, V3CodeAccountService, InstantiationType.Delayed);
