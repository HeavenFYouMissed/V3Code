/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	dedupeSessionAnchors, formatSessionContinuity, isPortableRelativePath, mayWritePlanProjection,
	mayAttributeLegacyThreadlessMemory, mayRecoverSessionOrigin, SessionAnchor, summarizeSessionContinuity,
} from '../../common/memory/sessionAnchors.js';

const anchor = (overrides: Partial<SessionAnchor> = {}): SessionAnchor => ({
	anchorId: 'anchor-1', profileId: 'profile-a', threadId: 'thread-a', originWorkspaceId: 'workspace-a',
	originRoot: '/work/a', kind: 'note', revision: 1, updateIdentity: 'one', payload: { id: 'note-1' },
	updatedAt: 100, ...overrides,
});

suite('session work anchors', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('deduplicates repeated imports and lets a tombstone win', () => {
		const live = anchor();
		const repeated = anchor();
		const tombstone = anchor({ revision: 2, updateIdentity: 'two', updatedAt: 200, deletedAt: 200 });
		assert.deepStrictEqual(dedupeSessionAnchors([live, repeated, tombstone]), []);
		assert.deepStrictEqual(dedupeSessionAnchors([live, repeated, tombstone], true), [tombstone]);
	});

	test('reports only active-thread anchors carried from another workspace', () => {
		const plan = anchor({
			anchorId: 'plan', kind: 'plan', payload: {
				threadId: 'thread-a', taskId: null, updatedAt: 120,
				todos: [{ id: 'todo-1', content: 'keep working', status: 'in_progress' }],
			},
		});
		const local = anchor({ anchorId: 'local', originWorkspaceId: 'workspace-b', originRoot: '/work/b' });
		const summary = summarizeSessionContinuity('thread-a', 'workspace-b', '/work/b', [anchor(), plan, local]);
		assert.deepStrictEqual(summary.origins, ['/work/a']);
		assert.deepStrictEqual(summary.carried, { notes: 1, editorial: 0, planItems: 1, snapshots: 0 });
		assert.match(formatSessionContinuity(summary), /origin: \/work\/a/);
		assert.match(formatSessionContinuity(summary), /plan \(1 items\)/);
	});

	test('protects another thread plan and rejects unsafe path rebasing', () => {
		assert.strictEqual(mayWritePlanProjection('thread-b', 'thread-a'), false);
		assert.strictEqual(mayWritePlanProjection('thread-a', 'thread-a'), true);
		assert.strictEqual(isPortableRelativePath('src/service.ts'), true);
		assert.strictEqual(isPortableRelativePath('../other/service.ts'), false);
		assert.strictEqual(isPortableRelativePath('/private/source.ts'), false);
		assert.strictEqual(isPortableRelativePath('C:\\source.ts'), false);
	});

	test('requires a recorded origin or confirmed repair and never infers legacy ownership', () => {
		const recorded = new Set(['/work/a']);
		assert.strictEqual(mayRecoverSessionOrigin('/work/a', recorded, false), true);
		assert.strictEqual(mayRecoverSessionOrigin('/work/unknown', recorded, false), false);
		assert.strictEqual(mayRecoverSessionOrigin('/work/unknown', recorded, true), true);
		assert.strictEqual(mayAttributeLegacyThreadlessMemory(false), false);
		assert.strictEqual(mayAttributeLegacyThreadlessMemory(true), true);
	});
});
