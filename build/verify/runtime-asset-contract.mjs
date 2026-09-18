/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Runtime-to-package contract shared by the package verifier and retrieval eval.
// A feature group names the files it needs at runtime. Structural-index grammar
// requirements are derived from both shipped implementations so a hand-written
// manifest cannot silently drift away from the client or cloud chunker.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_MANIFEST_PATH = join(HERE, 'artifact-manifest.json');

export const SEMANTIC_LANGUAGE_SOURCES = [
	'src/vs/workbench/contrib/void/common/semanticIndex/chunkerLanguages.ts',
	'cloud/v3index/src/core/chunkerLanguages.ts',
];

export function loadArtifactManifest(path = DEFAULT_MANIFEST_PATH) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function grammarId(grammar) {
	if (!grammar.startsWith('tree-sitter-')) {
		throw new Error(`semantic-index grammar must start with tree-sitter-: ${grammar}`);
	}
	return `grammar-${grammar.slice('tree-sitter-'.length)}`;
}

/** Extract the concrete grammar values from a LanguageProfile table. */
export function grammarsFromLanguageSource(source) {
	return new Set([...source.matchAll(/\bgrammar:\s*'([^']+)'/g)].map(match => match[1]));
}

export function discoverSemanticIndexGrammars(repoRoot = DEFAULT_REPO_ROOT) {
	const bySource = new Map();
	for (const relativePath of SEMANTIC_LANGUAGE_SOURCES) {
		const source = readFileSync(join(repoRoot, relativePath), 'utf8');
		const grammars = grammarsFromLanguageSource(source);
		if (grammars.size === 0) {
			throw new Error(`no semantic-index grammars discovered in ${relativePath}`);
		}
		bySource.set(relativePath, grammars);
	}
	return bySource;
}

function difference(left, right) {
	return [...left].filter(value => !right.has(value)).sort();
}

function artifactMap(platformConfig) {
	const result = new Map();
	for (const artifact of platformConfig.artifacts ?? []) {
		if (!result.has(artifact.id)) {
			result.set(artifact.id, artifact);
		}
	}
	return result;
}

/**
 * Resolve a package platform, including the small set of platform-specific
 * path overrides used by layouts that otherwise have the same contract.
 *
 * Keeping Linux as a derived win32-style layout makes parity meaningful: a
 * new shared artifact added to Windows is automatically demanded on Linux
 * until an explicit, reviewable override says otherwise.
 */
export function resolvePlatformConfig(manifest, platform, resolving = new Set()) {
	const raw = manifest.platforms?.[platform];
	if (!raw) { throw new Error(`unknown package platform: ${platform}`); }
	if (!raw.extends) { return structuredClone(raw); }
	if (resolving.has(platform)) {
		throw new Error(`cyclic package platform inheritance: ${[...resolving, platform].join(' -> ')}`);
	}

	const nextResolving = new Set(resolving);
	nextResolving.add(platform);
	const base = resolvePlatformConfig(manifest, raw.extends, nextResolving);
	const resolved = { ...base, ...structuredClone(raw) };
	delete resolved.extends;

	const overrides = resolved.artifactOverrides ?? {};
	delete resolved.artifactOverrides;
	const inheritedArtifacts = new Map((base.artifacts ?? []).map(artifact => [artifact.id, artifact]));
	for (const [id, override] of Object.entries(overrides)) {
		if (override === null) {
			inheritedArtifacts.delete(id);
			continue;
		}
		const inherited = inheritedArtifacts.get(id);
		if (!inherited) {
			throw new Error(`${platform} overrides undeclared artifact ${id}`);
		}
		inheritedArtifacts.set(id, { ...inherited, ...override, id });
	}
	resolved.artifacts = [...inheritedArtifacts.values(), ...(raw.artifacts ?? [])];
	return resolved;
}

/** Validate source parity, group references, and exact grammar-manifest parity. */
export function validateRuntimeAssetContract(manifest, repoRoot = DEFAULT_REPO_ROOT) {
	const issues = [];
	let sources;
	try {
		sources = discoverSemanticIndexGrammars(repoRoot);
	} catch (error) {
		return [error instanceof Error ? error.message : String(error)];
	}

	const sourceEntries = [...sources.entries()];
	const [canonicalPath, canonicalGrammars] = sourceEntries[0];
	for (const [relativePath, grammars] of sourceEntries.slice(1)) {
		const missing = difference(canonicalGrammars, grammars);
		const extra = difference(grammars, canonicalGrammars);
		if (missing.length || extra.length) {
			issues.push(`semantic grammar drift: ${relativePath} vs ${canonicalPath} (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
		}
	}

	const groups = manifest.runtimeAssetGroups ?? {};
	if (!groups['semantic-index-structural'] || groups['semantic-index-structural'].dynamic !== 'semantic-index-grammars') {
		issues.push('runtimeAssetGroups.semantic-index-structural must declare dynamic=semantic-index-grammars');
	}

	const expectedGrammarIds = new Set([...canonicalGrammars].map(grammarId));
	for (const platform of Object.keys(manifest.platforms ?? {})) {
		let config;
		try {
			config = resolvePlatformConfig(manifest, platform);
		} catch (error) {
			issues.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		const artifacts = artifactMap(config);
		const duplicateIds = (config.artifacts ?? [])
			.map(artifact => artifact.id)
			.filter((id, index, all) => all.indexOf(id) !== index);
		if (duplicateIds.length) {
			issues.push(`${platform} has duplicate artifact ids: ${[...new Set(duplicateIds)].sort().join(', ')}`);
		}

		for (const [groupName, group] of Object.entries(groups)) {
			if (group.platforms && !group.platforms.includes(platform)) { continue; }
			for (const id of group.artifactIds ?? []) {
				if (!artifacts.has(id)) {
					issues.push(`${platform} runtime group ${groupName} references undeclared artifact ${id}`);
				}
			}
		}

		const declaredGrammarIds = new Set([...artifacts.keys()].filter(id => id.startsWith('grammar-')));
		const missing = difference(expectedGrammarIds, declaredGrammarIds);
		const extra = difference(declaredGrammarIds, expectedGrammarIds);
		if (missing.length || extra.length) {
			issues.push(`${platform} semantic grammar manifest drift (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
		}
	}

	return issues;
}

function directoryBytes(path) {
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) { total += directoryBytes(child); }
		else if (entry.isFile()) { total += statSync(child).size; }
	}
	return total;
}

export function runtimeAssetIds(manifest, repoRoot, groupNames, platform) {
	const ids = new Set();
	let discoveredGrammars;
	for (const name of groupNames) {
		const group = manifest.runtimeAssetGroups?.[name];
		if (!group) { throw new Error(`unknown runtime asset group: ${name}`); }
		if (platform && group.platforms && !group.platforms.includes(platform)) { continue; }
		for (const id of group.artifactIds ?? []) { ids.add(id); }
		if (group.dynamic === 'semantic-index-grammars') {
			discoveredGrammars ??= discoverSemanticIndexGrammars(repoRoot).values().next().value;
			for (const grammar of discoveredGrammars) { ids.add(grammarId(grammar)); }
		}
	}
	return [...ids].sort();
}

/** Verify only the runtime feature groups exercised by a test/evaluator. */
export function verifyRuntimeAssetGroups({ manifest, repoRoot = DEFAULT_REPO_ROOT, platform, root, groupNames }) {
	const config = resolvePlatformConfig(manifest, platform);
	const artifacts = artifactMap(config);
	const results = [];
	for (const id of runtimeAssetIds(manifest, repoRoot, groupNames, platform)) {
		const artifact = artifacts.get(id);
		if (!artifact) {
			results.push({ status: 'FAIL', id, detail: 'runtime artifact is not declared for this platform' });
			continue;
		}
		const fullPath = join(root, artifact.path);
		if (!existsSync(fullPath)) {
			results.push({ status: 'FAIL', id, detail: `missing: ${artifact.path}` });
			continue;
		}
		const stat = statSync(fullPath);
		const bytes = stat.isDirectory() ? directoryBytes(fullPath) : stat.size;
		const minimum = artifact.minBytes ?? manifest.minBytesDefault ?? 0;
		if (bytes < minimum) {
			results.push({ status: 'FAIL', id, detail: `too small: ${artifact.path} (${bytes}b < ${minimum}b)` });
		} else {
			results.push({ status: 'PASS', id, detail: `${artifact.path} (${bytes}b)` });
		}
	}
	return results;
}

export function packageAppRoot(root, platform) {
	if (platform.startsWith('darwin-')) { return join(root, 'Contents', 'Resources', 'app'); }
	if (platform.startsWith('win32-') || platform.startsWith('linux-')) { return join(root, 'resources', 'app'); }
	throw new Error(`unsupported package platform layout: ${platform}`);
}
