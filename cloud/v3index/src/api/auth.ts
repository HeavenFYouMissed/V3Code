/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  Bearer-token auth. Keys are scoped: read (retrieve/MCP), write (sync/ingest),
 *  admin (workspace management). Comparison is timing-safe.
 *--------------------------------------------------------------------------------------*/

export type KeyScope = 'read' | 'write' | 'admin';

export interface AuthContext {
	orgId: string;
	workspaceId: string;
	scope: KeyScope;
}

const SCOPE_RANK: Record<KeyScope, number> = { read: 0, write: 1, admin: 2 };

export function scopeSatisfies(have: KeyScope, need: KeyScope): boolean {
	return SCOPE_RANK[have] >= SCOPE_RANK[need];
}

/** Constant-time string compare (both inputs hashed first so length never leaks). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(a)),
		crypto.subtle.digest('SHA-256', enc.encode(b)),
	]);
	const va = new Uint8Array(ha);
	const vb = new Uint8Array(hb);
	let diff = 0;
	for (let i = 0; i < va.length; i++) { diff |= va[i]! ^ vb[i]!; }
	return diff === 0;
}

export function bearerFrom(req: Request): string | null {
	const h = req.headers.get('authorization');
	if (h && h.toLowerCase().startsWith('bearer ')) {
		const token = h.slice(7).trim();
		if (token.length > 0) { return token; }
	}
	// Fallback: token in the URL query (?token= or ?key=). Many editor/browser MCP
	// clients can't attach an Authorization header to a streamable-HTTP endpoint
	// (the "SyntaxError: invalid string" when a header is configured) — letting the
	// token ride in the URL lets those clients connect. Header is preferred.
	try {
		const q = new URL(req.url).searchParams;
		const t = (q.get('token') ?? q.get('key') ?? '').trim();
		if (t.length > 0) { return t; }
	} catch { /* malformed URL — fall through */ }
	return null;
}
