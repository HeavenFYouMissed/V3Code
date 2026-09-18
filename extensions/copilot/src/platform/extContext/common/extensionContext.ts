/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import type { ExtensionContext } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';

export const IVSCodeExtensionContext = createServiceIdentifier<IVSCodeExtensionContext>('IVSCodeExtensionContext');

export interface IVSCodeExtensionContext extends ExtensionContext {
	readonly _serviceBrand: undefined;
}
