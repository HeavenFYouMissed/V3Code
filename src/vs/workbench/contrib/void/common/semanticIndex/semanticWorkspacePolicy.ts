/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * An in-memory semantic index is valid only for the exact workspace identity
 * that produced it. During a folder swap the old maps can remain alive while
 * the replacement walk is starting; treating them as current leaks code and
 * embeddings across projects.
 */
export const canServeSemanticWorkspace = (
	indexedWorkspaceKey: string | null | undefined,
	currentWorkspaceKey: string,
): boolean => !!indexedWorkspaceKey && indexedWorkspaceKey === currentWorkspaceKey;

/** Automatic prompt injection must wait for a complete, current index. Explicit
 * searches may use a verified same-workspace snapshot during a reconcile, but
 * background context must never consume a walking or partially rebuilt corpus. */
export const canInjectSemanticAutoContext = (
	state: string,
	filesIndexed: number,
): boolean => state === 'ready' && filesIndexed > 0;

/** An incomplete walk may preserve verified cached subtrees only while rebuilding
 * the same workspace. A live project swap must clear the corpus even when the new
 * root has unreadable files, otherwise relative-path collisions restore old code. */
export const shouldResetSemanticCorpus = (
	fullReset: boolean,
	incompleteWalk: boolean,
	sameWorkspaceCorpus: boolean,
): boolean => fullReset && (!incompleteWalk || !sameWorkspaceCorpus);
