/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Convert a failed absolute directory walk into the file-key prefix used by
 * the semantic index. An empty prefix means the workspace root itself failed. */
export function failedWalkPrefix(rootPath: string, failedPath: string, caseInsensitive: boolean): string | null {
	const slash = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
	const root = slash(rootPath);
	const failed = slash(failedPath);
	const rootCompare = caseInsensitive ? root.toLowerCase() : root;
	const failedCompare = caseInsensitive ? failed.toLowerCase() : failed;
	if (failedCompare === rootCompare) return '';
	if (!failedCompare.startsWith(`${rootCompare}/`)) return null;
	return failed.slice(root.length + 1);
}

/** True when a previously indexed file sits inside a directory whose latest
 * walk failed. Such files must be preserved until a successful retry proves
 * they were really deleted. */
export function coveredByFailedWalk(relativePath: string, failedPrefixes: readonly string[]): boolean {
	const path = relativePath.replace(/\\/g, '/');
	return failedPrefixes.some(prefix => prefix === '' || path === prefix || path.startsWith(`${prefix}/`));
}

/** Bounded exponential retry: quick recovery from transient handle pressure,
 * without hammering a persistently unreadable network or permission boundary. */
export function walkHealthRetryDelay(attempt: number): number {
	return Math.min(5 * 60_000, 15_000 * (2 ** Math.max(0, Math.min(attempt, 5))));
}
