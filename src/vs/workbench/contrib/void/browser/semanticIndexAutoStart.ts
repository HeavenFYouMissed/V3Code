/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Auto-start trigger for the semantic index.
 *
 * Why this exists:
 *   ISemanticIndexService is registered with InstantiationType.Delayed, so it
 *   stays dormant until something first asks for it (historically: the first
 *   `semantic_search` tool call, or a manual "V3Code: Rebuild Codebase Index").
 *   That made the index manual-only. This workbench contribution runs at
 *   AfterRestored and depends on ISemanticIndexService, which forces the
 *   singleton to instantiate on workspace open. The service's own constructor
 *   then walks + chunks the workspace automatically (see
 *   semanticIndexBrowserImpl._initAndMaybeRebuild), so the agent's
 *   semantic_search has a live index without any manual command.
 *
 * It also refreshes the index when workspace folders are added or removed
 * (multi-root / "add folder to workspace"), reusing the existing rebuild()
 * entrypoint — it does NOT reimplement chunking. Per-file edits are handled
 * separately by the debounced file watcher inside the service itself.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ISemanticIndexService } from '../common/semanticIndex/semanticIndexTypes.js';

export class SemanticIndexAutoStartContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'v3code.semanticIndex.autoStart';

	constructor(
		// Injecting the service here is the whole point: it pulls the Delayed
		// singleton into existence at startup so it indexes on workspace open.
		@ISemanticIndexService private readonly indexService: ISemanticIndexService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Refresh when folders are added/removed. The service self-builds for the
		// folders present at construction; this keeps the index correct when the
		// workspace shape changes later (add folder / remove folder). A full
		// rebuild also drops chunks that belonged to a removed folder.
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(e => {
			if (e.added.length === 0 && e.removed.length === 0) return;
			if (this.workspaceService.getWorkspace().folders.length === 0) return; // nothing to index
			this.logService.info(`[v3code-index] workspace folders changed (+${e.added.length}/-${e.removed.length}); refreshing index`);
			this.indexService.rebuild().catch(err =>
				this.logService.warn('[v3code-index] folder-change rebuild failed', err));
		}));

		this.logService.trace('[v3code-index] auto-start contribution active; index state:', this.indexService.getStatus().state);
	}
}

registerWorkbenchContribution2(SemanticIndexAutoStartContribution.ID, SemanticIndexAutoStartContribution, WorkbenchPhase.AfterRestored);
