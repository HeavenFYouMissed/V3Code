/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IProcessService } from '../../../../platform/process/common/process.js';

registerMainProcessRemoteService(IProcessService, 'process');

