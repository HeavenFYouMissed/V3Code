/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  V3Index Worker entry — REST API + per-workspace MCP endpoint + embed queue
 *  consumer. Routes under /v1/ws/:id/* forward to the workspace's Durable
 *  Object; /retrieve and /mcp orchestrate the vector channel (Vectorize) around
 *  the DO's lexical+graph fusion.
 *--------------------------------------------------------------------------------------*/

import type { Env, EmbedJob } from './env.js';
import { WorkspaceDO } from './do/workspaceDO.js';
import { embedIdentityOf, embedQuery, embedTextsIsolated } from './embed/embedder.js';
import { handleMcp, McpToolDef } from './mcp/mcpHandler.js';
import { bearerFrom, KeyScope, scopeSatisfies } from './api/auth.js';
import { createKey, listKeys, lookupToken, revokeKey } from './api/keys.js';
import { createQueryExpander } from './core/queryExpander.js';
import { tokenize } from './core/tokenize.js';
import { isIndexProfile, isPrivacyMode, privacyModeForProfile, vectorIndexFor, type IndexProfile } from './core/indexProfile.js';
export { tokenize };

export { WorkspaceDO };

const VECTOR_TOPK = 60; // candidates from the vector channel pre-fusion

// P0 read-path hardening (see V3INDEX review). The read tier had no cost ceiling:
// topK was unclamped (full-corpus fusion + unbounded response), queries were
// uncapped (the O(n^2) camelCase tokenizer + a billed query embedding per call),
// and Vectorize hits entered fusion with their cosine scores discarded (no floor).
const MIN_TOPK = 1;
const MAX_TOPK = 50;
const DEFAULT_TOPK = 30;
const MAX_QUERY_LEN = 8192; // 8KB — bounds tokenize() worst case and embed cost
const MAX_FILE_FILTERS = 500;
const MAX_FILE_PATH_LEN = 1024;
const SESSION_TTL_SECONDS = 15 * 60;
/** Cosine floor for admitting a Vectorize hit into fusion (editor hybridRetriever
 *  VEC_FLOOR parity). Vectorize always returns its topK nearest regardless of
 *  absolute similarity, so without this the heavier-weighted (0.6) vector channel
 *  fills with noise on weak/out-of-domain queries. */
export const VEC_FLOOR = 0.25;

/** Clamp a client-supplied topK to [1,50]; non-numeric/NaN falls back to the
 *  default. Bounds candidate materialization, fusion work, and response size. */
export function clampTopK(raw: unknown): number {
	if (raw == null) return DEFAULT_TOPK; // not provided (null/undefined) → default
	const n = Math.trunc(Number(raw));
	if (!Number.isFinite(n)) return DEFAULT_TOPK;
	return Math.min(MAX_TOPK, Math.max(MIN_TOPK, n));
}

/** Returns an error message if the query is unusable, else null. The length cap
 *  is the primary guard against the quadratic-backtracking tokenizer and against
 *  driving a Workers AI query embedding with an oversized string. */
export function queryError(query: unknown): string | null {
	if (typeof query !== 'string') return 'query must be a string';
	if (query.length === 0) return 'query must not be empty';
	if (query.length > MAX_QUERY_LEN) return `query exceeds ${MAX_QUERY_LEN}-character limit`;
	return null;
}

