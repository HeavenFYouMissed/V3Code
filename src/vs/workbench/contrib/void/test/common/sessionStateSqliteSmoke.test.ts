/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * Real SQLite commit/rollback smoke for session-scoped durable task storage.
 * Mirrors memoryDatabase.putSessionState compare-and-swap (BEGIN IMMEDIATE).
 */
function putSessionState(
	db: DatabaseSync,
	workspaceId: string,
	sessionId: string,
	stateKey: string,
	value: string,
	expectedRevision: number | null,
): { saved: boolean; revision: number } {
	db.exec('BEGIN IMMEDIATE');
	try {
		const current = db.prepare(
			'SELECT revision FROM session_state WHERE workspace_id = ? AND session_id = ? AND state_key = ?',
		).get(workspaceId, sessionId, stateKey) as { revision: number } | undefined;
		const currentRevision = current?.revision ?? null;
		if (currentRevision !== expectedRevision) {
			db.exec('ROLLBACK');
			return { saved: false, revision: currentRevision ?? 0 };
		}
		const revision = (current?.revision ?? 0) + 1;
		db.prepare(
			`INSERT INTO session_state(workspace_id, session_id, state_key, value_json, revision, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(workspace_id, session_id, state_key) DO UPDATE SET
			 value_json = excluded.value_json, revision = excluded.revision, updated_at = excluded.updated_at`,
		).run(workspaceId, sessionId, stateKey, value, revision, Date.now());
		db.exec('COMMIT');
		return { saved: true, revision };
	} catch (error) {
		try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
		throw error;
	}
}

suite('session_state SQLite smoke', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('commit, compare-and-swap reject, rollback, and two chats stay isolated', () => {
		const dir = mkdtempSync(join(tmpdir(), 'v3-session-state-'));
		const db = new DatabaseSync(join(dir, 'memory.db'));
		try {
			db.exec(`CREATE TABLE session_state (
				workspace_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				state_key TEXT NOT NULL,
				value_json TEXT NOT NULL,
				revision INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (workspace_id, session_id, state_key)
			)`);

			const a1 = putSessionState(db, 'wsA', 'chat-1', 'durable-task', '{"task":"one"}', null);
			assert.strictEqual(a1.saved, true);
			assert.strictEqual(a1.revision, 1);

			const lost = putSessionState(db, 'wsA', 'chat-1', 'durable-task', '{"task":"stale"}', null);
			assert.strictEqual(lost.saved, false, 'create must not clobber an existing row');

			const a2 = putSessionState(db, 'wsA', 'chat-1', 'durable-task', '{"task":"one-updated"}', 1);
			assert.strictEqual(a2.saved, true);
			assert.strictEqual(a2.revision, 2);

			const b1 = putSessionState(db, 'wsA', 'chat-2', 'durable-task', '{"task":"other-chat"}', null);
			assert.strictEqual(b1.saved, true);

			const wsB = putSessionState(db, 'wsB', 'chat-1', 'durable-task', '{"task":"other-workspace"}', null);
			assert.strictEqual(wsB.saved, true);

			db.exec('BEGIN IMMEDIATE');
			db.prepare(
				`UPDATE session_state SET value_json = 'should-not-stick', revision = 99
				 WHERE workspace_id = 'wsA' AND session_id = 'chat-1' AND state_key = 'durable-task'`,
			).run();
			db.exec('ROLLBACK');

			const rows = (db.prepare('SELECT workspace_id, session_id, value_json, revision FROM session_state ORDER BY workspace_id, session_id').all() as Array<{
				workspace_id: string; session_id: string; value_json: string; revision: number;
			}>).map(row => ({ ...row }));
			assert.deepStrictEqual(rows, [
				{ workspace_id: 'wsA', session_id: 'chat-1', value_json: '{"task":"one-updated"}', revision: 2 },
				{ workspace_id: 'wsA', session_id: 'chat-2', value_json: '{"task":"other-chat"}', revision: 1 },
				{ workspace_id: 'wsB', session_id: 'chat-1', value_json: '{"task":"other-workspace"}', revision: 1 },
			]);
		} finally {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
