/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_REPO_ROOT, loadArtifactManifest, resolvePlatformConfig } from './runtime-asset-contract.mjs';

test('every platform requires the installed Google SDK Node import entry', () => {
	const sdkRoot = join(DEFAULT_REPO_ROOT, 'node_modules/@google/genai');
	const sdk = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
	const lock = JSON.parse(readFileSync(join(DEFAULT_REPO_ROOT, 'package-lock.json'), 'utf8'));
	assert.equal(sdk.version, lock.packages['node_modules/@google/genai'].version);
	const entry = sdk.exports['.'].node.import.replace(/^\.\//, '');
	assert.equal(entry, sdk.main);
	const size = statSync(join(sdkRoot, entry)).size;
	const manifest = loadArtifactManifest();
	for (const platform of Object.keys(manifest.platforms)) {
		const config = resolvePlatformConfig(manifest, platform);
		const check = config.artifacts.find(artifact => artifact.id === 'google-genai-sdk');
		assert.ok(check?.shared, `${platform}: Google SDK must remain required`);
		assert.ok(check.path.endsWith(`/app/node_modules/@google/genai/${entry}`), `${platform}: gate must match the Node import export`);
		assert.ok(check.minBytes >= 211000, `${platform}: preserve truncation protection`);
		assert.ok(size >= check.minBytes, `${platform}: installed entry is truncated`);
	}
});
