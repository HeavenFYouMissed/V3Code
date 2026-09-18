/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IChatPendingDividerViewModel, IChatRequestViewModel, IChatResponseViewModel, isRequestVM } from '../model/chatViewModel.js';

export type V3StickyRequestItem = IChatRequestViewModel | IChatResponseViewModel | IChatPendingDividerViewModel;

/**
 * Master switch for the sticky request capsule, off for every chat surface
 * (sidebar chat and the Agents panel share this widget).
 *
 * It shipped reading as a second, translucent composer pinned above the
 * transcript holding a few lines of the prompt you had just sent — the
 * duplicate-input impression cost more than the pinned context was worth.
 * Disabled rather than deleted: the geometry below is non-obvious and unit
 * tested, so flipping this back to `true` restores the feature intact if we
 * want to retry it with an opaque treatment.
 */
export const V3_STICKY_REQUEST_ENABLED = false;

export interface V3ActiveStickyRequest {
	readonly item: IChatRequestViewModel;
	readonly rowBottomRel: number;
	readonly rowHeight: number;
}

export interface V3StickyRequestHandoff {
	readonly offsetY: number;
	readonly hideSource: boolean;
}

const V3_DEFAULT_REQUEST_VIEWPORT_HEIGHT = 200;
const V3_REQUEST_RESPONSE_GAP = 10;

/**
 * Keep the latest response tall enough to place its preceding request at the
 * top of the viewport. Once the request is represented by the sticky capsule,
 * use the capsule's measured height instead of the legacy 200px request cap so
 * the response begins immediately below the visible surface rather than below
 * hidden source-row space.
 */
export function getV3LastResponseMinHeight(contentHeight: number, precedingItemHeight: number, stickyCapsuleHeight?: number): number {
	const visiblePrecedingItemHeight = Math.min(
		precedingItemHeight,
		stickyCapsuleHeight !== undefined && stickyCapsuleHeight > 0
			? stickyCapsuleHeight
			: V3_DEFAULT_REQUEST_VIEWPORT_HEIGHT,
	);
	return Math.max(contentHeight - (visiblePrecedingItemHeight + V3_REQUEST_RESPONSE_GAP), 0);
}

export function isV3StickyRequestActive(hasActiveRequest: boolean, requestInProgress: boolean, requestNeedsInput: boolean): boolean {
	return hasActiveRequest || requestInProgress || requestNeedsInput;
}

/**
 * Resolve the visual handoff from the in-list request row to the capsule.
 * Short rows ride behind the capsule as one shape. Tall rows cannot be fully
 * covered by the clamped capsule, so their source is hidden until it clears the
 * viewport while retaining its layout height.
 */
export function getV3StickyRequestHandoff(match: V3ActiveStickyRequest, capsuleHeight: number): V3StickyRequestHandoff {
	const canRide = capsuleHeight > 0 && match.rowHeight <= capsuleHeight * 1.5;
	return {
		offsetY: canRide ? Math.max(0, match.rowBottomRel - capsuleHeight) : 0,
		hideSource: capsuleHeight > 0 && !canRide && match.rowBottomRel > 0,
	};
}

/**
 * Resolve the one request that may own the sticky viewport capsule.
 *
 * The capsule is intentionally limited to the request whose response is currently
 * running. Historical requests belong to the conversation rail; allowing them to
 * compete here was the source of the old wrong-message bug.
 *
 * The request becomes sticky as soon as its row top crosses the viewport top.
 * The returned row geometry lets the browser widget preserve the original
 * capsule's scrolling handoff instead of rendering a second stationary copy.
 */
export function findV3ActiveStickyRequest(
	items: readonly V3StickyRequestItem[],
	requestActive: boolean,
	scrollTop: number,
	getItemHeight: (item: V3StickyRequestItem) => number,
): V3ActiveStickyRequest | undefined {
	if (!requestActive || scrollTop <= 0) {
		return undefined;
	}

	// The durable active-request lifecycle is the source of truth for ownership.
	// Pending/steering requests may be appended after it, so choose the newest
	// request that has actually entered the transcript rather than the last item.
	let activeRequest: IChatRequestViewModel | undefined;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (isRequestVM(item) && !item.pendingKind) {
			activeRequest = item;
			break;
		}
	}
	if (!activeRequest) {
		return undefined;
	}

	let rowTop = 0;
	for (const item of items) {
		const height = getItemHeight(item);
		if (!Number.isFinite(height) || height <= 0) {
			// Do not guess at layout. A guessed zero/default was what let an older
			// request win while dynamic row measurements were still settling.
			return undefined;
		}
		if (item === activeRequest) {
			return rowTop < scrollTop
				? { item: activeRequest, rowBottomRel: rowTop + height - scrollTop, rowHeight: height }
				: undefined;
		}
		rowTop += height;
	}

	return undefined;
}
