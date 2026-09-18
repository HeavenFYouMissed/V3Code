/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Embedder IDENTITY vs embedder MODEL.
 *
 * Persisted vectors are only reusable when BOTH the model that produced them
 * and the EMBED-TEXT SCHEME (what text was fed to that model) match the live
 * pipeline. Contextual chunk headers (embedText.ts) changed the embed text
 * without changing chunk content — so contentHash, PERSIST_VERSION and the
 * CAS keys are all still valid, and the only thing that must invalidate is
 * the VECTORS. The cheap lever for that is salting the embedder identity:
 * every site that compares or persists a modelId for vector reuse goes
 * through {@link effectiveEmbedIdentity}, so headerless vectors (persisted
 * under the raw model id) mismatch once and re-embed via the normal backfill,
 * while chunks/tokens/CAS structure survive untouched.
 *
 * Do NOT use this for stores whose text is embedded raw (memory facts) — the
 * salt describes the CHUNK embed-text scheme only.
 */

/**
 * Bump whenever the chunk embed-text scheme changes.
 *   hdr1 — '// {relative path} :: {parent} :: {name}' header
 *   hdr2 — file segment truncated to its BASENAME (path prefix diluted
 *          mean-pooled potion vectors; see embedText.ts + scripts/retrieval-eval)
 */
export const EMBED_TEXT_SCHEME = 'hdr2';

const SCHEME_SUFFIX = `+${EMBED_TEXT_SCHEME}`;

/**
 * Effective identity of the chunk-embedding pipeline for a given model id.
 * Pure + idempotent: applying it to an already-salted id (e.g. one read back
 * from a manifest written by this version) is a no-op, and the empty id
 * (embedder not resolved yet / lexical-only) stays empty.
 */
export function effectiveEmbedIdentity(modelId: string): string {
	if (!modelId) return modelId;
	if (modelId.endsWith(SCHEME_SUFFIX)) return modelId;
	return modelId + SCHEME_SUFFIX;
}
