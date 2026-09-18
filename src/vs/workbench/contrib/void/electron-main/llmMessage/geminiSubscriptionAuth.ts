/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*---------------------------------------------------------------------------------------------
 *  Gemini (Plan) subscription auth + Code Assist transport.
 *
 *  Reuses the Google OAuth credentials that gemini-cli writes to ~/.gemini/oauth_creds.json so a
 *  user's Gemini plan (free tier, Google One AI Pro, or a Code Assist licence) drives the models
 *  instead of a billed AI Studio API key.
 *
 *  This lane does NOT talk to generativelanguage.googleapis.com — that host rejects these tokens.
 *  It talks to the Code Assist surface, cloudcode-pa.googleapis.com/v1internal, which differs from
 *  the public Gemini API in two ways that the SDK cannot express, which is why this module does
 *  its own HTTP:
 *    - the request is WRAPPED: {model, project, request: {contents, systemInstruction, ...}}
 *    - the response is wrapped too, under `.response`
 *
 *  The project id is not in the credential file. It is discovered once via :loadCodeAssist and
 *  cached, because getting it wrong is the single most common way this lane fails.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * gemini-cli's installed-app OAuth client. Google requires a client_secret for this client type;
 * it ships inside the public CLI binary, so it is not a secret in any meaningful sense, and the
 * refresh grant fails without it.
 */
const GEMINI_OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_OAUTH_CLIENT_SECRET = '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';

const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface GeminiOAuthCreds {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	token_type?: string;
	scope?: string;
	/** Epoch MILLISECONDS. */
	expiry_date?: number;
	// camelCase aliases used by newer versions:
	accessToken?: string;
	refreshToken?: string;
	idToken?: string;
	expiryDate?: number;
	/** Older RFC3339 form. */
	expiry?: string;
	[k: string]: unknown;
}

export interface GeminiPlanCredentials {
	token: string;
	projectId: string;
	email?: string;
}

const credsPaths = (): string[] => [
	join(homedir(), '.gemini', 'oauth_creds.json'),
	join(homedir(), '.gemini', 'oauth.json'),
];

interface NormalizedCreds {
	path: string;
	raw: GeminiOAuthCreds;
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresAtMs?: number;
}

const normalize = (path: string, raw: GeminiOAuthCreds): NormalizedCreds | null => {
	const accessToken = raw.access_token ?? raw.accessToken;
	if (!accessToken) { return null; }
	let expiresAtMs = raw.expiry_date ?? raw.expiryDate;
	if (typeof expiresAtMs !== 'number' && typeof raw.expiry === 'string') {
		const parsed = Date.parse(raw.expiry);
		if (!Number.isNaN(parsed)) { expiresAtMs = parsed; }
	}
	return {
		path,
		raw,
		accessToken,
		refreshToken: raw.refresh_token ?? raw.refreshToken,
		idToken: raw.id_token ?? raw.idToken,
		expiresAtMs: typeof expiresAtMs === 'number' ? expiresAtMs : undefined,
	};
};

async function loadCreds(): Promise<NormalizedCreds | null> {
	for (const path of credsPaths()) {
		try {
			const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as GeminiOAuthCreds;
			const normalized = normalize(path, parsed);
			if (normalized) { return normalized; }
		} catch { /* try the next path */ }
	}
	return null;
}

/** Email lives in the id_token claims, not in a field of its own. */
const emailFromIdToken = (idToken: string | undefined): string | undefined => {
	if (!idToken) { return undefined; }
	try {
		const payload = idToken.split('.')[1];
		if (!payload) { return undefined; }
		const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: string };
		return typeof json.email === 'string' ? json.email : undefined;
	} catch {
		return undefined;
	}
};

const isExpiringSoon = (expiresAtMs: number | undefined): boolean =>
	typeof expiresAtMs === 'number' && Number.isFinite(expiresAtMs)
		? expiresAtMs - Date.now() < REFRESH_SKEW_MS
		: false;

let refreshInFlight: Promise<NormalizedCreds | null> | null = null;

