/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export function makeTextResult(data: unknown): { content: [{ type: 'text'; text: string }] } {
	return {
		content: [
			{
				type: 'text',
				text: typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? String(data)),
			},
		],
	};
}
