/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for details.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MemoryDatabase } from '../../electron-main/memory/memoryDatabase.js';

suite('compaction boundary SQLite smoke', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('persists the resolved workspace atomically and rolls back a checkpoint failure', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'v3-compaction-boundary-'));
		const db = new MemoryDatabase();
		try {
			await db.open(join(dir, 'memory.db'));
			await db.record({
				workspaceId: 'workspace-A',
				sessionId: 'chat-1',
				kind: 'prompt',
				role: 'lead',
				title: 'Primary task',
				body: 'Keep the durable task through compaction.',
			});

			const saved = await db.recordCompactionBoundary(
				'workspace-A',
				{
					workspaceId: 'workspace-A',
					sessionId: 'chat-1',
					kind: 'note',
					role: 'lead',
					title: 'Compaction',
					body: 'Primary task remains active.',
					meta: { compaction: true, boundaryCount: 1 },
				},
				{
					sessionId: 'chat-1',
					trigger: 'explicit-compact',
					summary: 'Primary task remains active.',
				},
			);
			assert.strictEqual(saved.note.workspaceId, 'workspace-A');
			assert.strictEqual(saved.checkpoint.workspaceId, 'workspace-A');
			assert.strictEqual(saved.checkpoint.endEventId, saved.note.id);

			const llmDigest = await db.recordCompactionBoundary(
				'workspace-A',
				{
					workspaceId: 'workspace-A',
					sessionId: 'chat-1',
					kind: 'note',
					role: 'lead',
					title: 'Session digest',
					body: 'Rolling LLM digest.',
					meta: { digest: true, droppedCount: 12, llm: true, rolling: true },
				},
				{
					sessionId: 'chat-1',
					trigger: 'automatic-condensation',
					summary: 'Rolling LLM digest.',
					meta: { droppedCount: 12, llm: true, rolling: true },
				},
			);
			assert.strictEqual(llmDigest.checkpoint.endEventId, llmDigest.note.id);
			assert.strictEqual(await db.hasCompleteCheckpointForEndEvent('workspace-A', llmDigest.note.id), true,
				'LLM enrichment must pass the same checkpoint gate as the heuristic digest');

			const beforeFailure = await db.getSession('chat-1');
			await assert.rejects(() => db.recordCompactionBoundary(
				'workspace-A',
				{
					workspaceId: 'workspace-A',
					sessionId: 'chat-1',
					kind: 'note',
					title: 'Compaction',
					body: 'Must roll back.',
				},
				{ sessionId: 'chat-1', trigger: 'explicit-compact', summary: '   ' },
			), /summary is required/);
			assert.strictEqual((await db.getSession('chat-1')).length, beforeFailure.length);

			await assert.rejects(() => db.recordCompactionBoundary(
				undefined as unknown as string,
				{
					workspaceId: 'workspace-A',
					sessionId: 'chat-1',
					kind: 'note',
					title: 'Compaction',
					body: 'Missing contract workspace.',
				},
				{ sessionId: 'chat-1', trigger: 'explicit-compact', summary: 'summary' },
			), /requires a workspaceId/);
			assert.strictEqual((await db.getSession('chat-1')).length, beforeFailure.length);
		} finally {
			await db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
