/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { createServiceIdentifier } from '../../../util/common/services';

export const IHooksOutputChannel = createServiceIdentifier<IHooksOutputChannel>('IHooksOutputChannel');

export interface IHooksOutputChannel {
	readonly _serviceBrand: undefined;

	/**
	 * Append a line to the Hooks output channel.
	 */
	appendLine(message: string): void;
}
