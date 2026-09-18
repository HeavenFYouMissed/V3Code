/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Global token dictionary — interns lexical token strings to u32 ids so every
 * chunk holds a sorted Uint32Array instead of a Set<string>.
 *
 * Why: per-chunk token Sets were the single largest renderer-RAM consumer in
 * the index (~10-15M set entries at 300k chunks, roughly 0.5-1GB incl. string
 * headers — 2026-07-07 audit #6), and the hot retrieval loop paid a string
 * hash per (chunk × query-token) probe. Interned ids cut token RAM ~10x and
 * turn the probe into an integer binary search. The token universe is the
 * bounded set of code identifiers/subtokens, so a process-global table is
 * safe; ids are session-local — persistence still stores strings, mapped at
 * the save/load boundary (no format change, no migration). KNOWN TRADE: the
 * table is append-only for the window's lifetime — churned generated content
 * (hashes, lockfiles) accretes slowly; compaction-on-rebuild is boarded. Use
 * tokenDictSize() to observe growth.
 */

const idOf = new Map<string, number>();
const strings: string[] = [];

/** Shared empty for non-scored chunks — avoids ~10^5 identical allocations. */
export const EMPTY_TOKENS = new Uint32Array(0);

/** Intern + dedupe + sort a token bag into the canonical per-chunk form.
 *  Dedupe happens BEFORE the sort (raw tokenize output on the chunking path
 *  carries hundreds of duplicate occurrences), and the sort is the native
 *  comparator-free TypedArray sort. */
export function internTokens(tokens: Iterable<string>): Uint32Array {
	const unique = new Set<number>();
	for (const t of tokens) {
		if (typeof t !== 'string') { continue; } // corrupt persisted record guard
		let id = idOf.get(t);
		if (id === undefined) {
			id = strings.length;
			strings.push(t);
			idOf.set(t, id);
		}
		unique.add(id);
	}
	if (unique.size === 0) { return EMPTY_TOKENS; }
	return Uint32Array.from(unique).sort();
}

/** Query-side lookup. -1 = token never seen in any chunk (matches nothing).
 *  Never interns: queries must not grow the table. */
export function tokenIdOf(t: string): number {
	return idOf.get(t) ?? -1;
}

/** Reverse map for persistence — ids back to the stored string form, SORTED
 *  so identical content always serializes identically (intern-id order is
 *  session-history-dependent; load sites re-intern and are order-blind).
 *  Ids outside the table are skipped: persisting `undefined` into a declared
 *  string[] would silently corrupt IndexedDB pages and cloud payloads. */
export function tokenStringsOf(ids: Uint32Array): string[] {
	const out: string[] = [];
	for (let i = 0; i < ids.length; i++) {
		const s = strings[ids[i]];
		if (s !== undefined) { out.push(s); }
	}
	out.sort();
	return out;
}

/** Observability: current dictionary size (the table only ever grows within a
 *  window session; compaction on rebuild is a known follow-up — see board). */
export function tokenDictSize(): number {
	return strings.length;
}

/** Sorted-array membership (binary search) — the hot-loop probe. */
export function hasTokenId(sorted: Uint32Array, id: number): boolean {
	if (id < 0) { return false; }
	let lo = 0;
	let hi = sorted.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const v = sorted[mid];
		if (v === id) { return true; }
		if (v < id) { lo = mid + 1; } else { hi = mid - 1; }
	}
	return false;
}
