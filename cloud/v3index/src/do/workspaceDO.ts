/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  WorkspaceDO — one Durable Object per workspace. Owns the SQLite index
 *  (chunks + FTS5 + manifest + graph edges + signals), serializes ingest, and
 *  runs retrieval fusion with data locality. Vectors live in Vectorize
 *  (sqlite-vec is not permitted in Workers SQLite — see docs/RESEARCH.md);
 *  the Worker passes vector-channel rankings into /query.
 *--------------------------------------------------------------------------------------*/

import { DurableObject } from 'cloudflare:workers';
import type { EmbedJob, Env } from '../env.js';
import { computeManifestRoot, type WireChunk, type SyncBeginRequest, type SyncBeginResponse, type LspEdgesUpload, type RecentEditsSignal } from '../sync/protocol.js';
import { cloudFuse, FusionCandidate } from '../retrieve/cloudFusion.js';
import { SqlGraph, EDGE_TEXT_DEFINE, EDGE_TEXT_REF, EDGE_LSP_DEFINE, EDGE_LSP_REF, EDGE_FETCH_CAP, edgeRowsForChunk } from '../retrieve/sqlGraph.js';
import type { EdgeRow } from '../retrieve/sqlGraph.js';
import { embedTextFor, EmbedTextChunk } from '../core/embedText.js';
import { tokenize } from '../core/tokenize.js';
import { decodeQ8Vector, isQwen3CodeVectorIdentity, QWEN3_CODE_VECTOR_SPACE } from '../core/q8Vector.js';
import { isIndexProfile, isPrivacyMode, privacyModeForProfile, vectorIndexFor, type IndexProfile, type PrivacyMode } from '../core/indexProfile.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
	file TEXT PRIMARY KEY,
	content_hash TEXT NOT NULL,
	chunk_count INTEGER NOT NULL,
	indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
	id TEXT PRIMARY KEY,
	cas_key TEXT NOT NULL,
	file TEXT NOT NULL,
	start_line INTEGER NOT NULL,
	end_line INTEGER NOT NULL,
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	language TEXT NOT NULL,
	parent_id TEXT,
	scored INTEGER NOT NULL,
	defines TEXT, refs TEXT, lsp_defines TEXT, lsp_refs TEXT,
	has_vector INTEGER NOT NULL DEFAULT 0,
	embed_failed INTEGER NOT NULL DEFAULT 0,
	fts_rowid INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