export function normalizeFileFilter(raw: unknown): { files?: string[]; error?: string } {
	if (raw === undefined) return {};
	if (!Array.isArray(raw)) return { error: 'files must be an array of workspace-relative paths' };
	if (raw.length > MAX_FILE_FILTERS) return { error: `files exceeds ${MAX_FILE_FILTERS}-path limit` };
	const files = new Set<string>();
	for (const item of raw) {
		if (typeof item !== 'string') return { error: 'every files entry must be a string' };
		const file = item.replace(/\\/g, '/').replace(/^\.\//, '');
		const segments = file.split('/');
		if (!file || file.length > MAX_FILE_PATH_LEN || file.startsWith('/') || file.includes('\0') || segments.some(segment => !segment || segment === '.' || segment === '..')) {
			return { error: 'files entries must be safe workspace-relative paths' };
		}
		files.add(file);
	}
	return { files: [...files] };
}

/** Drop Vectorize matches below the cosine floor, preserving best-first order. */
export function filterVectorMatches(matches: ReadonlyArray<{ id: string; score: number }>, floor = VEC_FLOOR): string[] {
	return matches.filter(m => m.score >= floor).map(m => m.id);
}

// --- Workspace-scoped vector ids ----------------------------------------------
// Chunk id = hash(file:start:end) has NO workspace component, but the Vectorize
// index is SHARED across workspaces and deleteByIds takes no namespace — so two
// workspaces indexing the same path+line-range collided on one vector id, and a
// prune in one deleted the other's vector. Every vector id is therefore prefixed
// with `${workspaceId}:` at write and delete time; queries strip it back to the
// bare chunk id the DO's SQLite matches against. wsId is `[A-Za-z0-9_-]{1,64}`
// and chunk ids are hex — neither contains ':', so the split is unambiguous.
/** Prefix a chunk id with its workspace for storage in the shared Vectorize index. */
export function vectorId(wsId: string, chunkId: string): string {
	return `${wsId}:${chunkId}`;
}
/** Strip the `${wsId}:` prefix from a returned vector id back to the bare chunk
 *  id. Tolerates legacy UNSALTED ids (pre-migration vectors have no prefix) so
 *  retrieval works across the transition. */
export function unsaltVectorId(wsId: string, id: string): string {
	const p = `${wsId}:`;
	return id.startsWith(p) ? id.slice(p.length) : id;
}

/** Max chunks accepted in one /chunks call. Bounds the DO's per-request CPU +
 *  memory (the whole batch is buffered and ingested synchronously). The editor
 *  syncer batches ~400; this leaves headroom while rejecting the pathological
 *  multi-thousand-chunk uploads that killed the isolate (→ CF HTML 500). */
export const MAX_CHUNKS_PER_BATCH = 1000;
/** Also cap total content bytes per batch — 1000 chunks is fine for tiny chunks
 *  but a batch of large-content chunks still pressures DO CPU + the single
 *  transaction commit. ~10MB keeps a batch well under the 30s default CPU. */
export const MAX_BATCH_CONTENT_BYTES = 10 * 1024 * 1024;

/** Validates a /chunks body's shape/size; returns an error message or null. */
export function chunksBatchError(body: unknown): string | null {
	const chunks = (body as { chunks?: unknown })?.chunks;
	if (!Array.isArray(chunks)) return 'chunks must be an array';
	if (chunks.length > MAX_CHUNKS_PER_BATCH) {
		return `batch too large: ${chunks.length} chunks (max ${MAX_CHUNKS_PER_BATCH} per /chunks call — split into smaller batches)`;
	}
	let bytes = 0;
	for (const c of chunks) {
		const content = (c as { content?: unknown })?.content;
		if (typeof content === 'string') bytes += content.length;
		if (bytes > MAX_BATCH_CONTENT_BYTES) {
			return `batch too large: content exceeds ${MAX_BATCH_CONTENT_BYTES} bytes (split into smaller batches)`;
		}
	}
	return null;
}

/** Split an array into fixed-size groups (used to respect batch caps). */
export function chunkArr<T>(a: T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
	return out;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Single choke point so a thrown error or malformed JSON body returns
		// STRUCTURED JSON, never a raw Cloudflare HTML 500 (which clients can't
		// parse — the editor E2E hit exactly that). A hard CPU/memory kill still
		// can't be caught here; the /chunks batch cap + the linear tokenizer
		// prevent that class of failure upstream instead.
		try {
			return await handleRequest(request, env);
		} catch (err: any) {
			const msg = err?.message ?? String(err);
			const status = /json|parse|unexpected (token|end|non-whitespace)/i.test(msg) ? 400 : 500;
			return json({ error: msg }, status);
		}
	},

	/** Embed pipeline consumer: ids → DO embed-text → Workers AI → Vectorize →
	 *  DO vector-done (which purges transient embed text). */
	async queue(batch: MessageBatch<EmbedJob>, env: Env): Promise<void> {
		// The dead-letter queue drains here too (see wrangler.jsonc). A job that
		// exhausted its retries on the main queue lands on v3index-embed-dlq;
		// instead of vanishing silently, mark its chunks embed_failed in their DO
		// so /status surfaces the gap. Its pending_embed_text is left intact, so a
		// later /requeue can still recover it. (P1 #5 — was an unconsumed sink.)
		if (batch.queue === 'v3index-embed-dlq') {
			for (const msg of batch.messages) {
				try {
					const job = msg.body;
					const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(job.workspaceId));
					await forward(stub, '/embed-failed', { ids: job.chunkIds });
					msg.ack();
				} catch {
					msg.retry();
				}
			}
			return;
		}
		for (const msg of batch.messages) {
			const job = msg.body;
			try {
				const indexProfile: IndexProfile = job.indexProfile ?? 'standard';
				const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(job.workspaceId));
				// Guard the DO response: a 500 {error} JSON (transient DO trouble)
				// must be RETRIED, not mistaken for "no texts" — the old
				// `const { texts } = await res.json()` threw on `texts.length`, sent
				// the whole batch to retry→DLQ, and mis-marked every id embed_failed
				// (a plausible cause of the '13k pending / 0 vectors' incident).
				const res = await forward(stub, '/embed-text', { ids: job.chunkIds });
				if (!res.ok) {
					console.error(JSON.stringify({ evt: 'embed-text-http-error', ws: job.workspaceId, status: res.status }));
					msg.retry();
					continue;
				}
				const texts = (await res.json<any>().catch(() => null))?.texts;
				if (!Array.isArray(texts)) {
					console.error(JSON.stringify({ evt: 'embed-text-malformed', ws: job.workspaceId }));
					msg.retry();
					continue;
				}
				if (texts.length > 0) {
					// Per-item isolation: a poisonous text yields vector:null for
					// exactly that id instead of retry→DLQ'ing the whole batch (the
					// failure mode that repeatedly stranded requeued chunks in prod).
					const results = await embedTextsIsolated(env, texts, indexProfile);
					const ok = results.filter((r): r is { id: string; vector: number[] } => r.vector !== null);
					const poisoned = results.filter(r => r.vector === null).map(r => r.id);
					if (ok.length > 0) {
						const vectors = ok.map(r => ({
							// Workspace-prefixed id (shared index; see vectorId). namespace
							// is kept too — it's the query-time filter — but the prefix is
							// what makes deleteByIds tenant-safe.
							id: vectorId(job.workspaceId, r.id),
							values: r.vector,
							namespace: job.workspaceId,
							metadata: { identity: job.embedIdentity },
						}));
						// Vectorize upsert caps at 1000 vectors/call; a full consumer
						// batch (max_batch_size 20 × EMBED_JOB_BATCH 80 = up to 1600) can
						// exceed it → throw → whole batch retried→DLQ'd → chunks stuck at
						// 0 vectors. Chunk to ≤500 (also comfortably under any byte cap).
						for (const group of chunkArr(vectors, 500)) {
							await vectorIndexFor(env, indexProfile).upsert(group);
						}
						await forward(stub, '/vector-done', { ids: ok.map(r => r.id) });
					}
					if (poisoned.length > 0) {
						await forward(stub, '/embed-failed', { ids: poisoned });
					}
				}
				// Silent-ack fix (P1 #6): any requested id with no returned text is
				// either already embedded (has_vector=1 → /embed-failed no-ops via
				// its guard) or genuinely gone; mark it so it is not lost silently
				// as a permanent has_vector=0 with no signal.
				const returned = new Set<string>(texts.map((t: { id: string }) => t.id));
				const missing = job.chunkIds.filter(id => !returned.has(id));
				if (missing.length > 0) {
					await forward(stub, '/embed-failed', { ids: missing });
				}
				msg.ack();
			} catch (err: any) {
				console.error(JSON.stringify({ evt: 'embed-consume-error', ws: job.workspaceId, error: err?.message ?? String(err) }));
				msg.retry();
			}
		}
	},
} satisfies ExportedHandler<Env, EmbedJob>;

