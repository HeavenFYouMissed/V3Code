/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IRemoteAgentHostService } from '../common/remoteAgentHostService.js';
import { RemoteAgentHostService } from '../browser/remoteAgentHostServiceImpl.js';

registerSingleton(IRemoteAgentHostService, RemoteAgentHostService, InstantiationType.Delayed);
