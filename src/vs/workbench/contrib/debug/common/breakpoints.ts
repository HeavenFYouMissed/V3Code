/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ContextKeyExpr, ContextKeyExpression, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IBreakpointContribution } from './debug.js';

export class Breakpoints {

	private breakpointsWhen: ContextKeyExpression | undefined;

	constructor(
		private readonly breakpointContribution: IBreakpointContribution,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		this.breakpointsWhen = typeof breakpointContribution.when === 'string' ? ContextKeyExpr.deserialize(breakpointContribution.when) : undefined;
	}

	get language(): string {
		return this.breakpointContribution.language;
	}

	get enabled(): boolean {
		return !this.breakpointsWhen || this.contextKeyService.contextMatchesRules(this.breakpointsWhen);
	}
}
