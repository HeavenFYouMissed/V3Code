/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { acceptedSessionDigestDropCount, resolveWorkspaceHistoryBoundary, shouldPersistSessionDigestBoundary } from '../../common/memory/sessionDigestPolicy.js';

suite('session digest durability policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a moving history boundary still drops the last durable prefix', () => {
		// Boundary 40 became durable while five new messages arrived. The old boolean contract
		// returned false for boundary 45 and retained everything forever if the thread kept growing.
		assert.strictEqual(acceptedSessionDigestDropCount(45, 40), 40);
		assert.strictEqual(acceptedSessionDigestDropCount(40, 40), 40);
		assert.strictEqual(acceptedSessionDigestDropCount(39, 40), 0, 'never claim a checkpoint covers an earlier/different prefix');
		assert.strictEqual(acceptedSessionDigestDropCount(45, undefined), 0);
	});

	test('persistence is idempotent, throttled, and advances after enough new messages', () => {
		const decide = (requested: number, durable: number | undefined, pending = false, exact = false) =>
			shouldPersistSessionDigestBoundary({
				requestedDroppedCount: requested,
				durableDroppedCount: durable,
				exactBoundaryPending: pending,
				exactBoundaryDurable: exact,
			});
		assert.strictEqual(decide(40, undefined), true, 'first boundary persists');
		assert.strictEqual(decide(40, undefined, true), false, 'pending duplicate does not persist twice');
		assert.strictEqual(decide(40, 40, false, true), false, 'durable duplicate does not persist twice');
		assert.strictEqual(decide(41, 40), false, 'one-message growth reuses durable prefix');
		assert.strictEqual(decide(42, 40), false, 'two-message growth reuses durable prefix');
		assert.strictEqual(decide(43, 40), true, 'three-message growth advances the rolling checkpoint');
	});

	test('live workspace swaps preserve the swap turn while isolating earlier history', () => {
		const first = resolveWorkspaceHistoryBoundary(undefined, {
			workspaceIdentity: 'project-a',
			totalMessageCount: 80,
			currentTurnStart: 76,
			detectedWorkspaceMutationBoundary: 0,
		});
		assert.deepStrictEqual(first, { workspaceIdentity: 'project-a', messageCount: 0 }, 'first observation must not collapse a same-project transcript');

		const swapped = resolveWorkspaceHistoryBoundary(first, {
			workspaceIdentity: 'project-b',
			totalMessageCount: 84,
			currentTurnStart: 80,
			detectedWorkspaceMutationBoundary: 80,
		});
		assert.deepStrictEqual(swapped, { workspaceIdentity: 'project-b', messageCount: 80 }, 'the request and tool result that performed the swap stay live');

		const continued = resolveWorkspaceHistoryBoundary(swapped, {
			workspaceIdentity: 'project-b',
			totalMessageCount: 90,
			currentTurnStart: 89,
			detectedWorkspaceMutationBoundary: 80,
		});
		assert.deepStrictEqual(continued, swapped, 'normal turns do not move the project boundary');
	});

	test('persisted workspace mutation recovers the boundary after restart', () => {
		const restored = resolveWorkspaceHistoryBoundary(undefined, {
			workspaceIdentity: 'project-b',
			totalMessageCount: 90,
			currentTurnStart: 89,
			detectedWorkspaceMutationBoundary: 80,
		});
		assert.deepStrictEqual(restored, { workspaceIdentity: 'project-b', messageCount: 80 });
	});
});
