/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

export const preloads = [
	'vs/base/parts/sandbox/electron-browser/preload',
	'vs/base/parts/sandbox/electron-browser/preload-aux',
	'vs/platform/browserView/electron-browser/preload-browserView',
];

export const media = [
	'extensions/markdown-language-features/media/index.js',
	'extensions/markdown-language-features/media/pre.js',
	'extensions/simple-browser/media/index.js',
	'extensions/notebook-renderers/renderer-out/index.js',
	'extensions/markdown-math/notebook-out/katex.js',
];

function nonemptyFile(file) {
	try { const stat = statSync(file); return stat.isFile() && stat.size > 0; }
	catch { return false; }
}

export function checkSmoke(root, platform = process.platform) {
	const missing = [];
	const requireFile = relative => {
		if (!nonemptyFile(path.join(root, relative))) { missing.push(relative); }
	};
	for (const file of ['out/main.js', 'out/nls.messages.json', 'out/vs/workbench/contrib/void/browser/react/out/void-settings-tsx/index.js']) { requireFile(file); }
	for (const file of media) { requireFile(file); }
	for (const name of readdirSync(path.join(root, 'extensions'))) {
		const directory = path.join(root, 'extensions', name);
		const manifest = path.join(directory, 'package.json');
		if (!existsSync(manifest)) { continue; }
		const entry = JSON.parse(readFileSync(manifest, 'utf8')).main;
		if (typeof entry !== 'string') { continue; }
		const target = path.resolve(directory, entry);
		if (!nonemptyFile(target) && !nonemptyFile(`${target}.js`)) { missing.push(`extension entry: ${name}/${entry}`); }
	}
	for (const preload of preloads) {
		requireFile(`out/${preload}.js`);
		try { new Script(readFileSync(path.join(root, `out/${preload}.js`), 'utf8')); }
		catch (error) { missing.push(`preload ${preload}: ${error.message}`); }
	}
	if (platform === 'darwin') {
		requireFile('resources/computerUse/darwin/v3code-computer-use-helper');
		try { accessSync(path.join(root, 'resources/computerUse/darwin/v3code-computer-use-helper'), constants.X_OK); }
		catch { missing.push('executable resources/computerUse/darwin/v3code-computer-use-helper'); }
	}
	return missing;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const missing = checkSmoke(root);
	if (missing.length) {
		console.error(`Smoke launch blocked:\n${missing.map(item => `- ${item}`).join('\n')}\nBuild extensions/media, compile CommonJS preloads, and stage the helper before launching.`);
		process.exitCode = 1;
	} else { console.log('Smoke preflight passed: core, React, built-in entrypoints, selected media, preload syntax and helper. Runtime activation/permissions still require verification.'); }
}
