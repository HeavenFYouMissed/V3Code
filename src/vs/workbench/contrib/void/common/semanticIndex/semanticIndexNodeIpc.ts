/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Pure shapes + helpers shared by the node-backend IPC seam:
 *   electron-main/semanticIndexNodeChannel.ts  (engine host, main process)
 *   browser/semanticIndexNodeProxy.ts          (renderer proxy)
 *   browser/semanticIndexBrowserImpl.ts        (renderer orchestrator)
 *
 * Everything here is dependency-free pure logic so it can be unit-tested
 * without services (see test/common/semanticIndexNodePure.test.ts).
 */

import { Chunk, Hit } from './semanticIndexTypes.js';

// ---------------------------------------------------------------------------
// Command parameter shapes (channel `void-channel-semanticIndexNode`)
// ---------------------------------------------------------------------------

/** One chunk as mirrored from the renderer orchestrator to the node engine. */
export interface NodeIndexChunkInput {
	id: string;
	file: string;
	name: string;
	startLine: number;
	endLine: number;
	text: string;
	/** EMBEDDING-ONLY text (contextual chunk header + content, see
	 *  browser/semanticIndex/embedText.ts). FTS + stored chunk_text always use
	 *  the raw `text`; absent ⇒ the engine embeds `text` as before. */
	embedText?: string;
}

export interface NodeIndexOpenParams {
	dbPath: string;
	/** Embedder identity the RENDERER resolved (informational — the channel's own
	 *  embedder, resolved from `modelHint`, is authoritative when it loads). */
	modelId: string;
	dim: number;
	/** Same hint resolution as SemanticEmbedChannel ('auto' | 'qwen3-embed' | ...). */
	modelHint?: string;
	mirrorHost?: string;
}

export interface NodeIndexOpenResult {
	hasVec: boolean;
	embedderReady: boolean;
	modelId: string;
	dim: number;
	files: number;
	chunks: number;
}

export interface NodeIndexUpsertParams {
	dbPath: string;
	chunks: NodeIndexChunkInput[];
}

export interface NodeIndexRemoveFileParams {
	dbPath: string;
	file: string;
}

export interface NodeIndexRetrieveParams {
	dbPath: string;
	prompt: string;
	topK?: number;
	expanderMode?: 'heuristic' | 'local-llama' | 'chat-model';
}

export interface NodeIndexStatusParams {
	dbPath: string;
}

export interface NodeIndexStatusResult {
	files: number;
	chunks: number;
	hasVec: boolean;
	embedderReady: boolean;
	modelId: string;
	dim: number;
}

export interface NodeIndexDisposeParams {
	/** Close one engine; omit to close everything (incl. the channel embedder). */
	dbPath?: string;
}

/** Wire hit — structurally identical to the renderer Hit (no vectors cross IPC). */
export type NodeIndexHit = Hit;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Chunk texts longer than this are truncated before embedding (matches the
 *  renderer's EMBED_MAX_CHARS policy in semanticIndexBrowserImpl.ts). */
export const NODE_EMBED_MAX_CHARS = 8_000;

/** Chunks per `upsertChunks` IPC call from the renderer mirror queue. */
export const NODE_MIRROR_BATCH = 128;

/** Prefix-truncate a chunk text for embedding. */
export function capEmbedText(text: string, max: number = NODE_EMBED_MAX_CHARS): string {
	return text.length > max ? text.slice(0, max) : text;
}

/** Split `items` into consecutive batches of at most `batchSize` (>= 1). */
export function toBatches<T>(items: readonly T[], batchSize: number): T[][] {
	const size = Math.max(1, Math.floor(batchSize) || 1);
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size) as T[]);
	}
	return out;
}

/** Runtime guard for chunk inputs crossing IPC — the channel drops invalid rows
 *  instead of writing garbage into SQLite. */
export function isValidNodeChunkInput(c: unknown): c is NodeIndexChunkInput {
	const x = c as NodeIndexChunkInput | null | undefined;
	return !!x
		&& typeof x.id === 'string' && x.id.length > 0
		&& typeof x.file === 'string' && x.file.length > 0
		&& typeof x.name === 'string'
		&& Number.isInteger(x.startLine) && Number.isInteger(x.endLine)
		&& x.startLine >= 1 && x.endLine >= x.startLine
		&& typeof x.text === 'string'
		&& (x.embedText === undefined || typeof x.embedText === 'string');
}

/** A renderer-side chunk that can stand in for a wire chunk (IndexedChunk fits). */
export interface ResolvedChunkLike extends Chunk {
	content?: string;
}

/**
 * Map node-backend hits into the renderer Hit shape. Chunk metadata is resolved
 * from the renderer's in-memory map by id when present (richer: parentId,
 * tokens, live content); hits for unknown ids keep the engine's own chunk row
 * as a minimal synthetic chunk. Malformed rows are dropped.
 */
export function mapNodeHits(nodeHits: readonly NodeIndexHit[], resolveChunk: (id: string) => ResolvedChunkLike | undefined): Hit[] {
	const out: Hit[] = [];
	if (!Array.isArray(nodeHits)) return out;
	for (const h of nodeHits) {
		if (!h || !h.chunk || typeof h.chunk.id !== 'string' || !h.chunk.id) continue;
		const known = resolveChunk(h.chunk.id);
		out.push({
			chunk: known ?? h.chunk,
			content: h.content || known?.content || '',
			score: typeof h.score === 'number' ? h.score : 0,
			signals: h.signals ?? {},
		});
	}
	return out;
}
