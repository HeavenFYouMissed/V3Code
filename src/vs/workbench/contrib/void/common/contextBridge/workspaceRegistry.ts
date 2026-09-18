/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Workspace UUID registry + in-repo marker resolver (Phase 2 shelving).
 * Resolution precedence: marker -> registry -> mint generateUuid.
 */

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { generateUuid, isUUID } from '../../../../../base/common/uuid.js';
import { dirname } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { isLinux } from '../../../../../base/common/platform.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import {
	DEFAULT_MEMORY_PROFILE_ID,
	MemoryWorkspacePaths,
	resolveProfilePaths,
	resolveWorkspacePaths,
	workspaceIdMarkerUri,
} from './memoryAddress.js';

export interface WorkspaceRegistryEntry {
	wsId: string;
}

export interface WorkspaceRegistryFile {
	entries: Record<string, WorkspaceRegistryEntry>;
	/** wsIds that completed legacy .context-bridge/memory.db copy (S5). */
	legacyMigratedWsIds?: string[];
}

async function readRegistry(registryUri: URI, fileService: IFileService): Promise<WorkspaceRegistryFile> {
	if (!(await fileService.exists(registryUri))) {
		return { entries: {} };
	}
	try {
		const raw = (await fileService.readFile(registryUri)).value.toString();
		const data = JSON.parse(raw) as WorkspaceRegistryFile;
		return {
			entries: data.entries && typeof data.entries === 'object' ? data.entries : {},
			legacyMigratedWsIds: Array.isArray(data.legacyMigratedWsIds) ? data.legacyMigratedWsIds : [],
		};
	} catch {
		return { entries: {} };
	}
}

async function writeRegistry(registryUri: URI, data: WorkspaceRegistryFile, fileService: IFileService): Promise<void> {
	await fileService.createFolder(dirname(registryUri));
	await fileService.writeFile(registryUri, VSBuffer.fromString(JSON.stringify(data, null, 2)));
}

async function writeMarker(markerUri: URI, wsId: string, fileService: IFileService): Promise<void> {
	await fileService.createFolder(dirname(markerUri));
	await fileService.writeFile(markerUri, VSBuffer.fromString(wsId));
}

function pathKey(folderUri: URI): string {
	// Windows and macOS resolve paths case-insensitively, so the SAME folder arrives with
	// different casing depending on how it was opened (Explorer vs recent list vs CLI vs
	// drag-drop) — `C:\dev\proj` and `c:\dev\proj` are one folder. Keying on the raw fsPath
	// let one folder map to several ids, and every unseen casing minted a fresh (empty)
	// memory bucket, which reads to the user as "all my memory is gone". Linux paths really
	// are case-sensitive, so only fold elsewhere.
	return isLinux ? folderUri.fsPath : folderUri.fsPath.toLowerCase();
}

async function upsertRegistryPath(
	registryUri: URI,
	folderUri: URI,
	wsId: string,
	fileService: IFileService,
): Promise<void> {
	const registry = await readRegistry(registryUri, fileService);
	registry.entries[pathKey(folderUri)] = { wsId };
	await writeRegistry(registryUri, registry, fileService);
}

export interface ResolvedWorkspaceAddress extends MemoryWorkspacePaths {
	folderUri: URI;
	profileId: string;
	registryUri: URI;
	permanentDir: URI;
}

/** Resolve or mint wsId for an opened folder; refresh marker/registry per precedence contract. */
export async function resolveWorkspaceAddress(
	folderUri: URI,
	userRoamingDataHome: URI,
	fileService: IFileService,
	profileId: string = DEFAULT_MEMORY_PROFILE_ID,
): Promise<ResolvedWorkspaceAddress> {
	const profilePaths = resolveProfilePaths(userRoamingDataHome, profileId);
	const markerUri = workspaceIdMarkerUri(folderUri);
	const key = pathKey(folderUri);

	let wsId: string | undefined;

	if (await fileService.exists(markerUri)) {
		const markerText = (await fileService.readFile(markerUri)).value.toString().trim();
		if (isUUID(markerText)) {
			wsId = markerText;
			await upsertRegistryPath(profilePaths.registryUri, folderUri, wsId, fileService);
		}
	}

	if (!wsId) {
		const registry = await readRegistry(profilePaths.registryUri, fileService);
		let entry = registry.entries[key];
		if (!entry && !isLinux) {
			// Registries written before the key was case-folded used the raw fsPath, so an exact
			// lookup misses them. Adopt any entry that differs only by case instead of minting a
			// new id — otherwise this fix would itself orphan every existing workspace's memory.
			const legacyKey = Object.keys(registry.entries).find(k => k.toLowerCase() === key);
			if (legacyKey) entry = registry.entries[legacyKey];
		}
		if (entry?.wsId && isUUID(entry.wsId)) {
			wsId = entry.wsId;
			await writeMarker(markerUri, wsId, fileService);
			// Re-write under the folded key so the legacy entry is migrated, not re-scanned forever.
			await upsertRegistryPath(profilePaths.registryUri, folderUri, wsId, fileService);
		}
	}

	if (!wsId) {
		wsId = generateUuid();
		await writeMarker(markerUri, wsId, fileService);
		await upsertRegistryPath(profilePaths.registryUri, folderUri, wsId, fileService);
	}

	const workspacePaths = resolveWorkspacePaths(userRoamingDataHome, wsId, profileId);
	return {
		...workspacePaths,
		folderUri,
		profileId,
		registryUri: profilePaths.registryUri,
		permanentDir: profilePaths.permanentDir,
	};
}

export async function isLegacyMigrationDone(
	registryUri: URI,
	wsId: string,
	fileService: IFileService,
): Promise<boolean> {
	const registry = await readRegistry(registryUri, fileService);
	return registry.legacyMigratedWsIds?.includes(wsId) ?? false;
}

export async function markLegacyMigrationDone(
	registryUri: URI,
	wsId: string,
	fileService: IFileService,
): Promise<void> {
	const registry = await readRegistry(registryUri, fileService);
	const done = new Set(registry.legacyMigratedWsIds ?? []);
	done.add(wsId);
	registry.legacyMigratedWsIds = [...done];
	await writeRegistry(registryUri, registry, fileService);
}

export async function ensureThreeLayerDirs(address: ResolvedWorkspaceAddress, fileService: IFileService): Promise<void> {
	await fileService.createFolder(address.permanentDir);
	await fileService.createFolder(address.workspaceDir);
	await fileService.createFolder(address.chatDir);
}
