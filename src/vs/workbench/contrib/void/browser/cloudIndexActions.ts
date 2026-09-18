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
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { CLOUD_INDEX_SETTING_IDS } from '../common/cloudIndex/cloudIndexConfiguration.js';
import { ICloudIndexSyncService } from './cloudIndexSyncService.js';

const CATEGORY = localize2('v3code.category', 'V3Code');

export const CLOUD_INDEX_CONFIGURE_ID = 'v3code.cloudIndex.configure';
export const CLOUD_INDEX_SYNC_NOW_ID = 'v3code.cloudIndex.syncNow';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLOUD_INDEX_CONFIGURE_ID,
			title: localize2('v3code.cloudIndex.configure.title', 'V3Code: Cloud Index — Open Settings'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const preferencesService = accessor.get(IPreferencesService);
		await preferencesService.openSettings({
			jsonEditor: false,
			query: `@id:${CLOUD_INDEX_SETTING_IDS.join(',')}`,
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CLOUD_INDEX_SYNC_NOW_ID,
			title: localize2('v3code.cloudIndex.syncNow.title', 'V3Code: Cloud Index — Sync Now'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const cloudIndexSyncService = accessor.get(ICloudIndexSyncService);
		const notificationService = accessor.get(INotificationService);
		if (cloudIndexSyncService.getState().readOnly) {
			notificationService.notify({
				severity: Severity.Info,
				message: localize('v3code.cloudIndex.readOnly', 'The shared team base is read-only in this checkout. Your local index is the live overlay.'),
			});
			return;
		}

		let r;
		try {
			r = await cloudIndexSyncService.syncNow();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			notificationService.notify({
				severity: Severity.Error,
				message: localize('v3code.cloudIndex.syncFail', 'Cloud index sync failed: {0}', msg),
			});
			return;
		}
		if (!r) {
			notificationService.notify({
				severity: Severity.Warning,
				message: localize('v3code.cloudIndex.notConfigured', 'Cloud index sync is not configured — open Cloud Index settings.'),
			});
			return;
		}
		notificationService.notify({
			severity: r.ok ? Severity.Info : Severity.Error,
			message: r.ok
				? localize('v3code.cloudIndex.syncOk', 'Cloud index synced: {0} changed files, {1} chunks uploaded ({2}ms).', r.changedFiles, r.uploadedChunks, r.tookMs)
				: localize('v3code.cloudIndex.syncFail', 'Cloud index sync failed: {0}', r.error ?? 'unknown error'),
		});
	}
});
