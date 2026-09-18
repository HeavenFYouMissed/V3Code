/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Re-export from the workbench layer so both local and remote contributions
// can share the same bundler implementation.
export { SyncedCustomizationBundler } from '../../../../../workbench/contrib/chat/browser/agentSessions/agentHost/syncedCustomizationBundler.js';
export { SYNCED_CUSTOMIZATION_SCHEME } from '../../../../../workbench/services/agentHost/common/agentHostFileSystemService.js';
