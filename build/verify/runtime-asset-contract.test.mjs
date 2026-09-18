/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	DEFAULT_REPO_ROOT,
	discoverSemanticIndexGrammars,
	loadArtifactManifest,
	resolvePlatformConfig,
	validateRuntimeAssetContract,
	verifyRuntimeAssetGroups,
} from './runtime-asset-contract.mjs';

test('local, cloud, and package grammar contracts match exactly', () => {
	const manifest = loadArtifactManifest();
	assert.deepEqual(validateRuntimeAssetContract(manifest), []);
	const sources = [...discoverSemanticIndexGrammars().values()].map(set => [...set].sort());
	assert.equal(sources.length, 2);
	assert.deepEqual(sources[0], sources[1]);
	assert.deepEqual(sources[0], [
		'tree-sitter-c-sharp',
		'tree-sitter-cpp',
		'tree-sitter-go',
		'tree-sitter-java',
		'tree-sitter-javascript',
		'tree-sitter-php',
		'tree-sitter-python',
		'tree-sitter-ruby',
		'tree-sitter-rust',
		'tree-sitter-tsx',
		'tree-sitter-typescript',
	]);
});

test('linux package contract inherits shared assets and replaces native paths', () => {
	const manifest = loadArtifactManifest();
	const linux = resolvePlatformConfig(manifest, 'linux-x64');
	const artifacts = new Map(linux.artifacts.map(artifact => [artifact.id, artifact]));
	assert.equal(artifacts.get('workbench-shell-js').path, 'resources/app/out/vs/code/electron-browser/workbench/workbench.js');
	assert.equal(artifacts.get('node-pty-native').path, 'resources/app/node_modules/node-pty/build/Release/pty.node');
	assert.equal(artifacts.get('beast-sidecar').path, 'resources/beast/beast');
	assert.equal(artifacts.get('ripgrep').path, 'resources/app/node_modules/@vscode/ripgrep-universal/bin/linux-x64/rg');
	assert.equal(artifacts.has('computer-use-helper'), false);
});

test('computer use is explicitly unsupported on linux while supported platforms still require it', () => {
	const manifest = loadArtifactManifest();
	const packageRoot = mkdtempSync(join(tmpdir(), 'v3code-package-assets-'));
	try {
		assert.deepEqual(verifyRuntimeAssetGroups({
			manifest,
			platform: 'linux-x64',
			root: packageRoot,
			groupNames: ['computer-use'],
		}), []);
		const win32 = verifyRuntimeAssetGroups({
			manifest,
			platform: 'win32-x64',
			root: packageRoot,
			groupNames: ['computer-use'],
		});
		assert.ok(win32.some(result => result.id === 'computer-use-helper' && result.status === 'FAIL'));
	} finally {
		rmSync(packageRoot, { recursive: true, force: true });
	}
});

test('runtime group references must name declared package artifacts', () => {
	const manifest = structuredClone(loadArtifactManifest());
	manifest.runtimeAssetGroups['semantic-index-potion'].artifactIds.push('missing-loader');
	const issues = validateRuntimeAssetContract(manifest);
	assert.ok(issues.some(issue => issue.includes('semantic-index-potion references undeclared artifact missing-loader')));
});

test('package verification cannot borrow a runtime asset from workspace node_modules', () => {
	const manifest = loadArtifactManifest();
	const packageRoot = mkdtempSync(join(tmpdir(), 'v3code-package-assets-'));
	try {
		const workspaceGrammar = join(DEFAULT_REPO_ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm', 'tree-sitter-typescript.wasm');
		assert.equal(existsSync(workspaceGrammar), true, 'test precondition: grammar exists in workspace node_modules');
		const results = verifyRuntimeAssetGroups({
			manifest,
			platform: 'win32-x64',
			root: packageRoot,
			groupNames: ['semantic-index-structural'],
		});
		assert.ok(results.some(result => result.id === 'grammar-typescript' && result.status === 'FAIL'));
		assert.ok(results.some(result => result.id === 'tree-sitter-runtime-wasm' && result.status === 'FAIL'));
	} finally {
		rmSync(packageRoot, { recursive: true, force: true });
	}
});
