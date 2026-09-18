/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ExportAgentHostDebugLogsAction } from './actions/exportAgentHostDebugLogsAction.js';
import { ForkConversationAction } from './actions/chatForkActions.js';

registerAction2(ForkConversationAction);
registerAction2(ExportAgentHostDebugLogsAction);
