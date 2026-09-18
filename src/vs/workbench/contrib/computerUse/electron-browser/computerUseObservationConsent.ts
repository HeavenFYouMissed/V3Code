/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * The *second* consent dialog: the one that covers being watched, rather than being driven.
 *
 * Ambient observation is a different bargain from computer use and is therefore asked separately. The
 * computer-use dialog says "the agent can act on your machine when you ask it to"; this one says "the
 * agent will look at an application on a timer, with nobody asking, and keep notes about it". Reusing
 * the first acceptance for the second capability would mean the narrower permission silently bought the
 * broader one, which is the single most likely way a feature like this ends up being described as
 * spyware — accurately.
 *
 * The bullets are blunt for the same reason the computer-use ones are: a user who skims them and clicks
 * through has still been told the truth. Every claim in them is one this implementation actually keeps,
 * and each is enforced somewhere a reviewer can point at:
 *
 * - *only what is in front* — `_collect` in `browser/computerUseObservationService.ts` skips any tick
 *   where the observed application is not frontmost.
 * - *screenshots are not kept* — `ComputerUseObservationSample` in
 *   `browser/computerUseObservationStore.ts` has no field that could hold one.
 * - *per application, and it expires* — every rule carries an `expiresAt`, clamped by the policy engine.
 * - *turning it off deletes the notes* — `revokeOptIn` clears both storage keys.
 *
 * Lives in `electron-browser` because it needs a real modal. Its decorator is declared in
 * `browser/computerUseObservationService.ts` so the renderer's `browser` layer can depend on it without
 * importing across layers — see the warning on that interface about importing this module for its
 * side effect.
 */

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IComputerUseObservationConsentService } from '../browser/computerUseObservationService.js';

/**
 * Bumped when the wording below changes materially.
 *
 * Raising it re-prompts everyone rather than treating a previous, narrower acceptance as covering
 * something broader. Kept independent of `COMPUTER_USE_CONSENT_VERSION`: the two texts describe
 * different capabilities and will not change in step.
 */
export const COMPUTER_USE_OBSERVATION_CONSENT_VERSION = 1;

/**
 * Application-scoped: the ambient-observation consent version the user accepted.
 *
 * Owned exclusively by this service. Deliberately a *different key* from both the computer-use consent
 * and the observation policy: three independent records, all of which must agree before a single frame
 * is read, and none of which can be satisfied as a side effect of writing another.
 */
export const COMPUTER_USE_OBSERVATION_CONSENT_STORAGE_KEY = 'v3code.computerUse.observation.consentAcceptedVersion';

/** Prompts once for ambient-observation consent and remembers the answer until it is revoked. */
export class ComputerUseObservationConsentService extends Disposable implements IComputerUseObservationConsentService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConsent = this._register(new Emitter<boolean>());
	readonly onDidChangeConsent: Event<boolean> = this._onDidChangeConsent.event;

	/**
	 * The dialog currently on screen, if any.
	 *
	 * Coalesced for the same reason as the computer-use dialog: a settings toggle and a tool call can
	 * both ask within one tick, and two stacked modals asking the same question is how a user ends up
	 * accepting one they meant to decline.
	 */
	private _pending: Promise<boolean> | undefined;

	constructor(
		@IDialogService private readonly dialogService: IDialogService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	hasAccepted(): boolean {
		return this.storageService.getNumber(
			COMPUTER_USE_OBSERVATION_CONSENT_STORAGE_KEY,
			StorageScope.APPLICATION,
			0,
		) >= COMPUTER_USE_OBSERVATION_CONSENT_VERSION;
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
		this.storageService.remove(COMPUTER_USE_OBSERVATION_CONSENT_STORAGE_KEY, StorageScope.APPLICATION);
		this._onDidChangeConsent.fire(false);
	}

	private async _prompt(): Promise<boolean> {
		const promptResult = await this.dialogService.prompt<boolean>({
			type: Severity.Warning,
			message: localize('computerUse.observation.consent.title', "Let V3Code watch an application while you work?"),
			buttons: [{
				label: localize('computerUse.observation.consent.accept', "I understand"),
				run: () => true,
			}],
			cancelButton: true,
			custom: {
				icon: Codicon.eye,
				markdownDetails: [
					{
						markdown: new MarkdownString(localize(
							'computerUse.observation.consent.separate',
							"This is a separate permission from letting V3Code control your computer. It is off by default and does something different: V3Code reads an application's contents on a timer, with no request from you each time."
						)),
					},
					{
						markdown: new MarkdownString(localize(
							'computerUse.observation.consent.scope',
							"You approve one application at a time and each approval expires by itself. Only the application that is actually in front is ever read — nothing is collected from windows behind it, and V3Code never observes its own window."
						)),
					},
					{
						markdown: new MarkdownString(localize(
							'computerUse.observation.consent.memory',
							"Short summaries of what was on screen are saved into V3Code's memory, which means they can be used in later conversations and sent to the model provider you have configured. Screenshots are used to write those summaries and are not kept."
						)),
					},
					{
						markdown: new MarkdownString(localize(
							'computerUse.observation.consent.retention',
							"Summaries are deleted automatically after the retention period you choose, you can clear them at any time by application or by time range, and turning ambient observation off deletes all of them."
						)),
					},
					{
						markdown: new MarkdownString(localize(
							'computerUse.observation.consent.injection',
							"Anything on screen is untrusted input. Text captured this way can contain instructions aimed at the agent, and it becomes part of what the agent remembers. An indicator stays visible the whole time V3Code is watching, and you can stop it there."
						)),
					},
				],
			},
		});

		if (promptResult.result === true) {
			this.storageService.store(
				COMPUTER_USE_OBSERVATION_CONSENT_STORAGE_KEY,
				COMPUTER_USE_OBSERVATION_CONSENT_VERSION,
				StorageScope.APPLICATION,
				StorageTarget.USER,
			);
			this._onDidChangeConsent.fire(true);
			return true;
		}
		return false;
	}
}

registerSingleton(IComputerUseObservationConsentService, ComputerUseObservationConsentService, InstantiationType.Delayed);
