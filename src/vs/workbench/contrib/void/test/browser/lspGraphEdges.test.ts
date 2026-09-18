/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Pure tests for the LSP-derived dependency graph edges (PR: lsp-graph-edges).
// Follows hybridRetrieverRecency.test.ts's pattern: synthetic IndexedChunks,
// no services, direct calls into DependencyGraph and the enricher's exported
// pure functions.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DependencyGraph } from '../../browser/semanticIndex/dependencyGraph.js';
import { IndexedChunk } from '../../browser/semanticIndex/browserIndexTypes.js';
import {
	isFileEligible,
	selectBatch,
	pickTopLevelSymbols,
	chunkAtLine,
	applySymbolResolutions,
	FileEnrichState,
	LspEdgeEnricher,
	LspEdgeHost,
	MAX_FILES_PER_CYCLE,
	MAX_SYMBOLS_PER_FILE,
	MAX_LSP_REFS_PER_CHUNK,
	QUEUE_MAX,
	RETRY_COOLDOWN_MS,
} from '../../browser/semanticIndex/lspEdgeEnricher.js';

function chunk(id: string, file: string, extra?: Partial<IndexedChunk>): IndexedChunk {
	return {
		id, file, startLine: 1, endLine: 10, kind: 'function', name: id,
		language: 'typescript', contentHash: `h-${id}`,
		content: `function ${id}() {}`,
		tokens: new Uint32Array(0),
		scored: true,
		...extra,
	};
}

function graphOf(chunks: IndexedChunk[]): DependencyGraph {
	const g = new DependencyGraph();
	g.ensure(chunks);
	return g;
}

