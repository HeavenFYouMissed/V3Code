/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../base/common/lifecycle.js';

export class TextModelPart extends Disposable {
	private _isDisposed = false;

	public override dispose(): void {
		super.dispose();
		this._isDisposed = true;
	}
	protected assertNotDisposed(): void {
		if (this._isDisposed) {
			throw new Error('TextModelPart is disposed!');
		}
	}
}
