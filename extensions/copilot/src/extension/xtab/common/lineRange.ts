/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * A 0-based line range where `startLine` is inclusive and `endLineExcl` is exclusive.
 */
export class LineRange0Based {
	constructor(
		/** 0-based, inclusive. */
		readonly startLine: number,
		/** 0-based, exclusive. */
		readonly endLineExcl: number,
	) { }
}