suite('semanticIndex / lsp graph edges', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// -- DependencyGraph: union + preference + budgets --

	test('chunks without lsp fields behave exactly as before', () => {
		const a = chunk('a', 'a.ts', { defines: ['alphaFn'], refs: ['betaFn', 'gammaFn'] });
		const b = chunk('b', 'b.ts', { defines: ['betaFn'], refs: ['alphaFn'] });
		const g = chunk('g', 'g.ts', { defines: ['gammaFn'] });
		const graph = graphOf([a, b, g]);
		// Original semantics: outbound first (defs of refs, in ref order), then
		// inbound (referencers of defines), deduped.
		assert.deepStrictEqual(graph.neighborsOf(a, 10), ['b', 'g']);
		assert.deepStrictEqual(graph.neighborsOf(b, 10), ['a']);
		assert.deepStrictEqual(graph.neighborsOf(g, 10), ['a']);
		// max budget still respected.
		assert.deepStrictEqual(graph.neighborsOf(a, 1), ['b']);
	});

	test('lsp edges union with text edges: lspRefs finds text-defined targets and vice versa', () => {
		// callee is only TEXT-defined; caller's edge to it is only LSP-derived.
		const callee = chunk('callee', 'lib.ts', { defines: ['renderWidget'] });
		const caller = chunk('caller', 'app.ts', { lspRefs: ['renderWidget'] });
		const graph = graphOf([callee, caller]);
		// Outbound from the caller: renderWidget's definition.
		assert.deepStrictEqual(graph.neighborsOf(caller, 10), ['callee']);
		// Inbound to the callee: the LSP-verified referencer.
		assert.deepStrictEqual(graph.neighborsOf(callee, 10), ['caller']);
	});

	test('lsp edges bypass the GENERIC_SYMBOLS blocklist (text edges still do not)', () => {
		// 'get' is blocklisted for text edges…
		const textDef = chunk('textDef', 'a.ts', { defines: ['get'] });
		const textUse = chunk('textUse', 'b.ts', { refs: ['get'] });
		const gText = graphOf([textDef, textUse]);
		assert.deepStrictEqual(gText.neighborsOf(textUse, 10), []);
		assert.deepStrictEqual(gText.neighborsOf(textDef, 10), []);
		// …but a REAL, LSP-verified edge on the same name works.
		const lspDef = chunk('lspDef', 'a.ts', { lspDefines: ['get'] });
		const lspUse = chunk('lspUse', 'b.ts', { lspRefs: ['get'] });
		const gLsp = graphOf([lspDef, lspUse]);
		assert.deepStrictEqual(gLsp.neighborsOf(lspUse, 10), ['lspDef']);
		assert.deepStrictEqual(gLsp.neighborsOf(lspDef, 10), ['lspUse']);
	});

	test('lsp edges respect MAX_FANOUT', () => {
		// 41 chunks lsp-define the same symbol → over MAX_FANOUT (40) → dropped.
		const over = Array.from({ length: 41 }, (_, i) => chunk(`d${i}`, `d${i}.ts`, { lspDefines: ['hotSymbol'] }));
		const user = chunk('user', 'u.ts', { lspRefs: ['hotSymbol'] });
		assert.deepStrictEqual(graphOf([...over, user]).neighborsOf(user, 50), []);
		// Exactly 40 definers is still within budget.
		const ok = Array.from({ length: 40 }, (_, i) => chunk(`d${i}`, `d${i}.ts`, { lspDefines: ['hotSymbol'] }));
		assert.strictEqual(graphOf([...ok, user]).neighborsOf(user, 50).length, 40);
	});

	test('fan-out counts the UNION of text and lsp contributors', () => {
		// 25 text definers + 25 lsp definers (distinct chunks) = 50 > 40 → dropped
		// even though each layer alone is under the cap.
		const text = Array.from({ length: 25 }, (_, i) => chunk(`t${i}`, `t${i}.ts`, { defines: ['sharedSym'] }));
		const lsp = Array.from({ length: 25 }, (_, i) => chunk(`l${i}`, `l${i}.ts`, { lspDefines: ['sharedSym'] }));
		const user = chunk('user', 'u.ts', { refs: ['sharedSym'], lspRefs: ['sharedSym'] });
		assert.deepStrictEqual(graphOf([...text, ...lsp, user]).neighborsOf(user, 60), []);
	});

	test('neighborsOf prefers LSP-derived targets over text-derived ones', () => {
		// Query chunk references two symbols: one resolves via a REAL lsp edge,
		// the other only via a text guess. The lsp target must fill first.
		const textTarget = chunk('textTarget', 'text.ts', { defines: ['alphaFn'] });
		const lspTarget = chunk('lspTarget', 'lsp.ts', { lspDefines: ['betaFn'] });
		// Text ref to alphaFn listed FIRST — order within the chunk must not beat
		// the lsp preference.
		const query = chunk('query', 'q.ts', { refs: ['alphaFn'], lspRefs: ['betaFn'] });
		const graph = graphOf([textTarget, lspTarget, query]);
		assert.deepStrictEqual(graph.neighborsOf(query, 2), ['lspTarget', 'textTarget']);
		// Budget of 1 → only the lsp target survives.
		assert.deepStrictEqual(graph.neighborsOf(query, 1), ['lspTarget']);
	});

	test('inbound preference: LSP-verified callers rank before text-guessed callers', () => {
		const def = chunk('def', 'lib.ts', { defines: ['parseThing'], lspDefines: ['parseThing'] });
		const textCaller = chunk('textCaller', 'a.ts', { refs: ['parseThing'] });
		const lspCaller = chunk('lspCaller', 'b.ts', { lspRefs: ['parseThing'] });
		const graph = graphOf([def, textCaller, lspCaller]);
		assert.deepStrictEqual(graph.neighborsOf(def, 2), ['lspCaller', 'textCaller']);
		assert.deepStrictEqual(graph.neighborsOf(def, 1), ['lspCaller']);
	});

	test('relatedFiles ranks a file connected by lsp edges', () => {
		const def = chunk('def', 'lib.ts', { lspDefines: ['helperFn'] });
		const use = chunk('use', 'app.ts', { lspRefs: ['helperFn'] });
		const graph = graphOf([def, use]);
		const idToFile = (id: string) => (id === 'def' ? 'lib.ts' : id === 'use' ? 'app.ts' : undefined);
		assert.deepStrictEqual(graph.relatedFiles([use], idToFile, 5), ['lib.ts']);
		assert.deepStrictEqual(graph.relatedFiles([def], idToFile, 5), ['app.ts']);
	});

	// -- Enricher: eligibility / budget logic (pure) --

	test('isFileEligible: never-attempted and changed-content files are eligible', () => {
		assert.strictEqual(isFileEligible(undefined, 'h1', 1000), true);
		const st: FileEnrichState = { contentHash: 'h1', lastAttempt: 500, succeeded: true };
		assert.strictEqual(isFileEligible(st, 'h2', 1000), true, 'content changed → re-eligible');
	});

	test('isFileEligible: unchanged + succeeded files are never re-enriched', () => {
		const st: FileEnrichState = { contentHash: 'h1', lastAttempt: 0, succeeded: true };
		assert.strictEqual(isFileEligible(st, 'h1', Number.MAX_SAFE_INTEGER), false);
	});

	test('isFileEligible: cold-server empty result retries only after the cooldown', () => {
		const st: FileEnrichState = { contentHash: 'h1', lastAttempt: 10_000, succeeded: false };
		assert.strictEqual(isFileEligible(st, 'h1', 10_000 + RETRY_COOLDOWN_MS - 1), false);
		assert.strictEqual(isFileEligible(st, 'h1', 10_000 + RETRY_COOLDOWN_MS), true);
	});

	test('isFileEligible: un-indexed files (no hash) are never eligible', () => {
		assert.strictEqual(isFileEligible(undefined, undefined, 1000), false);
	});

	test('selectBatch caps at MAX_FILES_PER_CYCLE and filters ineligible files', () => {
		const queue = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
		const states = new Map<string, FileEnrichState>([
			// f0 already succeeded on current content → skipped.
			['f0.ts', { contentHash: 'h-f0.ts', lastAttempt: 0, succeeded: true }],
			// f1 failed 1ms ago → cooldown → skipped.
			['f1.ts', { contentHash: 'h-f1.ts', lastAttempt: 999, succeeded: false }],
		]);
		const batch = selectBatch(queue, f => states.get(f), f => `h-${f}`, 1000);
		assert.strictEqual(batch.length, MAX_FILES_PER_CYCLE);
		assert.ok(!batch.includes('f0.ts'));
		assert.ok(!batch.includes('f1.ts'));
		assert.strictEqual(batch[0], 'f2.ts');
	});

	test('pickTopLevelSymbols: top-level only, deduped, capped at MAX_SYMBOLS_PER_FILE', () => {
		const syms = [
			{ name: 'ClassA', line: 0, character: 0 },
			{ name: 'methodOfA', line: 2, character: 0, containerName: 'ClassA' }, // nested → skipped
			{ name: 'ClassA', line: 50, character: 0 },                            // dup → skipped
			{ name: '<anonymous>', line: 60, character: 0 },                       // anonymous → skipped
			{ name: 'fnB', line: 70, character: 0 },
			{ name: 'fnC', line: 80, character: 0 },
			{ name: 'fnD', line: 90, character: 0 },
			{ name: 'fnE', line: 100, character: 0 },
			{ name: 'fnF', line: 110, character: 0 }, // over the cap of 5
		];
		const picked = pickTopLevelSymbols(syms);
		assert.strictEqual(picked.length, MAX_SYMBOLS_PER_FILE);
		assert.deepStrictEqual(picked.map(s => s.name), ['ClassA', 'fnB', 'fnC', 'fnD', 'fnE']);
	});

	test('chunkAtLine: 0-indexed input, smallest containing span wins', () => {
		const parent = chunk('parent', 'a.ts', { startLine: 1, endLine: 30 });
		const method = chunk('method', 'a.ts', { startLine: 10, endLine: 20 });
		assert.strictEqual(chunkAtLine([parent, method], 14), method, 'line 15 (1-idx) is inside both — smallest wins');
		assert.strictEqual(chunkAtLine([parent, method], 4), parent, 'line 5 is only inside the parent');
		assert.strictEqual(chunkAtLine([parent, method], 40), undefined);
	});

	test('applySymbolResolutions: defining chunk gains lspDefines, referencing chunks gain lspRefs', () => {
		const defChunk = chunk('defChunk', 'lib.ts', { startLine: 1, endLine: 10 });
		const refChunk = chunk('refChunk', 'app.ts', { startLine: 1, endLine: 10 });
		const byFile = new Map<string, IndexedChunk[]>([['lib.ts', [defChunk]], ['app.ts', [refChunk]]]);
		const touched = applySymbolResolutions('lib.ts', f => byFile.get(f) ?? [], [{
			symbol: { name: 'doWork', line: 2, character: 9 },
			refLocations: [
				{ filePath: 'app.ts', line: 4 },  // real caller
				{ filePath: 'lib.ts', line: 2 },  // the definition site itself → skipped
			],
			definition: null,
		}]);
		assert.deepStrictEqual(defChunk.lspDefines, ['doWork']);
		assert.deepStrictEqual(refChunk.lspRefs, ['doWork']);
		assert.strictEqual(defChunk.lspRefs, undefined, 'self-site reference must not create a self edge');
		assert.deepStrictEqual([...touched].sort(), ['app.ts', 'lib.ts']);
	});

	test('applySymbolResolutions: cross-file definition adds an outbound lspRef (re-export case)', () => {
		const reExport = chunk('reExport', 'index.ts', { startLine: 1, endLine: 5 });
		const byFile = new Map<string, IndexedChunk[]>([['index.ts', [reExport]]]);
		const touched = applySymbolResolutions('index.ts', f => byFile.get(f) ?? [], [{
			symbol: { name: 'publicApi', line: 1, character: 14 },
			refLocations: [],
			definition: { name: 'publicApi', filePath: 'src/internal/api.ts' },
		}]);
		assert.deepStrictEqual(reExport.lspDefines, ['publicApi']);
		assert.deepStrictEqual(reExport.lspRefs, ['publicApi']);
		assert.deepStrictEqual([...touched], ['index.ts']);
	});

	test('applySymbolResolutions: per-chunk lspRefs are deduped and capped', () => {
		const refChunk = chunk('refChunk', 'app.ts', { startLine: 1, endLine: 200 });
		const byFile = new Map<string, IndexedChunk[]>([['app.ts', [refChunk]], ['lib.ts', []]]);
		const resolutions = Array.from({ length: MAX_LSP_REFS_PER_CHUNK + 10 }, (_, i) => ({
			symbol: { name: `sym${i}`, line: 0, character: 0 },
			refLocations: [
				{ filePath: 'app.ts', line: 5 },
				{ filePath: 'app.ts', line: 6 }, // same chunk again → deduped
			],
			definition: null,
		}));
		applySymbolResolutions('lib.ts', f => byFile.get(f) ?? [], resolutions);
		assert.strictEqual(refChunk.lspRefs!.length, MAX_LSP_REFS_PER_CHUNK);
		assert.deepStrictEqual([...new Set(refChunk.lspRefs)].length, refChunk.lspRefs!.length, 'no duplicates');
	});

	// -- Enricher queue: hydration seeding + bounds (fake host, no timers fire
	//    inside the tests — dispose() clears the scheduled pass) --

	function fakeHost(overrides: Partial<LspEdgeHost> = {}): LspEdgeHost {
		return {
			isEnabled: () => true,
			getDocumentSymbols: async () => [],
			getReferences: async () => [],
			getDefinition: async () => null,
			chunksOf: () => [],
			contentHashOf: () => 'h1',
			hasOwnLspEdges: () => false,
			onEnriched: () => { },
			...overrides,
		};
	}

	test('enqueue seeds from hydrated chunks: files that already carry their own lsp edges are never queued', () => {
		// Branch-switch scenario: 'hydrated.ts' came back from the CAS WITH its
		// lspDefines — re-resolving it would negate the cross-branch fast path.
		const enricher = new LspEdgeEnricher(fakeHost({ hasOwnLspEdges: (f) => f === 'hydrated.ts' }));
		enricher.enqueue(['hydrated.ts', 'fresh.ts']);
		assert.strictEqual(enricher.pendingCount, 1, 'only the un-enriched file is queued');
		// The seed persists: re-feeding the hydrated file is still a no-op even
		// if hasOwnLspEdges were to become expensive/false later on same content.
		enricher.enqueue(['hydrated.ts']);
		assert.strictEqual(enricher.pendingCount, 1);
		enricher.dispose();
	});

	test('enqueue drops files that are no longer indexed (no contentHash)', () => {
		const enricher = new LspEdgeEnricher(fakeHost({ contentHashOf: () => undefined }));
		enricher.enqueue(['gone.ts']);
		assert.strictEqual(enricher.pendingCount, 0);
		enricher.dispose();
	});

	test('enqueue keeps cooldown files queued (empty-outline retry still works)', () => {
		// A prior pass failed on this content (cold server). The file must stay
		// a candidate — only isFileEligible's cooldown gates WHEN it re-runs.
		const enricher = new LspEdgeEnricher(fakeHost(), () => 1000);
		enricher.enqueue(['cold.ts']);
		assert.strictEqual(enricher.pendingCount, 1, 'no state + no lsp edges → queued');
		enricher.dispose();
	});

	test('queue is bounded at QUEUE_MAX, keeping the most recent candidates', () => {
		const enricher = new LspEdgeEnricher(fakeHost());
		enricher.enqueue(Array.from({ length: QUEUE_MAX + 50 }, (_, i) => `f${i}.ts`));
		assert.strictEqual(enricher.pendingCount, QUEUE_MAX);
		enricher.dispose();
	});

	test('end-to-end pure flow: enriched chunks make neighborsOf find the real caller', () => {
		// `handler` calls an imported `dispatch` in a way the text extractor
		// missed (e.g. passed as a value) — no text refs at all.
		const dispatchDef = chunk('dispatchDef', 'lib/dispatch.ts', { startLine: 1, endLine: 10, defines: ['dispatch'] });
		const handler = chunk('handler', 'app/handler.ts', { startLine: 1, endLine: 20 });
		const byFile = new Map<string, IndexedChunk[]>([
			['lib/dispatch.ts', [dispatchDef]],
			['app/handler.ts', [handler]],
		]);
		// The LSP reports a reference to `dispatch` inside handler.
		applySymbolResolutions('lib/dispatch.ts', f => byFile.get(f) ?? [], [{
			symbol: { name: 'dispatch', line: 0, character: 16 },
			refLocations: [{ filePath: 'app/handler.ts', line: 4 }],
			definition: null,
		}]);
		const graph = graphOf([dispatchDef, handler]);
		assert.deepStrictEqual(graph.neighborsOf(dispatchDef, 10), ['handler'], 'real caller found');
		assert.deepStrictEqual(graph.neighborsOf(handler, 10), ['dispatchDef'], 'real definition found');
	});
});