async function refreshCreds(): Promise<NormalizedCreds | null> {
	if (refreshInFlight) { return refreshInFlight; }
	refreshInFlight = (async (): Promise<NormalizedCreds | null> => {
		try {
			const loaded = await loadCreds();
			if (!loaded?.refreshToken) { return loaded; }
			if (!isExpiringSoon(loaded.expiresAtMs)) { return loaded; } // someone else refreshed

			const body = new URLSearchParams({
				client_id: GEMINI_OAUTH_CLIENT_ID,
				client_secret: GEMINI_OAUTH_CLIENT_SECRET,
				refresh_token: loaded.refreshToken,
				grant_type: 'refresh_token',
			});
			const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body.toString(),
			});
			if (!res.ok) { return loaded; }
			const json = await res.json() as { access_token?: string; expires_in?: number; id_token?: string };
			if (!json?.access_token) { return loaded; }

			// Google does not normally rotate the refresh token, so preserve the existing one.
			const updatedRaw: GeminiOAuthCreds = {
				...loaded.raw,
				access_token: json.access_token,
				expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
			};
			if (json.id_token) { updatedRaw.id_token = json.id_token; }
			try {
				await fs.writeFile(loaded.path, JSON.stringify(updatedRaw, null, 2), { mode: 0o600 });
			} catch { /* best-effort; still use the fresh token */ }

			return normalize(loaded.path, updatedRaw) ?? loaded;
		} catch {
			return loadCreds();
		} finally {
			refreshInFlight = null;
		}
	})();
	return refreshInFlight;
}

/** Discovered once per process — the call is not free and the answer does not change. */
let cachedProjectId: string | undefined;

async function discoverProjectId(accessToken: string): Promise<string | null> {
	const envProject = process.env.GOOGLE_CLOUD_PROJECT?.trim() || process.env.GOOGLE_CLOUD_PROJECT_ID?.trim();
	if (envProject) { return envProject; }

	try {
		const res = await fetch(`${CODE_ASSIST_BASE_URL}:loadCodeAssist`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				cloudaicompanionProject: null,
				metadata: { ideType: 'GEMINI_CLI', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
			}),
		});
		if (!res.ok) { return null; }
		const json = await res.json() as { cloudaicompanionProject?: string };
		return json?.cloudaicompanionProject ?? null;
	} catch {
		return null;
	}
}

/**
 * Current Gemini subscription credentials plus the Code Assist project id, refreshing and
 * discovering as needed. Returns null when the user has not signed in to gemini-cli.
 */
export async function getGeminiPlanCredentials(): Promise<GeminiPlanCredentials | null> {
	let loaded = await loadCreds();
	if (!loaded) { return null; }
	if (isExpiringSoon(loaded.expiresAtMs)) {
		loaded = await refreshCreds() ?? loaded;
	}

	if (!cachedProjectId) {
		cachedProjectId = await discoverProjectId(loaded.accessToken) ?? undefined;
	}
	if (!cachedProjectId) { return null; }

	return {
		token: loaded.accessToken,
		projectId: cachedProjectId,
		email: emailFromIdToken(loaded.idToken),
	};
}

/** Lightweight, never-throwing status for the Settings sign-in card. */
export interface GeminiPlanStatus {
	signedIn: boolean;
	email?: string;
	/** Epoch ms. */
	expiresAt?: number;
	/** False when signed in but the Code Assist project could not be resolved. */
	projectResolved?: boolean;
}

export async function getGeminiPlanStatus(): Promise<GeminiPlanStatus> {
	try {
		const loaded = await loadCreds();
		if (!loaded) { return { signedIn: false }; }
		if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
			// gemini-cli prefers this env var over the credential file, so the two can disagree
			// about who is signed in. Surface it rather than silently using a different identity.
			console.warn('[gemini-plan] GOOGLE_APPLICATION_CREDENTIALS is set; gemini-cli may be using a different identity than this lane.');
		}
		return {
			signedIn: true,
			email: emailFromIdToken(loaded.idToken),
			expiresAt: loaded.expiresAtMs,
			projectResolved: !!cachedProjectId,
		};
	} catch {
		return { signedIn: false };
	}
}

