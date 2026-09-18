/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

const cdSpec: Fig.Spec = {
	name: 'Set-Location',
	description: 'Change the shell working directory',
	args: {
		name: 'folder',
		template: 'folders',
		suggestions: [
			{
				name: '-',
				description: 'Go to previous directory in history stack',
				hidden: true,
			},
			{
				name: '+',
				description: 'Go to next directory in history stack',
				hidden: true,
			},
		],
	}
};

export default cdSpec;
