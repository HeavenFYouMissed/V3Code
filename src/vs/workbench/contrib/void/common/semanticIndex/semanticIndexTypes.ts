/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

// ---------------------------------------------------------------------------
// Chunk shapes
// ---------------------------------------------------------------------------

export type ChunkKind =
	| 'function'
	| 'class'
	| 'method'
	| 'interface'
	| 'type'
	| 'enum'
	| 'file'
	| 'block';

export interface Chunk {
	/** sha256(file + ':' + startLine + ':' + endLine) — stable across edits if location is unchanged. */
	id: string;
	/** Workspace-relative POSIX path. Never absolute, never backslash. */
	file: string;
	/** 1-indexed, inclusive. */
	startLine: number;
	/** 1-indexed, inclusive. */
	endLine: number;
	kind: ChunkKind;
	/** Symbol name (e.g. function/class identifier) or filename for kind:'file'. */
	name: string;
	/** Language id matching VS Code's languageId conventions. */
	language: string;
	/** Hash of the exact chunk content — drives incremental skip and hydration verification. */
	contentHash: string;
}

/**
 * A structural unit (function/class/method/type) within a single file, as
 * extracted by the tree-sitter chunker. Returned by getLocalScope(); powers
 * the active-subsystem symbol skeleton injected at chat invocation and
 * autocomplete Engine 1. `content` is the full source of the unit.
 */
export interface LocalScopeUnit {
	name: string;
	kind: ChunkKind;
	startLine: number;
	endLine: number;
	content: string;
}

// ---------------------------------------------------------------------------
// Retrieval shapes
// ---------------------------------------------------------------------------

export interface Hit {
	chunk: Chunk;
	/** Hydrated from chunk_text. May be elided for transport — call retrieve() for full text. */
	content: string;
	/** Post-RRF score (higher = better). */
	score: number;
	/** Per-channel raw signals for debugging / UI. */
	signals: {
		/** Exact raw-query match in the chunk name, body, or path. Higher values
		 *  mean a stronger match class; used by the local exact-text lane. */
		exact?: number;
		vec?: number;
		fts?: number;
		hyde?: number;
		terms?: number;
		/** 1 when this hit's content is the enclosing PARENT block of a matched child chunk. */
		parent?: number;
		/** 1 when the underlying match was a precise CHILD (sub-statement) chunk. */
		child?: number;
		/** 1 when this hit was pulled in by dependency-graph neighbor expansion
		 *  (a caller of, or a definition referenced by, a primary hit) rather than
		 *  by direct lexical/vector match. */
		neighbor?: number;
		/** 0-10 relevance from the optional LLM rerank pass (llmRerank). Present only
		 *  when semantic_search was called with rerank enabled and the pass succeeded. */
		rerank?: number;
		/** Cross-encoder score from the local Qwen3 reranker (order-only semantics —
		 *  see llamaReranker.ts range-bug note). Present when the local stage ran. */
		xenc?: number;
		/** Propagated graph score from query-matched seeds (Aider-style one-hop). */
		graphBoost?: number;
		/** 1 when this primary hit sits below the adaptive score knee (likely noise). */
		weak?: number;
		/** Best (1-based) rank this hit's chunk earned in the beast sidecar's
		 *  trigram channel. Present only when beast fusion ran for the query. */
		beast?: number;
		/** Present when this result participated in the editor's live local overlay. */
		local?: number;
		/** Present when this result participated in the hosted shared base index. */
		cloud?: number;
	};
}

export interface QueryExpansion {
	original: string;
	/** Symbol-ish terms surfaced from the prompt — fed straight to FTS5. */
	codeTerms: string[];
	/** HyDE-style hallucinated code snippet that would answer the prompt. */
	hypotheticalCode: string;
	/** Rephrased variations of the prompt. */
	alternatives: string[];
}

// ---------------------------------------------------------------------------
// Index lifecycle
// ---------------------------------------------------------------------------

export type IndexState =
	| 'uninitialized'
	| 'idle'
	| 'walking'
	| 'chunking'
	| 'embedding'
	| 'ready'
	| 'error';

export interface IndexStatus {
	state: IndexState;
	filesTotal: number;
	filesIndexed: number;
	chunksTotal: number;
	lastError?: string;
	/** ms since epoch of last full index completion. */
	lastIndexedAt?: number;
	/** Active embedding model id (e.g. 'jina-embeddings-v2-base-code'). */
	modelId?: string;
	/** Embedding dimension currently in `chunk_vec`. */
	embeddingDim?: number;
	/** Rolling average files processed per second during an active rebuild. */
	filesPerSecond?: number;
	/** Estimated seconds remaining for the active rebuild. */
	etaSeconds?: number;
	/** Path of the file currently being processed (for the meter detail line). */
	currentFile?: string;
	/** Total bytes processed in the active run — used to compute throughput. */
	bytesProcessed?: number;
	/** Files skipped because content hash matched the previous index (Merkle incremental). */
	filesSkipped?: number;
	/** Chunks embedded so far during the background embedding phase. Distinct from
	 *  file counts — surfaced separately so the meter never mislabels chunks as "files". */
	embeddedChunks?: number;
	/** Total chunks that need embeddings in the current background phase. */
	chunksToEmbed?: number;
	/** True while a slow-model (Qwen3) backfill runs BEHIND a complete fast-space
	 *  index: state stays 'ready' (search fully works via dual-space retrieval)
	 *  and the embed counters describe the quality upgrade, not availability. */
	backgroundUpgrade?: boolean;
	/** Localized, short reason the index decided to rebuild ITSELF (e.g. language
	 *  support changed). Set only for self-healing rebuilds the user did not ask
	 *  for, so they are never silent; cleared when that rebuild finishes. */
	rebuildReason?: string;
	/** Sources the latest reconciliation could not safely refresh. Existing verified
	 * content is preserved and a bounded retry is scheduled. */
	staleSources?: number;
	/** Workspace documentation files (.md/.mdx/.rst/.adoc/.txt) currently in
	 * the same local hybrid index as code. */
	documentationFiles?: number;
}

// ---------------------------------------------------------------------------
// Service decorator
// ---------------------------------------------------------------------------

export interface ISemanticIndexService {
	readonly _serviceBrand: undefined;

	readonly status: IndexStatus;
	readonly onDidChangeStatus: Event<IndexStatus>;

	/** Trigger a full re-walk. Resolves when indexing finishes (or rejects on error). */
	rebuild(): Promise<void>;

	/** Issue a semantic query. Returns up to topK hits (default 30). */
	retrieve(prompt: string, opts?: {
		topK?: number; files?: string[]; quickPath?: boolean;
		/** Opt-in local cross-encoder rerank of the fused head. Never throws — on
		 *  timeout/failure the fused order is returned unchanged. Callers with a
		 *  tight latency budget pass { budgetMs }; default suits agent-tool calls. */
		rerank?: boolean | { budgetMs?: number };
	}): Promise<Hit[]>;

	getStatus(): IndexStatus;

	/**
	 * The file's structural units (functions/classes/methods/types), sorted by
	 * line. Synchronous, in-memory, no embedding round-trip. Empty array if the
	 * file isn't indexed yet. `kind:'block'` units are excluded.
	 */
	getLocalScope(file: string): LocalScopeUnit[];

	/**
	 * Files connected to `file` via the (text-derived) dependency graph, ranked
	 * by edge count. Used to widen the symbol skeleton to the active subsystem.
	 */
	getRelatedFiles(file: string, max?: number): string[];
}

export const ISemanticIndexService = createDecorator<ISemanticIndexService>('semanticIndexService');
