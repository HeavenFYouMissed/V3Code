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
 * Pure. Uses only Node builtins (`crypto`, `path`). Safe to import from any
 * void-contrib layer; the index pipeline always runs in a Node-enabled
 * renderer/worker context, so requiring `crypto` is fine.
 */

import { createHash } from 'node:crypto';

/** Normalize any FS path to POSIX form. All chunk.file values use POSIX. */
export function toPosix(p: string): string {
	return p.split('\\').join('/');
}

/** sha256 hex digest of a string. Stable across runs. */
export function sha256(input: string): string {
	return createHash('sha256').update(input, 'utf8').digest('hex');
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

/** Truncate any user-controlled string for safe logging. */
export function trunc(s: string, maxLen: number = 80): string {
	return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}
