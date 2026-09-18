/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*---------------------------------------------------------------------------------------------
 *  OpenAI (Plan) — ChatGPT Plus/Pro via Codex CLI tokens.
 *
 *  Copied from the working terminal Codex plan path (packages/opencode/src/plugin/openai/codex.ts)
 *  and the editor grokPlan credential-file pattern. Reads ~/.codex/auth.json when
 *  auth_mode is "chatgpt". NEVER reads or sends an API key — the separate `openAI`
 *  provider is the BYOK / per-token lane.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OPENAI_PLAN_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const authJsonPath = () => join(homedir(), '.codex', 'auth.json');

interface CodexAuthFile {
	auth_mode?: string;
	tokens?: {
		id_token?: string;
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	};
}

export interface OpenaiPlanCredentials {
	token: string;
	accountId?: string;
	expiresAt?: number;
}

function parseJwtPayload(token: string): { exp?: number; chatgpt_account_id?: string; email?: string } | undefined {
	const parts = token.split('.');
	if (parts.length !== 3) { return undefined; }
	try {
		return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { exp?: number; chatgpt_account_id?: string; email?: string };
	} catch {
		return undefined;
	}
}

async function loadCodexChatgpt(): Promise<CodexAuthFile | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(authJsonPath(), 'utf8')) as CodexAuthFile;
		if (parsed?.auth_mode !== 'chatgpt') { return null; }
		if (!parsed.tokens?.access_token || !parsed.tokens?.refresh_token) { return null; }
		return parsed;
	} catch {
		return null;
	}
}

function isExpiringSoon(access: string): boolean {
	const exp = parseJwtPayload(access)?.exp;
	if (typeof exp !== 'number') { return false; }
	return exp * 1000 - Date.now() < REFRESH_SKEW_MS;
}

async function refreshAccess(refreshToken: string): Promise<{ access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number } | null> {
	try {
		const res = await fetch(`${ISSUER}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}).toString(),
		});
		if (!res.ok) { return null; }
		return await res.json() as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
	} catch {
		return null;
	}
}

async function persistTokens(doc: CodexAuthFile, tokens: { access_token?: string; refresh_token?: string; id_token?: string }): Promise<void> {
	const next: CodexAuthFile = {
		...doc,
		auth_mode: 'chatgpt',
		tokens: {
			...doc.tokens,
			...(tokens.access_token ? { access_token: tokens.access_token } : {}),
			...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
			...(tokens.id_token ? { id_token: tokens.id_token } : {}),
		},
	};
	try {
		await fs.writeFile(authJsonPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
	} catch { /* best-effort */ }
}

export async function getOpenaiPlanCredentials(): Promise<OpenaiPlanCredentials | null> {
	let doc = await loadCodexChatgpt();
	if (!doc?.tokens?.access_token) { return null; }

	if (isExpiringSoon(doc.tokens.access_token) && doc.tokens.refresh_token) {
		const refreshed = await refreshAccess(doc.tokens.refresh_token);
		if (refreshed?.access_token) {
			await persistTokens(doc, refreshed);
			doc = await loadCodexChatgpt() ?? doc;
			if (refreshed.access_token) {
				doc = {
					...doc,
					tokens: {
						...doc.tokens,
						access_token: refreshed.access_token,
						refresh_token: refreshed.refresh_token ?? doc.tokens?.refresh_token,
					},
				};
			}
		}
	}

	const token = doc.tokens?.access_token;
	if (!token) { return null; }
	const payload = parseJwtPayload(token);
	return {
		token,
		accountId: doc.tokens?.account_id ?? payload?.chatgpt_account_id,
		expiresAt: typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined,
	};
}

export interface OpenaiPlanStatus {
	signedIn: boolean;
	email?: string;
	expiresAt?: number;
}

export async function getOpenaiPlanStatus(): Promise<OpenaiPlanStatus> {
	try {
		const doc = await loadCodexChatgpt();
		const access = doc?.tokens?.access_token;
		if (!access) { return { signedIn: false }; }
		const payload = parseJwtPayload(access);
		return {
			signedIn: true,
			email: payload?.email,
			expiresAt: typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined,
		};
	} catch {
		return { signedIn: false };
	}
}
