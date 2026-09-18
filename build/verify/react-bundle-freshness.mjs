/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Records and verifies that the generated React hosts consumed by core-ci came
// from the current React source tree. This closes the hole where a direct call
// to a low-level packager reused an old gitignored react/out directory and
// shipped a perfectly valid but stale Settings/onboarding UI.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const REACT_ROOT = join(REPO, 'src/vs/workbench/contrib/void/browser/react');
const SOURCE_ROOTS = [
	join(REACT_ROOT, 'src'),
	join(REACT_ROOT, 'build.js'),
	join(REACT_ROOT, 'tailwind.config.js'),
	join(REACT_ROOT, 'tsconfig.json'),
	join(REACT_ROOT, 'tsup.config.js'),
	join(REPO, 'package.json'),
	join(REPO, 'package-lock.json'),
];
const GENERATED_ROOT = join(REACT_ROOT, 'out');
const STAMP = join(REPO, '.build/react-bundle-freshness.json');
const MIN_BUNDLE = join(REPO, 'out-vscode-min/vs/workbench/workbench.desktop.main.js');

function filesUnder(target) {
	if (!existsSync(target)) { throw new Error(`freshness input is missing: ${relative(REPO, target)}`); }
	if (statSync(target).isFile()) { return [target]; }
	const entries = readdirSync(target, { withFileTypes: true });
	const files = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = join(target, entry.name);
		if (entry.isDirectory()) { files.push(...filesUnder(full)); }
		else if (entry.isFile()) { files.push(full); }
	}
	return files;
}

function digestTargets(targets) {
	const hash = createHash('sha256');
	let count = 0;
	for (const target of targets) {
		const files = filesUnder(target);
		if (files.length === 0) { throw new Error(`freshness input has no files: ${relative(REPO, target)}`); }
		for (const file of files) {
			hash.update(relative(REPO, file));
			hash.update('\0');
			hash.update(readFileSync(file));
			hash.update('\0');
			count++;
		}
	}
	return { sha256: hash.digest('hex'), files: count };
}

function currentCommit() {
	return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
}

function currentState() {
	if (!existsSync(GENERATED_ROOT)) { throw new Error('generated React output is missing; run npm run buildreact'); }
	if (!existsSync(MIN_BUNDLE)) { throw new Error('out-vscode-min workbench bundle is missing; run a full compile'); }
	return {
		commit: currentCommit(),
		source: digestTargets(SOURCE_ROOTS),
		generated: digestTargets([GENERATED_ROOT]),
		minBundle: digestTargets([MIN_BUNDLE]),
	};
}

const mode = process.argv[2];
if (mode === '--record') {
	const state = currentState();
	const buildCommit = process.env['BUILD_SOURCEVERSION'];
	if (buildCommit && buildCommit !== state.commit) {
		throw new Error(`BUILD_SOURCEVERSION ${buildCommit} does not match source commit ${state.commit}`);
	}
	mkdirSync(dirname(STAMP), { recursive: true });
	writeFileSync(STAMP, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	process.stdout.write(`recorded React bundle freshness (${state.source.files} source, ${state.generated.files} generated files)\n`);
} else if (mode === '--check') {
	if (!existsSync(STAMP)) { throw new Error('React freshness stamp is missing; run the packager without --skip-compile first'); }
	const expected = JSON.parse(readFileSync(STAMP, 'utf8'));
	const actual = currentState();
	if (expected.commit !== actual.commit) {
		throw new Error(`source commit changed since the last full compile (${expected.commit ?? 'unbound'} -> ${actual.commit}); --skip-compile would package stale output`);
	}
	for (const key of ['source', 'generated', 'minBundle']) {
		if (expected[key]?.sha256 !== actual[key]?.sha256) {
			throw new Error(`${key} changed since the last full compile; --skip-compile would package stale React UI`);
		}
	}
	process.stdout.write('React bundle freshness verified\n');
} else {
	process.stderr.write('usage: node build/verify/react-bundle-freshness.mjs --record|--check\n');
	process.exit(2);
}
