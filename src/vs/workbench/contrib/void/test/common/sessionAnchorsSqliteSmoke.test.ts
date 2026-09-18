/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MemoryDatabase } from '../../electron-main/memory/memoryDatabase.js';
import { SessionAnchorInput, SessionWorkspaceTransition } from '../../common/memory/sessionAnchors.js';

const input = (overrides: Partial<SessionAnchorInput> = {}): SessionAnchorInput => ({
	anchorId: 'anchor-1', profileId: 'profile-a', threadId: 'thread-a', originWorkspaceId: 'workspace-a',
	originRoot: '/work/a', kind: 'note', relativePath: 'src/a.ts', symbol: 'thing', updateIdentity: 'update-1',
	payload: { id: 'note-1', note: 'portable' }, updatedAt: 100, ...overrides,
});

suite('session anchors SQLite smoke', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('is idempotent, rejects stale recovery, isolates profile and thread, and preserves deletion', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'v3-session-anchors-'));
		const db = new MemoryDatabase();
		try {
			await db.open(join(dir, 'memory.db'));
			const first = await db.upsertSessionAnchor(input());
			const replay = await db.upsertSessionAnchor(input());
			assert.strictEqual(first.revision, 1);
			assert.strictEqual(replay.revision, 1, 'same update identity must not create a duplicate revision');

			const swapped = await db.upsertSessionAnchor(input({
				originWorkspaceId: 'workspace-b', originRoot: '/work/b', updateIdentity: 'update-2',
				payload: { id: 'note-1', note: 'updated after swap' }, updatedAt: 200,
			}));
			assert.strictEqual(swapped.revision, 2);
			const stale = await db.upsertSessionAnchor(input({ updateIdentity: 'recovery-old', updatedAt: 150 }));
			assert.strictEqual(stale.updateIdentity, 'update-2', 'an older recovery must not overwrite newer thread state');
			const swappedBack = await db.upsertSessionAnchor(input({
				originWorkspaceId: 'workspace-a', originRoot: '/work/a', updateIdentity: 'update-3',
				payload: { id: 'note-1', note: 'updated after swapping back' }, updatedAt: 250,
			}));
			assert.strictEqual(swappedBack.revision, 3);

			await db.upsertSessionAnchor(input({ anchorId: 'thread-b-anchor', threadId: 'thread-b' }));
			await db.upsertSessionAnchor(input({ profileId: 'profile-b', payload: { id: 'private-profile-note' } }));
			assert.strictEqual((await db.listSessionAnchors('profile-a', 'thread-a')).length, 1);
			assert.strictEqual((await db.listSessionAnchors('profile-a', 'thread-b')).length, 1);
			assert.strictEqual((await db.listSessionAnchors('profile-b', 'thread-a')).length, 1);

			const deleted = await db.upsertSessionAnchor(input({
				originWorkspaceId: 'workspace-b', originRoot: '/work/b', updateIdentity: 'delete-1',
				payload: swappedBack.payload, updatedAt: 300, deletedAt: 300,
			}));
			assert.strictEqual(deleted.revision, 4);
			assert.deepStrictEqual(await db.listSessionAnchors('profile-a', 'thread-a'), []);
			assert.strictEqual((await db.listSessionAnchors('profile-a', 'thread-a', true))[0].deletedAt, 300);

			const transition: SessionWorkspaceTransition = {
				id: 'transition-1', profileId: 'profile-a', threadId: 'thread-a', kind: 'replacement',
				fromWorkspaceId: 'workspace-a', fromRoot: '/work/a', toWorkspaceId: 'workspace-b',
				toRoot: '/work/b', createdAt: 400,
			};
			await db.recordSessionTransition(transition);
			await db.recordSessionTransition(transition);
			assert.deepStrictEqual(await db.listSessionTransitions('profile-a', 'thread-a'), [transition]);
			const multiRoot: SessionWorkspaceTransition = {
				...transition, id: 'transition-2', kind: 'multi-root-attach', fromWorkspaceId: 'workspace-b',
				fromRoot: '/work/b', toWorkspaceId: 'workspace-b', toRoot: '/work/c', createdAt: 500,
			};
			await db.recordSessionTransition(multiRoot);
			assert.deepStrictEqual(await db.listSessionTransitions('profile-a', 'thread-a'), [transition, multiRoot]);
			assert.deepStrictEqual(await db.listSessionTransitions('profile-b', 'thread-a'), []);
		} finally {
			await db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
