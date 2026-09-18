/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import util from 'node:util';

export function formatLogMessage(category: string, ...extra: unknown[]): string {
	return `[${category}] ${format(extra)}`;
}

function format(args: unknown[]): string {
	return util.formatWithOptions({ maxStringLength: Infinity }, ...args);
}
