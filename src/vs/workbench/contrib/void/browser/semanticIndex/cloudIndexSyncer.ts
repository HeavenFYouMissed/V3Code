/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * CloudIndexSyncer — pushes the local semantic index to a V3Index deployment.
 *
 * Cadence: callers run syncNow() periodically (the contribution
 * uses 5 minutes with backoff) and after big index events. Each run is a
 * Merkle-style manifest diff (`sync/begin`), then sequential chunk uploads for
 * changed files only, then a recent-edits signal push.
 *
 * The server manifest is authoritative. If it reports a file as changed, the
 * client always reconciles that file even when an old local checkpoint says it
 * was uploaded before. This repairs a reset, restored, or partially written
 * server workspace instead of permanently certifying missing chunks.
 */

import { CloudSyncResult, CloudSyncSnapshot, CloudWireChunk } from '../../common/cloudIndex/cloudIndexProtocol.js';

export interface CloudSyncHost {
	endpoint: string;
	token: string;
	workspaceId: string;
	privacyMode: 'full' | 'vectors-only' | 'ephemeral';
	getSnapshot(): CloudSyncSnapshot;
	getRecentEditRanks(): Record<string, number>;
	getEmbedIdentity(): string;
	log(message: string): void;
	/** Main-process HTTP — renderer fetch() is blocked by CORS on vscode-file:// */
	postJson(path: string, body: unknown): Promise<unknown>;
	onProgress?: (progress: { changedFilesTotal: number; filesProcessed: number; chunksUploaded: number }) => void;
}

/** Half the server's bounded transaction size (~50 chunks): each /chunks POST
 *  is one Durable Object invocation, and full-size batches of content-heavy
 *  chunks were tipping the DO over its per-request CPU limit on large repos
 *  ("Durable Object exceeded its CPU time limit and was reset"). Smaller
 *  requests = less work per invocation; the server caps at 1000/batch. */
const CHUNKS_PER_UPLOAD = 25;
/** Breather between sequential /chunks POSTs — keeps sustained ingest from
 *  starving the same DO that also answers reads. */
const UPLOAD_PACING_MS = 150;
/** Server CAS lookups at 90 keys per query. */
const CAS_CHECK_BATCH = 90;

const CLOUD_VECTOR_SPACE = 'qwen3-embedding-0.6b+hdr2' as const;

/** GGUF Q8 and Workers AI use the same Qwen3-Embedding-0.6B vector space. The
 * packaging/runtime identifiers differ, so compatibility is intentionally
 * narrower than string equality but still requires the hdr2 text scheme. */
export function isCloudVectorCompatible(embedIdentity: string): boolean {
	return /qwen3-embedding-0\.6b/i.test(embedIdentity) && embedIdentity.endsWith('+hdr2');
}

/** A source-free Standard writer can contribute only the exact Qwen document
 * vector space queried by the hosted index. Potion clients remain consumers of
 * the shared base; uploading lexical-only rows would silently weaken fusion. */
export function cloudContributionBlock(privacyMode: CloudSyncHost['privacyMode'], embedIdentity: string): CloudSyncResult | undefined {
	if (privacyMode !== 'vectors-only' || isCloudVectorCompatible(embedIdentity)) return undefined;
	return {
		ok: false,
		changedFiles: 0,
		removedFiles: 0,
		uploadedChunks: 0,
		tookMs: 0,
		failureCode: 'incompatible-vector-space',
		error: `This client cannot contribute to the source-free cloud index because ${embedIdentity || 'the active local embedder'} cannot produce Qwen3+hdr2 vectors. Local search and shared cloud retrieval still work. Use full mode or Qwen3 to contribute.`,
	};
}

/** Vectors-only manifests include local vector coverage. A deferred Qwen
 * backfill therefore makes the server request the file again even when source
 * bytes did not change. Full-mode manifests remain source-content hashes. */
export function cloudSyncFiles(snapshot: CloudSyncSnapshot, privacyMode: 'full' | 'vectors-only' | 'ephemeral', embedIdentity: string): Record<string, string> {
	if (privacyMode !== 'vectors-only') { return snapshot.files; }
	const compatible = isCloudVectorCompatible(embedIdentity);
	const files: Record<string, string> = {};
	for (const [file, hash] of Object.entries(snapshot.files)) {
		const vectorCount = compatible ? (snapshot.vectorCountForFile?.(file) ?? 0) : 0;
		files[file] = `${hash}:v3q8:${vectorCount}`;
	}
	return files;
}

/** Stable snapshot fingerprint so server status can attest which local file
 * manifest it committed. Canonical JSON avoids path/hash delimiter ambiguity. */
