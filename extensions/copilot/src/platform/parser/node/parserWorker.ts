/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { parentPort } from 'worker_threads';
import * as parser from './parserImpl';

function main() {
	const port = parentPort;
	if (!port) {
		throw new Error(`This module should only be used in a worker thread.`);
	}

	port.on('message', async ({ id, fn, args }) => {
		try {
			const res = await (parser as any)[fn](...args);
			port.postMessage({ id, res });
		} catch (err) {
			port.postMessage({ id, err });
		}
	});
}

main();
