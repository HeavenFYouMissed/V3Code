/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Provenance-gated contradiction resolution (catalog C6, decision (e)). When a new fact
 * disagrees with an existing one (same workspace + kind + subject, DIFFERING body), this
 * decides who wins -- the guiding rule being that an AI guess can NEVER silently demote a
 * human-authored or test-verified fact, and no clash is ever resolved silently when it
 * deserves a human's eyes. Pure -> headless-testable; detection (the same-key/diff-body
 * match) is the caller's job.
 */

export interface FactProvenance {
	source?: string;          // 'human' | 'ai_inferred' | 'tool' | ...
	verifiedByTest?: boolean;
}

export interface ContradictionDecision {
	winner: 'incoming' | 'existing';
	resolved: boolean; // true = clean (no review needed); false = flag for human review
}

/** A fact is authoritative if a human wrote it or a passing test verified it. */
export function isAuthoritative(p: FactProvenance): boolean {
	return p.source === 'human' || p.verifiedByTest === true;
}

/**
 * Resolve a contradiction between an existing fact and an incoming (newer) one:
 *  - incoming authoritative, existing NOT  -> incoming supersedes, RESOLVED (clean win).
 *  - incoming NOT authoritative, existing IS -> incoming REJECTED (AI can't demote a human
 *    or verified fact), and the clash is FLAGGED.
 *  - both authoritative (human-vs-human) OR neither (ai-vs-ai) -> the newer (incoming) wins,
 *    but the clash is FLAGGED so a human can review the disagreement.
 */
export function resolveContradiction(existing: FactProvenance, incoming: FactProvenance): ContradictionDecision {
	const exAuth = isAuthoritative(existing);
	const inAuth = isAuthoritative(incoming);
	if (inAuth && !exAuth) { return { winner: 'incoming', resolved: true }; }
	if (!inAuth && exAuth) { return { winner: 'existing', resolved: false }; }
	return { winner: 'incoming', resolved: false };
}
