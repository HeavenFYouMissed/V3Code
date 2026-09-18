/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// allow-any-unicode-comment-file

/**
 * Shared shapes for the renderer-side semantic index modules.
 *
 * Kept in its own file so `quantizer`, `treeSitterChunker`, `dependencyGraph`,
 * `hybridRetriever`, and the orchestrator (`semanticIndexBrowserImpl`) can all
 * depend on these types without importing each other (avoids cycles).
 */

import { Chunk, ChunkKind } from '../../common/semanticIndex/semanticIndexTypes.js';

/**
 * In-memory chunk. Extends the transport `Chunk` with the renderer-only fields
 * the retriever and graph need.
 *
 * Every chunk keeps its own `content`: a CHILD needs its text to (re-)embed
 * during deferred backfill, while DISPLAY injection resolves a child up to its
 * enclosing PARENT block via `parentId` (not via content presence). `tokens` is
 * only populated for `scored` chunks (the ones that participate in retrieval).
 */
export interface IndexedChunk extends Chunk {
	/** Full text of the chunk. */
	content: string;
	/** Lexical tokens for the overlap channel, interned to sorted u32 ids via
	 *  tokenDict (Set<string> per chunk was the largest renderer-RAM consumer
	 *  at scale — audit #6). Empty for non-scored chunks. */
	tokens: Uint32Array;
	/** int8-quantized embedding (dynamic range — see quantizer.ts). */
	embedding?: Int8Array;
	/** Per-vector dequantization factor: original ≈ q[i] / 127 * vecScale. */
	vecScale?: number;
	/** PREVIOUS-model vector kept alive during a model-swap backfill so search
	 *  quality doesn't cliff for hours (dual-space retrieval). Cleared the moment
	 *  the chunk gets its new-model vector, and swept when the backfill completes. */
	prevEmbedding?: Int8Array;
	/** Dequantization factor for `prevEmbedding`. */
	prevVecScale?: number;
	/** Display parent: a CHILD chunk points at the enclosing function/method/class. */
	parentId?: string;
	/** Whether this chunk participates in retrieval scoring (i.e. is embedded). */
	scored: boolean;
	/** Symbol names this chunk defines (function/class/type identifiers). */
	defines?: string[];
	/** Symbol names this chunk references (callees + type usages). */
	refs?: string[];
	/** LSP-verified symbol names this chunk defines (documentSymbols) — real
	 *  edges layered on top of the text-derived `defines` by lspEdgeEnricher.ts.
	 *  Optional + additive: older persisted records simply lack these. */
	lspDefines?: string[];
	/** LSP-verified symbol names this chunk references (reference sites resolved
	 *  by getReferences / cross-file definitions). Same name semantics as `refs`. */
	lspRefs?: string[];
}

/**
 * A structural unit emitted by the chunker before the orchestrator hashes,
 * tokenizes, and embeds it. `parentLocalId` is the index (within the same
 * emitted array) of the DISPLAY parent — set only for child sub-statements.
 */
export interface ExtractedUnit {
	startLine: number;
	endLine: number;
	kind: ChunkKind;
	name: string;
	text: string;
	/** True ⇒ this unit gets an embedding and is scored at retrieval time. */
	scored: boolean;
	/** Index of the display parent unit (children only); undefined ⇒ displays itself. */
	parentLocalId?: number;
	defines: string[];
	refs: string[];
}
