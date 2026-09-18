/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { resolve } from 'node:path';
import {
	DEFAULT_REPO_ROOT,
	loadArtifactManifest,
	validateRuntimeAssetContract,
	verifyRuntimeAssetGroups,
} from './runtime-asset-contract.mjs';

function value(name) {
	const index = process.argv.indexOf(`--${name}`);
	return index < 0 ? undefined : process.argv[index + 1];
}

const platform = value('platform');
const rootValue = value('root');
const groups = (value('groups') ?? 'semantic-index-structural').split(',').filter(Boolean);
if (!platform || !rootValue) {
	console.error('usage: node build/verify/verify-runtime-assets.mjs --platform <platform> --root <package> [--groups a,b]');
	process.exit(2);
}

const manifest = loadArtifactManifest();
const contractIssues = validateRuntimeAssetContract(manifest, DEFAULT_REPO_ROOT);
const results = contractIssues.map((detail, index) => ({ status: 'FAIL', id: `runtime-contract-${index + 1}`, detail }));
if (contractIssues.length === 0) {
	results.push(...verifyRuntimeAssetGroups({
		manifest,
		platform,
		root: resolve(DEFAULT_REPO_ROOT, rootValue),
		groupNames: groups,
	}));
}

for (const result of results) {
	console.log(`[${result.status}] ${result.id}: ${result.detail}`);
}
const failures = results.filter(result => result.status === 'FAIL').length;
console.log(`${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
