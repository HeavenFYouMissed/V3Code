/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  Embedding via Workers AI. Default model `@cf/qwen/qwen3-embedding-0.6b`
 *  (1024-dim, same model family the V3Code editor runs locally as GGUF).
 *  Identity = effectiveEmbedIdentity(`workers-ai/${model}`) — scheme-salted so
 *  embed-text format changes invalidate exactly the vectors (editor parity).
 *--------------------------------------------------------------------------------------*/

import type { Env } from '../env.js';
import { effectiveEmbedIdentity } from '../core/embedIdentity.js';
import type { IndexProfile } from '../core/indexProfile.js';

const AI_BATCH = 32; // Workers AI accepts 100 texts/request, but 100 near-8k-char code chunks can blow the request's total-token cap (the original poison-batch trigger) — smaller batches keep the fast path viable for big-chunk workloads
const MAX_QUERY_CHARS = 4_000;
const VOYAGE_BATCH = 8;
const VOYAGE_MAX_CHARS = 32_000;
const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

export function embedIdentityOf(env: Env, profile: IndexProfile = 'standard'): string {
	if (profile === 'advanced') {
		return effectiveEmbedIdentity(`voyage/${env.VOYAGE_MODEL ?? 'voyage-code-3'}/dim${env.VOYAGE_DIM ?? '1024'}`);
	}
	return effectiveEmbedIdentity(`workers-ai/${env.EMBED_MODEL}`);
}

export async function embedTexts(env: Env, texts: string[], profile: IndexProfile = 'standard'): Promise<number[][]> {
	if (profile === 'advanced') return embedVoyage(env, texts, 'document');
	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += AI_BATCH) {
		const slice = texts.slice(i, i + AI_BATCH).map(sanitizeEmbedText);
		const res = (await env.AI.run(env.EMBED_MODEL as never, { text: slice } as never)) as unknown as { data: number[][] };
		if (!res?.data || res.data.length !== slice.length) {
			throw new Error(`embedder returned ${res?.data?.length ?? 0} vectors for ${slice.length} texts`);
		}
		out.push(...res.data.map(l2Normalize));
	}
	return out;
}

type VoyageEmbeddingResponse = {
	data?: Array<{ embedding?: number[]; index?: number }>;
	usage?: { total_tokens?: number };
};

class VoyageInputError extends Error { }

/** Voyage's retrieval API with explicit document/query intent. Code chunks are
 * truncated by the provider only as a final safety net; the local cap keeps
 * request bodies and token spend bounded before they leave Cloudflare. */
