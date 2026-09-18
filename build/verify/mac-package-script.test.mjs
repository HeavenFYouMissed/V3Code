/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_REPO_ROOT } from './runtime-asset-contract.mjs';

test('both Mac architectures remove only the non-runtime isolated-vm source archive', () => {
	const script = readFileSync(join(DEFAULT_REPO_ROOT, 'scripts/v3-package-mac.sh'), 'utf8');
	const start = script.indexOf('# Source archives are not runtime assets.');
	const end = script.indexOf('# The update route lives or dies', start);
	assert.ok(start > 0 && end > start);
	assert.ok(script.slice(0, start).trimEnd().endsWith('fi'), 'archive cleanup must follow the architecture-specific block');
	assert.ok(script.includes('\nBUNDLE_MODULES="$APP_PATH/Contents/Resources/app/node_modules"\n'), 'bundle path must be initialized outside architecture branches');
	const cleanup = script.slice(start, end);
	for (const arch of ['arm64', 'x64']) {
		const fixture = mkdtempSync(join(tmpdir(), 'v3code-mac-archive-'));
		try {
			const modules = 'Contents/Resources/app/node_modules';
			const archive = join(fixture, modules, 'isolated-vm/isolated-vm-6.1.2.tgz');
			const runtime = join(fixture, modules, 'isolated-vm/isolated-vm.js');
			mkdirSync(join(fixture, modules, 'isolated-vm'), { recursive: true });
			writeFileSync(archive, 'non-runtime archive');
			writeFileSync(runtime, 'runtime entry');
			const verify = () => spawnSync(process.execPath, [join(DEFAULT_REPO_ROOT, 'build/verify/verify-package.mjs'),
				'--platform', `darwin-${arch}`, '--root', fixture], { encoding: 'utf8' });
			assert.match(verify().stdout, /\[FAIL\] no-isolated-vm-source-archive/);
			execFileSync('bash', ['-euo', 'pipefail', '-c', cleanup], {
				cwd: fixture,
				env: { ...process.env, ARCH: arch, APP_PATH: '.', BUNDLE_MODULES: modules },
			});
			assert.equal(existsSync(archive), false);
			assert.equal(readFileSync(runtime, 'utf8'), 'runtime entry');
			assert.match(verify().stdout, /\[PASS\] no-isolated-vm-source-archive/);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	}
});
