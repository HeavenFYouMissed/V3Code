/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Greenfield-workspace detection for memory scoping (see docs/V3CODE-MEMORY-CONTRACT.md).
 * Pure -> headless-testable.
 *
 * When the open workspace is effectively empty (a blank folder with nothing to ground against),
 * cross-project background memory MUST NOT auto-push: the GLOBAL store holds facts from OTHER
 * projects (e.g. V3Code's own dev), and the editorial layer holds OTHER projects' briefs. Pushing
 * them into a blank "build me a coffee site" folder makes the agent hallucinate off unrelated
 * history instead of just building. The session's OWN rolling digest is a separate, in-session
 * concern and is NOT gated by this. Everything remains available on demand via deep_recall.
 */

/** Lines like "Directory of /path:" head each folder block in the tree string; not content. */
const DIRECTORY_HEADER_RE = /^Directory of /;

/** Max non-dot entries for a workspace to count as greenfield (nothing meaningful to ground on). */
export const GREENFIELD_MAX_ENTRIES = 2;

/**
 * True when the workspace directory tree is effectively empty - no workspace, or only dot-entries
 * (.v3code, .git, ...) plus at most GREENFIELD_MAX_ENTRIES real files/dirs. Heuristic over the same
 * tree string the system message already builds; format-agnostic (strips leading tree scaffolding
 * before reading each entry name).
 */
export function isGreenfieldWorkspace(directoryStr: string): boolean {
	const s = (directoryStr ?? '').trim();
	if (!s || s === '(NO WORKSPACE OPEN)') { return true; }
	let entries = 0;
	for (const raw of s.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('(') || DIRECTORY_HEADER_RE.test(line)) { continue; }
		const name = line.replace(/^[^A-Za-z0-9._]+/, ''); // drop tree scaffolding (-, indent, box-drawing) to reach the entry name
		if (!name || name.startsWith('.')) { continue; }   // blanks + dotfiles/dirs don't count as content
		if (++entries > GREENFIELD_MAX_ENTRIES) { return false; }
	}
	return true;
}
