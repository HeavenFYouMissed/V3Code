/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Diff, DiffArea, VoidFileSnapshot } from '../common/editCodeServiceTypes.js';


export type StartBehavior = 'accept-conflicts' | 'reject-conflicts' | 'keep-conflicts'

export type CallBeforeStartApplyingOpts = {
	from: 'QuickEdit';
	diffareaid: number; // id of the CtrlK area (contains text selection)
} | {
	from: 'ClickApply';
	uri: 'current' | URI;
}

export type StartApplyingOpts = {
	from: 'QuickEdit';
	diffareaid: number; // id of the CtrlK area (contains text selection)
	startBehavior: StartBehavior;
} | {
	from: 'ClickApply';
	applyStr: string;
	uri: 'current' | URI;
	startBehavior: StartBehavior;
}

export type AddCtrlKOpts = {
	startLine: number,
	endLine: number,
	editor: ICodeEditor,
}

/** Result of Turbo Draft's owned DiffZone transaction — never silently succeeds. */
export type ApplyTurboDraftReviewResult =
	| { ok: true; diffAreaId: number; pendingDiffs: number }
	| { ok: false; reason: 'missing-model' | 'source-changed' | 'conflict' | 'parse-failure' | 'zero-diff'; message: string }

export const IEditCodeService = createDecorator<IEditCodeService>('editCodeService');

export interface IEditCodeService {
	readonly _serviceBrand: undefined;

	processRawKeybindingText(keybindingStr: string): string;

	callBeforeApplyOrEdit(uri: URI | 'current'): Promise<void>;
	startApplying(opts: StartApplyingOpts): [URI, Promise<void>] | null;
	instantlyApplySearchReplaceBlocks(opts: { uri: URI; searchReplaceBlocks: string; clearEditorDiffUI?: boolean; /** Keep DiffZones for cherry-pick even if autoAcceptLLMChanges is on. */ forceReview?: boolean }): void;
	/**
	 * Atomic Turbo Draft apply: validates source + conflicts, precomputes final text,
	 * creates a Turbo-owned DiffZone kept for Tab/Del review. Never mutates on failure.
	 */
	applyTurboDraftReview(opts: {
		uri: URI;
		searchReplaceBlocks: string;
		expectedSource: string;
		turboRunId: string;
	}): ApplyTurboDraftReviewResult;
	instantlyRewriteFile(opts: { uri: URI; newContent: string; clearEditorDiffUI?: boolean }): void;
	addCtrlKZone(opts: AddCtrlKOpts): number | undefined;
	removeCtrlKZone(opts: { diffareaid: number }): void;

	diffAreaOfId: Record<string, DiffArea>;
	diffAreasOfURI: Record<string, Set<string> | undefined>;
	diffOfId: Record<string, Diff>;

	acceptOrRejectAllDiffAreas(opts: { uri: URI, removeCtrlKs: boolean, behavior: 'reject' | 'accept', _addToHistory?: boolean }): void;
	acceptDiff({ diffid }: { diffid: number }): void;
	rejectDiff({ diffid }: { diffid: number }): void;

	// events
	onDidAddOrDeleteDiffZones: Event<{ uri: URI }>;
	onDidChangeDiffsInDiffZoneNotStreaming: Event<{ uri: URI; diffareaid: number }>; // only fires when not streaming!!! streaming would be too much
	onDidChangeStreamingInDiffZone: Event<{ uri: URI; diffareaid: number }>;
	onDidChangeStreamingInCtrlKZone: Event<{ uri: URI; diffareaid: number }>;

	// CtrlKZone streaming state
	isCtrlKZoneStreaming(opts: { diffareaid: number }): boolean;
	interruptCtrlKStreaming(opts: { diffareaid: number }): void;

	// // DiffZone codeBoxId streaming state
	interruptURIStreaming(opts: { uri: URI }): void;

	// testDiffs(): void;
	getVoidFileSnapshot(uri: URI): VoidFileSnapshot;
	restoreVoidFileSnapshot(uri: URI, snapshot: VoidFileSnapshot): void;
}
