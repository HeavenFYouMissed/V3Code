/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Contextual chunk headers — EMBED-TEXT ONLY (Anthropic "contextual retrieval",
 * pared down to what a local pipeline can afford).
 *
 * A chunk embedded in isolation loses where it lives: `for (const f of files)`
 * inside `walkWorkspace` in `browser/semanticIndexBrowserImpl.ts` embeds the
 * same as the identical loop anywhere else. Prepending a single header line
 *
 *   // {file BASENAME} :: {parent name} :: {chunk name}
 *
 * to the text fed to the EMBEDDER (and only there) lets the vector carry the
 * chunk's location and enclosing symbol, which is what natural-language
 * queries actually mention ("the workspace walk in the semantic index").
 *
 * Why the basename and not the relative path (scheme 'hdr2', measured with
 * scripts/retrieval-eval on this repo, potion-code-16M, 100 queries):
 * potion MEAN-POOLS token vectors, so the long path prefix most chunks share
 * (src/vs/workbench/contrib/...) homogenizes vectors and was a net regression
 * (Recall@5 20.7%→19.9%, MRR 0.252→0.229). The basename keeps the location
 * signal without the shared-prefix dilution: Recall@5 20.7%→22.4%, R@5 wins
 * 7 / losses 3 per query. Dropping the file segment entirely scored worse
 * than the basename, and intermediate path lengths (last 2–3 segments) sat
 * between basename and full path — monotone in prefix length.
 *
 * Boundaries, deliberately:
 *   • Stored/displayed `content` is untouched — persistence, contentHash,
 *     FTS and context injection all keep the raw text.
 *   • QUERIES stay raw (contextual-retrieval convention: documents get
 *     context, queries do not).
 *   • Parent is resolved ONE hop via `chunksMap.get(chunk.parentId)` — the
 *     chunker's hierarchy is at most file → parent → child.
 *   • Header survives EMBED_MAX_CHARS truncation because it is a prefix.
 *
 * Vector invalidation for the scheme change is handled by salting the
 * embedder identity — see common/semanticIndex/embedIdentity.ts.
 */

/** Minimal structural shape (IndexedChunk satisfies it) so tests and the
 *  offline eval harness can call this with plain objects. */
export interface EmbedTextChunk {
	file: string;
	name: string;
	content: string;
	parentId?: string;
}

/** Anything with a Map-like `get` over chunk ids (e.g. Map<string, IndexedChunk>). */
export interface EmbedTextChunkLookup {
	get(id: string): EmbedTextChunk | undefined;
}

/**
 * Text to feed the embedder for `chunk`. Pure: never mutates the chunk.
 * Empty header segments (anonymous chunks, missing parents) are elided; if
 * every segment is empty the body is returned unchanged (no bare `//` line).
 */
export function embedTextFor(chunk: EmbedTextChunk, chunksMap: EmbedTextChunkLookup): string {
	const body = chunk.content || chunk.name;
	const parent = chunk.parentId ? chunksMap.get(chunk.parentId) : undefined;
	// Basename only — the shared directory prefix dilutes mean-pooled vectors
	// (see header comment). chunk.file is workspace-relative, '/'-separated.
	const fileBase = chunk.file.slice(chunk.file.lastIndexOf('/') + 1);
	const segments: string[] = [];
	for (const seg of [fileBase, parent?.name ?? '', chunk.name]) {
		const s = seg.trim();
		if (s) segments.push(s);
	}
	if (segments.length === 0) return body;
	return `// ${segments.join(' :: ')}\n${body}`;
}