export async function computeCloudManifestRoot(files: Readonly<Record<string, string>>): Promise<string> {
	const canonical = JSON.stringify(Object.keys(files).sort().map(file => [file, files[file]]));
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

type PendingBatch = {
	chunks: CloudWireChunk[];
	fileHashes: Record<string, string>;
	/** Complete current chunk-id set for each file in this batch — lets the server
	 *  delete the file's departed chunks (deleted functions, line-shifted old
	 *  positions). Sent for every changed file, even one whose chunks were all
	 *  CAS-skipped, so a file that only LOST a chunk is still reconciled. */
	fileChunkIds: Record<string, string[]>;
};

export class CloudIndexSyncer {
	private _inFlight = false;
	private _lastResult: CloudSyncResult | undefined;

	constructor(private readonly host: CloudSyncHost) { }

	get lastResult(): CloudSyncResult | undefined { return this._lastResult; }
	get isRunning(): boolean { return this._inFlight; }
	get contributionBlock(): CloudSyncResult | undefined {
		return cloudContributionBlock(this.host.privacyMode, this.host.getEmbedIdentity());
	}

	async syncNow(): Promise<CloudSyncResult> {
		if (this._inFlight) {
			return { ok: false, changedFiles: 0, removedFiles: 0, uploadedChunks: 0, tookMs: 0, error: 'sync already in flight' };
		}
		const t0 = Date.now();
		const embedIdentity = this.host.getEmbedIdentity();
		const blocked = cloudContributionBlock(this.host.privacyMode, embedIdentity);
		if (blocked) {
			this._lastResult = blocked;
			this.host.log(`[cloud-index] ${blocked.error}`);
			return blocked;
		}
		this._inFlight = true;
		try {
			const result = await this._run(embedIdentity);
			this._lastResult = { ...result, tookMs: Date.now() - t0 };
			return this._lastResult;
		} catch (err: any) {
			this._lastResult = {
				ok: false, changedFiles: 0, removedFiles: 0, uploadedChunks: 0,
				tookMs: Date.now() - t0, error: err?.message ?? String(err),
			};
			this.host.log(`[cloud-index] sync failed: ${this._lastResult.error}`);
			return this._lastResult;
		} finally {
			this._inFlight = false;
		}
	}

	private async _run(embedIdentity: string): Promise<CloudSyncResult> {
		const snapshot = this.host.getSnapshot();
		const files = cloudSyncFiles(snapshot, this.host.privacyMode, embedIdentity);
		const fileCount = Object.keys(files).length;
		if (fileCount === 0) {
			return { ok: true, changedFiles: 0, removedFiles: 0, uploadedChunks: 0, tookMs: 0 };
		}

		const manifestRoot = await computeCloudManifestRoot(files);

		await this._post('/init', { privacyMode: this.host.privacyMode });

		const begin = await this._post<{ syncId: string; changedFiles: string[]; removedFiles: string[] }>(
			'/sync/begin', { files, embedIdentity, manifestRoot },
		);

		// Never veto the server's diff with local state. A client checkpoint cannot
		// know whether the server was reset, restored from an older backup, or lost
		// a partial batch after the checkpoint was written.
		const filesToUpload = begin.changedFiles;

		this.host.log(
			`[cloud-index] manifest diff: ${begin.changedFiles.length} changed, ${begin.removedFiles.length} removed (of ${fileCount}); server-authoritative reconciliation`,
		);

		const reportProgress = (filesProcessed: number, chunksUploaded: number) => {
			this.host.onProgress?.({
				changedFilesTotal: filesToUpload.length,
				filesProcessed,
				chunksUploaded,
			});
		};

		const batches: PendingBatch[] = [];
		let pending: CloudWireChunk[] = [];
		let pendingHashes: Record<string, string> = {};
		let pendingFileIds: Record<string, string[]> = {};
		let filesProcessed = 0;
		let uploaded = 0;
		let casSkipped = 0;

		const queueBatch = () => {
			// Flush if there are chunks OR reconciliation entries (a file that only
			// lost chunks has an id set but no chunks to upload).
			if (pending.length === 0 && Object.keys(pendingFileIds).length === 0) { return; }
			batches.push({ chunks: pending, fileHashes: { ...pendingHashes }, fileChunkIds: { ...pendingFileIds } });
			pending = [];
			pendingHashes = {};
			pendingFileIds = {};
		};

		const includeVectors = this.host.privacyMode === 'vectors-only' && isCloudVectorCompatible(embedIdentity);
		for (const file of filesToUpload) {
			const fileChunks = snapshot.chunksForFile(file, includeVectors).map(chunk => this._prepareChunk(chunk, embedIdentity));
			pending.push(...fileChunks);
			// Full current id set BEFORE CAS filtering — the server reconciles the
			// file against this to drop departed chunks. A file's chunks are never
			// split across batches (whole file pushed before the size check), so
			// this set is always complete within its batch.
			pendingFileIds[file] = fileChunks.map(c => c.id);
			const hash = files[file];
			if (hash !== undefined) { pendingHashes[file] = hash; }
			filesProcessed++;
			if (pending.length >= CHUNKS_PER_UPLOAD) { queueBatch(); }
			if (filesProcessed % 50 === 0) { reportProgress(filesProcessed, uploaded); }
		}
		queueBatch();

		// Durable Object ingests serially — parallel /chunks with done:true on the
		// last index raced ahead of earlier batches and 500'd the DO.
		const allFileHashes: Record<string, string> = {};
		for (const file of begin.changedFiles) {
			const hash = files[file];
			if (hash !== undefined) { allFileHashes[file] = hash; }
		}

		for (const batch of batches) {
			const filtered = await this._filterUnknownChunks(batch.chunks);
			casSkipped += batch.chunks.length - filtered.length;
			// POST when there are chunks to upload OR files to reconcile: a file that
			// only LOST chunks (deleted function) has an id set but no chunks, and
			// still needs the reconcile pass to drop its departed rows + vectors.
			const hasReconcile = Object.keys(batch.fileChunkIds).length > 0;
			if (filtered.length > 0 || hasReconcile) {
				await this._post('/chunks', {
					syncId: begin.syncId,
					chunks: filtered,
					fileHashes: batch.fileHashes,
					fileChunkIds: batch.fileChunkIds,
					done: false,
				});
				uploaded += filtered.length;
				await new Promise(resolve => setTimeout(resolve, UPLOAD_PACING_MS));
			}
			reportProgress(filesProcessed, uploaded);
		}

		await this._post('/chunks', {
			syncId: begin.syncId,
			chunks: [],
			fileHashes: allFileHashes,
			done: true,
		});

		if (casSkipped > 0) {
			this.host.log(`[cloud-index] CAS skip: ${casSkipped} chunks already on server`);
		}

		const ranks = this.host.getRecentEditRanks();
		if (Object.keys(ranks).length > 0) {
			await this._post('/signals/edits', { ranks });
		}

		return {
			ok: true,
			changedFiles: begin.changedFiles.length,
			removedFiles: begin.removedFiles.length,
			uploadedChunks: uploaded,
			tookMs: 0,
		};
	}

	private async _filterUnknownChunks(chunks: CloudWireChunk[]): Promise<CloudWireChunk[]> {
		if (chunks.length === 0) { return []; }
		// id-aware skip: the server returns the ids it already holds UNCHANGED (same
		// id AND casKey). Keying on id — not casKey alone — is what lets a RELOCATED
		// chunk (a line shift mints a new id from hash(file:start:end) while the
		// content, hence casKey, is unchanged) still upload; the old casKey-only
		// check dropped it, leaving its new-id row unwritten and its old-id row
		// stale. Reconciliation then removes the vacated old position.
		const knownIds = new Set<string>();
		const have = chunks.map(c => ({
			id: c.id,
			casKey: c.casKey,
			// Advanced owns embedding in the cloud, so a missing server vector must
			// force the content back across even though there is no client vector.
			wantsVector: this.host.privacyMode === 'ephemeral' || c.vectorQ8 !== undefined,
		}));
		const checkJobs: Promise<{ known: string[] }>[] = [];
		for (let i = 0; i < have.length; i += CAS_CHECK_BATCH) {
			const batch = have.slice(i, i + CAS_CHECK_BATCH);
			checkJobs.push(this._post<{ known: string[] }>('/chunks/check', { have: batch }));
		}
		const results = await Promise.all(checkJobs);
		for (const r of results) {
			for (const id of r.known) { knownIds.add(id); }
		}
		return chunks.filter(c => !knownIds.has(c.id));
	}

	private _prepareChunk(chunk: CloudWireChunk, embedIdentity: string): CloudWireChunk {
		if (this.host.privacyMode !== 'vectors-only') {
			const { vectorQ8: _vectorQ8, vectorScale: _vectorScale, vectorSpace: _vectorSpace, ...full } = chunk;
			return full;
		}
		const { content: _content, ...sourceFree } = chunk;
		if (isCloudVectorCompatible(embedIdentity) && sourceFree.vectorQ8 !== undefined && typeof sourceFree.vectorScale === 'number') {
			return { ...sourceFree, vectorSpace: CLOUD_VECTOR_SPACE };
		}
		const { vectorQ8: _vectorQ8, vectorScale: _vectorScale, vectorSpace: _vectorSpace, ...lexicalOnly } = sourceFree;
		return lexicalOnly;
	}

	private async _post<T = unknown>(path: string, body: unknown): Promise<T> {
		return await this.host.postJson(path, body) as T;
	}
}
