/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*---------------------------------------------------------------------------------------------
 *  Claude (Plan) subscription auth.
 *
 *  Reuses the OAuth token that Claude Code stores after `claude` -> `/login` so Claude Pro / Max
 *  subscribers can run Claude models on their plan instead of a per-token API key. Same host as
 *  the developer API (api.anthropic.com/v1/messages) — the difference is entirely in the auth:
 *  an `sk-ant-oat01-` OAuth token sent as `Authorization: Bearer` with the oauth beta header,
 *  never as `x-api-key`.
 *
 *  Credential store, in precedence order:
 *    1. $CLAUDE_CODE_OAUTH_TOKEN        — a long-lived token from `claude setup-token`
 *    2. macOS Keychain                  — generic password, service "Claude Code-credentials"
 *    3. $CLAUDE_CONFIG_DIR/.credentials.json or ~/.claude/.credentials.json (Linux / fallback)
 *
 *  Refresh tokens ROTATE. Using one invalidates it, so if we refresh we MUST write the new pair
 *  back to the same store Claude Code reads, or we silently log the user out of their own CLI.
 *  Refreshes are serialized through an in-process mutex and re-read the store immediately before
 *  the request, because two concurrent refreshes make Anthropic reject both and Claude Code has a
 *  known bug where it then persists an empty refresh token.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CLAUDE_PLAN_BASE_URL = 'https://api.anthropic.com';

/** Public client id for the Claude Code OAuth app. No secret — it is an installed-app client. */
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Primary refresh endpoint; the console host is a fallback for older logins. */
const CLAUDE_TOKEN_ENDPOINTS = [
	'https://api.anthropic.com/v1/oauth/token',
	'https://platform.claude.com/v1/oauth/token',
];

/** macOS Keychain generic-password service written by Claude Code. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Refresh when the access token has less than this much life left. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Anthropic gates the subscription lane on an identity block: for every model except Haiku, the
 * FIRST element of the `system` array must be exactly this text, on its own, as its own block.
 * A plain string, a reworded variant, or this text concatenated with the real prompt all fail
 * with an opaque `400 invalid_request_error`. The product's own system prompt goes in block two,
 * and because the model follows the LAST identity instruction it still answers as V3Code.
 */
export const CLAUDE_CODE_IDENTITY_PROMPT = `You are Claude Code, Anthropic's official CLI for Claude.`;

interface ClaudeOAuthPayload {
	accessToken?: string;
	refreshToken?: string;
	/** Epoch MILLISECONDS. */
	expiresAt?: number;
	refreshTokenExpiresAt?: number;
	scopes?: string[];
	subscriptionType?: string;
	rateLimitTier?: string;
	[k: string]: unknown;
}

interface ClaudeCredentialDoc {
	claudeAiOauth?: ClaudeOAuthPayload;
	organizationUuid?: string;
	[k: string]: unknown;
}

export interface ClaudePlanCredentials {
	token: string;
	/** Present only when we know it — the credential store has no email field. */
	email?: string;
	subscriptionType?: string;
	expiresAt?: number;
}

type StoreKind = 'env' | 'keychain' | 'file';

interface LoadedClaudeCreds {
	kind: StoreKind;
	doc: ClaudeCredentialDoc;
	oauth: ClaudeOAuthPayload;
}

const credentialsFilePath = (): string => {
	const configDir = process.env.CLAUDE_CONFIG_DIR;
	return configDir
		? join(configDir, '.credentials.json')
		: join(homedir(), '.claude', '.credentials.json');
};

const keychainAccount = (): string => {
	try { return userInfo().username; } catch { return process.env.USER ?? ''; }
};

async function readKeychain(): Promise<string | null> {
	if (process.platform !== 'darwin') { return null; }
	const account = keychainAccount();
	if (!account) { return null; }
	try {
		const { stdout } = await execFileAsync('/usr/bin/security', [
			'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w',
		], { timeout: 10_000, maxBuffer: 1024 * 1024 });
		const trimmed = stdout.trim();
		return trimmed || null;
	} catch {
		// Not found, or the user declined the macOS authorization prompt.
		return null;
	}
}

