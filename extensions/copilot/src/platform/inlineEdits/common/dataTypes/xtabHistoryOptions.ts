/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { vEnum } from '../../../configuration/common/validator';

export enum DiffHistoryMergeStrategy {
	SameStartLine = 'sameStartLine',
	Proximity = 'proximity',
	Hybrid = 'hybrid',
}

export namespace DiffHistoryMergeStrategy {
	export const VALIDATOR = vEnum(DiffHistoryMergeStrategy.SameStartLine, DiffHistoryMergeStrategy.Proximity, DiffHistoryMergeStrategy.Hybrid);
}
