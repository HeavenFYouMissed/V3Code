/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Stable cross-runtime name for locally produced Qwen code vectors. */
export const QWEN3_CODE_VECTOR_SPACE = 'qwen3-embedding-0.6b+hdr2' as const;

export function isQwen3CodeVectorIdentity(identity: string): boolean {
	return /qwen3-embedding-0\.6b/i.test(identity) && identity.endsWith('+hdr2');
}

/** Decode the editor's dynamic-range int8 vector and normalize it for
 * Vectorize cosine search. Throws before any storage write on malformed data. */
export function decodeQ8Vector(encoded: string, scale: number, expectedDim: number): number[] {
	if (!Number.isInteger(expectedDim) || expectedDim <= 0) throw new Error('invalid embedding dimension');
	if (!Number.isFinite(scale) || scale <= 0) throw new Error('vectorScale must be a finite positive number');
	if (typeof encoded !== 'string' || encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
		throw new Error('vectorQ8 must be padded base64');
	}
	let raw: string;
	try { raw = atob(encoded); } catch { throw new Error('vectorQ8 must be valid base64'); }
	if (raw.length !== expectedDim) throw new Error(`vectorQ8 dimension ${raw.length} does not match ${expectedDim}`);

	const values = new Array<number>(expectedDim);
	let normSq = 0;
	for (let i = 0; i < expectedDim; i++) {
		const byte = raw.charCodeAt(i);
		const signed = byte > 127 ? byte - 256 : byte;
		const value = signed / 127 * scale;
		values[i] = value;
		normSq += value * value;
	}
	if (normSq === 0) throw new Error('vectorQ8 must not be the zero vector');
	const invNorm = 1 / Math.sqrt(normSq);
	for (let i = 0; i < values.length; i++) values[i] *= invNorm;
	return values;
}
