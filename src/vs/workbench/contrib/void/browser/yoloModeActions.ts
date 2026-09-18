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
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

const CATEGORY = localize2('v3code.category', 'V3Code');

// Global "YOLO mode" — disables ALL tool approval in ALL workspaces. Same setting the
// Settings UI exposes under Features > Chat (chat.tools.*); this just makes it a one-click toggle.
const GLOBAL_AUTO_APPROVE_SETTING = 'chat.tools.global.autoApprove';

export const TOGGLE_YOLO_MODE_ID = 'v3code.yolo.toggle';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TOGGLE_YOLO_MODE_ID,
			title: localize2('v3code.yolo.toggle.title', 'V3Code: Toggle YOLO Mode (Auto-Approve All Tools)'),
			category: CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const config = accessor.get(IConfigurationService);
		const notify = accessor.get(INotificationService);

		// The setting can be a boolean or a per-tool object; treat any truthy non-empty value as "on".
		const current = config.getValue(GLOBAL_AUTO_APPROVE_SETTING);
		const isOn = current === true || (typeof current === 'object' && current !== null && Object.keys(current).length > 0 && Object.values(current).some(v => v === true));

		if (!isOn) {
			const confirmed = await new Promise<boolean>(resolve => {
				notify.prompt(
					Severity.Warning,
					localize('v3code.yolo.warn', "Enable YOLO mode? The agent will auto-approve ALL tools (edits, terminal commands, deletes) in every workspace, with no confirmation. This is dangerous — only use it in code you trust."),
					[
						{ label: localize('v3code.yolo.enable', 'Enable YOLO'), run: () => resolve(true) },
						{ label: localize('v3code.yolo.cancel', 'Cancel'), run: () => resolve(false) },
					],
					{ sticky: true }
				);
			});
			if (!confirmed) { return; }
			await config.updateValue(GLOBAL_AUTO_APPROVE_SETTING, true, ConfigurationTarget.USER);
			notify.info(localize('v3code.yolo.on', 'YOLO mode ON — all tools auto-approved.'));
		} else {
			await config.updateValue(GLOBAL_AUTO_APPROVE_SETTING, false, ConfigurationTarget.USER);
			notify.info(localize('v3code.yolo.off', 'YOLO mode OFF — tool approvals restored.'));
		}
	}
});
