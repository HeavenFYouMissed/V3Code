import { describe, expect, it } from 'vitest';
import { vectorId, unsaltVectorId, filterVectorMatches } from '../src/index.js';

/*--------------------------------------------------------------------------------------
 *  Workspace-salted vector ids. Chunk id = hash(file:start:end) has no workspace
 *  component and the Vectorize index is shared, so an unprefixed vector id let one
 *  workspace's prune deleteByIds another's colliding vector. Ids are stored as
 *  `${wsId}:${chunkId}`; queries strip the prefix back to the bare chunk id the DO
 *  matches against SQLite, tolerating legacy unsalted ids during migration.
 *--------------------------------------------------------------------------------------*/

describe('vector-id salting', () => {
	it('round-trips, tolerates legacy unsalted ids, and is workspace-isolating', () => {
		const ws = 'vselite';
		const chunk = 'c93c72c9b753cc77';

		// Salt → unsalt is identity.
		expect(vectorId(ws, chunk)).toBe('vselite:c93c72c9b753cc77');
		expect(unsaltVectorId(ws, vectorId(ws, chunk))).toBe(chunk);

		// Legacy (pre-migration) vectors have no prefix — unsalt leaves them intact
		// so retrieval works across the transition window.
		expect(unsaltVectorId(ws, chunk)).toBe(chunk);

		// A DIFFERENT workspace's prefix is NOT stripped (would be a cross-tenant
		// leak) — the id stays foreign so it can't be mistaken for a local chunk id.
		expect(unsaltVectorId(ws, vectorId('other-ws', chunk))).toBe('other-ws:c93c72c9b753cc77');

		// The query path: Vectorize (namespace-filtered) can return a MIX of salted
		// (new) and unsalted (legacy) ids; both map back to the bare chunk id.
		const matches = [
			{ id: vectorId(ws, 'aaaa'), score: 0.9 },
			{ id: 'bbbb', score: 0.8 },            // legacy unsalted
			{ id: vectorId(ws, 'cccc'), score: 0.1 }, // below floor → dropped
		];
		const ranked = filterVectorMatches(matches).map(id => unsaltVectorId(ws, id));
		expect(ranked).toEqual(['aaaa', 'bbbb']);
	});
});