/** REST + MCP request routing. Wrapped by fetch()'s try/catch so every failure
 *  becomes structured JSON. */
async function handleRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (url.pathname.startsWith('/v1/admin/keys')) return adminKeys(request, env, url);

	const m = url.pathname.match(/^\/v1\/ws\/([A-Za-z0-9_-]{1,64})(\/.*)$/);
	if (!m) return json({ error: 'not found' }, 404);
	const [, wsId, rest] = m as unknown as [string, string, string];

	// /debug/text-rows and /debug/edge-count are read-scoped like /status —
	// they return a row COUNT only (see workspaceDO.debug*), never chunk
	// content, so they are safe at the same tier as other read-only
	// introspection endpoints.
	const READ_ROUTES = new Set(['/retrieve', '/mcp', '/status', '/symbol', '/neighbors', '/outline', '/debug/text-rows', '/debug/edge-count']);
	const scopeNeeded: KeyScope = READ_ROUTES.has(rest) ? 'read' : 'write';
	const auth = await verifyToken(env, bearerFrom(request), wsId);
	if (!auth || !scopeSatisfies(auth.scope, scopeNeeded)) return json({ error: 'unauthorized' }, 401);

	const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(wsId));

	switch (rest) {
		case '/init': {
			const body = await request.json<any>();
			const indexProfile = auth.indexProfile;
			const privacyMode = auth.sessionBound
				? auth.privacyMode
				: (isPrivacyMode(body.privacyMode) ? body.privacyMode : privacyModeForProfile(indexProfile));
			return forward(stub, '/init', {
				...body,
				workspaceId: wsId,
				indexProfile,
				privacyMode,
				embedIdentity: embedIdentityOf(env, indexProfile),
			});
		}
		case '/sync/begin':
		case '/chunks/check':
		case '/signals/edits':
		case '/graph/lsp-edges':
			return forward(stub, rest, await request.json());
		case '/chunks': {
			const body = await request.json<any>();
			// Reject oversized batches before the DO buffers + synchronously ingests
			// them — the guard that keeps a huge upload from killing the isolate.
			const tooBig = chunksBatchError(body);
			if (tooBig) return json({ error: tooBig }, 413);
			return forward(stub, '/chunks', { ...body, _meter: auth.meterKey });
		}
		case '/status':
			return forward(stub, '/status', undefined, 'GET');
		case '/symbol':
		case '/neighbors':
		case '/outline':
			// Deterministic graph navigation (also exposed as MCP tools).
			return forward(stub, rest, await request.json().catch(() => ({})));
		case '/debug/text-rows':
			return forward(stub, '/debug/text-rows', await request.json());
		case '/debug/edge-count':
			return forward(stub, '/debug/edge-count', await request.json().catch(() => ({})));
		case '/debug/chunk-ids':
			// Live chunk ids for the ghost-vector purge script (opaque hashes,
			// keyset-paginated). Deliberately NOT in READ_ROUTES: write scope.
			return forward(stub, '/debug/chunk-ids', await request.json().catch(() => ({})));
		case '/requeue':
			return forward(stub, '/requeue', {});
		case '/reset':
			// Destructive: wipe + recreate the workspace (recovery from a wedged DO).
			return forward(stub, '/reset', {});
		case '/prune/kick':
			// Bounded background-prune drain, one batch per call (same pattern as
			// /reindex-graph): loop on {remaining > 0}. Write-scoped by default.
			return forward(stub, '/prune/kick', {});
		case '/reindex-graph':
			// Migration/backfill: builds symbol_edges for a workspace that has
			// chunks but no edges (pre-existing index). Write-scoped; the caller
			// loops on the returned {done:false, lastId} until done. Each call is
			// bounded (~2-3k chunks) to stay under DO CPU limits.
			return forward(stub, '/reindex-graph', await request.json().catch(() => ({})));
		case '/retrieve': {
			const body = await request.json<{ query: string; topK?: number; files?: string[] }>();
			const invalid = queryError(body.query);
			if (invalid) return json({ error: invalid }, 400);
			const fileFilter = normalizeFileFilter(body.files);
			if (fileFilter.error) return json({ error: fileFilter.error }, 400);
			const result = await retrieve(env, stub, wsId, body.query, body.topK ?? DEFAULT_TOPK, auth.meterKey, fileFilter.files, auth.indexProfile);
			return json(result);
		}
		case '/mcp':
			return handleMcp(request, mcpTools(env, stub, wsId, auth.meterKey, auth.indexProfile), `v3index:${wsId}`);
		default:
			return json({ error: 'not found' }, 404);
	}
}

