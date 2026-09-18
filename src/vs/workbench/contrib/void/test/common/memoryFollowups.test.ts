/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { coerceRawArrayParam } from '../../common/toolsServiceTypes.js';
import { describeCarriedContinuity, isPendingTransitionFresh, PENDING_TRANSITION_COMPLETION_WINDOW_MS, transitionShapeMatches } from '../../common/memory/sessionAnchors.js';
import { formatEditorialBriefing, mergeEditorialBranches } from '../../common/memory/editorialMerge.js';
import { EditorialBranch } from '../../common/memory/memoryTypes.js';

suite('search_memory kinds wire-format coercion', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts the JSON-array string the XML transport actually delivers', () => {
		assert.deepStrictEqual(coerceRawArrayParam('["checkpoint"]'), ['checkpoint']);
		assert.deepStrictEqual(coerceRawArrayParam('["fact", "symbol-note"]'), ['fact', 'symbol-note']);
	});

	test('accepts a bare string and a comma-separated list', () => {
		assert.deepStrictEqual(coerceRawArrayParam('checkpoint'), ['checkpoint']);
		assert.deepStrictEqual(coerceRawArrayParam('fact, checkpoint'), ['fact', 'checkpoint']);
	});

	test('tolerates sloppy bracketed text that is not valid JSON', () => {
		assert.deepStrictEqual(coerceRawArrayParam("['checkpoint']"), ['checkpoint']);
		assert.deepStrictEqual(coerceRawArrayParam('[checkpoint]'), ['checkpoint']);
	});

	test('passes real arrays through and treats empty/null-ish as undefined', () => {
		assert.deepStrictEqual(coerceRawArrayParam(['checkpoint']), ['checkpoint']);
		assert.strictEqual(coerceRawArrayParam(undefined), undefined);
		assert.strictEqual(coerceRawArrayParam(null), undefined);
		assert.strictEqual(coerceRawArrayParam(''), undefined);
		assert.strictEqual(coerceRawArrayParam('null'), undefined);
	});
});

suite('workspace-swap transition shape matching', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a replacement completes only as exactly that single root', () => {
		assert.strictEqual(transitionShapeMatches('replacement', '/a/proj', ['/a/proj']), true);
		assert.strictEqual(transitionShapeMatches('replacement', '/a/proj', ['/a/proj', '/b/other']), false);
		assert.strictEqual(transitionShapeMatches('replacement', '/a/proj', ['/b/other']), false);
	});

	test('an attach just needs the target present', () => {
		assert.strictEqual(transitionShapeMatches('multi-root-attach', '/a/proj', ['/b/other', '/a/proj']), true);
		assert.strictEqual(transitionShapeMatches('multi-root-attach', '/a/proj', ['/b/other']), false);
	});

	test('a swap reports its manifest: what carried, from where, and what never carries', () => {
		const text = describeCarriedContinuity({ carried: { notes: 0, editorial: 4, planItems: 5, snapshots: 0 }, origins: ['/tmp/old-ws'], status: 'available' });
		assert.ok(text.includes('carried from /tmp/old-ws: 0 symbol note(s), 4 editorial topic(s), 5 plan item(s), 0 snapshot(s)'));
		assert.ok(text.includes('stayed behind'), 'names what does not carry');
		assert.ok(text.includes('recover_session_anchors'), 'points at the repair path');
		const empty = describeCarriedContinuity({ carried: { notes: 0, editorial: 0, planItems: 0, snapshots: 0 }, origins: [], status: 'none' });
		assert.ok(empty.startsWith('No thread memory carried'));
	});

	test('a pending completes only while fresh — a later unrelated open of the same folder must not resurrect it', () => {
		const begun = 1_000_000;
		assert.strictEqual(isPendingTransitionFresh(begun, begun + 5_000), true, 'the reload itself (seconds) completes');
		assert.strictEqual(isPendingTransitionFresh(begun, begun + PENDING_TRANSITION_COMPLETION_WINDOW_MS), true, 'edge of the window still completes');
		assert.strictEqual(isPendingTransitionFresh(begun, begun + PENDING_TRANSITION_COMPLETION_WINDOW_MS + 1), false, 'past the window never completes');
		assert.strictEqual(isPendingTransitionFresh(begun, begun + 24 * 60 * 60 * 1000), false, 'a next-day open of the same folder is a fresh open, not the swap');
	});
});

