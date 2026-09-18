/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IDisposable, toDisposable } from '../../../util/vs/base/common/lifecycle';
import { ensureDependenciesAreSet } from '../../../util/vs/editor/common/core/text/positionToOffset';

export function createTimeout(ms: number, cb: () => void): IDisposable {
	const t = setTimeout(cb, ms);
	return toDisposable(() => clearTimeout(t));
}

ensureDependenciesAreSet();