async function retrieve(env: Env, stub: DurableObjectStub, wsId: string, query: string, topK: number, meterKey = 'internal', files?: string[], indexProfile: IndexProfile = 'standard') {
	const t0 = Date.now();
	// Hard guard so no caller (REST, MCP, or internal) can drive the tokenizer or
	// the embedder with an oversized/invalid query. The REST route translates this
	// to a 400 before we get here; the MCP handler surfaces it as a tool error.
	const invalid = queryError(query);
	if (invalid) throw new Error(invalid);
	const k = clampTopK(topK);
	if (files && files.length === 0) {
		return { hits: [], vectorCoverage: null, tookMs: Date.now() - t0, _timings: { embedVecMs: 0, queryMs: 0, scopedEmpty: true } };
	}
	const expander = createQueryExpander({ mode: 'heuristic' });
	const expansion = await expander.expand(query);
	const queryTokens = dedupe([...tokenize(query), ...expansion.codeTerms.flatMap(tokenize)]);

	// Vector channel — Qwen's query-side instruction is applied in embedQuery;
	// document vectors remain hdr2-enriched raw passages.
	let vectorRanked: string[] = [];
	try {
		const qv = await embedQuery(env, query, indexProfile);
		const res = await vectorIndexFor(env, indexProfile).query(qv, { namespace: wsId, topK: Math.min(VECTOR_TOPK, 100) });
		// Drop below-floor cosine hits before fusion — Vectorize returns its topK
		// nearest regardless of similarity, so unfiltered noise would enter the
		// 0.6-weighted channel and can outrank exact lexical answers. Strip the
		// `${wsId}:` id prefix so the ids match the DO's bare-chunk-id SQLite rows
		// (tolerant of legacy unsalted vectors during the migration window).
		vectorRanked = filterVectorMatches(res.matches).map(id => unsaltVectorId(wsId, id));
	} catch {
		// Embedder/Vectorize down → lexical-only retrieval, never a failed request.
	}

	const _tVec = Date.now();
	const doRes = await (await forward(stub, '/query', { queryTokens, vectorRanked, topK: k, files, _meter: meterKey })).json<any>();
	const _tQuery = Date.now();
	// vectorCoverage removed from the hot path: it was a full /status COUNT-scan DO
	// round-trip on EVERY search (~0.34s) for a cosmetic ops number. The editor can
	// poll /status separately when it wants coverage — a search must not pay for it.
	return { hits: doRes.hits, vectorCoverage: null, tookMs: Date.now() - t0, _timings: { embedVecMs: _tVec - t0, queryMs: _tQuery - _tVec, ...doRes._timings } };
}

