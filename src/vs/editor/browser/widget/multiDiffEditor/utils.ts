/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ActionRunner, IAction } from '../../../../base/common/actions.js';

export class ActionRunnerWithContext extends ActionRunner {
	constructor(private readonly _getContext: () => unknown) {
		super();
	}

	protected override runAction(action: IAction, _context?: unknown): Promise<void> {
		const ctx = this._getContext();
		return super.runAction(action, ctx);
	}
}
