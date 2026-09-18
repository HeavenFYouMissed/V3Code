/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * ESM-safe dynamic loader for `node-llama-cpp` (a native module) — the built-in local
 * autocomplete engine. Mirrors `sqliteLoader.ts`: the module is imported via `as any` so
 * this file (and everything that uses it) type-checks even before the dependency is
 * installed; the build installs it and unpacks the native binary, exactly like
 * `@vscode/sqlite3`. MAIN PROCESS ONLY — never import this from the renderer.
 */

let _modPromise: Promise<any> | null = null;

/** Resolve the node-llama-cpp module namespace (getLlama, LlamaCompletion, ...). Cached. */
export function loadNodeLlama(): Promise<any> {
	if (!_modPromise) {
		_modPromise = import('node-llama-cpp' as any).catch(err => {
			_modPromise = null; // allow retry after a transient failure
			throw err;
		});
	}
	return _modPromise;
}
