/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Hit } from '../semanticIndex/semanticIndexTypes.js';
import { contentHash, contentHash64 } from '../semanticIndex/hashing.js';

const RRF_K = 20;
const LOCAL_WEIGHT = 1;
const CLOUD_WEIGHT = 0.85;

/**
 * Return the exact candidate whose bytes are named by casKey. The live browser
 * index uses a 16-hex workspace-local hash; older Node-index snapshots used
 * SHA-256. Unknown key shapes fail closed.
 */
export function verifiedCloudContent(casKey: string, candidates: readonly string[]): string | undefined {
	let hash: ((content: string) => string) | undefined;
	if (/^[a-f0-9]{16}$/.test(casKey)) hash = contentHash64;
	else if (/^[a-f0-9]{64}$/.test(casKey)) hash = contentHash;
	else return undefined;

	for (const candidate of new Set(candidates)) {
		if (hash(candidate) === casKey) return candidate;
	}
	return undefined;
}

/** Reconstruct and verify a 1-indexed inclusive cloud pointer against a file. */
export function verifiedCloudSpan(casKey: string, source: string, startLine: number, endLine: number): string | undefined {
	if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) return undefined;
	const rawLines = source.split('\n');
	if (endLine > rawLines.length) return undefined;
	const rawSpan = rawLines.slice(startLine - 1, endLine).join('\n');
	// Structural chunks preserve CRLF because they split only on LF, while the
	// fallback window chunker deliberately normalizes CRLF. Verify both exact
	// representations and return the bytes that actually match the CAS key.
	const normalizedSpan = source.split(/\r?\n/).slice(startLine - 1, endLine).join('\n');
	return verifiedCloudContent(casKey, [rawSpan, normalizedSpan]);
}

/**
 * Fuse the editor's fresh local overlay with the shared hosted base.
 *
 * A hit present in both indexes receives both rank votes. When the same stable
 * chunk id has different content, the local hit is deliberately retained: it
 * represents the working tree the user can see, while the cloud may still hold
 * the previous team snapshot.
 */
export function mergeFederatedIndexHits(localHits: readonly Hit[], cloudHits: readonly Hit[], topK: number): Hit[] {
	type Entry = { hit: Hit; score: number; local: boolean; cloud: boolean };
	const byId = new Map<string, Entry>();

	for (let i = 0; i < localHits.length; i++) {
		const hit = localHits[i];
		byId.set(hit.chunk.id, { hit, score: LOCAL_WEIGHT / (RRF_K + i + 1), local: true, cloud: false });
	}
	for (let i = 0; i < cloudHits.length; i++) {
		const hit = cloudHits[i];
		const vote = CLOUD_WEIGHT / (RRF_K + i + 1);
		const existing = byId.get(hit.chunk.id);
		if (existing) {
			existing.score += vote;
			existing.cloud = true;
		} else {
			byId.set(hit.chunk.id, { hit, score: vote, local: false, cloud: true });
		}
	}

	const ranked = [...byId.values()]
		.sort((a, b) => b.score - a.score)
		.map(entry => ({
			...entry.hit,
			score: entry.score,
			signals: {
				...entry.hit.signals,
				...(entry.local ? { local: 1 } : {}),
				...(entry.cloud ? { cloud: 1 } : {}),
			},
		}));

	// The renderer treats the first weak hit as a boundary, so keep the tail
	// contiguous even when independent indexes disagree about the score knee.
	const strong = ranked.filter(hit => !hit.signals.weak);
	const weak = ranked.filter(hit => !!hit.signals.weak);
	return [...strong, ...weak].slice(0, Math.max(1, topK));
}
