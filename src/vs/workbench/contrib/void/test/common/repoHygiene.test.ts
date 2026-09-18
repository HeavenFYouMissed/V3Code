/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildHygienePlan, classifyWorktree, formatHygienePlan, parseForEachRef, parseMergedBranches, parseWorktreeList, parseWorktreeProbe, WorktreeFacts } from '../../common/repoHygiene.js';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const facts = (overrides: Partial<WorktreeFacts>): WorktreeFacts => ({
	path: '/repo/wt/feature-x', head: 'abc', branch: 'feature-x', isMain: false, locked: false, prunable: false,
	isCurrent: false, dirtyCount: 0, upstream: 'origin/feature-x', ahead: 0, behind: 0,
	mergedIntoDefault: false, aheadOfDefault: 0, lastCommitUnix: Math.floor(NOW / 1000) - 7 * 86400,
	...overrides,
});

suite('repo hygiene — parsers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses git worktree list --porcelain, including detached, locked and prunable entries', () => {
		const out = [
			'worktree /repo', 'HEAD 111', 'branch refs/heads/main', '',
			'worktree /repo/wt/a', 'HEAD 222', 'branch refs/heads/feat/a', 'locked', '',
			'worktree /repo/wt/gone', 'HEAD 333', 'detached', 'prunable gitdir file points to non-existent location', '',
		].join('\n');
		const entries = parseWorktreeList(out);
		assert.strictEqual(entries.length, 3);
		assert.deepStrictEqual(entries[0], { path: '/repo', head: '111', branch: 'main', isMain: true, locked: false, prunable: false });
		assert.strictEqual(entries[1].branch, 'feat/a'); assert.strictEqual(entries[1].locked, true); assert.strictEqual(entries[1].isMain, false);
		assert.strictEqual(entries[2].branch, null); assert.strictEqual(entries[2].prunable, true);
	});

	test('parses for-each-ref upstream tracking and dates', () => {
		const out = 'feat/a\torigin/feat/a\t[ahead 3, behind 1]\t1756800000\nlocal-only\t\t\t1756700000\n';
		const map = parseForEachRef(out);
		assert.deepStrictEqual(map.get('feat/a'), { upstream: 'origin/feat/a', ahead: 3, behind: 1, committerUnix: 1756800000 });
		assert.deepStrictEqual(map.get('local-only'), { upstream: null, ahead: 0, behind: 0, committerUnix: 1756700000 });
	});

	test('parses merged branch lists and the batched worktree probe', () => {
		assert.deepStrictEqual([...parseMergedBranches('* main\n  feat/a\n+ feat/b\n')], ['main', 'feat/a', 'feat/b']);
		const probe = parseWorktreeProbe('== /repo/wt/a\ndirty 2\nahead 0\n== /repo/wt/b\ndirty 0\nahead 4\n');
		assert.deepStrictEqual(probe.get('/repo/wt/a'), { dirtyCount: 2, aheadOfDefault: 0 });
		assert.deepStrictEqual(probe.get('/repo/wt/b'), { dirtyCount: 0, aheadOfDefault: 4 });
	});
});

suite('repo hygiene — overly cautious classification', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uncommitted changes always win: never proposes touching them', () => {
		const item = classifyWorktree(facts({ dirtyCount: 3, ahead: 5 }), NOW);
		assert.strictEqual(item.bucket, 'has-unsaved-work');
		assert.deepStrictEqual(item.actions, []);
	});

	test('commits only on this computer → push first, then remove', () => {
		const item = classifyWorktree(facts({ ahead: 2 }), NOW);
		assert.strictEqual(item.bucket, 'push-first');
		assert.deepStrictEqual(item.actions, ['push', 'remove']);
		assert.ok(item.reason.includes('only on this computer'));
	});

	test('never-pushed branch with its own commits → push first; with none → safe', () => {
		assert.strictEqual(classifyWorktree(facts({ upstream: null, ahead: null, aheadOfDefault: 3 }), NOW).bucket, 'push-first');
		assert.strictEqual(classifyWorktree(facts({ upstream: null, ahead: null, aheadOfDefault: 0 }), NOW).bucket, 'safe-to-remove');
	});

	test('merged and fully pushed → safe to remove, and the branch may be deleted (merged only)', () => {
		const item = classifyWorktree(facts({ mergedIntoDefault: true }), NOW);
		assert.strictEqual(item.bucket, 'safe-to-remove');
		assert.strictEqual(item.branchDeletable, true);
		const pushedNotMerged = classifyWorktree(facts({ mergedIntoDefault: false }), NOW);
		assert.strictEqual(pushedNotMerged.bucket, 'safe-to-remove', 'everything pushed: the folder is a copy');
		assert.strictEqual(pushedNotMerged.branchDeletable, false, 'branch stays: not merged');
	});

	test('main, current, detached, locked and last-day-active worktrees are kept', () => {
		assert.strictEqual(classifyWorktree(facts({ isMain: true }), NOW).bucket, 'keep');
		assert.strictEqual(classifyWorktree(facts({ isCurrent: true }), NOW).bucket, 'keep');
		assert.strictEqual(classifyWorktree(facts({ branch: null }), NOW).bucket, 'keep');
		assert.strictEqual(classifyWorktree(facts({ locked: true }), NOW).bucket, 'keep');
		assert.strictEqual(classifyWorktree(facts({ lastCommitUnix: Math.floor(NOW / 1000) - 3600 }), NOW).bucket, 'keep');
	});

	test('a gone folder is prunable — forgetting the record deletes nothing', () => {
		const item = classifyWorktree(facts({ prunable: true, dirtyCount: 99 }), NOW);
		assert.strictEqual(item.bucket, 'prunable');
		assert.deepStrictEqual(item.actions, ['prune']);
	});

	test('the plan reads like a careful colleague and states the no-force guarantee', () => {
		const plan = buildHygienePlan([facts({ isMain: true, path: '/repo', branch: 'main' }), facts({ mergedIntoDefault: true }), facts({ ahead: 1, path: '/repo/wt/y', branch: 'y' })], 'main', NOW);
		const text = formatHygienePlan(plan);
		assert.ok(text.startsWith('3 worktree(s) found (default branch: main).'));
		assert.ok(text.includes('SAFE TO REMOVE — nothing would be lost (1):'));
		assert.ok(text.includes('NEEDS A PUSH FIRST — commits only on this computer (1):'));
		assert.ok(text.includes('Nothing is ever force-deleted'));
	});
});
