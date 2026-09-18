/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * The one-time computer-use consent dialog.
 *
 * The three bullets below are the whole point of this file. They are written plainly and without
 * softening because a user who skims them and clicks through has still been told the truth: the
 * capability is machine-wide, it ships pixels of their screen to a model provider, and everything on
 * that screen is attacker-controllable input. Hedged copy here would make the acceptance worthless.
 *
 * Lives in `electron-browser` because it needs a real modal; the decorator it implements is in
 * `common` so the renderer's `browser` layer can depend on it without crossing layers.
 */

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	COMPUTER_USE_CONSENT_STORAGE_KEY,
	COMPUTER_USE_CONSENT_VERSION,
	IComputerUseConsentService,
} from '../common/computerUseConsent.js';

/** Prompts once for machine-wide computer-use consent and remembers the answer forever. */
export class ComputerUseConsentService extends Disposable implements IComputerUseConsentService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConsent = this._register(new Emitter<boolean>());
	readonly onDidChangeConsent: Event<boolean> = this._onDidChangeConsent.event;

	/**
	 * The dialog currently on screen, if any.
	 *
	 * Coalescing matters more here than for most prompts: a single agent turn can fire several tool
	 * calls before the first resolves, and without this each would stack its own modal.
	 */
	private _pending: Promise<boolean> | undefined;

	constructor(
		@IDialogService private readonly dialogService: IDialogService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	hasAccepted(): boolean {
		return this.storageService.getNumber(COMPUTER_USE_CONSENT_STORAGE_KEY, StorageScope.APPLICATION, 0) >= COMPUTER_USE_CONSENT_VERSION;
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

	revoke(): void {
		if (!this.hasAccepted()) {
			return;
		}
		this.storageService.remove(COMPUTER_USE_CONSENT_STORAGE_KEY, StorageScope.APPLICATION);
		this._onDidChangeConsent.fire(false);
	}

	private async _prompt(): Promise<boolean> {
		const promptResult = await this.dialogService.prompt<boolean>({
			type: Severity.Warning,
			message: localize('computerUse.consent.title', "Let V3Code control your computer?"),
			buttons: [{
				label: localize('computerUse.consent.accept', "I understand"),
				run: () => true,
			}],
			cancelButton: true,
			custom: {
				icon: Codicon.deviceDesktop,
				markdownDetails: [
					{
						markdown: new MarkdownString(localize(
							'computerUse.consent.scope',
							"This grants control of your whole machine, not just the editor. The agent can click, type, and press keys in any application that is in front, including ones you did not open for this task."
						)),
					},
					{
						markdown: new MarkdownString(localize(
							'computerUse.consent.screenshots',
							"Screenshots of your screen are sent to the model provider you have configured. Anything visible at the moment of capture is included, such as other windows, notifications, and open documents."
						)),
					},
					{
						markdown: new MarkdownString(localize(
							'computerUse.consent.injection',
							"Anything on screen is untrusted input. Text in a page, document, or message can contain instructions aimed at the agent, and the agent may follow them. Watch what it does and stop it with Escape."
						)),
					},
					{
						markdown: new MarkdownString(localize(
							'computerUse.consent.controls',
							"You will still be asked to approve each application the first time, browsers and terminals stay restricted, and V3Code never acts on its own window."
						)),
					},
				],
			},
		});

		if (promptResult.result === true) {
			this.storageService.store(
				COMPUTER_USE_CONSENT_STORAGE_KEY,
				COMPUTER_USE_CONSENT_VERSION,
				StorageScope.APPLICATION,
				StorageTarget.USER,
			);
			this._onDidChangeConsent.fire(true);
			return true;
		}
		return false;
	}
}

registerSingleton(IComputerUseConsentService, ComputerUseConsentService, InstantiationType.Delayed);