async function writeKeychain(json: string): Promise<boolean> {
	if (process.platform !== 'darwin') { return false; }
	const account = keychainAccount();
	if (!account) { return false; }
	try {
		// -U updates the existing item in place rather than erroring on a duplicate.
		await execFileAsync('/usr/bin/security', [
			'add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', json,
		], { timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

function parseDoc(raw: string): ClaudeCredentialDoc | null {
	try {
		const parsed = JSON.parse(raw) as ClaudeCredentialDoc;
		if (parsed && typeof parsed === 'object') { return parsed; }
		return null;
	} catch {
		return null;
	}
}

/**
 * Reads the credential store. Returns null when the user has not signed in to Claude Code.
 * Only accepts a document that actually carries `claudeAiOauth` — Claude Code also writes
 * suffixed keychain entries that hold nothing but MCP OAuth state.
 */
async function loadCreds(): Promise<LoadedClaudeCreds | null> {
	const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	if (envToken) {
		// A setup-token has no refresh pair and never needs one (1-year life).
		return { kind: 'env', doc: {}, oauth: { accessToken: envToken } };
	}

	const fromKeychain = await readKeychain();
	if (fromKeychain) {
		const doc = parseDoc(fromKeychain);
		if (doc?.claudeAiOauth?.accessToken) {
			return { kind: 'keychain', doc, oauth: doc.claudeAiOauth };
		}
	}

	try {
		const raw = await fs.readFile(credentialsFilePath(), 'utf8');
		const doc = parseDoc(raw);
		if (doc?.claudeAiOauth?.accessToken) {
			return { kind: 'file', doc, oauth: doc.claudeAiOauth };
		}
	} catch { /* not signed in on this path */ }

	return null;
}

async function persistCreds(loaded: LoadedClaudeCreds, oauth: ClaudeOAuthPayload): Promise<void> {
	const doc: ClaudeCredentialDoc = { ...loaded.doc, claudeAiOauth: oauth };
	const json = JSON.stringify(doc, null, 2);
	if (loaded.kind === 'keychain') {
		const ok = await writeKeychain(json);
		if (ok) { return; }
		// Keychain write refused (ACL/XARA): fall through and try the file so the fresh
		// refresh token is not lost entirely.
	}
	if (loaded.kind === 'env') { return; } // nothing to persist
	try {
		await fs.writeFile(credentialsFilePath(), json, { mode: 0o600 });
	} catch { /* best-effort */ }
}

const isExpiringSoon = (expiresAt: number | undefined): boolean => {
	if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) { return false; }
	return expiresAt - Date.now() < REFRESH_SKEW_MS;
};

async function requestRefresh(refreshToken: string): Promise<{
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	account?: { email_address?: string };
} | null> {
	for (const endpoint of CLAUDE_TOKEN_ENDPOINTS) {
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify({
					grant_type: 'refresh_token',
					refresh_token: refreshToken,
					client_id: CLAUDE_OAUTH_CLIENT_ID,
				}),
			});
			if (!res.ok) { continue; } // try the next host
			const json = await res.json() as { access_token?: string };
			if (json?.access_token) {
				return json as Awaited<ReturnType<typeof requestRefresh>>;
			}
		} catch { /* try the next host */ }
	}
	return null;
}

/** Serializes refreshes so two concurrent turns cannot burn the same rotating refresh token. */
let refreshInFlight: Promise<LoadedClaudeCreds | null> | null = null;
/** Email is only ever returned by the token endpoint, so remember it once we have seen it. */
let cachedEmail: string | undefined;

async function refreshCreds(): Promise<LoadedClaudeCreds | null> {
	if (refreshInFlight) { return refreshInFlight; }
	refreshInFlight = (async (): Promise<LoadedClaudeCreds | null> => {
		try {
			// Re-read immediately before refreshing: another process may have rotated the pair
			// while we waited, in which case the token we captured earlier is already dead.
			const loaded = await loadCreds();
			if (!loaded) { return null; }
			if (loaded.kind === 'env') { return loaded; }
			if (!isExpiringSoon(loaded.oauth.expiresAt)) { return loaded; } // someone else refreshed

			const refreshToken = loaded.oauth.refreshToken;
			if (!refreshToken) { return loaded; }

			const json = await requestRefresh(refreshToken);
			if (!json?.access_token) { return loaded; } // keep what we have; a 401 will explain

			const updated: ClaudeOAuthPayload = { ...loaded.oauth, accessToken: json.access_token };
			if (json.refresh_token) { updated.refreshToken = json.refresh_token; }
			if (typeof json.expires_in === 'number') {
				updated.expiresAt = Date.now() + json.expires_in * 1000;
			}
			if (json.account?.email_address) { cachedEmail = json.account.email_address; }

			await persistCreds(loaded, updated);
			return { ...loaded, oauth: updated };
		} catch {
			return loadCreds();
		} finally {
			refreshInFlight = null;
		}
	})();
	return refreshInFlight;
}

/**
 * Current Claude subscription credentials, refreshed proactively when near expiry.
 * Returns null when the user has not signed in to Claude Code.
 */
export async function getClaudePlanCredentials(): Promise<ClaudePlanCredentials | null> {
	let loaded = await loadCreds();
	if (!loaded) { return null; }

	if (loaded.kind !== 'env' && isExpiringSoon(loaded.oauth.expiresAt)) {
		loaded = await refreshCreds() ?? loaded;
	}

	const token = loaded.oauth.accessToken;
	if (!token) { return null; }

	return {
		token,
		email: cachedEmail,
		subscriptionType: loaded.oauth.subscriptionType,
		expiresAt: loaded.oauth.expiresAt,
	};
}

/** Lightweight, never-throwing status for the Settings sign-in card. */
export interface ClaudePlanStatus {
	signedIn: boolean;
	email?: string;
	/** e.g. "max", "pro". */
	subscriptionType?: string;
	/** Epoch ms, so the card can show "expires in ...". */
	expiresAt?: number;
}

export async function getClaudePlanStatus(): Promise<ClaudePlanStatus> {
	try {
		const loaded = await loadCreds();
		if (!loaded?.oauth.accessToken) { return { signedIn: false }; }
		return {
			signedIn: true,
			email: cachedEmail,
			subscriptionType: loaded.oauth.subscriptionType,
			expiresAt: loaded.oauth.expiresAt,
		};
	} catch {
		return { signedIn: false };
	}
}
