/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

declare module '@vscode/gulp-electron' {

	interface MainFunction {
		(options: any): NodeJS.ReadWriteStream;
		dest(destination: string, options: any): NodeJS.ReadWriteStream;
	}

	const main: MainFunction;
	export default main;
}
