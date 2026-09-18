/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  API-key registry (P1). Tokens look like `v3k_<48 hex>`; only the SHA-256 of
 *  the token is stored. KV layout:
 *    key:<tokenHash>          → KeyRecord            (auth lookup, O(1))
 *    ws:<workspaceId>:<hash>  → KeyRecord            (listing per workspace)
 *  Revocation flips `revoked` on both rows (KV is eventually consistent —
 *  revocation propagates globally within ~60s, acceptable for API keys).
 *--------------------------------------------------------------------------------------*/

import type { KeyScope } from './auth.js';

export interface KeyRecord {
	tokenHash: string;
	workspaceId: string; // '*' = all workspaces (org key)
	scope: KeyScope;
	label: string;
	createdAt: number;
	revoked?: boolean;
}

export interface CreatedKey extends KeyRecord {
	/** Returned exactly once at creation — never stored. */
	token: string;
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function createKey(kv: KVNamespace, workspaceId: string, scope: KeyScope, label: string): Promise<CreatedKey> {
	const raw = new Uint8Array(24);
	crypto.getRandomValues(raw);
	const token = 'v3k_' + [...raw].map(b => b.toString(16).padStart(2, '0')).join('');
	const tokenHash = await sha256Hex(token);
	const record: KeyRecord = { tokenHash, workspaceId, scope, label, createdAt: Date.now() };
	const json = JSON.stringify(record);
	await kv.put(`key:${tokenHash}`, json);
	await kv.put(`ws:${workspaceId}:${tokenHash}`, json);
	return { ...record, token };
}

export async function lookupToken(kv: KVNamespace, token: string): Promise<KeyRecord | null> {
	if (!token.startsWith('v3k_')) return null;
	const rec = await kv.get<KeyRecord>(`key:${await sha256Hex(token)}`, 'json');
	if (!rec || rec.revoked) return null;
	return rec;
}

export async function revokeKey(kv: KVNamespace, tokenHash: string): Promise<boolean> {
	const rec = await kv.get<KeyRecord>(`key:${tokenHash}`, 'json');
	if (!rec) return false;
	rec.revoked = true;
	const json = JSON.stringify(rec);
	await kv.put(`key:${tokenHash}`, json);
	await kv.put(`ws:${rec.workspaceId}:${tokenHash}`, json);
	return true;
}

export async function listKeys(kv: KVNamespace, workspaceId: string): Promise<KeyRecord[]> {
	const out: KeyRecord[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: `ws:${workspaceId}:`, cursor });
		for (const k of page.keys) {
			const rec = await kv.get<KeyRecord>(k.name, 'json');
			if (rec) out.push(rec);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return out;
}
