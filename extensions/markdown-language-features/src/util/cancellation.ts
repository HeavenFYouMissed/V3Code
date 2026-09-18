/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as vscode from 'vscode';

export const noopToken: vscode.CancellationToken = new class implements vscode.CancellationToken {
	readonly #onCancellationRequestedEmitter = new vscode.EventEmitter<void>();
	onCancellationRequested = this.#onCancellationRequestedEmitter.event;

	get isCancellationRequested() { return false; }
};
