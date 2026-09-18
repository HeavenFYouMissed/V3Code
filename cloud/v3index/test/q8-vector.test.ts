import { describe, expect, it } from 'vitest';
import { decodeQ8Vector, isQwen3CodeVectorIdentity } from '../src/core/q8Vector.js';

function base64(bytes: number[]): string {
	return btoa(String.fromCharCode(...bytes.map(value => value & 0xff)));
}

describe('source-free q8 vectors', () => {
	it('accepts only the Qwen3 0.6B hdr2 vector space', () => {
		expect(isQwen3CodeVectorIdentity('workers-ai/@cf/qwen/qwen3-embedding-0.6b+hdr2')).toBe(true);
		expect(isQwen3CodeVectorIdentity('workers-ai/@cf/qwen/qwen3-embedding-0.6b+hdr1')).toBe(false);
		expect(isQwen3CodeVectorIdentity('potion-base-8M+hdr2')).toBe(false);
	});

	it('dequantizes signed bytes and L2 normalizes for Vectorize', () => {
		const values = decodeQ8Vector(base64([127, -127, 64, 0]), 0.25, 4);
		expect(values[0]).toBeGreaterThan(0);
		expect(values[1]).toBeLessThan(0);
		expect(values[2]).toBeGreaterThan(0);
		expect(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 8);
	});

	it('rejects malformed, wrong-dimension, and zero vectors', () => {
		expect(() => decodeQ8Vector('not base64', 1, 4)).toThrow(/base64/);
		expect(() => decodeQ8Vector(base64([1, 2]), 1, 4)).toThrow(/dimension/);
		expect(() => decodeQ8Vector(base64([0, 0, 0, 0]), 1, 4)).toThrow(/zero/);
		expect(() => decodeQ8Vector(base64([1, 2, 3, 4]), 0, 4)).toThrow(/vectorScale/);
	});
});
