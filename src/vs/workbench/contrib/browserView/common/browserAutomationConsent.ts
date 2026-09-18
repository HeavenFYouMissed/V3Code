/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Application-scoped: user accepted the integrated-browser automation beta warning. */
export const BROWSER_AUTOMATION_CONSENT_STORAGE_KEY = 'v3code.browserAutomation.betaConsentAccepted';

export const IBrowserAutomationConsentService = createDecorator<IBrowserAutomationConsentService>('browserAutomationConsentService');

export interface IBrowserAutomationConsentService {
	readonly _serviceBrand: undefined;
	/** Returns true if the user has accepted (or already accepted in a prior session). */
	ensureAccepted(): Promise<boolean>;
	hasAccepted(): boolean;
}
