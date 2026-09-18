/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*---------------------------------------------------------------------------------------------
 *  GitHub Copilot subscription auth.
 *
 *  Two hops, and they use DIFFERENT auth schemes — getting them backwards produces a
 *  "badly formatted Authorization header" 400 that reads like a string bug:
 *
 *  There are two credential paths, depending on which Copilot client performed the login:
 *
 *    1. Current Copilot CLI writes a GitHub OAuth token (`gho_...`) to the OS credential store.
 *       It is accepted as a Bearer by the Copilot API, but its account-specific API endpoint
 *       still has to be discovered from `/copilot_internal/user`.
 *    2. Copilot editor plugins write a GitHub App user token (`ghu_...`). That older token is
 *       sent as `Authorization: token <ghu_...>` to GET /copilot_internal/v2/token, which returns
 *       a ~30 minute session token (`tid=...;exp=...`) for the Copilot API.
 *
 *  Do not send `gho_` through the legacy exchange endpoint: GitHub returns 404. Conversely, do
 *  not send `ghu_` directly to the chat API. The token prefix selects the correct path.
 *
 *  The chat host is read from `endpoints.api` in the exchange response rather than hardcoded, so
 *  individual / business / enterprise accounts route themselves.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Individual-plan host used only if GitHub's identity response omits `endpoints.api`. */
const COPILOT_DEFAULT_API_HOST = 'https://api.individual.githubcopilot.com';

const COPILOT_TOKEN_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';

/** macOS Keychain generic-password service written by `copilot login`. */
const KEYCHAIN_SERVICE = 'copilot-cli';

/**
 * The integration id is also the model-catalogue boundary. `vscode-chat` only exposes the old
 * editor catalogue on raw `/chat/completions`; the plan lane is authenticated by Copilot CLI and
 * must use its `copilot-developer-cli` integration to reach the current CLI catalogue.
 */
export const copilotIdentityHeaders = (): Record<string, string> => ({
	'Copilot-Integration-Id': 'copilot-developer-cli',
	'Editor-Version': 'v3code/1.0.0',
	'Editor-Plugin-Version': 'v3code/1.0.0',
	'User-Agent': 'V3Code/1.0.0',
	'x-github-api-version': '2025-10-01',
});

/** Refresh the session token this long before it actually expires. */
const SESSION_SKEW_MS = 60 * 1000;

export interface CopilotPlanCredentials {
	/** The `tid=...` session token — the Bearer for inference. */
	token: string;
	/** Chat base URL including the /v1-less Copilot root, e.g. https://api.githubcopilot.com */
	baseURL: string;
	login?: string;
}

interface CopilotCliIdentity {
	host?: string;
	login?: string;
}

/**
 * Copilot CLI keeps non-secret account metadata in ~/.copilot/config.json. The file permits
 * leading // comments even though its extension is .json.
 */
async function readCopilotCliIdentity(): Promise<CopilotCliIdentity | null> {
	try {
		const raw = await fs.readFile(join(homedir(), '.copilot', 'config.json'), 'utf8');
		const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '');
		const parsed = JSON.parse(withoutComments) as {
			lastLoggedInUser?: { host?: unknown; login?: unknown };
		};
		const host = typeof parsed.lastLoggedInUser?.host === 'string'
			? parsed.lastLoggedInUser.host
			: undefined;
		const login = typeof parsed.lastLoggedInUser?.login === 'string'
			? parsed.lastLoggedInUser.login
			: undefined;
		return host || login ? { host, login } : null;
	} catch {
		return null;
	}
}

async function readKeychain(): Promise<GithubToken | null> {
	if (process.platform !== 'darwin') { return null; }
	const identity = await readCopilotCliIdentity();
	const account = identity?.host && identity.login
		? `${identity.host}:${identity.login}`
		: undefined;
	// The CLI's Keychain account is "https://github.com:<login>", not the local macOS username.
	// Prefer the active account from config, then fall back to the first item for older configs.
	for (const candidate of account ? [account, undefined] : [undefined]) {
		try {
			const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE];
			if (candidate) { args.push('-a', candidate); }
			args.push('-w');
			const { stdout } = await execFileAsync('/usr/bin/security', args, {
				timeout: 10_000,
				maxBuffer: 1024 * 1024,
			});
			const token = stdout.trim();
			if (isSupportedGithubToken(token)) {
				return { token, login: identity?.login };
			}
		} catch { /* try the fallback */ }
	}
	return null;
}

interface GithubToken { token: string; login?: string }

/** `ghu_` is the GitHub App user-to-server prefix the legacy exchange requires. */
const looksLikeGhu = (t: string | undefined | null): t is string =>
	typeof t === 'string' && t.startsWith('ghu_');

/** Token forms supported by current Copilot CLI plus the editor-plugin `ghu_` store. */
const isSupportedGithubToken = (t: string | undefined | null): t is string =>
	typeof t === 'string' && (
		t.startsWith('ghu_') ||
		t.startsWith('gho_') ||
		t.startsWith('github_pat_')
	);

/**
 * apps.json / hosts.json are keyed by "<host>:<client_id>", and the client id changes between
 * Copilot releases, so iterate values instead of hardcoding the key.
 */
function extractFromAppsDoc(raw: string): GithubToken | null {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!parsed || typeof parsed !== 'object') { return null; }
		for (const value of Object.values(parsed)) {
			if (!value || typeof value !== 'object') { continue; }
			const entry = value as { oauth_token?: unknown; user?: unknown };
			if (typeof entry.oauth_token === 'string' && isSupportedGithubToken(entry.oauth_token)) {
				return {
					token: entry.oauth_token,
					login: typeof entry.user === 'string' ? entry.user : undefined,
				};
			}
		}
	} catch { /* not this file */ }
	return null;
}

