import { describe, expect, it } from 'vitest';
import { embedVector, StaticModel } from '../src/embed/staticEmbedder.js';
import fix from './fixtures-potion-embed.json';

/*--------------------------------------------------------------------------------------
 *  THE SECOND GATE — embed-math parity. embedVector() must produce the SAME vector the
 *  real potion-code-16M model does. Fixtures were computed by an independent Python
 *  pass over the actual model.safetensors (mapping I64 / weights F64 / embeddings
 *  F32[61826,256]); token ids reuse the parity-verified tokenizer fixtures, and the
 *  model rows are remapped to a compact mini-model so we test REAL rows without
 *  bundling the 64MB table. Tokenizer parity + this = the whole embedder verified.
 *--------------------------------------------------------------------------------------*/

const f = fix as {
	dim: number; normalize: boolean; unkId: number;
	weights: number[]; embeddings: number[];
	cases: Array<{ text: string; ids: number[]; vec: number[] }>;
};

const model: StaticModel = {
	mapping: null, // compact mini-model: id == row
	weights: new Float64Array(f.weights),
	embeddings: new Float32Array(f.embeddings),
	dim: f.dim, normalize: f.normalize, unkId: f.unkId,
};

describe('potion embed-math parity (real model rows)', () => {
	it('matches the safetensors reference vector on every fixture', () => {
		for (const c of f.cases) {
			const got = embedVector(c.ids, model);
			expect(got.length).toBe(f.dim);
			let maxErr = 0;
			for (let d = 0; d < f.dim; d++) maxErr = Math.max(maxErr, Math.abs(got[d] - c.vec[d]));
			expect(maxErr, `${JSON.stringify(c.text)} maxErr=${maxErr}`).toBeLessThan(1e-4);
		}
	});

	it('outputs unit-norm vectors (normalize=true) for non-empty input', () => {
		for (const c of f.cases) {
			const v = embedVector(c.ids, model);
			const norm = Math.sqrt([...v].reduce((s, x) => s + x * x, 0));
			// unk-only / empty inputs stay zero; everything else is L2-normalized.
			if (c.ids.some(id => id !== f.unkId)) expect(norm).toBeCloseTo(1, 4);
		}
	});
});
