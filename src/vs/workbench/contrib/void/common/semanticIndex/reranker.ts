/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * LLM reranker for hybrid retrieval (the "Continue insight", ported native).
 *
 * Our hybrid retriever fuses lexical + vector channels with weighted RRF — a
 * STATISTICAL merge. A rerank pass adds SEMANTIC judgement on top: a cheap model
 * scores each candidate's true relevance to the query, and we reorder by that.
 * It is the single biggest quality lever in retrieval.
 *
 * DESIGN GUARANTEES (this is wired into the core search path, so it must be safe):
 *   1. PURE + DECOUPLED — takes a `send` callback, depends on no service. Testable
 *      in isolation.
 *   2. NEVER THROWS — every failure mode (timeout, bad JSON, model error, length
 *      mismatch) falls back to the ORIGINAL hit order. Reranking can never make
 *      retrieval WORSE than it is today; worst case it's a no-op + a little latency.
 *   3. OPT-IN — callers pass rerank explicitly. The default search path (incl. the
 *      auto-context hot path injected every chat turn) does NOT rerank, so there is
 *      zero added latency unless asked for.
 */

import { Hit } from './semanticIndexTypes.js';

/** Returns the model's raw text for a single prompt. Implementations should apply
 *  their own timeout; the reranker adds a second guard on top regardless. */
export type RerankSendFn = (prompt: string) => Promise<string>;

export interface RerankOptions {
	/** Keep only the top-N after reranking. Default: keep all input hits. */
	topN?: number;
	/** Hard timeout for the model call. Default 8000ms. On timeout → input order. */
	timeoutMs?: number;
	/** Max chars of each chunk's content shown to the reranker. Default 600. */
	maxCharsPerHit?: number;
	/** Max candidates to send to the model (protects token budget). Default 24. */
	maxCandidates?: number;
	/** Optional diagnostic sink. Called exactly once with a short status string
	 *  describing the outcome ("scored:N", "fallback:timeout", "fallback:parse",
	 *  "fallback:error", "fallback:trivial"). Never affects behavior — purely for
	 *  observability so callers can surface WHY a rerank did or didn't reorder. */
	diag?: (status: string) => void;
}

const DEFAULTS = { timeoutMs: 8000, maxCharsPerHit: 600, maxCandidates: 24 };

/**
 * Rerank `hits` against `query` using an LLM. NEVER throws — on any failure
 * returns the input hits (optionally sliced to topN) in their original order.
 */
export async function llmRerank(
	query: string,
	hits: Hit[],
	send: RerankSendFn,
	opts: RerankOptions = {},
): Promise<Hit[]> {
	const topN = opts.topN;
	const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
	const maxChars = opts.maxCharsPerHit ?? DEFAULTS.maxCharsPerHit;
	const maxCand = opts.maxCandidates ?? DEFAULTS.maxCandidates;

	const diag = opts.diag ?? (() => { });
	const fallback = (reason: string) => { diag(reason); return topN ? hits.slice(0, topN) : hits; };

	// Nothing to do / not worth a round-trip.
	if (!Array.isArray(hits) || hits.length <= 1) return fallback('fallback:trivial');

	// Only rerank the top slice the model can reason about; anything past maxCand
	// keeps its existing order appended after the reranked head.
	const head = hits.slice(0, maxCand);
	const tail = hits.slice(maxCand);

	try {
		const prompt = buildPrompt(query, head, maxChars);
		const raw = await withTimeout(send(prompt), timeoutMs);
		const scores = parseScores(raw, head.length);
		if (!scores) return fallback('fallback:parse');

		// Stable sort head by score desc; unscored items sink but keep relative order.
		const order = head
			.map((hit, i) => ({ hit, i, s: scores[i] ?? -1 }))
			.sort((a, b) => b.s - a.s || a.i - b.i);

		const reranked: Hit[] = order.map(({ hit, s }) =>
			s >= 0 ? { ...hit, signals: { ...hit.signals, rerank: s } } : hit,
		);

		const scoredCount = order.filter(o => o.s >= 0).length;
		diag(`scored:${scoredCount}`);
		const merged = reranked.concat(tail);
		return topN ? merged.slice(0, topN) : merged;
	} catch (e) {
		// Any failure whatsoever → original order. The whole point of the reranker
		// is that it can only ever help; it must be impossible for it to break search.
		// Surface the REAL provider message (not just the category) so the silent
		// fallback stops hiding *why* scoring failed — e.g. a 400 model/param error.
		const rawMsg = e instanceof Error ? e.message : String(e);
		if (rawMsg === 'rerank timeout') return fallback('fallback:timeout');
		return fallback(`fallback:error:${rawMsg.slice(0, 200)}`);
	}
}

