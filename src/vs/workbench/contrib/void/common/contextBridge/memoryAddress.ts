/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Pure per-profile three-layer memory path resolver (Phase 2 shelving).
 * Depends only on URI/resources — no services — so it is trivially unit-testable.
 */

import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';

export const MEMORY_LIBRARY_ROOT = 'v3code-memory';
export const MEMORY_PROFILES_DIR = 'profiles';
export const DEFAULT_MEMORY_PROFILE_ID = 'default';
export const MEMORY_PERMANENT_DIR = 'permanent';
export const MEMORY_WORKSPACE_DIR = 'workspace';
export const MEMORY_CHAT_DIR = 'chat';
export const MEMORY_SHADOW_DIR = 'shadow';
export const MEMORY_GLOBAL_DIR = 'global';
export const MEMORY_DB_FILE = 'memory.db';
export const MEMORY_REGISTRY_FILE = 'registry.json';
export const WORKSPACE_ID_MARKER_REL = '.v3code/workspace-id';

export interface MemoryProfilePaths {
	profileRoot: URI;
	permanentDir: URI;
	registryUri: URI;
	globalDir: URI;
	globalDbPath: string;
}

export interface MemoryWorkspacePaths {
	wsId: string;
	workspaceDir: URI;
	dbPath: string;
	chatDir: URI;
}

export function resolveProfilePaths(userRoamingDataHome: URI, profileId: string = DEFAULT_MEMORY_PROFILE_ID): MemoryProfilePaths {
	const profileRoot = joinPath(userRoamingDataHome, MEMORY_LIBRARY_ROOT, MEMORY_PROFILES_DIR, profileId);
	const globalDir = joinPath(profileRoot, MEMORY_GLOBAL_DIR);
	return {
		profileRoot,
		permanentDir: joinPath(profileRoot, MEMORY_PERMANENT_DIR),
		registryUri: joinPath(profileRoot, MEMORY_REGISTRY_FILE),
		globalDir,
		globalDbPath: joinPath(globalDir, MEMORY_DB_FILE).fsPath,
	};
}

export function resolveWorkspacePaths(
	userRoamingDataHome: URI,
	wsId: string,
	profileId: string = DEFAULT_MEMORY_PROFILE_ID,
): MemoryWorkspacePaths {
	const { profileRoot } = resolveProfilePaths(userRoamingDataHome, profileId);
	const workspaceDir = joinPath(profileRoot, MEMORY_WORKSPACE_DIR, wsId);
	const chatDir = joinPath(profileRoot, MEMORY_CHAT_DIR, wsId);
	return {
		wsId,
		workspaceDir,
		dbPath: joinPath(workspaceDir, MEMORY_DB_FILE).fsPath,
		chatDir,
	};
}

export function resolveChatJsonlPath(
	userRoamingDataHome: URI,
	wsId: string,
	sessionId: string,
	profileId: string = DEFAULT_MEMORY_PROFILE_ID,
): string {
	const { chatDir } = resolveWorkspacePaths(userRoamingDataHome, wsId, profileId);
	return joinPath(chatDir, `${sessionId}.jsonl`).fsPath;
}

/**
 * The SHADOW archive dir for a workspace: `<profileRoot>/shadow/<wsId>/`. The raw,
 * append-only, never-deleted floor (one `<YYYY-MM-DD>.jsonl` per day inside it; the
 * day file + the disposable FTS index live under this dir). Same per-profile,
 * path-independent address as the rest of the memory library.
 */
export function resolveShadowDir(
	userRoamingDataHome: URI,
	wsId: string,
	profileId: string = DEFAULT_MEMORY_PROFILE_ID,
): string {
	const { profileRoot } = resolveProfilePaths(userRoamingDataHome, profileId);
	return joinPath(profileRoot, MEMORY_SHADOW_DIR, wsId).fsPath;
}

export function workspaceIdMarkerUri(folderUri: URI): URI {
	return joinPath(folderUri, '.v3code', 'workspace-id');
}
