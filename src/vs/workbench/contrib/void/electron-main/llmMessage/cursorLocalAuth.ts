/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*---------------------------------------------------------------------------------------------
 *  Cursor (Local) — first-class lane for the "API for Cursor" desktop app.
 *
 *  The app (standardagents/composer-api) runs a signed local server that exposes an
 *  OpenAI-compatible API at http://127.0.0.1:8788/v1 and holds the user's official Cursor
 *  API key (Cursor Dashboard → Integrations). It proxies to Cursor's own models (composer-*,
 *  grok-*) against the user's Cursor subscription — there is NO per-token key and nothing to
 *  paste into V3Code. Unlike the other subscription lanes we never read the key ourselves;
 *  the app keeps it. All we can do is PROBE the local server: /v1/models answers without a
 *  key when the app is up and signed in.
 *
 *  The 413 ("Request body too large") failures this lane replaces came from pointing the
 *  generic OpenAI-Compatible provider at the app with an unbounded payload — the editor's
 *  system prompt + tool defs can run to tens of KB. The lane's model options declare a
 *  bounded context window so prompt assembly budgets the body before it is sent.
 *--------------------------------------------------------------------------------------------*/

export const CURSOR_LOCAL_DEFAULT_ENDPOINT = 'http://127.0.0.1:8788/v1';

/** Logical ids the app serves today (verified against the terminal lane's working config). */
export const CURSOR_LOCAL_MODELS = [
	'composer-2.5',
	'composer-2.5-fast',
	'grok-4.6',
	'grok-4.6-fast',
	'grok-4.5',
	'grok-4.5-fast',
] as const;

const PROBE_TIMEOUT_MS = 4_000;

/** Never-throwing status for the Settings sign-in card and the model picker's visibility gate. */
export interface CursorLocalStatus {
	signedIn: boolean;
	/** Models the local app reports, when reachable. */
	models?: string[];
}

export async function getCursorLocalStatus(endpoint?: string): Promise<CursorLocalStatus> {
	const base = (endpoint?.trim() || CURSOR_LOCAL_DEFAULT_ENDPOINT).replace(/\/+$/, '');
	try {
		const res = await fetch(`${base}/models`, {
			method: 'GET',
			headers: { 'Accept': 'application/json' },
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (!res.ok) { return { signedIn: false }; }
		const json = await res.json() as { data?: Array<{ id?: string }> };
		const models = (json?.data ?? []).map(m => m?.id).filter((id): id is string => typeof id === 'string' && !!id);
		return { signedIn: true, models: models.length ? models : [...CURSOR_LOCAL_MODELS] };
	} catch {
		// App not running, not signed in, or wrong endpoint.
		return { signedIn: false };
	}
}
