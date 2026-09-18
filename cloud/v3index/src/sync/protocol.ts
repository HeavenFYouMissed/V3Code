/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  V3Index wire protocol — shared by the service, the editor client, and CI ingesters.
 *  Content-addressed: sync is a set-difference over CAS keys, never a re-upload.
 *--------------------------------------------------------------------------------------*/

/** Chunk record as it crosses the wire. Field-for-field compatible with the
 *  editor's IndexedChunk persisted subset (see docs/PORTING.md). `content` is
 *  present only for workspaces in `full` privacy mode. */
export interface WireChunk {
	/** Stable id — hash of `${file}:${startLine}:${endLine}` (editor parity). */
	id: string;
	/** Content hash of the chunk text — the CAS key. */
	casKey: string;
	file: string;
	startLine: number;
	endLine: number;
	kind: string;
	name: string;
	language: string;
	parentId?: string;
	/** Symbols this chunk defines / references (text layer). */
	defines?: string[];
	refs?: string[];
	/** LSP-verified edges (editor enricher) — inline alternative to /graph/lsp-edges. */
	lspDefines?: string[];
	lspRefs?: string[];
	/** Whether the chunk participates in scoring (mirrors editor `scored`). */
	scored: boolean;
	/** Chunk text — retained in `full`, transient until embedding in `ephemeral`,
	 * and forbidden in `vectors-only`. */
	content?: string;
	/** Pre-tokenized lexical tokens. Required in `vectors-only` mode (server
	 *  never sees text, so the client tokenizes); optional in `full` mode
	 *  (server can derive from content). */
	tokens?: string[];
	/** Dynamic-range int8 vector produced locally by Qwen3-Embedding-0.6B over
	 * the hdr2-enriched chunk text. The signed bytes are base64 encoded. */
	vectorQ8?: string;
	vectorScale?: number;
	vectorSpace?: 'qwen3-embedding-0.6b+hdr2';
}

export interface SyncBeginRequest {
	/** file → contentHash manifest of the client's current tree (Merkle-style diff input). */
	files: Record<string, string>;
	/** Embedder identity the client expects (model + embed-text scheme salt). */
	embedIdentity: string;
	/** SHA-256 over the canonical sorted file/hash entries. Promoted on done:true. */
	manifestRoot?: string;
}

export interface SyncBeginResponse {
	syncId: string;
	/** Files whose hash differs (or are new) — client should send their chunks. */
	changedFiles: string[];
	/** Files the server has that the client manifest no longer contains — will be pruned. */
	removedFiles: string[];
	/** Of the changed files' chunks, CAS keys the server already holds (skip upload). */
	knownCasKeys: string[];
}

/** Cross-runtime snapshot identity used by the editor and independently
 * verified by the Worker before it records a completed manifest. */
export async function computeManifestRoot(files: Readonly<Record<string, string>>): Promise<string> {
	const canonical = JSON.stringify(Object.keys(files).sort().map(file => [file, files[file]]));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface ChunkUploadRequest {
	syncId: string;
	chunks: WireChunk[];
	/** For each file touched in this batch, the COMPLETE current set of chunk ids.
	 *  Lets the server delete the file's DEPARTED chunks (deleted functions,
	 *  line-shifted old positions — id = hash(file:start:end)) that a plain upsert
	 *  never removes. Optional: an older client that omits it keeps the pre-fix
	 *  behaviour (stale rows linger). */
	fileChunkIds?: Record<string, string[]>;
	/** True on the final batch — server finalizes the manifest and prunes. */
	done: boolean;
}

/** /chunks/check request. `have` (id-aware) is preferred: the server returns the
 *  ids it already holds UNCHANGED so the client skips only truly-redundant
 *  uploads — a relocated chunk (new id, same content) is NOT skipped. `casKeys`
 *  is the legacy shape (skips by content hash alone, which drops relocated
 *  chunks); kept for back-compat. */
export interface ChunksCheckRequest {
	have?: Array<{ id: string; casKey: string; wantsVector?: boolean }>;
	casKeys?: string[];
}

export interface RecentEditsSignal {
	/** file → rank (0 = most recent). Feeds the recency boost, editor parity. */
	ranks: Record<string, number>;
}

export interface LspEdgesUpload {
	/** Per-file verified symbol edges from the editor's LSP enricher. */
	files: Array<{
		file: string;
		defines: Array<{ symbol: string; chunkId: string }>;
		refs: Array<{ symbol: string; chunkId: string }>;
	}>;
}

export interface RetrieveRequest {
	query: string;
	topK?: number;
	/** Restrict to these files (agent-scoped searches). */
	files?: string[];
}

export interface RetrieveHit {
	chunkId: string;
	casKey: string;
	file: string;
	startLine: number;
	endLine: number;
	kind: string;
	name: string;
	score: number;
	/** Populated in `full` mode only; `vectors-only` clients hydrate locally by casKey. */
	snippet?: string;
	/** Which channels contributed (debuggability + eval parity). */
	signals: { lexical?: number; vector?: number; graph?: number; recency?: number };
}

export interface RetrieveResponse {
	hits: RetrieveHit[];
	/** Vector coverage 0..1 — retrieval is lexical-complete before embed backfill finishes. */
	vectorCoverage: number;
	tookMs: number;
}

export interface WorkspaceStatus {
	files: number;
	chunks: number;
	vectors: number;
	vectorCoverage: number;
	embedIdentity: string;
	privacyMode: 'full' | 'vectors-only' | 'ephemeral';
	indexProfile?: 'standard' | 'advanced';
	pendingEmbedJobs: number;
	/** Locally generated, source-free vectors durably staged for Vectorize. */
	pendingClientVectors?: number;
	/** Chunks whose embed job was abandoned (DLQ'd or recovery text gone) and
	 *  still carry no vector — explains a stuck vectorCoverage < 1. */
	embedFailed?: number;
	/** Age (ms) of the oldest pending_embed_text row — ops signal for a stuck
	 *  embed backlog. Advanced expires abandoned text after one hour and forces
	 *  a file retry; legacy full mode retains its seven-day recovery window. */
	pendingEmbedTextMaxAgeMs?: number;
	/** Files still queued for background prune after a completed sync. */
	pruneRemaining?: number;
	/** Vectorize deletions owed for removed chunks. Drains to 0 within seconds of
	 *  a prune; stuck > 0 means the flush is failing and ghost vectors are
	 *  accumulating in the shared index. */
	pendingVectorDeletes?: number;
}
