import { describe, expect, it } from 'vitest';
import { cloudFuse, FusionCandidate } from '../src/retrieve/cloudFusion.js';
import { DependencyGraph } from '../src/core/dependencyGraph.js';

function cand(id: string, over: Partial<FusionCandidate> = {}): FusionCandidate {
	return {
		id, casKey: `cas-${id}`, file: `src/${id}.ts`, startLine: 1, endLine: 10,
		kind: 'function', name: id, language: 'typescript', scored: true, ...over,
	};
}

function candidates(...cs: FusionCandidate[]): Map<string, FusionCandidate> {
	return new Map(cs.map(c => [c.id, c]));
}

describe('cloudFuse', () => {
	it('ranks an item present in both channels above single-channel items', () => {
		const cs = candidates(cand('both'), cand('lexOnly'), cand('vecOnly'));
		const hits = cloudFuse(cs, new DependencyGraph(), {
			lexicalRanked: ['lexOnly', 'both'],
			vectorRanked: ['vecOnly', 'both'],
			recentFiles: null,
			queryTokens: ['both'],
		}, 10);
		expect(hits[0].chunk.id).toBe('both');
	});

	it('vector channel outweighs lexical at equal rank (0.6 vs 0.4)', () => {
		const cs = candidates(cand('lex'), cand('vec'));
		const hits = cloudFuse(cs, new DependencyGraph(), {
			lexicalRanked: ['lex'],
			vectorRanked: ['vec'],
			recentFiles: null,
			queryTokens: [],
		}, 10);
		expect(hits[0].chunk.id).toBe('vec');
		expect(hits[1].chunk.id).toBe('lex');
	});

	it('recency boost lifts recently edited files', () => {
		const cs = candidates(cand('a'), cand('b'));
		const hits = cloudFuse(cs, new DependencyGraph(), {
			lexicalRanked: ['a', 'b'],
			vectorRanked: ['a', 'b'],
			recentFiles: new Map([['src/b.ts', 0]]),
			queryTokens: [],
		}, 10);
		// b is rank-2 in both channels but recently edited; boost is 1.25x — with
		// RRF(k=30) rank1 vs rank2 gap (~3%) the boost flips the order.
		expect(hits[0].chunk.id).toBe('b');
	});

	it('collapses matched children into their parent', () => {
		const parent = cand('parent', { kind: 'class' });
		const c1 = cand('child1', { parentId: 'parent' });
		const c2 = cand('child2', { parentId: 'parent' });
		const cs = candidates(parent, c1, c2, cand('other'));
		const hits = cloudFuse(cs, new DependencyGraph(), {
			lexicalRanked: ['child1', 'child2', 'other'],
			vectorRanked: ['child1', 'child2'],
			recentFiles: null,
			queryTokens: [],
		}, 10);
		expect(hits[0].chunk.id).toBe('parent');
		expect(hits[0].signals.parent).toBe(1);
	});

	it('marks the weak tail below the adaptive knee', () => {
		const strong = Array.from({ length: 6 }, (_, i) => cand(`s${i}`));
		const weak = cand('weak', { language: 'markdown' }); // 0.5x language boost
		const cs = candidates(...strong, weak);
		const hits = cloudFuse(cs, new DependencyGraph(), {
			lexicalRanked: [...strong.map(c => c.id), 'weak'],
			vectorRanked: strong.map(c => c.id),
			recentFiles: null,
			queryTokens: [],
		}, 10);
		const weakHit = hits.find(h => h.chunk.id === 'weak');
		expect(weakHit?.signals.weak).toBe(1);
	});
});
