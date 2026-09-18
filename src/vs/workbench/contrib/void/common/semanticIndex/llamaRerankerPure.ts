/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Browser-safe rerank helpers (no Node builtins). Main-process engine: llamaReranker.ts */

import type { Hit } from './semanticIndexTypes.js';

export const QWEN3_RERANK_MODEL = {
	id: 'giladgd/Qwen3-Reranker-0.6B-GGUF@Q8_0',
	uri: 'hf:giladgd/Qwen3-Reranker-0.6B-GGUF:Q8_0',
	filename: 'Qwen3-Reranker-0.6B.Q8_0.gguf',
	/** What node-llama-cpp's downloader actually writes for `uri` (hf_<org>_<file>.<quant>). */
	downloadedFilename: 'hf_giladgd_Qwen3-Reranker-0.6B.Q8_0.gguf',
	approxBytes: 639_153_376,
} as const;

/** Per-document cap keeps one rank eval well under the context ceiling. */
export const RERANK_DOC_CHARS = 600;
/** Rerank only the head — beyond ~16 candidates latency grows and precision gains vanish. */
export const RERANK_MAX_CANDIDATES = 16;

export function buildRerankDoc(hit: Pick<Hit, 'chunk' | 'content'>): string {
	const body = (hit.content ?? '').replace(/\s+/g, ' ').slice(0, RERANK_DOC_CHARS);
	return `${hit.chunk.file} :: ${hit.chunk.name ?? ''}\n${body}`;
}

/**
 * Pure reorder: applies cross-encoder scores to the head (first `scores.length`
 * hits), stably sorting it by score desc, leaving the tail untouched behind it.
 *
 * `protectHead` pins the first N fused positions in place (the cross-encoder may
 * not demote them; the rest of the head still reranks normally). 0 = pure rerank,
 * which is the DEFAULT and the measured best configuration.
 *
 * MEASURED, golden-vselite-v2 (35 queries, potion, --max-files 800):
 *   pure rerank          R@5 85.7%  MRR 0.5838  nDCG 0.5534   (vs fused 74.3/0.5305/0.5070)
 *   protectHead 1        R@5 85.7%  MRR 0.5590  nDCG 0.5180
 *   protectHead 2        R@5 82.9%  MRR 0.5412  nDCG 0.5100
 * A blanket pin LOSES: it restores the 5 answers fusion already had at rank 1, but
 * reverts 14 promotions the cross-encoder got right (mostly 1->2), so it costs
 * more than it saves. Kept as an off-by-default knob because the trade depends on
 * the reranker model and goldset, and re-measuring it is one flag.
 *
 * `protectMinLead` narrows the pin to CONFIDENT fused winners — pin only when
 * hits[0].score >= protectMinLead * hits[1].score. Undefined = pin whenever
 * protectHead > 0 (the blanket behavior above).
 */
export function applyRerankOrder(hits: Hit[], scores: number[], options?: { protectHead?: number; protectMinLead?: number }): Hit[] {
	const head = hits.slice(0, scores.length);
	const tail = hits.slice(scores.length);
	const requested = Math.max(0, Math.min(Math.floor(options?.protectHead ?? 0), head.length));
	const minLead = options?.protectMinLead;
	let protect = requested;
	if (requested > 0 && minLead !== undefined) {
		const top = head[0]?.score ?? 0;
		const next = head[1]?.score ?? 0;
		protect = next <= 0 ? (top > 0 ? requested : 0) : (top / next >= minLead ? requested : 0);
	}
	const entries = head.map((h, i) => ({ h, i, s: scores[i] ?? 0 }));
	const pinned = entries.slice(0, protect);
	const reranked = entries.slice(protect);
	reranked.sort((a, b) => (b.s - a.s) || (a.i - b.i));
	const ordered = [...pinned, ...reranked];
	for (const { h, s } of ordered) {
		h.signals = { ...(h.signals ?? {}), xenc: s };
	}
	return [...ordered.map(x => x.h), ...tail];
}
