/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Chunker CAPABILITY — what structural chunking this installation can actually
 * perform, as opposed to what the source declares it supports.
 *
 * Why this exists: chunk boundaries depend on the tree-sitter grammar assets
 * that are PACKAGED, not on any source constant. `build/.moduleignore` shipped
 * ten of eleven grammars out of the artifact, so every language except
 * TypeScript fell through `treeSitterChunker.extract()` to blind line windows.
 * Nothing in the persisted index recorded that, and the index only re-chunks a
 * file whose CONTENT changed — so shipping the grammars fixes new workspaces
 * and leaves every existing one degraded forever.
 *
 * A capability record pins the grammar set the persisted chunks were produced
 * under. When the live set gains a grammar the index was built without, those
 * files must be re-chunked.
 *
 * Deliberately derived from PROBED assets rather than from a source constant:
 * the whole bug class is a packaging change that source cannot see. The
 * hand-maintained {@link CHUNKER_ALGO_VERSION} covers the other axis — changes
 * to the chunking ALGORITHM itself, which no probe can observe.
 */

import { LANGUAGE_PROFILES } from './chunkerLanguages.js';

/**
 * Bump when the chunking ALGORITHM changes in a way that makes existing chunk
 * boundaries wrong (node-type maps, parent/child split rules, window geometry).
 * A bump forces one re-chunk for every existing index, so it is a deliberate
 * cost — additive changes that only affect newly-chunked files do not need one.
 *   1 — parent/child structural split + line-window fallback (initial).
 */
export const CHUNKER_ALGO_VERSION = 1;

/**
 * The grammar set + algorithm version a set of chunks was produced under.
 * Persisted in the index manifest and on content-addressed cache entries.
 */
export interface ChunkerCapability {
	/** {@link CHUNKER_ALGO_VERSION} at the time the chunks were produced. */
	algo: number;
	/** Grammar asset names that were available, sorted and de-duplicated. */
	grammars: string[];
}

/**
 * Every distinct grammar asset the chunker would ever ask for, sorted. Derived
 * from the language profiles so adding a language automatically extends the
 * probe — the list can never drift out of sync with what `extract()` loads.
 */
export function chunkerGrammarNames(): string[] {
	const names = new Set<string>();
	for (const key of Object.keys(LANGUAGE_PROFILES)) {
		names.add(LANGUAGE_PROFILES[key].grammar);
	}
	return [...names].sort();
}

/** Capability record for a probed set of available grammars. */
export function chunkerCapabilityOf(presentGrammars: Iterable<string>): ChunkerCapability {
	const grammars = [...new Set(presentGrammars)].sort();
	return { algo: CHUNKER_ALGO_VERSION, grammars };
}

/**
 * Compact, order-independent key for a capability. Used where a scalar is
 * needed for equality (content-addressed cache entries) rather than the
 * subset comparison {@link shouldRechunkForCapability} performs.
 */
export function chunkerCapabilityKey(capability: ChunkerCapability | undefined): string {
	if (!capability) return '';
	return `a${capability.algo}:${capability.grammars.join(',')}`;
}

/**
 * Defensive read of a capability persisted in IndexedDB. Anything that isn't a
 * well-formed record reads as "not recorded", which is also how a manifest
 * written before capability tracking existed reads.
 */
export function readChunkerCapability(raw: unknown): ChunkerCapability | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const rec = raw as { algo?: unknown; grammars?: unknown };
	if (typeof rec.algo !== 'number' || !Array.isArray(rec.grammars)) return undefined;
	const grammars: string[] = [];
	for (const g of rec.grammars) {
		if (typeof g === 'string' && g) grammars.push(g);
	}
	return { algo: rec.algo, grammars: [...new Set(grammars)].sort() };
}

/** Grammars the live chunker has that the persisted index was built without. */
export function addedGrammars(persisted: ChunkerCapability | undefined, live: ChunkerCapability): string[] {
	const had = new Set(persisted?.grammars ?? []);
	return live.grammars.filter(g => !had.has(g));
}

/**
 * Whether the persisted chunks must be re-chunked under the live capability.
 *
 * TRUE when the algorithm version moved, or when the live chunker gained a
 * grammar the index was built without — those files hold line windows where
 * they could hold functions and classes.
 *
 * FALSE when the live chunker LOST a grammar. The persisted chunks are then
 * BETTER than anything we could produce now, so re-chunking would be a pure
 * downgrade; it would also flap a whole-workspace rebuild every session on an
 * installation whose assets come and go (antivirus quarantine, partial update).
 *
 * A missing `persisted` means the index predates capability tracking — which is
 * exactly the "upgraded into grammars it never had" case, so it re-chunks. A
 * genuinely fresh install never reaches here: it has no manifest to compare.
 */
export function shouldRechunkForCapability(persisted: ChunkerCapability | undefined, live: ChunkerCapability): boolean {
	if (!persisted) return true;
	if (persisted.algo !== live.algo) return true;
	return addedGrammars(persisted, live).length > 0;
}

/**
 * The capability to record after a whole-corpus re-chunk. The grammar sets are
 * UNIONED so a capability that shrank and came back doesn't re-trigger a
 * rebuild the chunks don't need — see {@link shouldRechunkForCapability}.
 */
export function mergeChunkerCapability(persisted: ChunkerCapability | undefined, live: ChunkerCapability): ChunkerCapability {
	if (!persisted || persisted.algo !== live.algo) return { algo: live.algo, grammars: [...live.grammars] };
	return { algo: live.algo, grammars: [...new Set([...persisted.grammars, ...live.grammars])].sort() };
}
