/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * One-time migration of legacy symbol notes into the SQLite memory store.
 * The active notes.json mirrors into the matching active scope. An open project
 * never imports or mirrors its symbol notes into the user-global store.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IContextBridgeService } from '../common/contextBridge/contextBridgeService.js';
import { IMemoryService } from './memoryService.js';
import { IContextBridgeScopeService } from '../common/contextBridge/contextBridgeScopeService.js';

class MemoryStartup extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.memoryStartup';

	constructor(
		@IMemoryService private readonly memoryService: IMemoryService,
		@IContextBridgeService private readonly contextBridgeService: IContextBridgeService,
		@IContextBridgeScopeService private readonly scopeService: IContextBridgeScopeService,
	) {
		super();
		void this._migrateLegacyNotes();
	}

	private async _migrateLegacyNotes(): Promise<void> {
		await this.scopeService.resolve();
		try {
			// listNotes() reads the active workspace notes.json (or global only when no
			// folder is open). SQLite ws_facts is a rebuildable same-scope mirror.
			// Thread-owned work notes are canonical session anchors, not rebuildable
			// workspace facts. Only legacy/shared project notes belong in ws_facts.
			const notes = (await this.contextBridgeService.listNotes()).filter(note => !note.threadId);
			if (notes.length) {
				await this.memoryService.migrateSymbolNotes(notes.map(n => ({
					filePath: n.filePath,
					symbolName: n.symbolName,
					note: n.note,
					ts: Date.parse(n.updatedAt) || Date.parse(n.createdAt) || Date.now(),
				})), this.memoryService.hasWorkspace ? 'workspace' : 'global');
			}
		} catch {
			// Best-effort — store may not exist yet on first boot.
		}
	}
}

registerWorkbenchContribution2(MemoryStartup.ID, MemoryStartup, WorkbenchPhase.Eventually);