/** Build the scoring prompt: query + a numbered, truncated candidate list. */
function buildPrompt(query: string, hits: Hit[], maxChars: number): string {
	const lines: string[] = [];
	for (let i = 0; i < hits.length; i++) {
		const h = hits[i];
		const c = h.chunk;
		const body = (h.content || c.name || '').slice(0, maxChars).replace(/\s+/g, ' ').trim();
		lines.push(`[${i}] ${c.file} :: ${c.name || c.kind}\n${body}`);
	}
	return [
		'You are a precise code-search reranker. Score how well each CANDIDATE answers the QUERY.',
		'Score each candidate from 0 (irrelevant) to 10 (exactly answers the query).',
		'Return ONLY a compact JSON array of {"i":<index>,"s":<score>} for EVERY candidate index. No prose, no code fences.',
		'',
		`QUERY: ${query}`,
		'',
		'CANDIDATES:',
		lines.join('\n---\n'),
		'',
		'JSON:',
	].join('\n');
}

/**
 * Parse the model's reply into a dense score array of length `n`.
 * Accepts the canonical `[{"i":0,"s":7}, ...]` form, an `{"index","score"}`
 * variant, or a bare score array `[7,3,9,...]`. Returns null if it can't get a
 * usable mapping (caller then falls back to input order).
 */
export function parseScores(raw: string, n: number): (number | undefined)[] | null {
	if (typeof raw !== 'string' || n <= 0) return null;
	const start = raw.indexOf('[');
	const end = raw.lastIndexOf(']');
	if (start < 0 || end <= start) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return null;

	const out: (number | undefined)[] = new Array(n).fill(undefined);
	let any = false;

	// Bare score array: [7, 3, 9, ...]
	if (typeof parsed[0] === 'number') {
		for (let i = 0; i < parsed.length && i < n; i++) {
			const v = clampScore(parsed[i]);
			if (v !== undefined) { out[i] = v; any = true; }
		}
		return any ? out : null;
	}

	// Object array: [{i,s}] or [{index,score}]
	for (const item of parsed) {
		if (!item || typeof item !== 'object') continue;
		const o = item as Record<string, unknown>;
		const idx = pickNum(o.i, o.index, o.idx, o.id);
		const sc = clampScore(pickNum(o.s, o.score, o.relevance, o.rank));
		if (idx === undefined || sc === undefined) continue;
		const ii = Math.trunc(idx);
		if (ii < 0 || ii >= n) continue;
		out[ii] = sc;
		any = true;
	}
	return any ? out : null;
}

function pickNum(...vals: unknown[]): number | undefined {
	for (const v of vals) {
		if (typeof v === 'number' && Number.isFinite(v)) return v;
		if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
	}
	return undefined;
}

function clampScore(v: number | undefined): number | undefined {
	if (v === undefined || !Number.isFinite(v)) return undefined;
	return Math.max(0, Math.min(10, v));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('rerank timeout')), ms);
		p.then(
			v => { clearTimeout(t); resolve(v); },
			e => { clearTimeout(t); reject(e); },
		);
	});
}
