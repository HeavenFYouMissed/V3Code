import { describe, expect, it } from 'vitest';
import { parseStaticModel, embedVector } from '../src/embed/staticEmbedder.js';
import fix from './fixtures-potion-int8.json';

/*--------------------------------------------------------------------------------------
 *  THE THIRD GATE — the production int8 path. Parse the packed model blob (the exact
 *  format that ships to R2) and confirm the int8-dequant vectors stay faithful to the
 *  f32 reference. This exercises parseStaticModel + the scale/dequant branch of
 *  embedVector on real (quantized) model rows.
 *--------------------------------------------------------------------------------------*/

const f = fix as { blobB64: string; cases: Array<{ text: string; ids: number[]; vec: number[] }> };

function b64ToArrayBuffer(b64: string): ArrayBuffer {
	const bin = atob(b64);
	const buf = new ArrayBuffer(bin.length);
	const view = new Uint8Array(buf);
	for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
	return buf;
}

const model = parseStaticModel(b64ToArrayBuffer(f.blobB64));

describe('potion int8 loader + dequant', () => {
	it('parses the packed blob into the right shapes', () => {
		expect(model.dim).toBe(256);
		expect(model.embeddings).toBeInstanceOf(Int8Array);
		expect(model.normalize).toBe(true);
		expect(model.scale!).toBeGreaterThan(0);
	});

	it('int8-dequant vectors stay ~identical to the f32 reference (cosine > 0.997)', () => {
		for (const c of f.cases) {
			const v = embedVector(c.ids, model);
			let dot = 0, a = 0, b = 0;
			for (let d = 0; d < model.dim; d++) { dot += v[d] * c.vec[d]; a += v[d] * v[d]; b += c.vec[d] * c.vec[d]; }
			if (b === 0) continue; // unk-only / empty → zero vector, no direction to compare
			const cos = dot / (Math.sqrt(a) * Math.sqrt(b) + 1e-32);
			expect(cos, `${JSON.stringify(c.text)} cos=${cos}`).toBeGreaterThan(0.997);
		}
	});
});
