/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { IWebWorkerServer, IWebWorkerClient } from '../../../base/common/worker/webWorker.js';

export abstract class EditorWorkerHost {
	public static CHANNEL_NAME = 'editorWorkerHost';
	public static getChannel(workerServer: IWebWorkerServer): EditorWorkerHost {
		return workerServer.getChannel<EditorWorkerHost>(EditorWorkerHost.CHANNEL_NAME);
	}
	public static setChannel(workerClient: IWebWorkerClient<unknown>, obj: EditorWorkerHost): void {
		workerClient.setChannel<EditorWorkerHost>(EditorWorkerHost.CHANNEL_NAME, obj);
	}

	// foreign host request
	abstract $fhr(method: string, args: unknown[]): Promise<unknown>;
}
