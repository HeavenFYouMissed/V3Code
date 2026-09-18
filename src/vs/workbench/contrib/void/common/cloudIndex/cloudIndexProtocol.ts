/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3Index cloud-index wire protocol (client side). Mirrors V3Index
 * `src/sync/protocol.ts` — keep the two in lockstep. Sync is content-addressed:
 * a manifest diff decides which files to send; chunk records ride with their
 * contentHash as the CAS key so the server dedups and re-embeds only deltas.
 */

export interface CloudWireChunk {
	id: string;
	casKey: string;
	file: string;
	startLine: number;
	endLine: number;
	kind: string;
	name: string;
	language: string;
	parentId?: string;
	scored: boolean;
	defines?: string[];
	refs?: string[];
	lspDefines?: string[];
	lspRefs?: string[];
	content?: string;
	tokens?: string[];
	/** Dynamic-range int8 Qwen vector, encoded as base64. Present only when the
	 * local vector is in the cloud-compatible Qwen3 + hdr2 space. */
	vectorQ8?: string;
	vectorScale?: number;
	vectorSpace?: 'qwen3-embedding-0.6b+hdr2';
}

export interface CloudSyncSnapshot {
	/** rel path → contentHash (Merkle-style manifest). */
	files: Record<string, string>;
	chunksForFile(file: string, includeVectors?: boolean): CloudWireChunk[];
	/** Number of cloud-compatible vectors currently available for this file.
	 * Included in vectors-only manifest hashes so deferred local backfill
	 * automatically repairs the shared cloud base without a source edit. */
	vectorCountForFile?(file: string): number;
}

/** Duck-typed capability on the semantic-index service — the sync contribution
 *  probes for these instead of extending ISemanticIndexService (keeps the sync
 *  feature additive while other index work is in flight). */
export interface CloudSyncSnapshotProvider {
	getCloudSyncSnapshot(): CloudSyncSnapshot;
	getRecentEditRanks(): Record<string, number>;
}

export interface CloudSyncResult {
	ok: boolean;
	changedFiles: number;
	removedFiles: number;
	uploadedChunks: number;
	tookMs: number;
	error?: string;
	/** Deterministic client-side block. Callers must not retry it as a network failure. */
	failureCode?: 'incompatible-vector-space';
}

/** Read-side result returned by the hosted V3Index workspace. Content is
 * omitted in vectors-only mode and can be hydrated from the checked-out file. */
export interface CloudIndexQueryHit {
	chunkId: string;
	casKey: string;
	file: string;
	startLine: number;
	endLine: number;
	kind: string;
	name: string;
	language: string;
	score: number;
	snippet?: string;
	signals: {
		vec?: number;
		fts?: number;
		graphBoost?: number;
		neighbor?: number;
		parent?: number;
		child?: number;
		weak?: number;
	};
}

export interface CloudIndexQueryResult {
	hits: CloudIndexQueryHit[];
	vectorCoverage: number | null;
	tookMs: number;
}
