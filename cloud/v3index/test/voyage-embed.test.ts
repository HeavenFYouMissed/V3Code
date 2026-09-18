import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedIdentityOf, embedQuery, embedTexts, embedTextsIsolated } from '../src/embed/embedder.js';
import type { Env } from '../src/env.js';

const voyageEnv = {
	VOYAGE_API_KEY: 'test-voyage-key',
	VOYAGE_MODEL: 'voyage-code-3',
	VOYAGE_DIM: '1024',
	EMBED_MODEL: '@cf/qwen/qwen3-embedding-0.6b',
	EMBED_DIM: '1024',
} as unknown as Env;

function unitVector(): number[] {
	return [1, ...new Array(1023).fill(0)];
}

afterEach(() => vi.restoreAllMocks());

describe('Voyage Advanced embedder', () => {
	it('uses a distinct scheme-salted identity', () => {
		expect(embedIdentityOf(voyageEnv, 'advanced')).toBe('voyage/voyage-code-3/dim1024+hdr2');
		expect(embedIdentityOf(voyageEnv, 'standard')).toBe('workers-ai/@cf/qwen/qwen3-embedding-0.6b+hdr2');
	});

	it('marks documents and queries explicitly and requests the isolated 1024-d space', async () => {
		const requests: Array<Record<string, unknown>> = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return Response.json({ data: [{ index: 0, embedding: unitVector() }] });
		});

		await embedTexts(voyageEnv, ['export function settleInvoice() {}'], 'advanced');
		await embedQuery(voyageEnv, 'where is invoice settlement', 'advanced');

		expect(requests.map(request => request.input_type)).toEqual(['document', 'query']);
		for (const request of requests) {
			expect(request.model).toBe('voyage-code-3');
			expect(request.output_dimension).toBe(1024);
			expect(request.output_dtype).toBe('float');
		}
	});

	it('does not echo provider response bodies into errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('source-derived-secret', { status: 429 }));
		await expect(embedTexts(voyageEnv, ['private source'], 'advanced')).rejects.toThrow('HTTP 429');
		await expect(embedTexts(voyageEnv, ['private source'], 'advanced')).rejects.not.toThrow('source-derived-secret');
	});

	it('lets the queue retry a systemic provider failure without per-item fanout', async () => {
		const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }));
		await expect(embedTextsIsolated(voyageEnv, [
			{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }, { id: 'c', text: 'three' },
		], 'advanced')).rejects.toThrow('HTTP 429');
		expect(request).toHaveBeenCalledTimes(1);
	});
});
