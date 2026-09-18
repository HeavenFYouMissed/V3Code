/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

declare module 'vscode' {

	export namespace env {
		export function getDataChannel<T>(channelId: string): DataChannel<T>;
	}

	export interface DataChannel<T = unknown> {
		readonly onDidReceiveData: Event<DataChannelEvent<T>>;
	}

	export interface DataChannelEvent<T> {
		data: T;
	}
}
