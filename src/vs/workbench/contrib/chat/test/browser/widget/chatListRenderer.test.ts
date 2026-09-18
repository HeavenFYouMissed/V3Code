/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { getToolInvocationGroupingTransition, isToolInvocationStatePinnable, shouldFinalizeThinkingPhase, shouldRolloverThinkingPhase, ToolInvocationGroupingTransition } from '../../../browser/widget/chatListRenderer.js';
import { IChatToolInvocation } from '../../../common/chatService/chatService.js';
import { ThinkingDisplayMode } from '../../../common/constants.js';

suite('ChatListRenderer tool grouping', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('pins only active or completed tool states', () => {
		assert.strictEqual(isToolInvocationStatePinnable(IChatToolInvocation.StateKind.Streaming), true);
		assert.strictEqual(isToolInvocationStatePinnable(IChatToolInvocation.StateKind.Executing), true);
		assert.strictEqual(isToolInvocationStatePinnable(IChatToolInvocation.StateKind.Completed), true);

		assert.strictEqual(isToolInvocationStatePinnable(IChatToolInvocation.StateKind.WaitingForConfirmation), false);
		assert.strictEqual(isToolInvocationStatePinnable(IChatToolInvocation.StateKind.WaitingForPostApproval), false);
		assert.strictEqual(isToolInvocationStatePinnable(IChatToolInvocation.StateKind.Cancelled), false);
	});

	test('rejoins after pre-confirmation and post-execution approval', () => {
		let hasMovedOutPart = false;
		let isAttachedToThinking = false;
		const transition = (state: IChatToolInvocation.StateKind): ToolInvocationGroupingTransition => {
			const result = getToolInvocationGroupingTransition(state, hasMovedOutPart, isAttachedToThinking);
			if (result === 'moveOut') {
				// Moving a pending lazy child back out cancels its grouped ownership.
				hasMovedOutPart = true;
				isAttachedToThinking = false;
			} else if (result === 'rejoin') {
				// Collapsed groups retain moved-out ownership until the lazy child renders.
				isAttachedToThinking = true;
			}
			return result;
		};

		assert.strictEqual(transition(IChatToolInvocation.StateKind.WaitingForConfirmation), 'moveOut');
		assert.strictEqual(transition(IChatToolInvocation.StateKind.Executing), 'rejoin');
		assert.strictEqual(transition(IChatToolInvocation.StateKind.Completed), undefined, 'must not queue the collapsed lazy item twice');
		assert.strictEqual(transition(IChatToolInvocation.StateKind.WaitingForPostApproval), 'moveOut');
		assert.strictEqual(transition(IChatToolInvocation.StateKind.Completed), 'rejoin');
		assert.strictEqual(hasMovedOutPart, true);
		assert.strictEqual(isAttachedToThinking, true);
	});

	test('fixed-scrolling narration defers rollover while the paragraph is streaming', () => {
		assert.strictEqual(shouldFinalizeThinkingPhase(true, false, ThinkingDisplayMode.FixedScrolling), false);
	});

	test('fixed-scrolling narration rolls over when later work starts', () => {
		assert.strictEqual(shouldRolloverThinkingPhase(ThinkingDisplayMode.FixedScrolling, true, true, 0, 1, 2), true);
		assert.strictEqual(shouldRolloverThinkingPhase(ThinkingDisplayMode.FixedScrolling, false, true, 0, 1, 2), false,
			'narration by itself must not fragment the live group');
		assert.strictEqual(shouldRolloverThinkingPhase(ThinkingDisplayMode.FixedScrolling, true, false, 0, 1, 2), false,
			'work without the boundary-owned group stays in the current chapter');
		assert.strictEqual(shouldRolloverThinkingPhase(ThinkingDisplayMode.FixedScrolling, true, true, 0, 2, 1), false,
			'an older work-item rerender must not consume the later narration boundary');
	});

	test('fixed-scrolling supports repeating work and narration chapters', () => {
		assert.strictEqual(shouldRolloverThinkingPhase(ThinkingDisplayMode.FixedScrolling, true, true, 0, 1, 2), true,
			'first later work chapter rolls over after the first paragraph');
		assert.strictEqual(shouldRolloverThinkingPhase(ThinkingDisplayMode.FixedScrolling, true, true, 2, 3, 4), true,
			'second later work chapter rolls over after the second paragraph');
		assert.strictEqual(shouldRolloverThinkingPhase(ThinkingDisplayMode.FixedScrolling, false, true, 4, 5, 6), false,
			'a third paragraph can stream without prematurely fragmenting its work chapter');
	});

	test('preview-style groups do not use deferred rollover', () => {
		assert.strictEqual(shouldRolloverThinkingPhase(ThinkingDisplayMode.CollapsedPreview, true, true, 0, 1, 2), false,
			'preview narration already finalized its group immediately');
	});

	test('preview-style narration finalizes the chronological phase', () => {
		assert.strictEqual(shouldFinalizeThinkingPhase(true, false, ThinkingDisplayMode.CollapsedPreview), true);
	});

	test('request completion finalizes the active rolling phase', () => {
		assert.strictEqual(shouldFinalizeThinkingPhase(false, true, ThinkingDisplayMode.FixedScrolling), true,
			'the response lifecycle must collapse the final group even when it ends on a tool');
	});
});