/** One streamed chunk, already unwrapped from the Code Assist envelope. */
export interface CodeAssistChunk {
	candidates?: {
		content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown; id?: string } }[] };
		finishReason?: string;
	}[];
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
		cachedContentTokenCount?: number;
	};
}

/**
 * Streams a Code Assist generateContent call, yielding unwrapped chunks.
 *
 * `generationConfig` is sent inside `request`, but some backend revisions reject it outright
 * ("Unknown name generationConfig"), so that specific failure retries once without it rather
 * than failing the turn.
 */
export async function* streamCodeAssist(args: {
	creds: GeminiPlanCredentials;
	model: string;
	contents: unknown;
	systemInstruction?: unknown;
	tools?: unknown;
	generationConfig?: Record<string, unknown>;
	signal: AbortSignal;
}): AsyncGenerator<CodeAssistChunk, void, unknown> {
	const buildBody = (includeGenerationConfig: boolean) => {
		const request: Record<string, unknown> = { contents: args.contents };
		if (args.systemInstruction) { request.systemInstruction = args.systemInstruction; }
		if (args.tools) { request.tools = args.tools; }
		if (includeGenerationConfig && args.generationConfig) { request.generationConfig = args.generationConfig; }
		return JSON.stringify({ model: args.model, project: args.creds.projectId, request });
	};

	const doFetch = (includeGenerationConfig: boolean) => fetch(
		`${CODE_ASSIST_BASE_URL}:streamGenerateContent?alt=sse`,
		{
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${args.creds.token}`,
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream',
			},
			body: buildBody(includeGenerationConfig),
			signal: args.signal,
		},
	);

	let res = await doFetch(true);
	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		if (args.generationConfig && /generationConfig/i.test(errText)) {
			res = await doFetch(false);
			if (!res.ok) {
				throw new Error(codeAssistErrorMessage(res.status, await res.text().catch(() => '')));
			}
		} else {
			throw new Error(codeAssistErrorMessage(res.status, errText));
		}
	}
	if (!res.body) { throw new Error('Gemini (Plan): the Code Assist response had no body.'); }

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }
			buffer += decoder.decode(value, { stream: true });

			// SSE frames are separated by a blank line; a frame may carry several `data:` lines.
			let sep: number;
			while ((sep = buffer.indexOf('\n\n')) !== -1) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const payload = frame
					.split('\n')
					.filter(line => line.startsWith('data:'))
					.map(line => line.slice(5).trim())
					.join('');
				if (!payload || payload === '[DONE]') { continue; }
				try {
					const parsed = JSON.parse(payload) as { response?: CodeAssistChunk } & CodeAssistChunk;
					// Unwrap the Code Assist envelope; tolerate a bare chunk just in case.
					yield parsed.response ?? parsed;
				} catch { /* a partial or non-JSON keepalive frame */ }
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** Turns Code Assist's JSON error bodies into something a user can act on. */
function codeAssistErrorMessage(status: number, body: string): string {
	let reason = '';
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string; status?: string; details?: { reason?: string }[] } };
		reason = parsed?.error?.details?.find(d => d.reason)?.reason ?? parsed?.error?.status ?? parsed?.error?.message ?? '';
	} catch { /* body was not JSON */ }

	if (status === 429) {
		// On this surface a 429 is usually SERVER capacity, not the user's quota, and it often
		// arrives with no Retry-After. Saying "quota exceeded" would send the user to go buy
		// something that will not help.
		return reason.includes('MODEL_CAPACITY_EXHAUSTED')
			? 'Gemini (Plan): Google reports no capacity for this model right now (not your quota). Try again shortly or pick another model.'
			: 'Gemini (Plan): rate limited by Google. Try again shortly.';
	}
	if (status === 401 || status === 403) {
		return 'Gemini (Plan): Google rejected the sign-in. Run `gemini` and sign in again. (Settings > Models > Gemini (Plan))';
	}
	return `Gemini (Plan): Code Assist returned ${status}${reason ? ` (${reason})` : ''}.`;
}
