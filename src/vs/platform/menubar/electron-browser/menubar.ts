/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ICommonMenubarService } from '../common/menubar.js';

export const IMenubarService = createDecorator<IMenubarService>('menubarService');

export interface IMenubarService extends ICommonMenubarService {
	readonly _serviceBrand: undefined;
}
