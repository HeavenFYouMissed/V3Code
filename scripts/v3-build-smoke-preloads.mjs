/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preloads } from './v3-check-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Match build/next/index.ts standalone preload compilation without wiping out/.
for (const preload of preloads) {
	await build({
		entryPoints: [path.join(root, `src/${preload}.ts`)],
		outfile: path.join(root, `out/${preload}.js`),
		bundle: false, format: 'cjs', platform: 'node', target: ['es2024'],
		sourcemap: 'linked', sourcesContent: false,
	});
}
console.log('Compiled all three Electron preloads as CommonJS.');
