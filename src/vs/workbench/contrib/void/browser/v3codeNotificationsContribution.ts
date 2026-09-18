/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * V3Code notification UX — no blocking toast popups.
 * Notifications go to the status-bar bell (with dot when unread); click to open the center panel.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { INotificationsModel, NotificationChangeType } from '../../../common/notifications.js';
import { HIDE_NOTIFICATION_TOAST } from '../../../browser/parts/notifications/notificationsCommands.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

export const V3CODE_SHOW_NOTIFICATION_TOASTS = 'v3code.notifications.showToasts';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	properties: {
		[V3CODE_SHOW_NOTIFICATION_TOASTS]: {
			type: 'boolean',
			default: false,
			description: localize(
				'v3code.notifications.showToasts',
				"When disabled, notifications are collected silently and shown only in the status bar bell and notification center (no popup toasts)."
			),
		},
	},
});

class V3CodeNotificationsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3codeNotifications';

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(V3CODE_SHOW_NOTIFICATION_TOASTS)) {
				this.enforceToastPolicy();
			}
		}));

		this.lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this.enforceToastPolicy();
			// `model` lives on the concrete NotificationService, not the public
			// INotificationService interface; narrow to it to observe added toasts.
			const model = (this.notificationService as { model?: INotificationsModel }).model;
			if (model) {
				this._register(model.onDidChangeNotification(e => {
					if (e.kind === NotificationChangeType.ADD) {
						this.enforceToastPolicy();
					}
				}));
			}
		});
	}

	private enforceToastPolicy(): void {
		if (this.configurationService.getValue<boolean>(V3CODE_SHOW_NOTIFICATION_TOASTS) === true) {
			return;
		}
		void this.commandService.executeCommand(HIDE_NOTIFICATION_TOAST);
	}
}

registerWorkbenchContribution2(V3CodeNotificationsContribution.ID, V3CodeNotificationsContribution, WorkbenchPhase.AfterRestored);
