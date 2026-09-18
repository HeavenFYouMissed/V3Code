/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as vscodeTypes from '../../vscodeTypes';

export function collapseRangeToStart(range: vscodeTypes.Range): vscodeTypes.Range {
	return new vscodeTypes.Range(range.start, range.start);
}