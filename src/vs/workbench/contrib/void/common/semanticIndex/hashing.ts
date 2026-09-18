/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Path + hashing helpers for the semantic index.
 *
 * Pure, dependency-free and layer-safe: this file lives in `common/` and is
 * therefore reachable from the renderer, so it MUST NOT import Node builtins.
 * It previously did `import { createHash } from 'node:crypto'`; once any
 * browser-layer module pulled this file into `workbench.desktop.main.js`, the
 * renderer CSP (`script-src 'self' 'unsafe-eval' blob:`) refused the `node:`
 * specifier, the whole bundle failed to load, and the window rendered blank on
 * every platform. The SHA-256 below is self-contained and its digests are
 * byte-identical to `createHash('sha256').update(s, 'utf8').digest('hex')`, so
 * every existing chunk id and CAS key stays valid.
 */

/** Normalize any FS path to POSIX form. All chunk.file values use POSIX. */
export function toPosix(p: string): string {
	return p.split('\\').join('/');
}

const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
	return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** sha256 hex digest of a string. Stable across runs, platforms and layers. */
export function sha256(input: string): string {
	const bytes = new TextEncoder().encode(input);
	const bitLength = bytes.length * 8;
	const totalLength = Math.ceil((bytes.length + 9) / 64) * 64;

	const block = new Uint8Array(totalLength);
	block.set(bytes);
	block[bytes.length] = 0x80;

	const view = new DataView(block.buffer);
	view.setUint32(totalLength - 8, Math.floor(bitLength / 0x100000000), false);
	view.setUint32(totalLength - 4, bitLength >>> 0, false);

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const w = new Uint32Array(64);

	for (let offset = 0; offset < totalLength; offset += 64) {
		for (let i = 0; i < 16; i++) {
			w[i] = view.getUint32(offset + i * 4, false);
		}
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}

		let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			hh = g; g = f; f = e; e = (d + t1) >>> 0;
			d = c; c = b; b = a; a = (t1 + t2) >>> 0;
		}

		h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
		h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
	}

	let hex = '';
	for (let i = 0; i < 8; i++) {
		hex += h[i].toString(16).padStart(8, '0');
	}
	return hex;
}

/**
 * Stable chunk id — same {file, startLine, endLine} always hashes to the same
 * id. Drives upsert semantics. Note that `contentHash` is stored separately
 * so we can detect content changes at the same location without changing the
 * chunk's identity.
 */
export function chunkId(file: string, startLine: number, endLine: number): string {
	return sha256(`${toPosix(file)}:${startLine}:${endLine}`);
}

/** Hash a chunk's full text content. Used for incremental skip. */
export function contentHash(content: string): string {
	return sha256(content);
}

/**
 * Renderer index content hash — 64 bits rendered as 16 hex characters.
 *
 * This is intentionally the exact FNV-1a xor djb2 scheme used by the live
 * browser index. It is a fast workspace-local CAS key, not a security digest.
 * Keep it shared so any consumer that labels content with one of these keys can
 * verify the bytes with the same algorithm.
 */
export function contentHash64(content: string): string {
	let h1 = 0x811c9dc5 >>> 0;
	let h2 = 5381 >>> 0;
	for (let i = 0; i < content.length; i++) {
		const c = content.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = (((h2 << 5) + h2) + c) >>> 0;
	}
	return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Truncate any user-controlled string for safe logging. */
export function trunc(s: string, maxLen: number = 80): string {
	return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}
