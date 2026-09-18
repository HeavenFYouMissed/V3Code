/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Quick-search fast path — skip embed/rerank for obvious lookups. */
export function isQuickSearchQuery(query: string): boolean {
	const q = query.trim();
	if (!q || q.length > 64) { return false; }
	if (/\.[a-z0-9]{1,8}$/i.test(q) || q.includes('/') || q.includes('\\')) { return true; }
	if (/^[A-Z][a-zA-Z0-9_]{0,40}$/.test(q)) { return true; }
	if (/^[a-z][a-z0-9_]{0,32}$/.test(q)) { return true; }
	if (/^(where|find|locate|definition of|who calls|grep)\s+\S{1,40}$/i.test(q)) { return true; }
	return false;
}