function mcpTools(env: Env, stub: DurableObjectStub, wsId: string, meterKey = 'mcp', indexProfile: IndexProfile = 'standard'): McpToolDef[] {
	return [
		{
			name: 'search_codebase',
			description: 'Hybrid semantic + lexical + graph search over the indexed workspace. Call this FIRST for any question about where something lives or how it works — it beats grep for concepts and cross-file relationships. Returns ranked chunks with file:line ranges.',
			inputSchema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Natural-language or symbol query' },
					topK: { type: 'number', description: 'Max results (default 15)' },
				},
				required: ['query'],
			},
			invoke: async (args: { query: string; topK?: number }) =>
				retrieve(env, stub, wsId, args.query, args.topK ?? 15, meterKey, undefined, indexProfile),
		},
		{
			name: 'symbol_lookup',
			description: 'Find where a symbol (function/class/type/variable) is DEFINED — deterministic go-to-definition over the dependency graph, exact not semantic. Use for "where is X defined". Faster and more precise than search_codebase when you know the exact name.',
			inputSchema: {
				type: 'object',
				properties: { symbol: { type: 'string', description: 'Exact symbol name' } },
				required: ['symbol'],
			},
			invoke: async (args: { symbol: string }) => (await forward(stub, '/symbol', { symbol: args.symbol, which: 'def' })).json(),
		},
		{
			name: 'find_references',
			description: 'Find every call site / reference of a symbol — deterministic find-references over the dependency graph. Use for "who calls X" / "where is X used".',
			inputSchema: {
				type: 'object',
				properties: { symbol: { type: 'string', description: 'Exact symbol name' } },
				required: ['symbol'],
			},
			invoke: async (args: { symbol: string }) => (await forward(stub, '/symbol', { symbol: args.symbol, which: 'ref' })).json(),
		},
		{
			name: 'graph_neighbors',
			description: 'Given a chunkId (from a search_codebase hit), return the directly related chunks — the definitions it calls and the callers that use it. Use to expand context around a result without another search.',
			inputSchema: {
				type: 'object',
				properties: { chunkId: { type: 'string', description: 'chunkId from a search_codebase hit' }, max: { type: 'number', description: 'Max neighbors (default 10)' } },
				required: ['chunkId'],
			},
			invoke: async (args: { chunkId: string; max?: number }) => (await forward(stub, '/neighbors', { chunkId: args.chunkId, max: args.max })).json(),
		},
		{
			name: 'file_outline',
			description: 'List the functions/classes/blocks in a file in order (name, kind, line range) — the file\'s structure, so you can navigate before reading the whole file.',
			inputSchema: {
				type: 'object',
				properties: { file: { type: 'string', description: 'Workspace-relative file path' } },
				required: ['file'],
			},
			invoke: async (args: { file: string }) => (await forward(stub, '/outline', { file: args.file })).json(),
		},
		{
			name: 'index_status',
			description: 'Index health for this workspace: files, chunks, vector coverage, embed identity. Call when search results seem stale or empty.',
			inputSchema: { type: 'object', properties: {} },
			invoke: async () => (await forward(stub, '/status', undefined, 'GET')).json(),
		},
	];
}

