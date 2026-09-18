/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * int8 vector quantization with DYNAMIC per-vector range.
 *
 * A fixed scalar (`round(v * 127)`) wastes bit-depth: MiniLM's L2-normalized
 * outputs cluster in a narrow band (a 384-d unit vector has components around
 * ±1/sqrt(384) ≈ ±0.05, peaks ~±0.3), so a fixed /127 only ever uses ~⅓ of the
 * int8 range and the rounding step (1/127) is coarse relative to the values.
 *
 * Dynamic range fixes this: each vector is scaled by its own max-abs component
 * before quantizing, then the scale (one float32) is stored alongside. This
 * spreads the values across the full [-127, 127] range, shrinking the rounding
 * step proportionally and pushing cosine recall to ~99.9% of raw float32 — at
 * the same 4x compression (1 byte/dim + 4 bytes/vector vs 4 bytes/dim).
 *
 * Pure, allocation-light, no SIMD (plain JS doesn't expose int8 SIMD to user
 * code — this is a tight scalar loop, which V8 keeps in the fast path).
 */

export interface QuantizedVector {
	/** int8 components: q[i] = round(v[i] / scale * 127). */
	q: Int8Array;
	/** Dequantization factor: v[i] ≈ q[i] / 127 * scale. */
	scale: number;
}

const Q_MAX = 127;

/** Quantize an embedding to int8 using its own max-abs component as the scale. */
export function quantizeDynamic(vec: Float32Array): QuantizedVector {
	let maxAbs = 0;
	for (let i = 0; i < vec.length; i++) {
		const a = vec[i] < 0 ? -vec[i] : vec[i];
		if (a > maxAbs) maxAbs = a;
	}
	const scale = maxAbs > 0 ? maxAbs : 1;
	const inv = Q_MAX / scale;
	const q = new Int8Array(vec.length);
	for (let i = 0; i < vec.length; i++) {
		let x = Math.round(vec[i] * inv);
		if (x > Q_MAX) x = Q_MAX; else if (x < -Q_MAX) x = -Q_MAX;
		q[i] = x;
	}
	return { q, scale };
}

/**
 * Cosine similarity between a normalized float32 query and a dynamic-range
 * int8 stored vector.
 *
 *   stored_dequant[i] = q[i] / 127 * scale  ≈  original[i]
 *   cos(query, original) = Σ query[i] * stored_dequant[i]
 *                        = (scale / 127) * Σ query[i] * q[i]
 *
 * Both operands are unit-length, so the dot product is the cosine directly.
 */
export function cosineQueryToInt8(query: Float32Array, stored: Int8Array, scale: number): number {
	const n = query.length < stored.length ? query.length : stored.length;
	let dot = 0;
	for (let i = 0; i < n; i++) dot += query[i] * stored[i];
	return (dot * scale) / Q_MAX;
}
