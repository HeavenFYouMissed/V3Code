/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * One-time capability consent for computer use, and the names both sides of the IPC boundary
 * must agree on.
 *
 * Kept in `common` because the decorator is consumed from the renderer's `browser` layer while the
 * implementation lives in `electron-browser` (it needs a real dialog), and because the main process
 * needs the channel name without reaching into renderer code.
 */

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Name of the `IMainProcessService` channel that fronts the native computer-use helper.
 *
 * Declared here rather than in the caller so the renderer service and the main-process channel
 * registration cannot drift apart. Naming follows the existing `void-channel-*` convention.
 */
export { COMPUTER_USE_CHANNEL_NAME } from './computerUseTypes.js';

/**
 * Bumped when the consent text changes materially enough that a previous acceptance no longer
 * describes what the user is agreeing to.
 *
 * Stored alongside the acceptance so raising it re-prompts everyone instead of silently treating an
 * old, narrower acceptance as covering a broader capability.
 */
export const COMPUTER_USE_CONSENT_VERSION = 1;

/**
 * Application-scoped: the consent version the user accepted, or absent when they never have.
 *
 * Owned exclusively by {@link IComputerUseConsentService}. Nothing else may write it.
 */
export const COMPUTER_USE_CONSENT_STORAGE_KEY = 'v3code.computerUse.consentAcceptedVersion';

export const IComputerUseConsentService = createDecorator<IComputerUseConsentService>('computerUseConsentService');

/**
 * Gate for the one-time "you are handing an agent your whole machine" acknowledgement.
 *
 * Separate from per-application approval: this is asked once, covers the capability as a whole, and
 * is what makes every later, narrower prompt meaningful.
 */
export interface IComputerUseConsentService {
	readonly _serviceBrand: undefined;

	/** Fires whenever {@link hasAccepted} would return a different answer. */
	readonly onDidChangeConsent: Event<boolean>;

	/**
	 * True when the current {@link COMPUTER_USE_CONSENT_VERSION} has already been accepted.
	 *
	 * Synchronous so availability checks never have to show a dialog to answer "is this feature on".
	 */
	hasAccepted(): boolean;

	/**
	 * Resolves true once consent exists, prompting if it does not.
	 *
	 * Concurrent callers share a single dialog: the first caller's prompt is reused, so a burst of
	 * tool calls cannot stack modal dialogs on top of each other.
	 */
	ensureAccepted(): Promise<boolean>;

	/** Drops the stored acceptance, so the next {@link ensureAccepted} prompts again. */
	revoke(): void;
}