CREATE INDEX IF NOT EXISTS idx_chunks_cas ON chunks(cas_key);
-- Graph edges, denormalized out of chunks.defines/refs/lsp_* at ingest so the
-- retrieval path does BOUNDED symbol lookups instead of loading the whole table
-- and building an in-memory DependencyGraph per DO (that blew DO CPU/memory at
-- ~39k chunks — see git history / prod 500). One row per (symbol, chunk, kind).
-- kind: 0=text-define, 1=text-ref, 2=lsp-define, 3=lsp-ref. Text edges are
-- noise-filtered AT WRITE TIME (dependencyGraph rules: min symbol length 3 +
-- generic stoplist); LSP edges bypass those filters. The fan-out cap (a symbol
-- in >40 chunks is too ambiguous) is NOT applied here — fan-out grows with the
-- corpus, so it is enforced at QUERY time.
CREATE TABLE IF NOT EXISTS symbol_edges (
	symbol TEXT NOT NULL,
	chunk_id TEXT NOT NULL,
	kind INTEGER NOT NULL,
	PRIMARY KEY (symbol, chunk_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_symbol ON symbol_edges(symbol);
CREATE INDEX IF NOT EXISTS idx_edges_chunk ON symbol_edges(chunk_id);
CREATE TABLE IF NOT EXISTS chunk_text (id TEXT PRIMARY KEY, content TEXT NOT NULL);
-- created_at backs the privacy backstop alarm below: failed embed jobs must
-- not leave plaintext (embed_text is derived from chunk content) lingering
-- forever, so we need to know how old a row is to sweep it.
CREATE TABLE IF NOT EXISTS pending_embed_text (id TEXT PRIMARY KEY, embed_text TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0);
-- Source-free client vectors wait here until an alarm can durably upsert them
-- into Vectorize. q8 is an embedding payload, not plaintext source.
CREATE TABLE IF NOT EXISTS pending_client_vectors (
	id TEXT PRIMARY KEY,
	cas_key TEXT NOT NULL,
	q8 TEXT NOT NULL,
	scale REAL NOT NULL,
	identity TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS recent_edits (file TEXT PRIMARY KEY, rank INTEGER NOT NULL);
-- Removals staged at /sync/begin, applied only when the client finalizes with
-- /chunks {done:true}, so a partial or abandoned sync never destroys server
-- state (review finding M10). Only one sync is active at a time.
CREATE TABLE IF NOT EXISTS pending_removals (sync_id TEXT NOT NULL, file TEXT NOT NULL, PRIMARY KEY (sync_id, file));
-- Vectorize deletions owed for removed chunk ids. SQLite deletes are synchronous
-- but Vectorize is an async external call that cannot run inside transactionSync,
-- so every path that drops chunk rows (removeFile, reset) queues the ids here in
-- the SAME transaction and a bounded flush (alarm-chained, like the prune drain)
-- issues the deleteByIds calls afterwards. Without this, pruned/edited chunks
-- left their vectors live forever: the shared index filled with ghosts that
-- crowded the per-namespace topK and collapsed RRF ranking.
CREATE TABLE IF NOT EXISTS pending_vector_deletes (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL DEFAULT 0,
	profile TEXT NOT NULL DEFAULT 'standard'
);
CREATE TABLE IF NOT EXISTS usage (
	day TEXT NOT NULL,
	key TEXT NOT NULL,
	op TEXT NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (day, key, op)
);
`;

const EMBED_JOB_BATCH = 80; // ids per queue message (well under 128KB)
// Chunks per SQLite transaction during ingest. One transaction over a whole
// 400-chunk batch is ~10k row-writes in a single durable commit, which can
// exceed the DO's storage-operation timeout and reset the object (prod 500:
// "storage operation exceeded timeout"). Bounding each commit to this many
// chunks keeps every storage op small; sub-batches are idempotent (replace-by-id)
// so a mid-batch failure is safe to retry.
const CHUNK_TXN_SIZE = 50;
// Cap on how much of a chunk's content is tokenized into the FTS body. The
// tokenizer is linear now, so this is a storage/sanity bound: a generated or
// minified chunk shouldn't produce a multi-MB FTS row — the first 64KB of
// tokens is far more than enough for lexical matching.
const MAX_FTS_SOURCE_LEN = 65536;
// English stopwords stripped from a query before the FTS MATCH. A token like
// "the"/"how"/"which" matches a large fraction of the corpus, so an OR query full of
// them makes FTS5 rank tens of thousands of rows before LIMIT — a verbose intent
// query ("how does the agent decide which tool to call") took 6.6s of pure fusion.
// Dropping them shrinks the match set to the distinctive terms (fast AND more
// relevant). Code-ish words (get/set/call/use/make) are intentionally NOT here — they
// can be real method names. Falls back to the unfiltered set if a query is all stops.
const FTS_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'was', 'were', 'how', 'does', 'do', 'did', 'which', 'what', 'where', 'when', 'who', 'why', 'this', 'that', 'these', 'those', 'it', 'its', 'as', 'at', 'by', 'from', 'we', 'you', 'your', 'our', 'their', 'can', 'could', 'would', 'should', 'will', 'if', 'then', 'else', 'so', 'not', 'no', 'all', 'any', 'into', 'about', 'over', 'than', 'them', 'they', 'he', 'she', 'his', 'her', 'i', 'me', 'my', 'but', 'there', 'here', 'been', 'has', 'have', 'had', 'up', 'out', 'off']);
// Cap on distinctive query terms fed to the FTS OR-match (bounds the worst case).
const MAX_FTS_TERMS = 14;

// pending_embed_text is a RECOVERY BUFFER for stuck embed jobs, not the privacy
// surface — that is chunk_text (empty in vectors-only mode) plus snippet
// suppression on retrieval. The normal life of a row is seconds/minutes:
// vectorDone purges it the moment the vector lands. Keeping it around while a
// job is still pending/failed is what lets /requeue actually recover — so the
// sweep does NOT delete a row just because 24h passed (that was purging the
// recovery text out from under /requeue; see review finding M2). It only
// removes rows that are (a) redundant — the vector already landed — or (b)
// truly abandoned, past the mode-specific backstop. Legacy `full` keeps seven
// days for recovery; Advanced `ephemeral` keeps at most one hour and then
// invalidates the file manifest so normal sync retries without long retention.
const PENDING_TEXT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7d abandoned backstop
/** Advanced source is a transient processing buffer, not a recovery archive.
 * One hour covers normal queue retries; after that we invalidate the affected
 * file manifests so the next editor sync safely re-uploads and retries. */
const EPHEMERAL_TEXT_MAX_AGE_MS = 60 * 60 * 1000;
const BACKSTOP_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

// -- Deferred prune (bounded, alarm-continued) --------------------------------
// A sync's done:true used to apply EVERY staged removal in one invocation.
// After the editor's watcher fix shrank a real workspace from ~28k synced
// files to ~14.5k, that meant 28k removeFile() calls (~6 statements each) in
// a single Durable Object request — guaranteed "exceeded its CPU time limit"
// on every sync, forever (the staging is re-derived each /sync/begin, so the
// storm never drains). Now done:true promotes staged rows to a persistent
// prune queue, drains one bounded batch synchronously, and an alarm chain
// (fresh CPU budget per invocation) drains the rest in the background.
/** sync_id sentinel marking rows promoted from a completed sync into the background prune queue. */
const PRUNE_SENTINEL = '__prune__';
/** CHUNK deletions per drain invocation. Budgeting by chunks, not files: stale
 *  build-artifact files hold up to 120 chunks each, so a fixed FILE count can
 *  explode into a storage-timeout-sized pass (live failure: 400 files ≈ 48k
 *  chunk deletions → "storage operation exceeded timeout" → object reset →
 *  alarm crash-retry loop). ~1500 chunk deletes × 5 tables stays comfortably
 *  under both the CPU and storage-op budgets. */
const PRUNE_CHUNK_BUDGET = 1000;
/** Chunk deletions per SQLite transaction inside a drain (mirrors CHUNK_TXN_SIZE
 *  logic: one big commit exceeds the storage-op timeout; statement-by-statement
 *  auto-commits are hundreds of tiny storage ops and time out the other way —
 *  observed live on /prune/kick. Small bounded commits are the middle path). */
const PRUNE_TXN_CHUNKS = 250;
/** Delay between prune-drain alarms — fast drain without starving other requests. */
const PRUNE_ALARM_DELAY_MS = 500;
/** Ids per Vectorize deleteByIds call. The REST API rejects >100 ids per
 *  delete ("max id count is 100" — observed live, code 40007); the binding's
 *  cap is undocumented, so stay at the known-safe bound. A larger batch here
 *  would make the flush throw on EVERY attempt and the queue would never
 *  drain (retry-forever with the same over-sized batch). */
const VECTOR_DELETE_BATCH = 50;
/** Vector ids per deleteByIds call — the REST/binding hard cap (code 40007). Each
 *  queued chunk id expands to two vector ids (salted + legacy-unsalted), so 50
 *  chunk ids → 100 vector ids → one call. */
const VECTOR_DELETE_ID_CALL = 100;
/** Ids flushed to Vectorize per invocation (request or alarm): bounded like every
 *  other per-invocation budget in this file. */
const VECTOR_DELETE_FLUSH_CAP = 1500;
/** Client-produced 1024-d vectors per Vectorize upsert pass. */
const CLIENT_VECTOR_FLUSH_CAP = 100;

export class WorkspaceDO extends DurableObject<Env> {
	private initialized = false;

	private sql() { return this.ctx.storage.sql; }

	private ensureSchema(): void {
		if (this.initialized) return;
		this.sql().exec(SCHEMA);
		// Backfill for DOs created before the privacy backstop alarm existed —
		// CREATE TABLE IF NOT EXISTS above is a no-op on an already-existing
		// pending_embed_text table, so the column has to be added here instead.
		// Guarded by try/catch: throws (duplicate column) once the ALTER has
		// already run on this DO, which we treat as success.
		// fts_rowid: rowid of the chunk's row in chunk_fts. FTS5's UNINDEXED id
		// column cannot be indexed, so deleting BY ID full-scans the FTS table —
		// quadratic at scale (live: 673k rows made every removal path time out).
		// Deleting by rowid is O(log n). NULL on legacy rows (pre-migration):
		// those fall back to the id-scan path until re-ingested.
		try { this.sql().exec('ALTER TABLE chunks ADD COLUMN fts_rowid INTEGER'); } catch { /* already migrated */ }
		try {
			this.sql().exec('ALTER TABLE pending_embed_text ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
			// Rows that existed pre-migration land with created_at = 0, which the
			// alarm sweep would read as "already past the backstop" and delete on
			// the very next tick — too abrupt for an in-flight embed job. Give them
			// a fresh grace window (created_at = now) instead of treating unknown
			// age as infinitely old.
			this.sql().exec('UPDATE pending_embed_text SET created_at = ? WHERE created_at = 0', Date.now());
		} catch { /* column already present */ }
		// Backfill embed_failed (observability flag for abandoned embed jobs) on
		// DOs created before it existed — CREATE TABLE IF NOT EXISTS above won't
		// add a column to the existing chunks table. Throws once already applied.
		try {
			this.sql().exec('ALTER TABLE chunks ADD COLUMN embed_failed INTEGER NOT NULL DEFAULT 0');
		} catch { /* column already present */ }
		try {
			this.sql().exec("ALTER TABLE pending_vector_deletes ADD COLUMN profile TEXT NOT NULL DEFAULT 'standard'");
		} catch { /* column already present */ }
		this.initialized = true;
	}

	private metaGet(key: string): string | undefined {
		const rows = this.sql().exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray();
		return rows[0]?.value;
	}
	private metaSet(key: string, value: string): void {
		this.sql().exec('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
	}

	override async fetch(request: Request): Promise<Response> {
		this.ensureSchema();
		const url = new URL(request.url);
		const body = request.method === 'POST' ? await request.json<any>() : undefined;
		try {
			switch (url.pathname) {
				case '/init': return json(this.init(body));
				case '/reset': return json(await this.reset());
				// Manual prune drain: one bounded batch per request (fresh CPU budget
				// each call) — the guaranteed drain path when/if alarms misbehave, and
				// an ops hatch to hurry a large queue. Re-arms the alarm chain too.
				case '/prune/kick': {
					const pruned = this.drainPruneBatch(PRUNE_CHUNK_BUDGET);
					// Flush failure must not 500 the kick — the prune above already
					// committed, and the rows stay queued for the alarm chain anyway.
					let vectors = { deleted: 0, remaining: 0 };
					let vectorError: string | undefined;
					try {
						vectors = await this.flushVectorDeletes();
					} catch (err) {
						vectors.remaining = this.vectorDeleteQueueSize();
						vectorError = String((err as { message?: string })?.message ?? err);
					}
					const remaining = this.pruneQueueSize();
					if (remaining > 0 || vectors.remaining > 0) { await this.ctx.storage.setAlarm(Date.now() + PRUNE_ALARM_DELAY_MS); }
					return json({ pruned, remaining, vectorDeletes: vectors.deleted, vectorDeletesRemaining: vectors.remaining, vectorError });
				}
				case '/sync/begin': return json(await this.syncBegin(body));
				case '/chunks/check': return json(this.chunksCheck(body));
				case '/chunks': return json(await this.chunksUpload(body));
				case '/signals/edits': return json(this.signalsEdits(body));
				case '/graph/lsp-edges': return json(this.lspEdges(body));
				case '/query': return json(await this.query(body));
				// Deterministic graph navigation for agents (MCP tools) — exact
				// defs/refs/neighbors/outline over symbol_edges, not semantic search.
				case '/symbol': return json(this.symbolLookup(body));
				case '/neighbors': return json(this.neighbors(body));
				case '/outline': return json(this.outline(body));
				case '/reindex-graph': return json(this.reindexGraph(body ?? {}));
				case '/requeue': return json(await this.requeue());
				case '/embed-text': return json(this.embedTextBatch(body));
				case '/vector-done': return json(await this.vectorDone(body));
				case '/embed-failed': return json(this.embedFailed(body));
				case '/status': return json(this.status());
				case '/usage': return json(this.usage());
				// Debug-only, no plaintext leaked (count only) — see debugTextRows.
				case '/debug/text-rows': return json(await this.debugTextRows(body));
				// Debug-only: symbol_edges row count (optionally for one chunk id) —
				// lets tests assert edges are written on upload and removed on file
				// removal without reaching into SQL. Count only, no content.
				case '/debug/edge-count': return json(this.debugEdgeCount(body));
				// Keyset-paginated dump of live chunk ids (opaque hashes, no content) —
				// the ground truth the ghost-vector purge script diffs the shared
				// Vectorize index against. Write-scoped at the Worker route.
				case '/debug/chunk-ids': return json(this.chunkIds(body ?? {}));
				default: return new Response('not found', { status: 404 });
			}
		} catch (err: any) {
			const message = err?.message ?? String(err);
			const status = /requires \/reset/.test(message) ? 409
				: /vectors-only|ephemeral|advanced index|index profile|vectorQ8|vectorScale|embedding dimension/.test(message) ? 400 : 500;
			return new Response(JSON.stringify({ error: message }), { status });
		}
	}

	private init(body: { privacyMode?: PrivacyMode; indexProfile?: IndexProfile; embedIdentity: string; workspaceId?: string }): unknown {
		const existingProfile = this.metaGet('indexProfile');
		const requestedProfile = isIndexProfile(body.indexProfile) ? body.indexProfile : (isIndexProfile(existingProfile) ? existingProfile : 'standard');
		const existingMode = this.metaGet('privacyMode');
		const requestedMode = isPrivacyMode(body.privacyMode)
			? body.privacyMode
			: (isPrivacyMode(existingMode) ? existingMode : privacyModeForProfile(requestedProfile));
		if (requestedProfile === 'advanced' && requestedMode !== 'ephemeral') {
			throw new Error('advanced index requires ephemeral privacy mode');
		}
		if (!this.metaGet('createdAt')) {
			this.metaSet('createdAt', String(Date.now()));
			this.metaSet('privacyMode', requestedMode);
			this.metaSet('indexProfile', requestedProfile);
		} else {
			if (body.privacyMode !== undefined && existingMode && existingMode !== requestedMode) {
				throw new Error(`privacy mode change ${existingMode} -> ${requestedMode} requires /reset`);
			}
			if (!existingMode) this.metaSet('privacyMode', requestedMode);
			if (existingProfile && existingProfile !== requestedProfile) {
				throw new Error(`index profile change ${existingProfile} -> ${requestedProfile} requires /reset`);
			}
			if (!existingProfile) this.metaSet('indexProfile', requestedProfile);
		}
		// The DO's own name — REQUIRED for embed jobs to route back to this DO.
		// (An empty workspaceId sent every job to the empty-named DO: silent no-op.)
		if (body.workspaceId) { this.metaSet('workspaceId', body.workspaceId); }
		this.metaSet('embedIdentity', body.embedIdentity);
		// Lightweight response — do NOT run status()'s COUNT(*) full-table scans
		// here. On a large/contended DO those scans (66k chunks + 50k pending, no
		// index on the filtered columns) can exceed the storage-op timeout and
		// reset the object on what should be a trivial call. /status is separate.
		return {
			workspaceId: this.metaGet('workspaceId') ?? '',
			privacyMode: this.metaGet('privacyMode') ?? 'vectors-only',
			indexProfile: this.metaGet('indexProfile') ?? 'standard',
			embedIdentity: this.metaGet('embedIdentity') ?? '',
			ok: true,
		};
	}

	/** Wipe the workspace: drop ALL storage (chunks, edges, FTS, content, pending
	 *  embeds, alarm) and re-create the schema. Recovery hatch for a DO that got
	 *  wedged/bloated by repeated failed syncs + a huge embed backlog. Destructive;
	 *  the client must /init and re-sync afterward.
	 *
	 *  Vectors: deleteAll wipes SQLite but Vectorize lives outside the DO, so the
	 *  chunk ids are collected FIRST (keyset-paged SELECTs; ids only, ~40 bytes
	 *  each — even a 1M-chunk workspace stays far under the DO memory limit) and
	 *  re-queued into pending_vector_deletes after the schema is recreated. The
	 *  alarm chain then flushes them. Before this, every reset leaked the whole
	 *  workspace's vectors into the shared index as permanent ghosts. */
	private async reset(): Promise<unknown> {
		const resetProfile = this.currentIndexProfile();
		const ids: string[] = [];
		let after = '';
		for (;;) {
			const rows = this.sql().exec<{ id: string }>('SELECT id FROM chunks WHERE id > ? ORDER BY id LIMIT 5000', after).toArray();
			if (rows.length === 0) break;
			for (const r of rows) ids.push(r.id);
			after = rows[rows.length - 1]!.id;
		}
		// Deletions ALREADY queued are disjoint from the chunks table by
		// construction (removeFile stages ids in the same transaction that drops
		// their rows; vectorDone orphans never had rows) — deleteAll would destroy
		// that owed backlog, and reset is the wedged-DO recovery hatch, i.e. most
		// likely invoked exactly when such a backlog exists (review finding).
		after = '';
		for (;;) {
			const rows = this.sql().exec<{ id: string }>('SELECT id FROM pending_vector_deletes WHERE id > ? ORDER BY id LIMIT 5000', after).toArray();
			if (rows.length === 0) break;
			for (const r of rows) ids.push(r.id);
			after = rows[rows.length - 1]!.id;
		}
		await this.ctx.storage.deleteAll();
		this.initialized = false;
		this.ensureSchema();
		// Bounded commits, mirroring syncBegin's staging: one transaction per 900
		// ids instead of one auto-commit per INSERT (a 293k-chunk reset would be
		// ~6.5k storage ops otherwise) or one giant commit (storage-op timeout).
		for (const group of chunked(ids, 900)) {
			this.ctx.storage.transactionSync(() => this.queueVectorDeletes(group, resetProfile));
		}
		if (ids.length > 0) { await this.ctx.storage.setAlarm(Date.now() + PRUNE_ALARM_DELAY_MS); }
		return { reset: true, vectorDeletesQueued: ids.length };
	}

	/** Manifest diff — the Merkle-style cheap sync. Prune is DEFERRED: removals
	 *  are computed here but only applied when the client finalizes the sync
	 *  (/chunks {done:true}), so a partial/abandoned sync never destroys server
	 *  state. An empty manifest against a populated index is rejected outright as
	 *  a truncated/misconfigured client (review finding M10). */
	private async syncBegin(body: SyncBeginRequest): Promise<SyncBeginResponse> {
		if (!body.files || typeof body.files !== 'object') throw new Error('sync/begin: files manifest required');
		if (body.manifestRoot !== undefined && !/^[a-f0-9]{64}$/.test(body.manifestRoot)) {
			throw new Error('sync/begin: manifestRoot must be a SHA-256 hex digest');
		}
		if (body.manifestRoot !== undefined && body.manifestRoot !== await computeManifestRoot(body.files)) {
			throw new Error('sync/begin: manifestRoot does not match files manifest');
		}
		const server = new Map<string, string>();
		for (const r of this.sql().exec<{ file: string; content_hash: string }>('SELECT file, content_hash FROM files').toArray()) {
			server.set(r.file, r.content_hash);
		}
		// Defense-in-depth alongside the done-gated prune below: an empty manifest
		// would stage every server file for removal — almost always a truncated or
		// misconfigured client, never an intentional whole-index wipe. Refuse it.
		if (server.size > 0 && Object.keys(body.files).length === 0) {
			throw new Error('sync/begin: refusing empty manifest against a non-empty index (would prune all files)');
		}
		const changedFiles: string[] = [];
		for (const [file, hash] of Object.entries(body.files)) {
			if (server.get(file) !== hash) changedFiles.push(file);
		}
		const removedFiles: string[] = [];
		for (const file of server.keys()) {
			if (!(file in body.files)) removedFiles.push(file);
		}
		const syncId = crypto.randomUUID();
		this.metaSet('activeSync', syncId);
		this.metaSet('activeManifestRoot', body.manifestRoot ?? '');
		// Stage removals for this sync. Assumes a single active sync per workspace
		// (the editor's syncer enforces this): a new /sync/begin supersedes any
		// prior one, so its staged removals are cleared first. Under concurrent
		// divergent syncs a prune may be deferred to a later completing sync —
		// self-healing, never a wrong deletion. Rows already promoted to the
		// background prune queue (PRUNE_SENTINEL) survive: they belong to a
		// COMPLETED sync and keep draining via the alarm chain. (Even if they
		// were dropped, this begin's manifest diff would re-derive them — the
		// queue is an optimization, files-table truth is authoritative.)
		this.sql().exec('DELETE FROM pending_removals WHERE sync_id != ?', PRUNE_SENTINEL);
		// Multi-row inserts in bounded transactions: a stale-manifest storm can
		// stage tens of thousands of removals, and one INSERT statement per row
		// was tens of thousands of storage ops in a single request (the same
		// failure family as the drain fixes — bound EVERYTHING at this scale).
		// 45 rows × 2 params = 90 bound variables, the file-wide param cap.
		for (const group of chunked(removedFiles, 900)) {
			this.ctx.storage.transactionSync(() => {
				for (const rows of chunked(group, 45)) {
					const values = rows.map(() => '(?, ?)').join(',');
					this.sql().exec(`INSERT INTO pending_removals(sync_id, file) VALUES ${values}`, ...rows.flatMap(f => [syncId, f]));
				}
			});
		}
		return { syncId, changedFiles, removedFiles, knownCasKeys: [] };
	}

	/** What can the client skip re-uploading?
	 *
	 *  id-aware mode (`have` = client's current {id, casKey} pairs): returns the
	 *  ids the server already holds UNCHANGED (same id AND same casKey). Keyed on
	 *  id, NOT casKey alone — a relocated chunk (an edit shifted its lines → new
	 *  id, identical content → identical casKey) must NOT be skipped: skipping it
	 *  left its new-id row unwritten while its old-id row lingered stale. This is
	 *  the client half of the reconcileFile fix.
	 *
	 *  Legacy casKey mode (`casKeys`): older clients ask "which casKeys do you
	 *  hold?" — kept for back-compat so a pre-fix editor still syncs (it just
	 *  can't relocate chunks correctly, exactly as before). */
	private chunksCheck(body: { casKeys?: string[]; have?: Array<{ id: string; casKey: string; wantsVector?: boolean }> }): { known: string[] } {
		const known: string[] = [];
		if (body.have) {
			const wanted = new Map(body.have.map(h => [h.id, h]));
			for (const batch of chunked(body.have.map(h => h.id), 90)) {
				const ph = batch.map(() => '?').join(',');
				for (const r of this.sql().exec<{ id: string; cas_key: string; has_vector: number }>(`SELECT id, cas_key, has_vector FROM chunks WHERE id IN (${ph})`, ...batch).toArray()) {
					const want = wanted.get(r.id);
					if (want?.casKey === r.cas_key && (!want.wantsVector || r.has_vector === 1)) known.push(r.id);
				}
			}
			return { known };
		}
		for (const batch of chunked(body.casKeys ?? [], 90)) {
			const q = `SELECT DISTINCT cas_key FROM chunks WHERE cas_key IN (${batch.map(() => '?').join(',')})`;
			for (const r of this.sql().exec<{ cas_key: string }>(q, ...batch).toArray()) known.push(r.cas_key);
		}
		return { known };
	}

	private async chunksUpload(body: { syncId: string; chunks: WireChunk[]; fileHashes?: Record<string, string>; fileChunkIds?: Record<string, string[]>; done?: boolean; _meter?: string }): Promise<unknown> {
		this.meter(body._meter, 'chunks');
		const rawPrivacyMode = this.metaGet('privacyMode');
		const privacyMode: PrivacyMode = isPrivacyMode(rawPrivacyMode) ? rawPrivacyMode : 'vectors-only';
		const rawIndexProfile = this.metaGet('indexProfile');
		const indexProfile: IndexProfile = isIndexProfile(rawIndexProfile) ? rawIndexProfile : 'standard';
		const embedIdentity = this.metaGet('embedIdentity') ?? '';
		const workspaceId = this.metaGet('workspaceId') ?? '';
		const embedDim = Number(this.env.EMBED_DIM);
		if (privacyMode === 'vectors-only') {
			for (const c of body.chunks) {
				if (c.content !== undefined) throw new Error('vectors-only upload must omit content');
				if (c.scored && (!Array.isArray(c.tokens) || c.tokens.length === 0)) throw new Error(`vectors-only scored chunk ${c.id} requires lexical tokens`);
				const hasAnyVectorField = c.vectorQ8 !== undefined || c.vectorScale !== undefined || c.vectorSpace !== undefined;
				if (hasAnyVectorField) {
					if (!c.scored || !isQwen3CodeVectorIdentity(embedIdentity) || c.vectorSpace !== QWEN3_CODE_VECTOR_SPACE || c.vectorQ8 === undefined || c.vectorScale === undefined) {
						throw new Error(`vectors-only chunk ${c.id} has an incomplete or incompatible client vector`);
					}
					decodeQ8Vector(c.vectorQ8, c.vectorScale, embedDim);
				}
			}
		}
		if (privacyMode === 'ephemeral') {
			for (const c of body.chunks) {
				if (c.scored && c.content === undefined) throw new Error(`ephemeral scored chunk ${c.id} requires content for cloud embedding`);
				if (c.vectorQ8 !== undefined || c.vectorScale !== undefined || c.vectorSpace !== undefined) {
					throw new Error(`ephemeral chunk ${c.id} must not provide a client vector`);
				}
			}
		}
		// O(1) parent-name lookups within the batch (was an O(n) .find per chunk).
		const nameById = new Map(body.chunks.map(c => [c.id, c.name]));
		const touchedFiles = new Map<string, number>();
		const toEmbed: string[] = [];
		const clientVectorsStaged: string[] = [];
		const toStore = new Map<string, string>(); // casKey → content, offloaded to R2 (full mode)
		let removed = 0;

		// Prior state per id (casKey + has_vector) so we can SKIP re-embedding a
		// chunk whose content is unchanged and already has a vector — the #1
		// recurring waste: a line-shift on save otherwise re-embeds unchanged code
		// (Workers AI neurons + queue churn) and refills the embed backlog. Bounded
		// read, batched like everything else.
		const prior = new Map<string, { casKey: string; hasVector: number; ftsRowid: number | null }>();
		for (const batch of chunked(body.chunks.map(c => c.id), 90)) {
			const ph = batch.map(() => '?').join(',');
			for (const r of this.sql().exec<{ id: string; cas_key: string; has_vector: number; fts_rowid: number | null }>(`SELECT id, cas_key, has_vector, fts_rowid FROM chunks WHERE id IN (${ph})`, ...batch).toArray()) {
				prior.set(r.id, { casKey: r.cas_key, hasVector: r.has_vector, ftsRowid: r.fts_rowid ?? null });
			}
		}

		// Embed jobs need the DO's own name to route back here — fail up front if
		// any scored+content chunk would need embedding but the workspace wasn't
		// init'd, before doing any writes.
		if (!workspaceId && body.chunks.some(c => c.scored && (c.content !== undefined || c.vectorQ8 !== undefined))) {
			throw new Error('workspace not initialized — call /init before /chunks (embed jobs need the DO name)');
		}

		// A file being uploaded now must not sit in the background prune queue: a
		// stale PRUNE_SENTINEL row (from a prior sync that removed it) firing via
		// the alarm chain MID-INGEST would delete the rows this request just wrote
		// (the ingest loop's yields open the input gate). Cancel before ingesting;
		// a genuinely removed file is re-derived by the next /sync/begin anyway.
		const uploadedFiles = new Set<string>(body.chunks.map(c => c.file));
		for (const f of Object.keys(body.fileHashes ?? {})) uploadedFiles.add(f);
		for (const batch of chunked([...uploadedFiles], 89)) {
			const ph = batch.map(() => '?').join(',');
			this.sql().exec(`DELETE FROM pending_removals WHERE sync_id = ? AND file IN (${ph})`, PRUNE_SENTINEL, ...batch);
		}

		// Bound each transaction to CHUNK_TXN_SIZE chunks so a huge batch can't
		// exceed the DO storage-operation timeout (which resets the object). Each
		// sub-batch commits independently and is idempotent (replace-by-id), so a
		// mid-batch failure is safe to retry. Yield between sub-batches so commits
		// land and embed callbacks can interleave instead of starving.
		let gi = 0;
		for (const group of chunked(body.chunks, CHUNK_TXN_SIZE)) {
			this.ctx.storage.transactionSync(() => {
				for (const c of group) this.ingestChunk(c, privacyMode, embedIdentity, nameById, prior, touchedFiles, toEmbed, clientVectorsStaged, toStore);
			});
			// Yield only every 4th sub-batch (~200 chunks), not every 50: each yield
			// opens the input gate and lets the (huge) embed backlog's /embed-text +
			// /vector-done callbacks interleave and steal the DO thread mid-ingest.
			// Ingesting in bursts keeps the storage-op bounded while letting ingest
			// actually make progress; embeds drain between /chunks batches instead.
			if ((++gi & 3) === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
		}

		// A re-added id cancels its queued Vectorize deletion: the file was pruned
		// (ids staged in pending_vector_deletes) and re-appeared before the flush
		// ran. The rows just ingested are live again — deleting their vectors now
		// would punch silent semantic holes. Batched here, not per-chunk inside
		// ingestChunk (the JS↔SQLite crossing dominates ingest CPU).
		for (const batch of chunked(body.chunks.map(c => c.id), 90)) {
			this.sql().exec(`DELETE FROM pending_vector_deletes WHERE id IN (${batch.map(() => '?').join(',')})`, ...batch);
		}
		// A same-id content replacement temporarily leaves the old Vectorize value
		// addressable. In vectors-only mode, stage its deletion AFTER the generic
		// re-add cancellation whether or not a replacement Qwen vector is ready;
		// the alarm deletes stale values before upserting any new generation.
		const replacedClientVectorIds = privacyMode === 'vectors-only' ? body.chunks
			.filter(c => prior.has(c.id) && prior.get(c.id)!.casKey !== c.casKey)
			.map(c => c.id) : [];
		if (replacedClientVectorIds.length > 0) this.queueVectorDeletes(replacedClientVectorIds);

		// Per-file reconciliation: the client sends the COMPLETE current chunk-id
		// set for each file it touched, so departed chunks (deleted functions,
		// line-shifted old positions) get removed + their vectors queued. Without
		// this an edited-but-still-present file leaks stale rows forever (removeFile
		// only fires for whole-file removal). Each file in its own transaction so a
		// big truncation stays a bounded storage op. Off the ingest transaction so
		// removeChunkRows' commits don't nest.
		let reconciledOut = 0;
		if (body.fileChunkIds) {
			for (const [file, ids] of Object.entries(body.fileChunkIds)) {
				this.ctx.storage.transactionSync(() => { reconciledOut += this.reconcileFile(file, ids); });
			}
		}

		// Manifest update + deferred prune, once all chunk sub-batches have landed
		// (touchedFiles is complete). Its own bounded transaction.
		this.ctx.storage.transactionSync(() => {
			if (body.fileHashes) {
				for (const [file, hash] of Object.entries(body.fileHashes)) {
					this.sql().exec(
						'INSERT INTO files(file, content_hash, chunk_count, indexed_at) VALUES (?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET content_hash=excluded.content_hash, chunk_count=excluded.chunk_count, indexed_at=excluded.indexed_at',
						file, hash, touchedFiles.get(file) ?? 0, Date.now(),
					);
				}
			}
			// Deferred prune: the client's final batch applies the removals staged at
			// /sync/begin (review finding M10). A sync that never reaches done leaves
			// server state intact; its staged removals are discarded by the next
			// /sync/begin. BOUNDED: promote to the background queue, drain one batch
			// now, alarm-chain the rest — done:true must never die to a removal storm.
			if (body.done && body.syncId) {
				this.sql().exec('UPDATE pending_removals SET sync_id = ? WHERE sync_id = ?', PRUNE_SENTINEL, body.syncId);
				if (this.metaGet('activeSync') === body.syncId) {
					const manifestRoot = this.metaGet('activeManifestRoot');
					// A legacy client with no root must clear any prior attestation;
					// otherwise /status would falsely label its new snapshot with the old root.
					this.metaSet('manifestRoot', manifestRoot ?? '');
					this.metaSet('activeSync', '');
					this.metaSet('activeManifestRoot', '');
				}
			}
		});
		// Drain OUTSIDE the ingest transaction: drainPruneBatch commits its own
		// small transactions and transactionSync does not nest.
		if (body.done && body.syncId) {
			removed = this.drainPruneBatch(PRUNE_CHUNK_BUDGET);
		}
		const pruneRemaining = body.done ? this.pruneQueueSize() : 0;
		// Vector deletions queued by the drain OR by per-file reconciliation flush
		// on the alarm chain, OFF the editor's critical path (each flush is a few
		// Vectorize subrequests). Reconciliation can queue on ANY batch (not just
		// done), so arm whenever it removed something.
		if (pruneRemaining > 0 || reconciledOut > 0 || clientVectorsStaged.length > 0 || (body.done && this.vectorDeleteQueueSize() > 0)) {
			// Continue in the background with a fresh CPU budget per alarm.
			await this.ctx.storage.setAlarm(Date.now() + PRUNE_ALARM_DELAY_MS);
		}

		// Offload full-mode content to R2 OFF the /chunks critical path (waitUntil).
		// The editor uploads batches SEQUENTIALLY, so awaiting ~400 R2 PUTs here
		// delays its next batch by the whole PUT wave. Content is content-addressed
		// by casKey, idempotent, and BEST-EFFORT (retrieval never depends on the
		// snippet; a lost PUT self-heals on the next sync), so returning before the
		// PUTs land is safe and lets the editor stream the next batch immediately.
		if (toStore.size > 0) {
			this.ctx.waitUntil((async () => {
				try {
					for (const grp of chunked([...toStore.entries()], 50)) {
						await Promise.all(grp.map(([casKey, content]) => this.env.BLOBS.put(blobKey(workspaceId, casKey), content)));
					}
				} catch (e) {
					console.error(JSON.stringify({ evt: 'r2-put-error', ws: workspaceId, err: String((e as { message?: string })?.message ?? e) }));
				}
			})());
		}

		// Enqueue embedding jobs (ids only — consumer pulls text via /embed-text).
		// sendBatch instead of a per-job await loop: a large initial sync produces
		// hundreds of jobs, and one batched send per ≤25 jobs collapses that many
		// subrequests into a few (25 kept well under the 100-msg / 256KB batch cap
		// even with long chunk ids).
		const jobs = chunked(toEmbed, EMBED_JOB_BATCH).map(ids => ({ body: { workspaceId, chunkIds: ids, embedIdentity, indexProfile } as EmbedJob }));
		for (const group of chunked(jobs, 25)) {
			await this.env.EMBED_QUEUE.sendBatch(group);
		}
		// New pending_embed_text rows exist now — make sure the privacy backstop
		// sweep is scheduled. Lazy + idempotent: setAlarm only actually reschedules
		// when there isn't already one further out (see ensureBackstopAlarm).
		if (toEmbed.length > 0) { await this.ensureBackstopAlarm(); }
		return { upserted: body.chunks.length, queuedForEmbed: toEmbed.length, queuedClientVectors: clientVectorsStaged.length, removed, reconciled: reconciledOut, pruneRemaining };
	}

	/** Files still queued for background prune (PRUNE_SENTINEL rows). */
	private pruneQueueSize(): number {
		return this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM pending_removals WHERE sync_id = ?', PRUNE_SENTINEL).one().n;
	}

	/** Remove queued files until ~`chunkBudget` chunk rows have been deleted (or
	 *  the queue empties). At least one file is always processed so a single
	 *  over-budget file cannot stall the queue. Work is committed in small
	 *  transactions (PRUNE_TXN_CHUNKS) — safe to call from a request OR an
	 *  alarm; a mid-drain failure loses at most one sub-batch of progress.
	 *  Returns files pruned this call. */
	private drainPruneBatch(chunkBudget: number): number {
		let pruned = 0;
		let chunksDeleted = 0;
		while (chunksDeleted < chunkBudget) {
			const rows = this.sql().exec<{ file: string }>(
				'SELECT file FROM pending_removals WHERE sync_id = ? LIMIT 25', PRUNE_SENTINEL,
			).toArray();
			if (rows.length === 0) break;
			let subBatchChunks = 0;
			this.ctx.storage.transactionSync(() => {
				for (const r of rows) {
					subBatchChunks += this.removeFile(r.file);
					this.sql().exec('DELETE FROM pending_removals WHERE sync_id = ? AND file = ?', PRUNE_SENTINEL, r.file);
					pruned++;
					if (subBatchChunks >= PRUNE_TXN_CHUNKS) break;
				}
			});
			chunksDeleted += subBatchChunks;
			if (subBatchChunks === 0) break; // defensive: no forward progress
		}
		return pruned;
	}

	/** Ingest one chunk: replace-by-id upsert + graph edges + FTS body + content,
	 *  and (unless it's unchanged and already vectorized) stage its embed job.
	 *  Pure synchronous SQLite — safe to call inside transactionSync. */
	private ingestChunk(
		c: WireChunk,
		privacyMode: PrivacyMode,
		embedIdentity: string,
		nameById: Map<string, string>,
		prior: Map<string, { casKey: string; hasVector: number; ftsRowid: number | null }>,
		touchedFiles: Map<string, number>,
		toEmbed: string[],
		clientVectorsStaged: string[],
		toStore: Map<string, string>,
	): void {
		// Replace-by-id upsert; FTS row replaced alongside. Skip the DELETE for a
		// brand-new id — there's no existing FTS row to clear, and on a full initial
		// sync EVERY chunk is new, so this removes ~one JS↔SQLite boundary crossing
		// per chunk (that crossing dominates ingest CPU). prior is the pre-fetched
		// prior state, identical to the isNew signal writeEdges already uses.
		const priorState = prior.get(c.id);
		if (priorState) {
			// rowid-addressed delete (indexed); legacy rows without fts_rowid take
			// the id scan until their file is re-ingested.
			if (priorState.ftsRowid != null) this.sql().exec('DELETE FROM chunk_fts WHERE rowid = ?', priorState.ftsRowid);
			else this.sql().exec('DELETE FROM chunk_fts WHERE id = ?', c.id);
		}
		this.sql().exec(
			`INSERT INTO chunks(id, cas_key, file, start_line, end_line, kind, name, language, parent_id, scored, defines, refs, lsp_defines, lsp_refs, has_vector)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
			 ON CONFLICT(id) DO UPDATE SET cas_key=excluded.cas_key, file=excluded.file, start_line=excluded.start_line,
			   end_line=excluded.end_line, kind=excluded.kind, name=excluded.name, language=excluded.language,
			   parent_id=excluded.parent_id, scored=excluded.scored, defines=excluded.defines, refs=excluded.refs,
			   lsp_defines=excluded.lsp_defines, lsp_refs=excluded.lsp_refs,
			   has_vector=CASE WHEN chunks.cas_key = excluded.cas_key THEN chunks.has_vector ELSE 0 END, embed_failed=0`,
			c.id, c.casKey, c.file, c.startLine, c.endLine, c.kind, c.name, c.language,
			c.parentId ?? null, c.scored ? 1 : 0,
			c.defines ? JSON.stringify(c.defines) : null, c.refs ? JSON.stringify(c.refs) : null,
			c.lspDefines ? JSON.stringify(c.lspDefines) : null, c.lspRefs ? JSON.stringify(c.lspRefs) : null,
		);
		// Graph edges — replace-by-id like the chunk row. Noise filter for text
		// edges applied inside edgeRowsForChunk; LSP edges bypass it. isNew skips
		// the (empty) pre-delete for chunks that didn't already exist.
		this.writeEdges(c, !prior.has(c.id));
		// Lexical body: SPLIT tokens (camelCase-aware), never raw text; content
		// bounded (MAX_FTS_SOURCE_LEN) so a giant generated chunk can't bloat it.
		const ftsBody = c.tokens ? c.tokens.join(' ')
			: tokenize(`${c.name}\n${c.content ?? ''}`.slice(0, MAX_FTS_SOURCE_LEN)).join(' ');
		this.sql().exec('INSERT INTO chunk_fts(id, body) VALUES (?, ?)', c.id, ftsBody);
		this.sql().exec('UPDATE chunks SET fts_rowid = last_insert_rowid() WHERE id = ?', c.id);
		const p = prior.get(c.id);
		const alreadyEmbedded = p !== undefined && p.casKey === c.casKey && p.hasVector === 1;
		if (privacyMode === 'vectors-only' && c.scored && c.vectorQ8 !== undefined && c.vectorScale !== undefined && !alreadyEmbedded) {
			this.sql().exec(
				`INSERT INTO pending_client_vectors(id, cas_key, q8, scale, identity, created_at) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET cas_key=excluded.cas_key, q8=excluded.q8, scale=excluded.scale, identity=excluded.identity,
				 created_at=CASE WHEN pending_client_vectors.created_at >= excluded.created_at THEN pending_client_vectors.created_at + 1 ELSE excluded.created_at END`,
				c.id, c.casKey, c.vectorQ8, c.vectorScale, embedIdentity, Date.now(),
			);
			clientVectorsStaged.push(c.id);
		}
		if (c.content !== undefined) {
			if (privacyMode === 'full') {
				// Offload content to R2 (content-addressed by casKey), NOT DO SQLite —
					// keeps the DO small so a big repo can't wedge it. Collected here;
					// PUT after the transaction (R2 is async, can't run in transactionSync).
					toStore.set(c.casKey, c.content);
			}
			// Skip re-embedding a scored chunk whose content is unchanged and already
			// vectorized (casKey identical + prior has_vector=1): the upsert's CASE
			// keeps has_vector=1, so we neither re-derive embed text nor re-queue.
			if (c.scored && !alreadyEmbedded) {
				// Embed text (hdr2 headers) computed HERE so the queue carries ids only.
				const parentName = c.parentId ? (nameById.get(c.parentId) ?? this.dbChunkName(c.parentId)) : undefined;
				const et = embedTextFor(
					toEmbedShape(c),
					{ get: (id: string) => (id === c.parentId && parentName !== undefined ? { file: c.file, name: parentName, content: '' } : undefined) } as { get(id: string): EmbedTextChunk | undefined },
				);
				this.sql().exec(
					'INSERT INTO pending_embed_text(id, embed_text, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET embed_text = excluded.embed_text, created_at = excluded.created_at',
					c.id, et, Date.now(),
				);
				toEmbed.push(c.id);
			}
		}
		touchedFiles.set(c.file, (touchedFiles.get(c.file) ?? 0) + 1);
	}

	/** Name of an already-stored chunk (parent lookup fallback when the parent
	 *  isn't in the current batch). */
	private dbChunkName(id: string): string | undefined {
		const rows = this.sql().exec<{ name: string }>('SELECT name FROM chunks WHERE id = ?', id).toArray();
		return rows[0]?.name;
	}

	/** Delete a set of chunk rows (by id + fts_rowid): FTS + content + pending
	 *  embed + graph edges + the chunk row, and queue their Vectorize deletions.
	 *  The shared core of removeFile (whole file) and reconcileFile (the departed
	 *  chunks of a still-present, edited file). Caller owns the transaction. */
	private removeChunkRows(rows: { id: string; fts_rowid: number | null }[]): void {
		if (rows.length === 0) return;
		const ids = rows.map(r => r.id);
		// FTS deletes by ROWID (indexed) — deleting by the UNINDEXED id column
		// full-scans the FTS table, which is quadratic during a large prune
		// (live failure at 673k rows). Legacy rows (fts_rowid NULL) fall back.
		const ftsRowids = rows.filter(r => r.fts_rowid != null).map(r => r.fts_rowid as number);
		const legacyIds = rows.filter(r => r.fts_rowid == null).map(r => r.id);
		for (const batch of chunked(ftsRowids, 90)) {
			this.sql().exec(`DELETE FROM chunk_fts WHERE rowid IN (${batch.map(() => '?').join(',')})`, ...batch);
		}
		for (const batch of chunked(legacyIds, 90)) {
			this.sql().exec(`DELETE FROM chunk_fts WHERE id IN (${batch.map(() => '?').join(',')})`, ...batch);
		}
		for (const batch of chunked(ids, 90)) {
			const ph = batch.map(() => '?').join(',');
			this.sql().exec(`DELETE FROM chunk_text WHERE id IN (${ph})`, ...batch);
			this.sql().exec(`DELETE FROM pending_embed_text WHERE id IN (${ph})`, ...batch);
			this.sql().exec(`DELETE FROM pending_client_vectors WHERE id IN (${ph})`, ...batch);
			this.sql().exec(`DELETE FROM symbol_edges WHERE chunk_id IN (${ph})`, ...batch);
			this.sql().exec(`DELETE FROM chunks WHERE id IN (${ph})`, ...batch);
		}
		// Vectors are external (Vectorize) — queue their deletion in the SAME
		// transaction as the row deletes so a removed chunk can never keep a live
		// vector. Every id is queued regardless of has_vector: a vector can exist
		// while has_vector is still 0 (upsert landed, /vector-done lost), and
		// deleting a nonexistent id is a no-op — ghost-safety over queue thrift.
		this.queueVectorDeletes(ids);
	}

	/** Returns how many chunk rows the file held (drives the prune chunk budget). */
	private removeFile(file: string): number {
		const rows = this.sql().exec<{ id: string; fts_rowid: number | null }>('SELECT id, fts_rowid FROM chunks WHERE file = ?', file).toArray();
		this.removeChunkRows(rows);
		this.sql().exec('DELETE FROM files WHERE file = ?', file);
		return rows.length;
	}

	/** Reconcile a still-present, re-synced file against the client's COMPLETE
	 *  current chunk-id set: delete the file's rows whose id is NOT in the set.
	 *  id = hash(file:start:end), so an edit that shifts lines mints new ids and
	 *  a deleted function drops its id — the old rows linger forever otherwise
	 *  (removeFile only fires for whole-file removal, when the file is absent from
	 *  the manifest; a re-synced file is present). Those stale rows serve wrong
	 *  line numbers / deleted code and keep live vectors. Safe to run per batch
	 *  even before the file's new chunks have all landed: departed = (existing
	 *  rows) − (full current set), and a not-yet-uploaded current id is in the set
	 *  so it is never deleted. Returns departed count. Caller owns the transaction. */
	private reconcileFile(file: string, currentIds: string[]): number {
		const keep = new Set(currentIds);
		const rows = this.sql().exec<{ id: string; fts_rowid: number | null }>('SELECT id, fts_rowid FROM chunks WHERE file = ?', file)
			.toArray().filter(r => !keep.has(r.id));
		this.removeChunkRows(rows);
		return rows.length;
	}

	/** Stage chunk ids for Vectorize deletion. Plain execs, NO transaction of its
	 *  own — removeFile calls this inside drainPruneBatch's transactionSync (which
	 *  does not nest), so callers own the transaction boundary.
	 *
	 *  Re-queueing an id BUMPS created_at instead of being ignored: created_at is
	 *  the generation guard flushVectorDeletes keys its row cleanup on, so a
	 *  re-queue that interleaves during an in-flight deleteByIds (vectorDone's
	 *  orphan detection racing the flush) survives the flush's cleanup and gets
	 *  delivered on the next pass instead of being silently erased. */
	private queueVectorDeletes(ids: string[], profile: IndexProfile = this.currentIndexProfile()): void {
		const now = Date.now();
		// 30 rows × 3 params = 90 bound variables, the file-wide param cap.
		for (const batch of chunked(ids, 30)) {
			const values = batch.map(() => '(?, ?, ?)').join(',');
			this.sql().exec(
				`INSERT INTO pending_vector_deletes(id, created_at, profile) VALUES ${values}
				 ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, profile = excluded.profile`,
				...batch.flatMap(id => [id, now, profile]),
			);
		}
	}

	/** Pending Vectorize deletions (queued by removeFile/reset, drained by flush). */
	private vectorDeleteQueueSize(): number {
		return this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM pending_vector_deletes').one().n;
	}

	/** Issue queued Vectorize deletions, bounded per invocation like the prune
	 *  drain. Rows are removed only AFTER deleteByIds succeeds — a Vectorize
	 *  outage leaves them queued and the alarm chain retries. Callers decide
	 *  whether to re-arm the alarm from `remaining`.
	 *
	 *  Cleanup is GUARDED per row on (id, created_at): the deleteByIds await
	 *  opens the input gate, so a /vector-done orphan re-queue for one of the
	 *  in-flight ids can interleave — it bumps created_at, the guard misses, the
	 *  row survives for the next pass. Unguarded cleanup silently erased exactly
	 *  the re-queue the orphan detection exists to make (review finding). */
	private async flushVectorDeletes(cap = VECTOR_DELETE_FLUSH_CAP): Promise<{ deleted: number; remaining: number }> {
		const wsId = this.metaGet('workspaceId') ?? '';
		let deleted = 0;
		while (deleted < cap) {
			// 50 chunk ids/iteration: each expands to TWO vector ids (salted +
			// legacy-unsalted, see below), and deleteByIds caps at 100 ids/call.
			const rows = this.sql().exec<{ id: string; created_at: number; profile: string }>(
				'SELECT id, created_at, profile FROM pending_vector_deletes LIMIT ?', Math.min(VECTOR_DELETE_BATCH, cap - deleted),
			).toArray();
			if (rows.length === 0) break;
			// Delete BOTH the workspace-prefixed id and the bare id: vectors written
			// after the salting change are stored as `${wsId}:${id}`, but any written
			// before it (and not yet migrated) are bare. Deleting a nonexistent id is
			// a no-op, so covering both is free insurance that a prune never strands a
			// vector under whichever scheme it happens to be stored in.
			for (const profile of ['standard', 'advanced'] as const) {
				const vectorIds: string[] = [];
				for (const r of rows) {
					if (r.profile !== profile) continue;
					if (wsId) vectorIds.push(`${wsId}:${r.id}`);
					vectorIds.push(r.id);
				}
				for (const batch of chunked(vectorIds, VECTOR_DELETE_ID_CALL)) {
					await vectorIndexFor(this.env, profile).deleteByIds(batch);
				}
			}
			this.ctx.storage.transactionSync(() => {
				for (const r of rows) {
					this.sql().exec('DELETE FROM pending_vector_deletes WHERE id = ? AND created_at = ?', r.id, r.created_at);
				}
			});
			deleted += rows.length;
		}
		return { deleted, remaining: this.vectorDeleteQueueSize() };
	}

	private clientVectorQueueSize(): number {
		return this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM pending_client_vectors').one().n;
	}

	/** Drain locally produced Qwen vectors without ever receiving source. Rows
	 * survive a Vectorize outage and are generation-guarded across input-gate
	 * interleaving. The alarm flushes pending deletions first, so a same-id source
	 * replacement cannot have its new vector erased by an older delete. */
	private async flushClientVectors(cap = CLIENT_VECTOR_FLUSH_CAP): Promise<{ upserted: number; remaining: number }> {
		const workspaceId = this.metaGet('workspaceId') ?? '';
		if (!workspaceId) return { upserted: 0, remaining: this.clientVectorQueueSize() };
		const embedDim = Number(this.env.EMBED_DIM);
		const rows = this.sql().exec<{ id: string; cas_key: string; q8: string; scale: number; identity: string; created_at: number }>(
			'SELECT id, cas_key, q8, scale, identity, created_at FROM pending_client_vectors ORDER BY created_at LIMIT ?', cap,
		).toArray();
		if (rows.length === 0) return { upserted: 0, remaining: 0 };

		await vectorIndexFor(this.env, 'standard').upsert(rows.map(row => ({
			id: `${workspaceId}:${row.id}`,
			values: decodeQ8Vector(row.q8, row.scale, embedDim),
			namespace: workspaceId,
			metadata: { identity: row.identity },
		})));

		this.ctx.storage.transactionSync(() => {
			for (const row of rows) {
				const pending = this.sql().exec<{ created_at: number }>('SELECT created_at FROM pending_client_vectors WHERE id = ?', row.id).toArray()[0];
				const chunk = this.sql().exec<{ cas_key: string }>('SELECT cas_key FROM chunks WHERE id = ?', row.id).toArray()[0];
				if (pending?.created_at === row.created_at && chunk?.cas_key === row.cas_key) {
					this.sql().exec('UPDATE chunks SET has_vector = 1, embed_failed = 0 WHERE id = ? AND cas_key = ?', row.id, row.cas_key);
					this.sql().exec('DELETE FROM pending_client_vectors WHERE id = ? AND created_at = ?', row.id, row.created_at);
				} else {
					// The row was removed or replaced while Vectorize was in flight.
					// Delete the stale upsert; a newer pending generation stays queued.
					this.queueVectorDeletes([row.id]);
				}
			}
		});
		return { upserted: rows.length, remaining: this.clientVectorQueueSize() };
	}

	/** Keyset-paginated live chunk ids (opaque hashes only) — ground truth for the
	 *  ghost-vector purge script's diff against the shared Vectorize index. */
	private chunkIds(body: { afterId?: string; limit?: number }): { ids: string[]; done: boolean; lastId?: string } {
		const limit = Math.min(Math.max(1, body.limit ?? 5000), 10000);
		const rows = this.sql().exec<{ id: string }>(
			'SELECT id FROM chunks WHERE id > ? ORDER BY id LIMIT ?', body.afterId ?? '', limit,
		).toArray();
		return { ids: rows.map(r => r.id), done: rows.length < limit, lastId: rows[rows.length - 1]?.id };
	}

	private signalsEdits(body: RecentEditsSignal): unknown {
		this.sql().exec('DELETE FROM recent_edits');
		for (const [file, rank] of Object.entries(body.ranks)) {
			this.sql().exec('INSERT INTO recent_edits(file, rank) VALUES (?, ?)', file, rank);
		}
		return { ok: true };
	}

	private lspEdges(body: LspEdgesUpload): unknown {
		for (const f of body.files) {
			const byChunk = new Map<string, { defines: string[]; refs: string[] }>();
			for (const d of f.defines) {
				const e = byChunk.get(d.chunkId) ?? { defines: [], refs: [] };
				e.defines.push(d.symbol); byChunk.set(d.chunkId, e);
			}
			for (const r of f.refs) {
				const e = byChunk.get(r.chunkId) ?? { defines: [], refs: [] };
				e.refs.push(r.symbol); byChunk.set(r.chunkId, e);
			}
			for (const [chunkId, e] of byChunk) {
				this.sql().exec('UPDATE chunks SET lsp_defines = ?, lsp_refs = ? WHERE id = ?',
					JSON.stringify(e.defines), JSON.stringify(e.refs), chunkId);
				// Refresh only the LSP-kind edges for this chunk (text edges from the
				// original upload stay put). LSP edges bypass the noise filter.
				this.sql().exec('DELETE FROM symbol_edges WHERE chunk_id = ? AND kind IN (?, ?)', chunkId, EDGE_LSP_DEFINE, EDGE_LSP_REF);
				for (const sym of e.defines) if (sym) this.sql().exec('INSERT OR IGNORE INTO symbol_edges(symbol, chunk_id, kind) VALUES (?, ?, ?)', sym, chunkId, EDGE_LSP_DEFINE);
				for (const sym of e.refs) if (sym) this.sql().exec('INSERT OR IGNORE INTO symbol_edges(symbol, chunk_id, kind) VALUES (?, ?, ?)', sym, chunkId, EDGE_LSP_REF);
			}
		}
		return { ok: true };
	}

	/** Queue consumer pulls embed text by id; purged after the vectors land. */
	private embedTextBatch(body: { ids: string[] }): { texts: Array<{ id: string; text: string }> } {
		const texts: Array<{ id: string; text: string }> = [];
		for (const batch of chunked(body.ids, 90)) {
			const q = `SELECT id, embed_text FROM pending_embed_text WHERE id IN (${batch.map(() => '?').join(',')})`;
			for (const r of this.sql().exec<{ id: string; embed_text: string }>(q, ...batch).toArray()) {
				texts.push({ id: r.id, text: r.embed_text });
			}
		}
		return { texts };
	}

	private async vectorDone(body: { ids: string[] }): Promise<unknown> {
		let orphaned = 0;
		for (const batch of chunked(body.ids, 90)) {
			const ph = batch.map(() => '?').join(',');
			// Vector landed → clear any embed_failed flag from a prior abandoned attempt.
			this.sql().exec(`UPDATE chunks SET has_vector = 1, embed_failed = 0 WHERE id IN (${ph})`, ...batch);
			this.sql().exec(`DELETE FROM pending_embed_text WHERE id IN (${ph})`, ...batch);
			// An acked id with NO chunk row means the chunk was pruned while its
			// embed job was in flight — the upsert that just landed re-created a
			// ghost vector. Queue its deletion; the alarm chain delivers it.
			const present = new Set(this.sql().exec<{ id: string }>(`SELECT id FROM chunks WHERE id IN (${ph})`, ...batch).toArray().map(r => r.id));
			const missing = batch.filter(id => !present.has(id));
			if (missing.length > 0) {
				this.queueVectorDeletes(missing);
				orphaned += missing.length;
			}
		}
		if (orphaned > 0) { await this.ctx.storage.setAlarm(Date.now() + PRUNE_ALARM_DELAY_MS); }
		return { ok: true, orphaned };
	}

	/** Mark chunk ids whose embed job was abandoned (queue retries exhausted →
	 *  DLQ, or the pending text was already gone when the job ran) so the gap is
	 *  visible in /status instead of silently sitting at has_vector = 0. Guarded
	 *  on has_vector = 0 so a redelivered/already-succeeded id is never mis-marked
	 *  (its pending_embed_text is retained, so /requeue can still recover it). */
	private embedFailed(body: { ids: string[] }): { marked: number } {
		let marked = 0;
		for (const batch of chunked(body.ids, 90)) {
			const ph = batch.map(() => '?').join(',');
			marked += this.sql().exec<{ n: number }>(`SELECT COUNT(*) AS n FROM chunks WHERE has_vector = 0 AND embed_failed = 0 AND id IN (${ph})`, ...batch).one().n;
			this.sql().exec(`UPDATE chunks SET embed_failed = 1 WHERE has_vector = 0 AND id IN (${ph})`, ...batch);
		}
		return { marked };
	}

	/** Retrieval: FTS5 lexical channel + caller-provided Vectorize ranking →
	 *  full fusion pipeline with graph, all local to this DO. */
	private async query(body: { queryTokens: string[]; vectorRanked: string[]; topK: number; files?: string[]; _meter?: string }): Promise<unknown> {
		this.meter(body._meter, 'retrieve');
		const topK = body.topK || 30;
		const allowedFiles = body.files === undefined ? null : new Set(body.files);
		const _t0 = Date.now();
		const lexicalRanked = this.ftsQuery(body.queryTokens, Math.max(60, topK * 2), body.files);
		const _tFts = Date.now();

		const wanted = new Set<string>([...lexicalRanked, ...body.vectorRanked]);
		const candidates = new Map<string, FusionCandidate>();
		for (const batch of chunked([...wanted], 90)) {
			const q = `SELECT * FROM chunks WHERE id IN (${batch.map(() => '?').join(',')})${allowedFiles ? ' AND file IN (SELECT value FROM json_each(?))' : ''}`;
			const args = allowedFiles ? [...batch, JSON.stringify(body.files)] : batch;
			for (const r of this.sql().exec<any>(q, ...args).toArray()) candidates.set(r.id, rowToCandidate(r));
		}
		const scopedVectorRanked = body.vectorRanked.filter(id => candidates.has(id));
		// Bring parents of matched children into the candidate set (collapse targets).
		const parentIds = [...candidates.values()].map(c => c.parentId).filter((p): p is string => !!p && !candidates.has(p));
		for (const batch of chunked(parentIds, 90)) {
			const q = `SELECT * FROM chunks WHERE id IN (${batch.map(() => '?').join(',')})${allowedFiles ? ' AND file IN (SELECT value FROM json_each(?))' : ''}`;
			const args = allowedFiles ? [...batch, JSON.stringify(body.files)] : batch;
			for (const r of this.sql().exec<any>(q, ...args).toArray()) candidates.set(r.id, rowToCandidate(r));
		}

		const recentFiles = new Map<string, number>();
		for (const r of this.sql().exec<{ file: string; rank: number }>('SELECT file, rank FROM recent_edits').toArray()) {
			if (!allowedFiles || allowedFiles.has(r.file)) recentFiles.set(r.file, r.rank);
		}

		// Graph signals come from bounded SQL edge lookups (SqlGraph), not an
		// in-memory graph over the whole corpus. cloudFuse asks only for the
		// symbols of its seed/primary chunks; each ask is one batched IN query
		// (chunked to ≤90 params like the rest of this file).
		const _tCand = Date.now();
		const graph = new SqlGraph({ edgesForSymbols: (symbols) => this.edgesForSymbols(symbols) });
		const hits = cloudFuse(candidates, graph, {
			lexicalRanked, vectorRanked: scopedVectorRanked,
			recentFiles: recentFiles.size ? recentFiles : null,
			queryTokens: body.queryTokens,
		}, topK);
		const _tFuse = Date.now();

		// Snippets in full mode only. Content lives in R2 (content-addressed by
		// casKey); fall back to legacy chunk_text for chunks indexed before the R2
		// offload, so existing workspaces keep serving snippets with no migration.
		const privacyMode = this.metaGet('privacyMode') ?? 'vectors-only';
		const workspaceId = this.metaGet('workspaceId') ?? '';
		const snippets = new Map<string, string>();
		if (privacyMode === 'full') {
			await Promise.all(hits.map(async h => {
				const obj = await this.env.BLOBS.get(blobKey(workspaceId, h.chunk.casKey));
				if (obj) { snippets.set(h.chunk.id, await obj.text()); return; }
				const legacy = this.sql().exec<{ content: string }>('SELECT content FROM chunk_text WHERE id = ?', h.chunk.id).toArray();
				if (legacy[0]) snippets.set(h.chunk.id, legacy[0].content);
			}));
		}
		return {
			hits: hits.map(h => ({
				chunkId: h.chunk.id, casKey: h.chunk.casKey, file: h.chunk.file,
				startLine: h.chunk.startLine, endLine: h.chunk.endLine,
				kind: h.chunk.kind, name: h.chunk.name, language: h.chunk.language, score: h.score,
				snippet: snippets.get(h.chunk.id), signals: h.signals,
			})),
			_timings: { ftsMs: _tFts - _t0, candMs: _tCand - _tFts, fuseMs: _tFuse - _tCand, snipMs: Date.now() - _tFuse, candN: candidates.size },
		};
	}

	/** Deterministic go-to-definition / find-references over the symbol graph —
	 *  exact symbol matches (text + LSP edges), verified (LSP) edges first. This
	 *  is what agents want for "where is X defined / who calls X", vs semantic
	 *  search. Bounded by `limit`. */
	private symbolLookup(body: { symbol?: string; which?: 'def' | 'ref'; limit?: number }): unknown {
		const symbol = String(body?.symbol ?? '');
		if (!symbol) return { symbol: '', which: body?.which ?? 'def', matches: [] };
		const which = body.which === 'ref' ? 'ref' : 'def';
		const kinds = which === 'def' ? [EDGE_TEXT_DEFINE, EDGE_LSP_DEFINE] : [EDGE_TEXT_REF, EDGE_LSP_REF];
		const limit = Math.min(Math.max(1, body.limit ?? 50), 200);
		// kinds are numeric constants (not user input) — safe to inline.
		const rows = this.sql().exec<any>(
			`SELECT c.id, c.file, c.name, c.kind, c.start_line, c.end_line, MAX(e.kind) AS edge_kind
			 FROM symbol_edges e JOIN chunks c ON c.id = e.chunk_id
			 WHERE e.symbol = ? AND e.kind IN (${kinds.join(',')})
			 GROUP BY c.id ORDER BY edge_kind DESC, c.file LIMIT ?`,
			symbol, limit,
		).toArray();
		return {
			symbol, which,
			matches: rows.map(r => ({
				chunkId: r.id, file: r.file, name: r.name, kind: r.kind,
				startLine: r.start_line, endLine: r.end_line, lsp: r.edge_kind >= EDGE_LSP_DEFINE,
			})),
		};
	}

	/** Graph neighbors of a chunk (the definitions it calls + the callers that use
	 *  it) — "what's related to this hit", for agents expanding context around a
	 *  search result. Byte-parity with retrieval's neighbor expansion. */
	private neighbors(body: { chunkId?: string; max?: number }): unknown {
		const chunkId = String(body?.chunkId ?? '');
		if (!chunkId) return { chunkId: '', neighbors: [] };
		const max = Math.min(Math.max(1, body.max ?? 10), 30);
		const seedRows = this.sql().exec<any>('SELECT * FROM chunks WHERE id = ?', chunkId).toArray();
		if (seedRows.length === 0) return { chunkId, neighbors: [] };
		const graph = new SqlGraph({ edgesForSymbols: (symbols) => this.edgesForSymbols(symbols) });
		const ids = graph.neighborsOf(rowToCandidate(seedRows[0]) as never, max);
		const neighbors: Array<Record<string, unknown>> = [];
		for (const batch of chunked(ids, 90)) {
			const ph = batch.map(() => '?').join(',');
			for (const r of this.sql().exec<any>(`SELECT id, file, name, kind, start_line, end_line FROM chunks WHERE id IN (${ph})`, ...batch).toArray()) {
				neighbors.push({ chunkId: r.id, file: r.file, name: r.name, kind: r.kind, startLine: r.start_line, endLine: r.end_line });
			}
		}
		return { chunkId, neighbors };
	}

	/** Ordered structural outline of a file (functions/classes/blocks) — for an
	 *  agent to understand a file's shape before reading it. */
	private outline(body: { file?: string }): unknown {
		const file = String(body?.file ?? '');
		if (!file) return { file: '', chunks: [] };
		const rows = this.sql().exec<any>(
			'SELECT id, name, kind, start_line, end_line, parent_id FROM chunks WHERE file = ? ORDER BY start_line LIMIT 2000',
			file,
		).toArray();
		return {
			file,
			chunks: rows.map(r => ({
				chunkId: r.id, name: r.name, kind: r.kind,
				startLine: r.start_line, endLine: r.end_line, parentId: r.parent_id ?? undefined,
			})),
		};
	}

	private ftsQuery(tokens: string[], limit: number, files?: string[]): string[] {
		if (files && files.length === 0) return [];
		const clean = tokens.map(t => t.replace(/[^A-Za-z0-9_]/g, '')).filter(t => t.length >= 2);
		// Strip stopwords so a verbose query doesn't OR-match half the corpus (the 6s
		// fusion bug); fall back to the unfiltered terms if the query is ALL stopwords,
		// then bound the OR-term count.
		let safe = clean.filter(t => !FTS_STOPWORDS.has(t.toLowerCase()));
		if (safe.length === 0) safe = clean;
		if (safe.length === 0) return [];
		if (safe.length > MAX_FTS_TERMS) safe = safe.slice(0, MAX_FTS_TERMS);
		const match = safe.map(t => `"${t}"`).join(' OR ');
		try {
			const scoped = files !== undefined;
			const query = scoped
				? 'SELECT chunk_fts.id FROM chunk_fts JOIN chunks ON chunks.id = chunk_fts.id WHERE chunk_fts MATCH ? AND chunks.file IN (SELECT value FROM json_each(?)) ORDER BY bm25(chunk_fts) LIMIT ?'
				: 'SELECT id FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT ?';
			const args = scoped ? [match, JSON.stringify(files), limit] : [match, limit];
			return this.sql()
				.exec<{ id: string }>(query, ...args)
				.toArray().map(r => r.id);
		} catch {
			return []; // malformed MATCH must never take down retrieval
		}
	}

	/** Persist one chunk's graph edges (replace-by-id). Called on every upsert.
	 *  Text edges are noise-filtered inside edgeRowsForChunk; LSP edges bypass.
	 *  Speed: a chunk's ~10-20 edges are written in ONE multi-row INSERT instead
	 *  of one exec per edge (the JS↔SQLite boundary crossing dominated ingest),
	 *  and the pre-delete is skipped for brand-new chunks (nothing to clear). */
	private writeEdges(c: WireChunk, isNew: boolean): void {
		if (!isNew) this.deleteEdges(c.id);
		const edges = edgeRowsForChunk(c);
		// 30 rows × 3 params = 90 bound variables — under Cloudflare DO SQLite's ~100
		// param cap (the same cap the IN-list queries respect at 90). At 100 rows this
		// was 300 params and a chunk with 34+ edges 500'd with "too many SQL variables".
		for (const batch of chunked(edges, 30)) {
			const values = batch.map(() => '(?, ?, ?)').join(', ');
			const args: (string | number)[] = [];
			for (const e of batch) args.push(e.symbol, e.chunk_id, e.kind);
			this.sql().exec(`INSERT OR IGNORE INTO symbol_edges(symbol, chunk_id, kind) VALUES ${values}`, ...args);
		}
	}

	/** Drop all edges for a chunk id. Used before re-inserting on upsert and when
	 *  a chunk row is removed (removeFile). */
	private deleteEdges(chunkId: string): void {
		this.sql().exec('DELETE FROM symbol_edges WHERE chunk_id = ?', chunkId);
	}

	/** Batched edge fetch for a set of symbols — the QUERY-time surface SqlGraph
	 *  binds to. IN lists are chunked to ≤90 params like the rest of the file.
	 *
	 *  BOUNDED per symbol: at most EDGE_FETCH_CAP (MAX_FANOUT+1 = 41) rows per
	 *  (symbol, kind) via a ROW_NUMBER window. A hub symbol referenced by the
	 *  whole 39k-chunk corpus would otherwise return 39k rows here — the exact
	 *  cost the in-memory graph incurred. 41 is the minimum that still lets the
	 *  query-time fan-out filter (>40 ⇒ drop that side) fire correctly: a single
	 *  kind at 41 already exceeds 40, so the side is dropped regardless of the
	 *  other layer's (unfetched) tail. Worst case: 4 kinds × 41 = 164 rows/symbol.
	 *
	 *  Never throws: on a workspace whose symbol_edges table predates this schema
	 *  or has not been backfilled yet, it returns [] and retrieval degrades to
	 *  no-graph-signal. */
	private edgesForSymbols(symbols: string[]): EdgeRow[] {
		if (symbols.length === 0) return [];
		const rows: EdgeRow[] = [];
		try {
			for (const batch of chunked(symbols, 90)) {
				const ph = batch.map(() => '?').join(',');
				// Rank rows within each (symbol, kind) and keep the first EDGE_FETCH_CAP.
				const q = `SELECT symbol, chunk_id, kind FROM (
					SELECT symbol, chunk_id, kind,
					       ROW_NUMBER() OVER (PARTITION BY symbol, kind ORDER BY chunk_id) AS rn
					FROM symbol_edges WHERE symbol IN (${ph})
				) WHERE rn <= ${EDGE_FETCH_CAP}`;
				for (const r of this.sql().exec<{ symbol: string; chunk_id: string; kind: number }>(q, ...batch).toArray()) {
					rows.push({ symbol: r.symbol, chunk_id: r.chunk_id, kind: r.kind });
				}
			}
		} catch {
			return []; // no edges table / backfill pending → no-graph-signal, never an error
		}
		return rows;
	}

	/** Backfill symbol_edges for a workspace that has chunks but no edges yet
	 *  (created before this schema, or migrated in). Keyset-paginated on chunk id
	 *  so each call stays well under DO CPU limits; the caller loops on `done`.
	 *  Idempotent per chunk (deleteEdges before re-insert), so re-running a batch
	 *  is safe. Reads defines/refs/lsp_* straight off the chunk rows. */
	private reindexGraph(body: { afterId?: string; limit?: number }): { processed: number; done: boolean; lastId?: string } {
		const limit = Math.min(Math.max(1, body.limit ?? 2000), 3000); // hard cap: ~2-3k chunks/call
		const after = body.afterId ?? '';
		const rows = this.sql().exec<{ id: string; defines: string | null; refs: string | null; lsp_defines: string | null; lsp_refs: string | null }>(
			'SELECT id, defines, refs, lsp_defines, lsp_refs FROM chunks WHERE id > ? ORDER BY id LIMIT ?',
			after, limit,
		).toArray();
		let lastId: string | undefined;
		for (const r of rows) {
			this.deleteEdges(r.id);
			const edges = edgeRowsForChunk({
				id: r.id,
				defines: r.defines ? JSON.parse(r.defines) : undefined,
				refs: r.refs ? JSON.parse(r.refs) : undefined,
				lspDefines: r.lsp_defines ? JSON.parse(r.lsp_defines) : undefined,
				lspRefs: r.lsp_refs ? JSON.parse(r.lsp_refs) : undefined,
			});
			for (const e of edges) {
				this.sql().exec('INSERT OR IGNORE INTO symbol_edges(symbol, chunk_id, kind) VALUES (?, ?, ?)', e.symbol, e.chunk_id, e.kind);
			}
			lastId = r.id;
		}
		// done when this page was short (fewer rows than requested → no more after lastId).
		return { processed: rows.length, done: rows.length < limit, lastId };
	}

	/** Re-enqueue embed jobs for every pending (orphaned) embed text — recovery
	 *  path for jobs that exhausted queue retries before the DLQ existed. */
	private async requeue(): Promise<unknown> {
		const workspaceId = this.metaGet('workspaceId') ?? '';
		if (!workspaceId) return { requeued: 0, error: 'workspace not initialized' };
		const embedIdentity = this.metaGet('embedIdentity') ?? '';
		const indexProfile = this.currentIndexProfile();
		const ids = this.sql().exec<{ id: string }>('SELECT id FROM pending_embed_text').toArray().map(r => r.id);
		for (const batch of chunked(ids, EMBED_JOB_BATCH)) {
			const ph = batch.map(() => '?').join(',');
			// Re-driving these — clear any embed_failed flag so /status shows them
			// back in flight rather than abandoned (vectorDone/embedFailed will set
			// the final state once the job resolves).
			this.sql().exec(`UPDATE chunks SET embed_failed = 0 WHERE id IN (${ph})`, ...batch);
			await this.env.EMBED_QUEUE.send({ workspaceId, chunkIds: batch, embedIdentity, indexProfile });
		}
		return { requeued: ids.length };
	}

	/** Schedules the hourly privacy-backstop sweep if nothing is scheduled yet.
	 *  Called lazily on every insert into pending_embed_text rather than once
	 *  at DO construction, because a fresh Worker isolate re-runs the class
	 *  constructor but setAlarm is durable — we only need to set it the first
	 *  time a workspace ever produces a pending row. */
	private async ensureBackstopAlarm(): Promise<void> {
		const existing = await this.ctx.storage.getAlarm();
		if (existing !== null) return;
		await this.ctx.storage.setAlarm(Date.now() + BACKSTOP_SWEEP_INTERVAL_MS);
	}

	/** DO alarm handler — sweeps pending_embed_text rows older than the max
	 *  age (failed/lost embed jobs) and reschedules itself hourly so the
	 *  backstop keeps running for the life of the workspace. */
	override async alarm(): Promise<void> {
		this.ensureSchema();
		// Backstop sweeps run at their OWN hourly cadence, not per alarm tick:
		// during a prune drain the alarm fires every 500ms, and sweep (a)'s
		// subquery FULL-SCANS the chunks table (has_vector is unindexed) — at
		// 673k rows that is hundreds of full scans per drain, inside the very
		// handler whose failure mode is a crash-retry loop (fresh-eyes audit #2).
		const nextSweepAt = Number(this.metaGet('nextSweepAt') ?? 0);
		if (Date.now() >= nextSweepAt) {
			// (a) Redundant rows: the vector already landed but the row wasn't purged
			//     (shouldn't happen — vectorDone deletes it — but clean up defensively).
			this.sql().exec('DELETE FROM pending_embed_text WHERE id IN (SELECT id FROM chunks WHERE has_vector = 1)');
			// (b) Advanced text is transient even on failure. Before purging an
			//     abandoned row, invalidate its file manifest; the editor's next
			//     normal sync then uploads that file again instead of certifying a
			//     permanently vectorless chunk. Legacy full mode keeps the longer
			//     recovery window because it already retains source in R2.
			const privacyMode = this.metaGet('privacyMode') ?? 'vectors-only';
			if (privacyMode === 'ephemeral') {
				const cutoff = Date.now() - EPHEMERAL_TEXT_MAX_AGE_MS;
				this.sql().exec('DELETE FROM files WHERE file IN (SELECT c.file FROM chunks c JOIN pending_embed_text p ON p.id = c.id WHERE p.created_at < ?)', cutoff);
				this.sql().exec('UPDATE chunks SET embed_failed = 1 WHERE has_vector = 0 AND id IN (SELECT id FROM pending_embed_text WHERE created_at < ?)', cutoff);
				this.sql().exec('DELETE FROM pending_embed_text WHERE created_at < ?', cutoff);
			} else {
				this.sql().exec('DELETE FROM pending_embed_text WHERE created_at < ?', Date.now() - PENDING_TEXT_MAX_AGE_MS);
			}
			this.metaSet('nextSweepAt', String(Date.now() + BACKSTOP_SWEEP_INTERVAL_MS));
		}
		// (c) Background prune drain: one bounded batch per alarm (fresh CPU
		//     budget each invocation). Chain short alarms until the queue is
		//     empty, then fall back to the hourly backstop cadence.
		const prunedNow = this.drainPruneBatch(PRUNE_CHUNK_BUDGET);
		const pruneRemaining = prunedNow > 0 ? this.pruneQueueSize() : 0;
		// (d) Flush queued Vectorize deletions (staged by removeFile/reset). MUST
		//     NOT throw out of the alarm: a Vectorize outage would otherwise put
		//     the handler into a crash-retry loop — the exact failure family the
		//     bounded drains exist to prevent. On error the rows stay queued and
		//     the chain below retries with backoff via the next alarm.
		let vectorRemaining = 0;
		let vectorErrored = false;
		try {
			const flushed = await this.flushVectorDeletes();
			vectorRemaining = flushed.remaining;
			if (flushed.deleted > 0) {
				console.log(JSON.stringify({ evt: 'vector-delete-flush', deleted: flushed.deleted, remaining: flushed.remaining }));
			}
		} catch (err) {
			vectorErrored = true;
			vectorRemaining = this.vectorDeleteQueueSize();
			console.error(JSON.stringify({ evt: 'vector-delete-error', remaining: vectorRemaining, err: String((err as { message?: string })?.message ?? err) }));
		}
		// (e) Source-free local vectors land only after all older deletes have
		// drained, which makes same-id replacement ordering deterministic.
		let clientVectorRemaining = this.clientVectorQueueSize();
		let clientVectorErrored = false;
		if (!vectorErrored && vectorRemaining === 0 && clientVectorRemaining > 0) {
			try {
				const flushed = await this.flushClientVectors();
				clientVectorRemaining = flushed.remaining;
				if (flushed.upserted > 0) console.log(JSON.stringify({ evt: 'client-vector-flush', upserted: flushed.upserted, remaining: flushed.remaining }));
			} catch (err) {
				clientVectorErrored = true;
				clientVectorRemaining = this.clientVectorQueueSize();
				console.error(JSON.stringify({ evt: 'client-vector-error', remaining: clientVectorRemaining, err: String((err as { message?: string })?.message ?? err) }));
			}
		}
		if (pruneRemaining > 0 || vectorRemaining > 0 || clientVectorRemaining > 0) {
			console.log(JSON.stringify({ evt: 'prune-drain', pruned: prunedNow, remaining: pruneRemaining, vectorRemaining, clientVectorRemaining }));
			// A Vectorize outage with nothing left to prune must not spin the
			// chain at 500ms forever — back off to a minute between retries.
			const delay = pruneRemaining === 0 && (vectorErrored || clientVectorErrored) ? 60_000 : PRUNE_ALARM_DELAY_MS;
			await this.ctx.storage.setAlarm(Date.now() + delay);
		} else {
			await this.ctx.storage.setAlarm(Date.now() + BACKSTOP_SWEEP_INTERVAL_MS);
		}
	}

	private meter(key: string | undefined, op: string): void {
		const day = new Date().toISOString().slice(0, 10);
		this.sql().exec(
			'INSERT INTO usage(day, key, op, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, key, op) DO UPDATE SET count = count + 1',
			day, key ?? 'unknown', op,
		);
	}

	private usage(): unknown {
		return { usage: this.sql().exec<any>('SELECT day, key, op, count FROM usage ORDER BY day DESC LIMIT 500').toArray() };
	}

	private status(): unknown {
		// (workspaceId included so clients/tests can verify init routing.)
		const files = this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM files').one().n;
		const chunks = this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM chunks').one().n;
		const vectors = this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM chunks WHERE has_vector = 1').one().n;
		const scored = this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM chunks WHERE scored = 1').one().n;
		const pending = this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM pending_embed_text').one().n;
		const pendingClientVectors = this.clientVectorQueueSize();
		// Chunks whose embed job was abandoned (DLQ'd or text gone) and still have
		// no vector — the honest "these will never be semantically searchable
		// unless re-embedded" signal, so vectorCoverage < 1 has an explanation.
		const embedFailed = this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM chunks WHERE embed_failed = 1 AND has_vector = 0').one().n;
		// Oldest still-pending row's age — ops signal for lingering plaintext
		// (pending_embed_text holds embed text derived from chunk content).
		// Should normally stay well under the 7-day abandoned-backstop threshold.
		const oldest = this.sql().exec<{ min_created: number | null }>('SELECT MIN(created_at) AS min_created FROM pending_embed_text').one().min_created;
		return {
			workspaceId: this.metaGet('workspaceId') ?? '',
			manifestRoot: this.metaGet('manifestRoot') || null,
			files, chunks, vectors,
			vectorCoverage: scored > 0 ? vectors / scored : 0,
			embedIdentity: this.metaGet('embedIdentity') ?? '',
			privacyMode: this.metaGet('privacyMode') ?? 'vectors-only',
			indexProfile: this.currentIndexProfile(),
			pendingEmbedJobs: pending + pendingClientVectors,
			pendingClientVectors,
			embedFailed,
			pendingEmbedTextMaxAgeMs: oldest != null ? Date.now() - oldest : 0,
			pruneRemaining: this.pruneQueueSize(),
			// Vectorize deletions owed for removed chunks — should drain to 0 within
			// seconds of a prune; stuck > 0 means the flush is failing (Vectorize
			// trouble) and ghost vectors are accumulating.
			pendingVectorDeletes: this.vectorDeleteQueueSize(),
		};
	}

	private currentIndexProfile(): IndexProfile {
		const value = this.metaGet('indexProfile');
		return isIndexProfile(value) ? value : 'standard';
	}

	/** Debug-only: proves no plaintext is stored for a chunk id without leaking
	 *  it — `rows` = legacy chunk_text rows, `r2` = whether R2 holds the content
	 *  (the new full-mode home). Both must be 0 in vectors-only mode. */
	private async debugTextRows(body: { id: string }): Promise<unknown> {
		const n = this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM chunk_text WHERE id = ?', body.id).one().n;
		const row = this.sql().exec<{ cas_key: string }>('SELECT cas_key FROM chunks WHERE id = ?', body.id).toArray()[0];
		let r2 = 0;
		if (row) {
			const obj = await this.env.BLOBS.head(blobKey(this.metaGet('workspaceId') ?? '', row.cas_key));
			if (obj) r2 = 1;
		}
		return { rows: n, r2 };
	}

	/** Debug-only: symbol_edges row count, total or scoped to one chunk id.
	 *  Used by graph tests to assert edges are written/removed. Count only. */
	private debugEdgeCount(body: { chunkId?: string }): unknown {
		if (body?.chunkId) {
			const n = this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM symbol_edges WHERE chunk_id = ?', body.chunkId).one().n;
			return { edges: n };
		}
		const n = this.sql().exec<{ n: number }>('SELECT COUNT(*) AS n FROM symbol_edges').one().n;
		return { edges: n };
	}
}

function toEmbedShape(c: WireChunk): EmbedTextChunk {
	return { file: c.file, name: c.name, content: c.content ?? '', parentId: c.parentId };
}

function rowToCandidate(r: any): FusionCandidate {
	return {
		id: r.id, casKey: r.cas_key ?? '', file: r.file,
		startLine: r.start_line ?? 0, endLine: r.end_line ?? 0,
		kind: r.kind ?? 'block', name: r.name ?? '', language: r.language ?? 'plaintext',
		parentId: r.parent_id ?? undefined, scored: !!r.scored,
		defines: r.defines ? JSON.parse(r.defines) : undefined,
		refs: r.refs ? JSON.parse(r.refs) : undefined,
		lspDefines: r.lsp_defines ? JSON.parse(r.lsp_defines) : undefined,
		lspRefs: r.lsp_refs ? JSON.parse(r.lsp_refs) : undefined,
	};
}

function chunked<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** R2 key for a chunk's content: namespaced per workspace (tenant isolation),
 *  content-addressed by casKey so unchanged content stores once. */
function blobKey(workspaceId: string, casKey: string): string {
	return `${workspaceId || '_'}/${casKey}`;
}

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}
