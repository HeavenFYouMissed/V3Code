/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// #234440
declare module 'vscode' {

	export interface TaskExecution {
		/**
		 * The terminal associated with this task execution, if any.
		 */
		terminal?: Terminal;
	}
}
