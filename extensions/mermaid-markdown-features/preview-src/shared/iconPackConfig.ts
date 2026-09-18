/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
export const iconPacks = [
	{
		name: 'logos',
		loader: () => import('@iconify-json/logos').then(m => m.icons),
	},
	{
		name: 'mdi',
		loader: () => import('@iconify-json/mdi').then(m => m.icons),
	},
];
