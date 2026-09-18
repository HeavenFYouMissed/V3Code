/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ISandboxHelperService } from '../common/sandboxHelperService.js';

export const ISandboxHelperMainService = createDecorator<ISandboxHelperMainService>('sandboxHelper');

export interface ISandboxHelperMainService extends ISandboxHelperService {
	readonly _serviceBrand: undefined;
}
