/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { SearchMemoryOptions } from './memoryTypes.js';

export interface MemorySearchTargets {
	workspace: boolean;
	global: boolean;
}

/**
 * Memory isolation contract:
 *
 * - An open workspace is a hard project boundary. Automatic injection and the default
 *   search path may read that workspace only.
 * - User-global recall is available only when a caller explicitly asks for
 *   `scope=global`. An empty window gets no ambient global facts.
 * - A single request never silently merges both stores.
 */
export function memorySearchTargets(
	scope: SearchMemoryOptions['scope'],
	hasWorkspace: boolean,
): MemorySearchTargets {
	if (scope === 'global') {
		return { workspace: false, global: true };
	}
	if (!hasWorkspace) {
		return { workspace: false, global: false };
	}
	return { workspace: true, global: false };
}

export function automaticMemoryTarget(hasWorkspace: boolean): 'workspace' | 'global' {
	return hasWorkspace ? 'workspace' : 'global';
}

/** Stable identity for prompt/memory caches. Project swaps must never reuse the
 * previous workspace's pinned facts simply because the chat session id stayed the same. */
export function workspaceMemoryIdentity(workspaceUris: readonly string[]): string {
	return workspaceUris.length > 0 ? [...workspaceUris].sort().join('|') : '<no-workspace>';
}
