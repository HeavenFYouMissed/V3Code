/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { localize } from '../../../../nls.js';

// The strings localized in this file will get pulled into the manifest of the language packs.
// So that they are available for VS Code to use without downloading the entire language pack.

export const minimumTranslatedStrings: { [key: string]: string } = {
	showLanguagePackExtensions: localize('showLanguagePackExtensions', "Search language packs in the Marketplace to change the display language to {0}."),
	searchMarketplace: localize('searchMarketplace', "Search Marketplace"),
	installAndRestartMessage: localize('installAndRestartMessage', "Install language pack to change the display language to {0}."),
	installAndRestart: localize('installAndRestart', "Install and Restart")
};