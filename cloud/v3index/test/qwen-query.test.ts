import { describe, expect, it } from 'vitest';
import { formatQwen3Query } from '../src/embed/embedder.js';

describe('Qwen3 cloud query formatting', () => {
	it('matches the editor query instruction exactly', () => {
		expect(formatQwen3Query('find the billing retry path')).toBe(
			'Instruct: Given a code search query, retrieve the most relevant code passages\nQuery: find the billing retry path',
		);
	});

	it('caps query text at the editor limit', () => {
		const formatted = formatQwen3Query('x'.repeat(5_000));
		expect(formatted.endsWith('x'.repeat(4_000))).toBe(true);
		expect(formatted.endsWith('x'.repeat(4_001))).toBe(false);
	});
});