async function readAppsFile(path: string): Promise<GithubToken | null> {
	try {
		return extractFromAppsDoc(await fs.readFile(path, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Finds a Copilot-capable GitHub token. `gho_`/fine-grained PATs go directly to the Copilot API;
 * only editor-plugin `ghu_` credentials use the legacy exchange endpoint.
 */
async function findGithubToken(): Promise<GithubToken | null> {
	for (const envName of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const) {
		const v = process.env[envName]?.trim();
		if (isSupportedGithubToken(v)) { return { token: v }; }
	}

	const fromKeychain = await readKeychain();
	if (fromKeychain) { return fromKeychain; }

	const candidates = [
		join(homedir(), '.copilot', 'config.json'),
		join(homedir(), '.config', 'github-copilot', 'apps.json'),
		join(homedir(), '.config', 'github-copilot', 'hosts.json'),
		join(homedir(), 'Library', 'Application Support', 'GitHub Copilot', 'apps.json'),
		join(homedir(), 'Library', 'Application Support', 'GitHub Copilot', 'hosts.json'),
	];
	for (const path of candidates) {
		const found = await readAppsFile(path);
		if (found) { return found; }
	}
	return null;
}

interface CachedSession {
	sourceToken: string;
	token: string;
	baseURL: string;
	expiresAtMs: number;
	login?: string;
}

let cachedSession: CachedSession | null = null;
let resolutionInFlight: Promise<CachedSession | null> | null = null;

async function exchangeForSession(ghu: GithubToken): Promise<CachedSession | null> {
	const res = await fetch(COPILOT_TOKEN_EXCHANGE_URL, {
		method: 'GET',
		headers: {
			'Authorization': `token ${ghu.token}`,
			'Accept': 'application/json',
			...copilotIdentityHeaders(),
		},
	});
	if (!res.ok) {
		// 404 here almost always means a `gho_` token slipped through, or the account has no
		// Copilot entitlement at all.
		return null;
	}
	const json = await res.json() as {
		token?: string;
		expires_at?: number;
		endpoints?: { api?: string };
	};
	if (!json?.token) { return null; }

	// expires_at is epoch SECONDS here (Claude's store uses ms — do not copy that assumption).
	const expiresAtMs = typeof json.expires_at === 'number'
		? json.expires_at * 1000
		: Date.now() + 25 * 60 * 1000;

	return {
		sourceToken: ghu.token,
		token: json.token,
		baseURL: json.endpoints?.api || COPILOT_DEFAULT_API_HOST,
		expiresAtMs,
		login: ghu.login,
	};
}

/**
 * Current CLI OAuth tokens do not need a short-lived token exchange, but the API host is still
 * account-specific (`individual`, `business`, or `enterprise`). Using the generic host silently
 * returns the legacy model list, which made every current CLI model fail as "not supported".
 */
async function resolveDirectSession(github: GithubToken): Promise<CachedSession | null> {
	const res = await fetch(COPILOT_USER_URL, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${github.token}`,
			'Accept': 'application/json',
			...copilotIdentityHeaders(),
		},
	});
	if (!res.ok) { return null; }
	const json = await res.json() as {
		login?: string;
		chat_enabled?: boolean;
		endpoints?: { api?: string };
	};
	if (json.chat_enabled === false) { return null; }

	return {
		sourceToken: github.token,
		token: github.token,
		baseURL: json.endpoints?.api || COPILOT_DEFAULT_API_HOST,
		// Identity/entitlement can change without the Keychain token rotating. Refresh periodically.
		expiresAtMs: Date.now() + 15 * 60 * 1000,
		login: json.login || github.login,
	};
}

/**
 * Returns a usable Copilot session token, exchanging or re-exchanging as needed.
 * Returns null when the user is not signed in to Copilot.
 */
export async function getCopilotPlanCredentials(): Promise<CopilotPlanCredentials | null> {
	const github = await findGithubToken();
	if (!github) { return null; }

	const cached = cachedSession;
	if (cached && cached.sourceToken === github.token && cached.expiresAtMs - Date.now() > SESSION_SKEW_MS) {
		return { token: cached.token, baseURL: cached.baseURL, login: cached.login };
	}

	if (!resolutionInFlight) {
		resolutionInFlight = (async () => {
			try {
				const session = looksLikeGhu(github.token)
					? await exchangeForSession(github)
					: await resolveDirectSession(github);
				cachedSession = session;
				return session;
			} catch {
				return null;
			} finally {
				resolutionInFlight = null;
			}
		})();
	}

	const session = await resolutionInFlight;
	if (!session) { return null; }
	return { token: session.token, baseURL: session.baseURL, login: session.login };
}

/** Drops the cached session so the next send re-exchanges (used after a 401). */
export function invalidateCopilotSession(): void {
	cachedSession = null;
}

/** Lightweight, never-throwing status for the Settings sign-in card. */
export interface CopilotPlanStatus {
	signedIn: boolean;
	login?: string;
}

export async function getCopilotPlanStatus(): Promise<CopilotPlanStatus> {
	try {
		const github = await findGithubToken();
		if (!github) { return { signedIn: false }; }
		return { signedIn: true, login: github.login };
	} catch {
		return { signedIn: false };
	}
}
