/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as vscode from 'vscode';
import { Disposable } from './util/dispose';


export interface ILogger {
	trace(title: string, message: string, data?: unknown): void;
}

export class VsCodeOutputLogger extends Disposable implements ILogger {
	#outputChannelValue?: vscode.LogOutputChannel;

	get #outputChannel() {
		this.#outputChannelValue ??= this._register(vscode.window.createOutputChannel('Markdown', { log: true }));
		return this.#outputChannelValue;
	}

	constructor() {
		super();
	}

	public trace(title: string, message: string, data?: unknown): void {
		this.#outputChannel.trace(`${title}: ${message}`, ...(data ? [JSON.stringify(data, null, 4)] : []));
	}
}
