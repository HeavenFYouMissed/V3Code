/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISemanticIndexService } from '../common/semanticIndex/semanticIndexTypes.js';
import { IBeastService } from './beastService.js';

const CATEGORY = localize2('v3code.category', 'V3Code');

export const REBUILD_INDEX_ID = 'v3code.semanticIndex.rebuild';
export const SHOW_INDEX_STATUS_ID = 'v3code.semanticIndex.showStatus';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: REBUILD_INDEX_ID,
			title: localize2('v3code.semanticIndex.rebuild.title', 'V3Code: Rebuild Codebase Index'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ISemanticIndexService);
		const notify = accessor.get(INotificationService);
		notify.info(localize('v3code.semanticIndex.rebuilding', 'V3Code: rebuilding semantic index…'));
		try {
			await service.rebuild();
			const s = service.getStatus();
			notify.info(localize('v3code.semanticIndex.done', 'V3Code: indexed {0} files, {1} chunks.', s.filesIndexed, s.chunksTotal));
		} catch (err: any) {
			notify.error(localize('v3code.semanticIndex.failed', 'V3Code index rebuild failed: {0}', err?.message ?? String(err)));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SHOW_INDEX_STATUS_ID,
			title: localize2('v3code.semanticIndex.showStatus.title', 'V3Code: Show Index Status'),
			category: CATEGORY,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		const service = accessor.get(ISemanticIndexService);
		const notify = accessor.get(INotificationService);
		const s = service.getStatus();
		notify.info(localize(
			'v3code.semanticIndex.status',
			'V3Code Index — state: {0}, files: {1}/{2}, chunks: {3}, model: {4}',
			s.state, s.filesIndexed, s.filesTotal, s.chunksTotal, s.modelId ?? 'n/a'
		));
	}
});

export const BEAST_SEARCH_TEST_ID = 'v3code.beast.searchTest';

// Phase A "done" test (WIRING-PLAN): proves the sidecar answers over IPC.
// Ranking is untouched — this command is diagnostics, not a search UI.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: BEAST_SEARCH_TEST_ID,
			title: localize2('v3code.beast.searchTest.title', 'V3Code: Beast Search (Sidecar Test)'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const beast = accessor.get(IBeastService);
		const notify = accessor.get(INotificationService);
		const quickInput = accessor.get(IQuickInputService);
		if (!(await beast.isAvailable())) {
			notify.warn(localize('v3code.beast.unavailable', 'Beast sidecar is not available (binary missing, disabled, or tripped this session). See the window log for details.'));
			return;
		}
		const query = await quickInput.input({ prompt: localize('v3code.beast.queryPrompt', 'Beast search query') });
		if (!query) { return; }
		const t0 = Date.now();
		const hits = await beast.search(query, 10);
		const tookMs = Date.now() - t0;
		if (hits.length === 0) {
			notify.info(localize('v3code.beast.noHits', 'Beast: no hits for "{0}" ({1}ms). The sidecar index may still be building — try again shortly.', query, tookMs));
			return;
		}
		const lines = hits.slice(0, 5).map((h, i) => `${i + 1}. ${h.file}:${h.line}`).join('\n');
		notify.info(localize('v3code.beast.hits', 'Beast: {0} hits in {1}ms for "{2}"\n{3}', hits.length, tookMs, query, lines));
	}
});
