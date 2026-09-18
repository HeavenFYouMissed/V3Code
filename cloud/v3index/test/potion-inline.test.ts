import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { loadStaticModel, embedWith, STATIC_MODEL_KEY } from '../src/embed/staticEmbedder.js';
import type { Env } from '../src/env.js';

/*--------------------------------------------------------------------------------------
 *  Inline embedding — the R2 model-load + embed path used by ingest/retrieve. (The
 *  Vectorize upsert itself can't be tested here — the test runtime routes Vectorize to
 *  the real account — so it's verified in prod staging; load + embed are proven here,
 *  and tokenizer/embed/int8 correctness by the gate tests.)
 *--------------------------------------------------------------------------------------*/

const typedEnv = env as unknown as Env;

/** A tiny but well-formed 256-dim model blob in parseStaticModel's layout. */
function buildTestModel(): ArrayBuffer {
	const dim = 256, V = 8, rows = 8, unkId = 7;
	const vjson = new TextEncoder().encode(JSON.stringify({ greet: 0, widget: 1, export: 2, function: 3, return: 4, const: 5, the: 6, '[UNK]': 7 }));
	const buf = new ArrayBuffer(21 + V * 4 + V * 4 + rows * dim + 4 + vjson.length);
	const dv = new DataView(buf);
	dv.setUint32(0, dim, true); dv.setUint32(4, V, true); dv.setUint32(8, rows, true);
	dv.setFloat32(12, 1.0, true); dv.setUint8(16, 1); dv.setUint32(17, unkId, true);
	let off = 21;
	for (let i = 0; i < V; i++) { dv.setInt32(off, i, true); off += 4; }
	for (let i = 0; i < V; i++) { dv.setFloat32(off, 1.0, true); off += 4; }
	for (let i = 0; i < rows * dim; i++) { dv.setInt8(off, ((i * 7) % 15) - 7); off += 1; }
	dv.setUint32(off, vjson.length, true); off += 4;
	new Uint8Array(buf, off).set(vjson);
	return buf;
}

describe('inline embedding: R2 model load + embed', () => {
	it('loads the model (incl. vocab tail) from R2 and embeds text to a dim-vector', async () => {
		await typedEnv.BLOBS.put(STATIC_MODEL_KEY, buildTestModel());
		const model = await loadStaticModel(typedEnv.BLOBS);
		expect(model.dim).toBe(256);
		expect(model.vocab?.size).toBe(8); // vocab travelled in the blob tail
		const v = embedWith('export function greet return widget', model); // tokens in-vocab
		expect(v.length).toBe(256);
		expect([...v].some(x => x !== 0)).toBe(true); // real (non-zero) vector
	});
});
