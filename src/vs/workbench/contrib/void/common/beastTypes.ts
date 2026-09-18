/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Shared wire types for the beast sidecar (electron-main/beastChannel.ts ↔
// browser/beastService.ts). The sidecar is the Rust code index built in the
// V3Index repo; see docs/v3index-beast-packet/BEAST-FOR-EDITOR.md.

/** One hit from `beast search --json` (newline-JSON, one object per line). */
export interface BeastHit {
	file: string;
	line: number;
	span: [number, number];
	score: number;
	why: string;
	symbol: string | null;
}

/** One tag from `beast symbol --json` (tree-sitter def/ref lookup). */
export interface BeastSymbolTag {
	path: string;
	name: string;
	kind: string;
	is_definition: boolean;
	line: number;
	span: [number, number];
	syntax_type: string | null;
	docs: string | null;
}

/** One impacted file from `beast trace --json` (blast-radius ripple BFS). */
export interface BeastImpacted {
	file: string;
	distance: number;
	why: string;
	is_hub: boolean;
}

/** One stored note from `beast remember --json`. */
export interface BeastMemoryNote {
	id: number;
	text: string;
	files: string[];
	symbols: string[];
	created_unix: number;
	confidence: number;
}

/**
 * Parse `beast search --json` stdout: one JSON object per line; blank or
 * non-JSON lines (llama banners, warnings) are skipped, never fatal.
 */
export function parseBeastHits(stdout: string): BeastHit[] {
	const hits: BeastHit[] = [];
	for (const line of stdout.split('\n')) {
		const t = line.trim();
		if (!t) { continue; }
		try {
			const o = JSON.parse(t);
			if (o && typeof o.file === 'string' && typeof o.line === 'number') { hits.push(o); }
		} catch { /* non-JSON noise line — skip */ }
	}
	return hits;
}
