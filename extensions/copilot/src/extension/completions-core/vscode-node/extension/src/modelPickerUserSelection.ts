/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { ServicesAccessor } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ConfigKey, getConfig } from '../../lib/src/config';


export function getUserSelectedModelConfiguration(accessor: ServicesAccessor): string | null {
	const value = getConfig<string | null>(accessor, ConfigKey.UserSelectedCompletionModel);
	return typeof value === 'string' && value.length > 0 ? value : null;
}
