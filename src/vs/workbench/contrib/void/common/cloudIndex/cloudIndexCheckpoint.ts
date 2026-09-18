/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Local checkpoint for cloud-index chunk uploads.
 *
 * The server manifest diff can keep listing files as "changed" until a sync
 * completes; without a client-side checkpoint we re-upload the same chunks
 * every cycle. We persist file→contentHash pairs once a batch succeeds so
 * subsequent runs skip uploads for unchanged files.
 */

import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

const STORAGE_PREFIX = 'v3code.cloudIndex.checkpoint.v1';

export type CloudIndexCheckpoint = Record<string, string>;

export function cloudIndexCheckpointKey(workspaceId: string, embedIdentity: string): string {
	const safeIdentity = embedIdentity.replace(/[^a-zA-Z0-9+._-]/g, '_').slice(0, 128) || 'unknown';
	return `${STORAGE_PREFIX}.${workspaceId}.${safeIdentity}`;
}

export function loadCloudIndexCheckpoint(
	storageService: IStorageService,
	workspaceId: string,
	embedIdentity: string,
): CloudIndexCheckpoint {
	const raw = storageService.get(cloudIndexCheckpointKey(workspaceId, embedIdentity), StorageScope.APPLICATION, '{}');
	try {
		const parsed = JSON.parse(raw) as CloudIndexCheckpoint;
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

export function saveCloudIndexCheckpoint(
	storageService: IStorageService,
	workspaceId: string,
	embedIdentity: string,
	checkpoint: CloudIndexCheckpoint,
): void {
	storageService.store(
		cloudIndexCheckpointKey(workspaceId, embedIdentity),
		JSON.stringify(checkpoint),
		StorageScope.APPLICATION,
		StorageTarget.USER,
	);
}

export function mergeCloudIndexCheckpoint(
	storageService: IStorageService,
	workspaceId: string,
	embedIdentity: string,
	confirmed: CloudIndexCheckpoint,
): CloudIndexCheckpoint {
	const existing = loadCloudIndexCheckpoint(storageService, workspaceId, embedIdentity);
	const merged = { ...existing, ...confirmed };
	saveCloudIndexCheckpoint(storageService, workspaceId, embedIdentity, merged);
	return merged;
}
