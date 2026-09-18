/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*---------------------------------------------------------------------------------------------
 *  Grok (Plan) subscription auth.
 *
 *  Reuses the token that `grok login` stores in ~/.grok/auth.json to talk to the Grok CLI chat
 *  proxy (cli-chat-proxy.grok.com) on the user's SuperGrok / X Premium subscription — the same
 *  lane the grok CLI itself uses. This is NOT the xAI developer API (api.x.ai), which bills a
 *  BYOK key and 402s a subscription token.
 *
 *  The token is a short-lived OIDC JWT (~6h). We refresh it via the standard refresh_token grant
 *  (token endpoint discovered from {issuer}/.well-known/openid-configuration) when it is near
 *  expiry, and write the new token back into auth.json in grok's own shape so the CLI and V3Code
 *  stay in sync. All failures are best-effort: we return whatever token we have and let a 401
 *  surface a "run grok login" message.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GROK_CHAT_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';

/** Fallback CLI version if ~/.grok/version.json is unreadable. Proxy rejects versions it can't parse. */
const GROK_VERSION_FALLBACK = '0.2.111';

/** Refresh when the token has less than this many ms of life left. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface GrokAuthEntry {
	key?: string;
	auth_mode?: string;
	refresh_token?: string;
	expires_at?: string;
	oidc_issuer?: string;
	oidc_client_id?: string;
	email?: string;
	[k: string]: unknown;
}

export interface GrokPlanCredentials {
	token: string;
	version: string;
	email?: string;
	expiresAt?: string;
}

const authJsonPath = () => join(homedir(), '.grok', 'auth.json');
const versionJsonPath = () => join(homedir(), '.grok', 'version.json');

let cachedVersion: string | undefined;

async function readGrokVersion(): Promise<string> {
	if (cachedVersion) { return cachedVersion; }
	try {
		const raw = await fs.readFile(versionJsonPath(), 'utf8');
		const parsed = JSON.parse(raw) as { version?: string };
		if (parsed?.version && /^\d+\.\d+\.\d+/.test(parsed.version)) {
			cachedVersion = parsed.version;
			return cachedVersion;
		}
	} catch { /* ignore */ }
	cachedVersion = GROK_VERSION_FALLBACK;
	return cachedVersion;
}

interface LoadedEntry { entryKey: string; entry: GrokAuthEntry; all: Record<string, GrokAuthEntry>; }

async function loadAuth(): Promise<LoadedEntry | null> {
	let raw: string;
	try {
		raw = await fs.readFile(authJsonPath(), 'utf8');
	} catch {
		return null; // not signed in
	}
	let parsed: Record<string, GrokAuthEntry>;
	try {
		parsed = JSON.parse(raw) as Record<string, GrokAuthEntry>;
	} catch {
		return null;
	}
	// The key name varies by CLI version ("https://auth.x.ai::<clientId>",
	// "https://accounts.x.ai/sign-in", ...). Find the OIDC entry that actually holds a token.
	for (const [entryKey, entry] of Object.entries(parsed)) {
		if (entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key) {
			if (entry.auth_mode === 'oidc' || entry.refresh_token || entry.oidc_issuer) {
				return { entryKey, entry, all: parsed };
			}
		}
	}
	// Fallback: any entry with a key.
	for (const [entryKey, entry] of Object.entries(parsed)) {
		if (entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key) {
			return { entryKey, entry, all: parsed };
		}
	}
	return null;
}

function isExpiringSoon(expiresAt: string | undefined): boolean {
	if (!expiresAt) { return false; }
	const t = Date.parse(expiresAt);
	if (Number.isNaN(t)) { return false; }
	return t - Date.now() < REFRESH_SKEW_MS;
}

async function discoverTokenEndpoint(issuer: string): Promise<string | null> {
	try {
		const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
		const res = await fetch(url, { method: 'GET' });
		if (!res.ok) { return null; }
		const cfg = await res.json() as { token_endpoint?: string };
		return cfg?.token_endpoint ?? null;
	} catch {
		return null;
	}
}

/**
 * Attempt an OIDC refresh_token grant. On success, persists the new token back into auth.json
 * (same shape) and returns the fresh access token. On any failure returns null (caller keeps
 * the existing token).
 */
async function refreshToken(loaded: LoadedEntry): Promise<string | null> {
	const { entry, entryKey, all } = loaded;
	const issuer = entry.oidc_issuer;
	const clientId = entry.oidc_client_id;
	const refresh = entry.refresh_token;
	if (!issuer || !clientId || !refresh) { return null; }

	const tokenEndpoint = await discoverTokenEndpoint(issuer);
	if (!tokenEndpoint) { return null; }

	try {
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			client_id: clientId,
			refresh_token: refresh,
		});
		const res = await fetch(tokenEndpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
			body: body.toString(),
		});
		if (!res.ok) { return null; }
		const json = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
		if (!json?.access_token) { return null; }

		// Persist back in grok's shape so the CLI keeps working too.
		const updated: GrokAuthEntry = { ...entry, key: json.access_token };
		if (json.refresh_token) { updated.refresh_token = json.refresh_token; }
		if (typeof json.expires_in === 'number') {
			updated.expires_at = new Date(Date.now() + json.expires_in * 1000).toISOString();
		}
		all[entryKey] = updated;
		try {
			await fs.writeFile(authJsonPath(), JSON.stringify(all, null, 2), { mode: 0o600 });
		} catch { /* best-effort persist; still return the fresh token */ }
		return json.access_token;
	} catch {
		return null;
	}
}

/**
 * Returns the current Grok subscription credentials (token + CLI version headers), refreshing
 * proactively if near expiry. Returns null if the user has not run `grok login`.
 */
export async function getGrokPlanCredentials(): Promise<GrokPlanCredentials | null> {
	const loaded = await loadAuth();
	if (!loaded) { return null; }
	const version = await readGrokVersion();

	let token = loaded.entry.key as string;
	if (isExpiringSoon(loaded.entry.expires_at)) {
		const fresh = await refreshToken(loaded);
		if (fresh) { token = fresh; }
	}

	return {
		token,
		version,
		email: typeof loaded.entry.email === 'string' ? loaded.entry.email : undefined,
		expiresAt: typeof loaded.entry.expires_at === 'string' ? loaded.entry.expires_at : undefined,
	};
}

/** True if ~/.grok/auth.json currently holds a usable subscription token. */
export async function isGrokPlanSignedIn(): Promise<boolean> {
	const loaded = await loadAuth();
	return !!loaded?.entry.key;
}

/** Lightweight, never-throwing status for the Settings sign-in card (read over the LLM channel). */
export interface GrokPlanStatus {
	signedIn: boolean;
	email?: string;
	expiresAt?: string;
}

export async function getGrokPlanStatus(): Promise<GrokPlanStatus> {
	try {
		const loaded = await loadAuth();
		if (!loaded?.entry.key) { return { signedIn: false }; }
		return {
			signedIn: true,
			email: typeof loaded.entry.email === 'string' ? loaded.entry.email : undefined,
			expiresAt: typeof loaded.entry.expires_at === 'string' ? loaded.entry.expires_at : undefined,
		};
	} catch {
		return { signedIn: false };
	}
}

/** Force a refresh regardless of expiry (used by a manual "Refresh" action). Returns the token or null. */
export async function forceRefreshGrokPlan(): Promise<string | null> {
	const loaded = await loadAuth();
	if (!loaded) { return null; }
	return refreshToken(loaded);
}