export async function embedVoyage(env: Env, texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
	const apiKey = env.VOYAGE_API_KEY;
	if (!apiKey) throw new Error('Advanced index is not configured: VOYAGE_API_KEY is missing');
	const model = env.VOYAGE_MODEL ?? 'voyage-code-3';
	const outputDimension = Number(env.VOYAGE_DIM ?? '1024');
	if (!Number.isInteger(outputDimension) || outputDimension <= 0) throw new Error('VOYAGE_DIM is invalid');

	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
		const input = texts.slice(i, i + VOYAGE_BATCH).map(sanitizeVoyageText);
		const response = await fetch(VOYAGE_ENDPOINT, {
			method: 'POST',
			headers: {
				'authorization': `Bearer ${apiKey}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				input,
				model,
				input_type: inputType,
				truncation: true,
				output_dimension: outputDimension,
				output_dtype: 'float',
			}),
		});
		if (!response.ok) {
			// Never include the response body: providers sometimes echo request
			// details, and embed inputs are source-derived plaintext.
			const message = `Voyage embeddings returned HTTP ${response.status}`;
			if (response.status === 400 || response.status === 422) throw new VoyageInputError(message);
			throw new Error(message);
		}
		const payload = await response.json<VoyageEmbeddingResponse>();
		const rows = payload.data?.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		if (!rows || rows.length !== input.length) {
			throw new Error(`Voyage returned ${rows?.length ?? 0} vectors for ${input.length} texts`);
		}
		for (const row of rows) {
			if (!Array.isArray(row.embedding) || row.embedding.length !== outputDimension || row.embedding.some(value => !Number.isFinite(value))) {
				throw new Error('Voyage returned an invalid embedding');
			}
			out.push(l2Normalize(row.embedding));
		}
		console.log(JSON.stringify({
			evt: 'voyage-embed',
			model,
			inputType,
			texts: input.length,
			tokens: payload.usage?.total_tokens ?? null,
		}));
	}
	return out;
}

/** Workers AI rejects (or silently drops from the response, breaking the
 *  count check) empty/whitespace-only inputs — the poison-batch failure mode
 *  that stranded 3.5k chunks in prod. Never send a blank; a lone '.' embeds
 *  to a harmless junk vector for a chunk that had no content anyway. */
function sanitizeEmbedText(t: string): string {
	const trimmed = t.length > 8000 ? t.slice(0, 8000) : t;
	return trimmed.trim().length === 0 ? '.' : trimmed;
}

function sanitizeVoyageText(text: string): string {
	const bounded = text.length > VOYAGE_MAX_CHARS ? text.slice(0, VOYAGE_MAX_CHARS) : text;
	return bounded.trim().length === 0 ? '.' : bounded;
}

/** Per-item isolation for the queue consumer: one poisonous text must not
 *  condemn its whole batch to retry→DLQ (the failure mode that repeatedly
 *  stranded requeued chunks). Fast path = one batched call; on ANY batch
 *  failure, fall back to embedding items one-by-one so exactly the bad ids
 *  come back as null and everything else still lands. */
export async function embedTextsIsolated(env: Env, items: Array<{ id: string; text: string }>, profile: IndexProfile = 'standard'): Promise<Array<{ id: string; vector: number[] | null }>> {
	try {
		const vectors = await embedTexts(env, items.map(i => i.text), profile);
		return items.map((it, i) => ({ id: it.id, vector: vectors[i] ?? null }));
	} catch (error) {
		// A provider outage, rate limit, or bad credential affects every item.
		// Let the queue retry the batch instead of turning one 429/500 into up to
		// 80 immediate API calls. Only a 400/422 may be one poisonous input and is
		// worth isolating item-by-item.
		if (profile === 'advanced' && !(error instanceof VoyageInputError)) throw error;
		const out: Array<{ id: string; vector: number[] | null }> = [];
		for (const it of items) {
			try {
				const [v] = await embedTexts(env, [it.text], profile);
				out.push({ id: it.id, vector: v ?? null });
			} catch {
				out.push({ id: it.id, vector: null });
			}
		}
		return out;
	}
}

export async function embedQuery(env: Env, query: string, profile: IndexProfile = 'standard'): Promise<number[]> {
	if (profile === 'advanced') {
		const [vector] = await embedVoyage(env, [query], 'query');
		return vector!;
	}
	const input = /qwen3-embedding/i.test(env.EMBED_MODEL) ? formatQwen3Query(query) : query;
	const [v] = await embedTexts(env, [input], profile);
	return v!;
}

/** Qwen3 requires a task instruction on queries (documents stay raw). Keep
 * byte-for-byte parity with the editor and the measured retrieval harness. */
export function formatQwen3Query(query: string): string {
	const text = query.length > MAX_QUERY_CHARS ? query.slice(0, MAX_QUERY_CHARS) : query;
	return `Instruct: Given a code search query, retrieve the most relevant code passages\nQuery: ${text}`;
}

/** Qwen3-family embeddings need explicit L2 normalization (editor parity —
 *  llamaEmbedder.ts does the same); harmless for already-normalized models. */
function l2Normalize(v: number[]): number[] {
	let norm = 0;
	for (const x of v) norm += x * x;
	norm = Math.sqrt(norm);
	if (norm === 0) return v;
	return v.map(x => x / norm);
}
