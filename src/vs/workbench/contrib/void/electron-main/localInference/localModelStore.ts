/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Where the built-in local GGUF models live on disk. Phase 1 only RESOLVES the path; Phase 2
 * owns the actual first-run download + hardware-adaptive pick + the one-click picker. Until a
 * file exists at the resolved path, the inference call errors cleanly ("model not downloaded").
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Global per-user models directory (NOT in the workspace — never committed). */
export function localModelsDir(): string {
	return join(homedir(), '.v3code', 'models');
}

// Logical model name (from defaultModelsOfProvider['v3code-local']) -> GGUF filename.
// Phase 2 will make this hardware-adaptive (0.5B / 1.5B / 7B) and prefer the BASE model for FIM.
const FILENAME_OF_MODEL: Record<string, string> = {
	'qwen2.5-coder-1.5b': 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
	'qwen2.5-coder-0.5b': 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf',
};

export function resolveLocalModelPath(modelName: string): string {
	const file = FILENAME_OF_MODEL[modelName] ?? `${modelName}.gguf`;
	return join(localModelsDir(), file);
}