suite('editorial briefing merge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const branch = (id: string, name: string, tsUpdated: number, originWorkspaceId?: string): EditorialBranch & { originWorkspaceId?: string } => ({
		id, projectId: 'p', name, miniReadme: '', worked: '', didntWork: '', buildNotes: '',
		codeRefs: [], confidence: 0.9, tsUpdated,
		...(originWorkspaceId ? { originWorkspaceId } : {}),
	});

	test('a dual-written topic appears once, as the workspace copy', () => {
		const merged = mergeEditorialBranches(
			[branch('ws-1', 'auth-notes', 100)],
			[branch('sa:editorial:thread:auth', 'auth-notes', 200)],
		);
		assert.deepStrictEqual(merged.map(b => b.id), ['ws-1']);
	});

	test('a thread-only topic is kept', () => {
		const merged = mergeEditorialBranches(
			[branch('ws-1', 'auth-notes', 100)],
			[branch('sa:editorial:thread:build', 'build-notes', 200)],
		);
		assert.deepStrictEqual(merged.map(b => b.name).sort(), ['auth-notes', 'build-notes']);
	});

	test('a same-name branch carried from ANOTHER workspace stays visible', () => {
		const merged = mergeEditorialBranches(
			[branch('ws-1', 'auth-notes', 100)],
			[branch('sa:editorial:thread:auth', 'auth-notes', 200, 'other-workspace')],
		);
		assert.deepStrictEqual(merged.map(b => b.id).sort(), ['sa:editorial:thread:auth', 'ws-1']);
	});

	test('result is newest-first', () => {
		const merged = mergeEditorialBranches(
			[branch('ws-1', 'old', 100), branch('ws-2', 'new', 300)],
			[branch('sa-1', 'mid', 200)],
		);
		assert.deepStrictEqual(merged.map(b => b.id), ['ws-2', 'sa-1', 'ws-1']);
	});
});

suite('editorial briefing honesty after a workspace swap', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const carried = (id: string, name: string, originRoot: string): EditorialBranch => ({
		id, projectId: 'thread:t1', name, miniReadme: 'notes', worked: '', didntWork: '', buildNotes: '',
		codeRefs: [], confidence: 0.9, tsUpdated: 100, originWorkspaceId: 'ws-old', originRoot,
	});

	test('a workspace with no project and no branches still reports empty', () => {
		const text = formatEditorialBriefing({ projectId: null, projectName: '', readme: '', branches: [] }, 'proj');
		assert.ok(text.startsWith('No editorial project filed yet for this workspace.'));
	});

	test('carried branches are LISTED even when this workspace has no project (the smoke bug)', () => {
		const text = formatEditorialBriefing({
			projectId: null, projectName: '', readme: '',
			branches: [carried('sa-1', 'parallel-subagent-coherence', '/old/proj'), carried('sa-2', 'publishd-brand-palette', '/old/proj')],
		}, 'proj');
		assert.ok(!text.startsWith('No editorial project filed yet for this workspace.'), 'must not claim emptiness');
		assert.ok(text.includes('2 branch(es) are available to this thread'));
		assert.ok(text.includes('parallel-subagent-coherence'));
		assert.ok(text.includes('carried with this thread from /old/proj'), 'each carried branch names its origin');
		assert.ok(text.includes('stay behind'), 'says what does NOT carry');
	});

	test('with a workspace project, carried branches are annotated and the carry note appears once', () => {
		const local: EditorialBranch = { id: 'ws-1', projectId: 'p', name: 'local-topic', miniReadme: '', worked: 'x', didntWork: '', buildNotes: '', codeRefs: [], confidence: 0.9, tsUpdated: 200 };
		const text = formatEditorialBriefing({
			projectId: 'p', projectName: 'proj', readme: '',
			branches: [local, carried('sa-1', 'imported-topic', '/old/proj')],
		}, 'proj');
		assert.ok(text.startsWith('Editorial project: proj [p] — 2 branch(es)'));
		assert.strictEqual(text.split('carried with this thread from /old/proj').length, 3, 'one carry note + one annotated branch header');
		assert.ok(!text.includes('local-topic [ws-1] (confidence 0.90) — carried'), 'local branches are not marked carried');
	});
});
