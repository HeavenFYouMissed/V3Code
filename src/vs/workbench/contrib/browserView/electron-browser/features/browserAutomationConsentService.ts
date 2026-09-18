/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { Severity } from '../../../../../platform/notification/common/notification.js';
import {
	BROWSER_AUTOMATION_CONSENT_STORAGE_KEY,
	IBrowserAutomationConsentService,
} from '../../common/browserAutomationConsent.js';

export class BrowserAutomationConsentService implements IBrowserAutomationConsentService {
	declare readonly _serviceBrand: undefined;

	private _pending: Promise<boolean> | undefined;

	constructor(
		@IDialogService private readonly dialogService: IDialogService,
		@IStorageService private readonly storageService: IStorageService,
	) { }

	hasAccepted(): boolean {
		return this.storageService.getBoolean(BROWSER_AUTOMATION_CONSENT_STORAGE_KEY, StorageScope.APPLICATION, false);
	}

	async ensureAccepted(): Promise<boolean> {
		if (this.hasAccepted()) {
			return true;
		}
		if (this._pending) {
			return this._pending;
		}
		this._pending = this._prompt().finally(() => {
			this._pending = undefined;
		});
		return this._pending;
	}

	private async _prompt(): Promise<boolean> {
		const learnMore = 'https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome';
		const promptResult = await this.dialogService.prompt<boolean>({
			type: Severity.Warning,
			message: localize('browserAutomationConsent.title', 'This is a beta feature'),
			buttons: [{
				label: localize('browserAutomationConsent.accept', 'I understand'),
				run: () => true,
			}],
			cancelButton: true,
			custom: {
				icon: Codicon.globe,
				markdownDetails: [
					{
						markdown: new MarkdownString(localize(
							'browserAutomationConsent.risk',
							'Browser automation has unique risks. You are responsible for what the agent reads, clicks, types, and screenshots in the integrated browser.'
						)),
					},
					{
						markdown: new MarkdownString(localize(
							'browserAutomationConsent.privacy',
							'The agent can capture page screenshots while working. For privacy, avoid sensitive sites (health, banking, dating) unless you trust the page and the task.'
						)),
					},
					{
						markdown: new MarkdownString(
							localize(
								'browserAutomationConsent.injection',
								'Malicious pages can hide instructions that try to steer the agent. Review tool approvals on unfamiliar sites. [Learn more]({0})',
								learnMore,
							),
							{ isTrusted: true },
						),
					},
				],
			},
		});

		if (promptResult.result === true) {
			this.storageService.store(BROWSER_AUTOMATION_CONSENT_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
			return true;
		}
		return false;
	}
}

registerSingleton(IBrowserAutomationConsentService, BrowserAutomationConsentService, InstantiationType.Delayed);
