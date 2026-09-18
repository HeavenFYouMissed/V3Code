/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';

export const IChatSessionService = createServiceIdentifier<IChatSessionService>('IChatSessionService');

export interface IChatSessionService {
	readonly _serviceBrand: undefined;

	onDidDisposeChatSession: Event<string>;
}