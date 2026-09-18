/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Provenance for Turbo Draft / NES context — Tab/NES accepts beat raw typing. */
export type EditEntrySource = 'tab' | 'nes' | 'edit';

/** One coalesced edit burst in the recent-edits journal (autocomplete packet section 1). Lives in
 *  common/ so both the browser service and the (common) tools types can share the shape. */
export interface EditEntry {
	id: string;
	fileUri: string;
	relativePath: string;
	timestamp: number;
	range: { startLine: number; endLine: number };
	oldText: string;   // replaced text, cap 200 chars
	newText: string;   // replacement, cap 200 chars
	summary: string;   // "<relativePath>:<lineRange> — <first changed line>"
	/** Defaults to `edit` for typing/paste; Tab/NES accepts are tagged. */
	source?: EditEntrySource;
}
