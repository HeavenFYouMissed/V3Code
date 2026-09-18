/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { boundaryNoteApplicable, formatWorkspaceTransitionStamp, selectMonotonicDigest, selectValidMonotonicDigest, workspaceMutationResultFromToolContent } from '../../common/memory/sessionDigestPolicy.js';
import { withBusyRetry } from '../../common/memory/withBusyRetry.js';

type DigestNote = { id: string; meta?: Record<string, unknown> };

function digest(id: string, droppedCount: number, llm = false): DigestNote {
	return { id, meta: { digest: true, droppedCount, ...(llm ? { llm: true, rolling: true } : {}) } };
}

suite('sessionDigestPolicy — task-lock repairs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('T5: digest selection is monotonic by covered boundary — a stale late fold never regresses', () => {
		const heuristicNew = digest('newer', 21);
		const staleFold = digest('stale-fold', 18, true); // LLM fold for an OLDER boundary, completing late
		assert.strictEqual(selectMonotonicDigest([staleFold, heuristicNew])?.id, 'newer');
		assert.strictEqual(selectMonotonicDigest([heuristicNew, staleFold])?.id, 'newer', 'order-independent');
	});

	test('within the same covered boundary the LLM fold wins over the heuristic sheet', () => {
		const heuristic = digest('heuristic', 21);
		const fold = digest('fold', 21, true);
		assert.strictEqual(selectMonotonicDigest([heuristic, fold])?.id, 'fold');
	});

	test('T2 + scenario 5: a note without its checkpoint (aborted/legacy orphan) is never applicable', () => {
		assert.strictEqual(boundaryNoteApplicable({ aborted: false, hasCheckpoint: true }), true);
		assert.strictEqual(boundaryNoteApplicable({ aborted: false, hasCheckpoint: false }), false, 'orphan note');
		assert.strictEqual(boundaryNoteApplicable({ aborted: true, hasCheckpoint: true }), false, 'explicitly aborted');
		assert.strictEqual(boundaryNoteApplicable({ aborted: true, hasCheckpoint: false }), false);
	});

	test('scenario 6: actual open_project/close_project prose is not parsed; only the stamp is', () => {
		const switched = 'Switched to project: /x\nActive project folders: /x'
			+ formatWorkspaceTransitionStamp({ tool: 'open_project', changed: true });
		assert.deepStrictEqual(workspaceMutationResultFromToolContent('open_project', switched), { changed: true });
		const already = 'Project was already the only active root: /x'
			+ formatWorkspaceTransitionStamp({ tool: 'open_project', changed: false });
		assert.deepStrictEqual(workspaceMutationResultFromToolContent('open_project', already), { changed: false });
		const closed = 'Detached project root (files were not deleted): /x'
			+ formatWorkspaceTransitionStamp({ tool: 'close_project', removed: true });
		assert.deepStrictEqual(workspaceMutationResultFromToolContent('close_project', closed), { removed: true });
		assert.strictEqual(workspaceMutationResultFromToolContent('find_text', switched), null, 'other tools untouched');
		assert.strictEqual(workspaceMutationResultFromToolContent('open_project', 'Project is already open.'), null, 'prose stays null');
		assert.strictEqual(workspaceMutationResultFromToolContent('close_project', 'text mentioning "removed":true'), null, 'coincidental JSON in prose is ignored');
	});

	test('invalid LLM digest is skipped so a valid heuristic is not blanked', () => {
		const heuristic = digest('heuristic', 18);
		const orphanLlm = digest('orphan-llm', 21, true);
		const valid = selectValidMonotonicDigest([orphanLlm, heuristic], d => d.id !== 'orphan-llm');
		assert.strictEqual(valid?.id, 'heuristic');
	});
});

suite('withBusyRetry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('scenario 4: a busy write retries until it lands, without sleeping before the first attempt', async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		const value = await withBusyRetry('test-stage', async () => {
			attempts++;
			if (attempts < 3) throw new Error('SQLITE_BUSY: database is locked');
			return 'ok';
		}, async ms => { sleeps.push(ms); });
		assert.strictEqual(value, 'ok');
		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(sleeps, [75, 250], 'backoff only between attempts');
	});

	test('non-busy errors fail immediately, labeled with the exact failing stage', async () => {
		let attempts = 0;
		await assert.rejects(
			withBusyRetry('boundary-checkpoint', async () => { attempts++; throw new Error('constraint violation'); }, async () => { }),
			(error: Error) => error.message.includes('boundary-checkpoint') && error.message.includes('constraint violation'),
		);
		assert.strictEqual(attempts, 1, 'no retry for non-busy failures');
	});

	test('persistent busy exhausts the retries and throws with the stage label', async () => {
		let attempts = 0;
		await assert.rejects(
			withBusyRetry('boundary-note', async () => { attempts++; throw new Error('database is locked'); }, async () => { }),
			/memory write failed at stage "boundary-note"/,
		);
		assert.strictEqual(attempts, 4);
	});
});
