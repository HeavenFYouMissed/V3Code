/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { isEqual } from '../../../../base/common/resources.js'
import { URI } from '../../../../base/common/uri.js'

export type ProjectOpenMode = 'replace' | 'add'

export interface ProjectWorkspaceChange {
	readonly kind: 'none' | ProjectOpenMode
	readonly folders: readonly URI[]
}

/**
 * Plan the root list before mutating the workbench. Replace is deliberately exclusive:
 * even when the target is already present, every unrelated root is removed.
 */
export function planProjectWorkspaceChange(existing: readonly URI[], target: URI, mode: ProjectOpenMode): ProjectWorkspaceChange {
	const alreadyAttached = existing.some(folder => isEqual(folder, target))
	if (mode === 'replace') {
		return existing.length === 1 && alreadyAttached
			? { kind: 'none', folders: existing }
			: { kind: 'replace', folders: [target] }
	}
	return alreadyAttached
		? { kind: 'none', folders: existing }
		: { kind: 'add', folders: [...existing, target] }
}