interface AuthResult {
	scope: KeyScope;
	meterKey: string;
	indexProfile: IndexProfile;
	privacyMode: 'vectors-only' | 'ephemeral';
	sessionBound: boolean;
}

export interface IndexSessionClaims {
	v: 1;
	iss: 'superclaw';
	aud: 'v3index';
	sub: string;
	ws: string;
	scope: 'read' | 'write';
	profile: IndexProfile;
	privacy: 'vectors-only' | 'ephemeral';
	iat: number;
	exp: number;
	jti: string;
}

/** Verify the control plane's compact HMAC token without network or KV lookup. */
export async function verifySessionToken(
	token: string,
	secret: string,
	wsId: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<IndexSessionClaims | null> {
	const secretBytes = new TextEncoder().encode(secret);
	if (!token.startsWith('v3s_') || token.length > 4096 || secretBytes.byteLength < 32) return null;
	const parts = token.slice(4).split('.');
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	const [encoded, suppliedSignature] = parts as [string, string];

	const key = await crypto.subtle.importKey(
		'raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
	if (!(await timingSafeEq(suppliedSignature, b64url(new Uint8Array(signature))))) return null;

	try {
		const payloadBytes = fromB64url(encoded);
		if (!payloadBytes) return null;
		const rawClaims = JSON.parse(new TextDecoder().decode(payloadBytes)) as Partial<IndexSessionClaims>;
		// Rolling-deploy bridge: sessions minted by the pre-profile control plane
		// did not contain these claims. Treat only that exact absence as Standard;
		// invalid or mismatched present values are still rejected. This lets the
		// Worker deploy first without an auth outage or a mixed model space.
		const profile: unknown = rawClaims.profile ?? 'standard';
		const privacy: unknown = rawClaims.privacy ?? 'vectors-only';
		const claims = { ...rawClaims, profile, privacy } as Partial<IndexSessionClaims>;
		if (
			claims.v !== 1 || claims.iss !== 'superclaw' || claims.aud !== 'v3index' || claims.ws !== wsId ||
			(claims.scope !== 'read' && claims.scope !== 'write') ||
			!isIndexProfile(profile) ||
			(privacy !== 'vectors-only' && privacy !== 'ephemeral') ||
			(isIndexProfile(profile) && privacy !== privacyModeForProfile(profile)) ||
			typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 128 ||
			typeof claims.jti !== 'string' || claims.jti.length < 8 || claims.jti.length > 128 ||
			typeof claims.iat !== 'number' || typeof claims.exp !== 'number' ||
			claims.exp <= nowSeconds || claims.iat > nowSeconds + 30 ||
			claims.exp <= claims.iat || claims.exp - claims.iat > SESSION_TTL_SECONDS
		) return null;
		return claims as IndexSessionClaims;
	} catch {
		return null;
	}
}

/** Auth resolution order:
 *  1. KV key registry (`v3k_…` tokens — hashed at rest, revocable, per-workspace or org-wide).
 *  2. HMAC fallback: base64url(HMAC-SHA256(master, `${wsId}:${scope}`)) — the
 *     zero-setup dev path and the root bootstrap. */
async function verifyToken(env: Env, token: string | null, wsId: string): Promise<AuthResult | null> {
	if (!token) return null;
	if (token.startsWith('v3s_') && env.SESSION_KEY_SECRET) {
		const claims = await verifySessionToken(token, env.SESSION_KEY_SECRET, wsId);
		if (!claims) return null;
		const meterHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${claims.sub}:${claims.jti}`));
		return {
			scope: claims.scope,
			meterKey: `session:${b64url(new Uint8Array(meterHash)).slice(0, 12)}`,
			indexProfile: claims.profile,
			privacyMode: claims.privacy,
			sessionBound: true,
		};
	}
	if (token.startsWith('v3k_') && env.KEYS) {
		const rec = await lookupToken(env.KEYS, token);
		if (rec && (rec.workspaceId === wsId || rec.workspaceId === '*')) {
			return { scope: rec.scope, meterKey: rec.tokenHash.slice(0, 12), indexProfile: 'standard', privacyMode: 'vectors-only', sessionBound: false };
		}
		return null;
	}
	if (!env.MASTER_KEY_SECRET) return null;
	for (const scope of ['admin', 'write', 'read'] as const) {
		if (await timingSafeEq(token, await deriveToken(env.MASTER_KEY_SECRET, wsId, scope))) {
			return { scope, meterKey: 'hmac', indexProfile: 'standard', privacyMode: 'vectors-only', sessionBound: false };
		}
	}
	return null;
}

/** Admin key management. Root auth = HMAC admin token for workspace '*'
 *  (deriveToken(master, '*', 'admin')) or an org-wide registry key with admin scope. */
async function adminKeys(request: Request, env: Env, url: URL): Promise<Response> {
	const root = await verifyToken(env, bearerFrom(request), '*');
	if (!root || !scopeSatisfies(root.scope, 'admin')) return json({ error: 'unauthorized' }, 401);

	if (request.method === 'POST' && url.pathname === '/v1/admin/keys') {
		const body = await request.json<{ workspaceId: string; scope: KeyScope; label?: string }>();
		if (!body.workspaceId || !['read', 'write', 'admin'].includes(body.scope)) {
			return json({ error: 'workspaceId and scope (read|write|admin) required' }, 400);
		}
		return json(await createKey(env.KEYS, body.workspaceId, body.scope, body.label ?? ''));
	}
	if (request.method === 'GET' && url.pathname === '/v1/admin/keys') {
		const workspaceId = url.searchParams.get('workspaceId');
		if (!workspaceId) return json({ error: 'workspaceId query param required' }, 400);
		return json({ keys: await listKeys(env.KEYS, workspaceId) });
	}
	if (request.method === 'POST' && url.pathname === '/v1/admin/keys/revoke') {
		const body = await request.json<{ tokenHash: string }>();
		return json({ revoked: await revokeKey(env.KEYS, body.tokenHash) });
	}
	return json({ error: 'not found' }, 404);
}

export async function deriveToken(master: string, wsId: string, scope: KeyScope): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', enc.encode(master), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${wsId}:${scope}`));
	return b64url(new Uint8Array(sig));
}

async function timingSafeEq(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(a)),
		crypto.subtle.digest('SHA-256', enc.encode(b)),
	]);
	const va = new Uint8Array(ha), vb = new Uint8Array(hb);
	let diff = 0;
	for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
	return diff === 0;
}

function b64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try {
		const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
		const raw = atob(padded);
		const bytes = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/** Editor-parity tokenizer (camelCase/snake_case splitting, ≥2 chars). */


function dedupe(arr: string[]): string[] { return [...new Set(arr)]; }

async function forward(stub: DurableObjectStub, path: string, body?: unknown, method = 'POST'): Promise<Response> {
	return stub.fetch(`https://do${path}`, {
		method,
		body: body === undefined ? undefined : JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
	});
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
