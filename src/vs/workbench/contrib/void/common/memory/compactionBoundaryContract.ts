/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for details.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ChatEventInput, CreateMemoryCheckpointInput } from './memoryTypes.js';

export type CompactionBoundaryScope = {
	dbPath: string;
	workspaceId: string;
};

export type CompactionBoundaryNoteInput = Omit<ChatEventInput, 'workspaceId'>;
export type CompactionBoundaryCheckpointInput = Omit<CreateMemoryCheckpointInput, 'endEventId' | 'sessionId'>;

/**
 * Build the renderer -> main-process payload for an atomic compaction boundary.
 *
 * `workspaceId` is intentionally carried twice: the top-level value selects and
 * constrains the transaction, while the stamped event value is the persisted row.
 * Keeping this in one builder prevents those two contract fields from drifting.
 */
export function buildCompactionBoundaryChannelParams(
	scope: CompactionBoundaryScope,
	note: CompactionBoundaryNoteInput,
	checkpoint: CompactionBoundaryCheckpointInput,
	chatJsonlPath?: string,
	shadowDir?: string,
): {
	dbPath: string;
	workspaceId: string;
	chatJsonlPath?: string;
	shadowDir?: string;
	noteInput: ChatEventInput;
	checkpointInput: Omit<CreateMemoryCheckpointInput, 'endEventId'>;
} {
	if (!scope.workspaceId.trim()) {
		throw new Error('compaction boundary requires a workspaceId');
	}
	return {
		dbPath: scope.dbPath,
		workspaceId: scope.workspaceId,
		chatJsonlPath,
		shadowDir,
		noteInput: { ...note, workspaceId: scope.workspaceId },
		checkpointInput: { ...checkpoint, sessionId: note.sessionId },
	};
}
