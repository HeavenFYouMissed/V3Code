/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { diffLines } from '../react/out/diff/index.js';

const MAX_DIFF_CHARS = 12_000;

export type EditDiffSummary = { diffText: string; added: number; removed: number };

/** Model-visible unified diff for edit/rewrite tool results (Phase 0). */
export function formatUnifiedDiffForModel(before: string, after: string, filePath: string): EditDiffSummary {
	const changes = diffLines(before, after);
	let added = 0;
	let removed = 0;
	const hunks: string[] = [];
	for (const part of changes) {
		const chunk = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value;
		if (!chunk) continue;
		for (const line of chunk.split('\n')) {
			if (part.added) {
				hunks.push(`+${line}`);
				added++;
			} else if (part.removed) {
				hunks.push(`-${line}`);
				removed++;
			}
		}
	}
	let body = hunks.join('\n');
	if (body.length > MAX_DIFF_CHARS) {
		body = body.slice(0, MAX_DIFF_CHARS) + '\n...[diff truncated]';
	}
	const diffText = body
		? `\n\n\`\`\`diff\n--- ${filePath}\n+++ ${filePath}\n${body}\n\`\`\``
		: '';
	return { diffText, added, removed };
}
