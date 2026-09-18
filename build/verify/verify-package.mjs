/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Post-package artifact gate. A packaged tree that is missing ANY required
// artifact — or that contains a forbidden one — fails with a non-zero exit and
// a printed list of what is wrong, BEFORE signing and before any human sees it.
// This exists because Windows builds repeatedly shipped without the beast
// sidecar and the computer-use helper, and nothing failed.
//
//   node build/verify/verify-package.mjs --platform win32-x64 --root <treeDir>
//   node build/verify/verify-package.mjs --platform darwin-arm64 --root <appPath>
//   node build/verify/verify-package.mjs --parity
//
// Exit codes: 0 = all pass, 1 = one or more FAIL, 2 = bad invocation.
// Output is plain text only. Every path in the manifest came from a walked real
// package or the script line that stages it — see artifact-manifest.json.

import { readFileSync, statSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlatformConfig, validateRuntimeAssetContract } from './runtime-asset-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, 'artifact-manifest.json');
const REPO = resolve(HERE, '..', '..');

function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}
function has(name) {
	return process.argv.includes(`--${name}`);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

// macOS architecture packages share one product contract. Materialize derived
// platforms before parity/runtime validation so every new shared arm64 gate is
// inherited by x64 unless the manifest explicitly says otherwise.
for (const [platform, derivation] of Object.entries(manifest.derivedPlatforms ?? {})) {
	if (manifest.platforms[platform]) {
		throw new Error(`derived platform ${platform} is also declared directly`);
	}
	const source = manifest.platforms[derivation.from];
	if (!source) {
		throw new Error(`derived platform ${platform} references missing source ${derivation.from}`);
	}
	let serialized = JSON.stringify(source);
	for (const [from, to] of derivation.replacements ?? []) {
		serialized = serialized.split(from).join(to);
	}
	const derived = JSON.parse(serialized);
	for (const [category, entries] of Object.entries(derivation.overrides ?? {})) {
		if (!['artifacts', 'forbidden', 'asar', 'content'].includes(category)) {
			throw new Error(`derived platform ${platform} has unsupported override category ${category}`);
		}
		for (const [id, override] of Object.entries(entries)) {
			const entry = (derived[category] ?? []).find(candidate => candidate.id === id);
			if (!entry) {
				throw new Error(`derived platform ${platform} override references missing ${category} entry ${id}`);
			}
			Object.assign(entry, override);
		}
	}
	manifest.platforms[platform] = derived;
}
const rows = [];
let failed = 0;

function record(status, id, detail) {
	rows.push({ status, id, detail });
	if (status === 'FAIL') {
		failed++;
	}
}

/** Recursive byte size of a directory (files only, symlinks not followed). */
function dirBytes(dir) {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			total += dirBytes(full);
		} else if (entry.isFile()) {
			total += statSync(full).size;
		}
	}
	return total;
}

function checkArtifact(entry, root, minDefault) {
	if (!entry.path || entry.path.includes('<<FILL') || entry.status === 'UNRESOLVED') {
		record('FAIL', entry.id, 'unresolved path in manifest');
		return;
	}
	const full = join(root, entry.path);
	if (!existsSync(full)) {
		record('FAIL', entry.id, `missing: ${entry.path}`);
		return;
	}
	const st = statSync(full);
	const min = entry.minBytes ?? minDefault;
	if (st.isDirectory()) {
		const bytes = dirBytes(full);
		if (bytes < min) {
			record('FAIL', entry.id, `dir too small: ${entry.path} (${bytes}b < ${min}b)`);
		} else {
			record('PASS', entry.id, `dir ${entry.path} (${bytes}b)`);
		}
		return;
	}
	if (st.size < min) {
		record('FAIL', entry.id, `too small: ${entry.path} (${st.size}b < ${min}b)`);
		return;
	}
	record('PASS', entry.id, `${entry.path} (${st.size}b)`);
}

/**
 * Assert what lives INSIDE an asar archive — the one place a file-level tree
 * walk cannot see. Today both platforms ship an EMPTY node_modules.asar (28
 * bytes, `{"files":{}}`) with every dependency unpacked as real files, so a
 * plain tree check happens to be sufficient. That is a property of the current
 * build, not a guarantee: if packaging ever starts packing modules into the
 * archive, every file-existence check here would still pass while the app
 * failed to resolve them at runtime. So verify the archive matches the
 * expectation rather than assuming it stays empty.
 *
 * Parses the asar header directly (8-byte pickle prefix, then a JSON index) so
 * this needs no dependency — @electron/asar is not available to the packaging
 * scripts on every platform.
 */
function checkAsar(entry, root) {
	const archive = join(root, entry.path);
	if (!existsSync(archive)) {
		record(entry.expect === 'absent' ? 'PASS' : 'FAIL', entry.id, `asar missing: ${entry.path}`);
		return;
	}
	let index;
	try {
		const fd = openSync(archive, 'r');
		const prefix = Buffer.alloc(16);
		readSync(fd, prefix, 0, 16, 0);
		// asar: UInt32 pickle size, UInt32 header-pickle size, UInt32 string
		// size, UInt32 json length — the JSON index follows at byte 16.
		const jsonLen = prefix.readUInt32LE(12);
		const body = Buffer.alloc(jsonLen);
		readSync(fd, body, 0, jsonLen, 16);
		closeSync(fd);
		index = JSON.parse(body.toString('utf8'));
	} catch (err) {
		record('FAIL', entry.id, `asar header unreadable: ${entry.path} (${err.message})`);
		return;
	}
	const names = Object.keys(index.files ?? {});
	if (entry.expect === 'empty') {
		if (names.length === 0) {
			record('PASS', entry.id, `${entry.path} is empty as expected (all modules unpacked)`);
		} else {
			record('FAIL', entry.id, `${entry.path} now packs ${names.length} entr${names.length === 1 ? 'y' : 'ies'} (${names.slice(0, 5).join(', ')}) — the tree checks above cannot see inside it, so the manifest must declare what belongs in here before this can pass`);
		}
		return;
	}
	for (const required of entry.contains ?? []) {
		if (names.includes(required)) {
			record('PASS', `${entry.id}:${required}`, `${entry.path}!${required}`);
		} else {
			record('FAIL', `${entry.id}:${required}`, `${entry.path} is missing ${required}`);
		}
	}
}

/** Collect files under dir (recursive) whose name ends with suffix. */
function findFilesBySuffix(dir, suffix, hits) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			findFilesBySuffix(full, suffix, hits);
		} else if (entry.name.endsWith(suffix)) {
			hits.push(full);
		}
	}
}

/**
 * Forbidden entries must NOT exist. A trailing * is a prefix match on the
 * parent dir. A `<dir>/**` + `/*<suffix>` pattern matches ANY file anywhere
 * under <dir> whose name ends with <suffix> (e.g. `out/**` + `/*.js.map`).
 */
function checkForbidden(entry, root) {
	const recursive = entry.path.match(/^(?<base>[^*]+)\/\*\*\/\*(?<suffix>[^*/]+)$/);
	if (recursive) {
		const base = join(root, recursive.groups.base);
		if (!existsSync(base)) {
			record('PASS', entry.id, `clean (no ${recursive.groups.base})`);
			return;
		}
		const hits = [];
		findFilesBySuffix(base, recursive.groups.suffix, hits);
		if (hits.length) {
			const shown = hits.slice(0, 3).map(h => h.slice(root.length + 1)).join(', ');
			record('FAIL', entry.id, `forbidden present: ${hits.length} file(s) matching ${entry.path} (${shown}${hits.length > 3 ? ', ...' : ''})`);
		} else {
			record('PASS', entry.id, `clean (${entry.path})`);
		}
		return;
	}
	if (entry.path.endsWith('*')) {
		const parent = join(root, dirname(entry.path));
		const prefix = basename(entry.path).slice(0, -1);
		if (!existsSync(parent)) {
			record('PASS', entry.id, `clean (no ${dirname(entry.path)})`);
			return;
		}
		const hits = readdirSync(parent).filter(name => name.startsWith(prefix));
		if (hits.length) {
			record('FAIL', entry.id, `forbidden present: ${dirname(entry.path)}/${hits.join(', ')}`);
		} else {
			record('PASS', entry.id, `clean (${entry.path})`);
		}
		return;
	}
	if (existsSync(join(root, entry.path))) {
		record('FAIL', entry.id, `forbidden present: ${entry.path}`);
	} else {
		record('PASS', entry.id, `clean (${entry.path})`);
	}
}

/**
 * Content assertions on a shipped file. `requiredPatterns` are regex sources
 * that must appear; `forbiddenPatterns` must NOT appear.
 *
 * This exists because of the 1.4.9-0086 blank-window bug: a `common/` helper
 * imported `node:crypto`, a browser-layer module pulled it into
 * workbench.desktop.main.js, and the renderer CSP refused the `node:`
 * specifier — so the entire workbench bundle failed to load and every window
 * rendered grey, on mac and Windows alike. Every structural check passed on
 * that build: the file existed and was the right size. Only its CONTENT was
 * fatal.
 */
function checkContent(entry, root) {
	const file = join(root, entry.path);
	if (!existsSync(file)) {
		record('FAIL', entry.id, `missing: ${entry.path}`);
		return;
	}
	const text = readFileSync(file, 'utf8');
	const violations = [];
	for (const pattern of entry.requiredPatterns ?? []) {
		if (!new RegExp(pattern).test(text)) {
			violations.push(`/${pattern}/ missing`);
		}
	}
	for (const pattern of entry.forbiddenPatterns ?? []) {
		const match = text.match(new RegExp(pattern));
		if (match) {
			violations.push(`/${pattern}/ matched "${match[0].slice(0, 60)}"`);
		}
	}
	if (violations.length) {
		record('FAIL', entry.id, `${entry.path}: ${violations.join('; ')}${entry.hint ? ` — ${entry.hint}` : ''}`);
	} else {
		const count = (entry.requiredPatterns?.length ?? 0) + (entry.forbiddenPatterns?.length ?? 0);
		record('PASS', entry.id, `${entry.path} content verified (${count} pattern(s))`);
	}
}

/**
 * Parse the JSON-with-comments format used by VS Code theme files without adding a packaging-time
 * dependency. This removes comments and trailing commas only while outside strings, so values such
 * as `vscode://schemas/color-theme` are preserved verbatim.
 */
function parseJsonc(text, source) {
	let withoutComments = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			withoutComments += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			withoutComments += ch;
			continue;
		}
		if (ch === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') { i++; }
			withoutComments += '\n';
			continue;
		}
		if (ch === '/' && next === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i++; }
			i++;
			continue;
		}
		withoutComments += ch;
	}

	let normalized = '';
	inString = false;
	escaped = false;
	for (let i = 0; i < withoutComments.length; i++) {
		const ch = withoutComments[i];
		if (inString) {
			normalized += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			normalized += ch;
			continue;
		}
		if (ch === ',') {
			let lookahead = i + 1;
			while (/\s/.test(withoutComments[lookahead] ?? '')) { lookahead++; }
			if (withoutComments[lookahead] === '}' || withoutComments[lookahead] === ']') {
				continue;
			}
		}
		normalized += ch;
	}
	try {
		return JSON.parse(normalized);
	} catch (error) {
		throw new Error(`${source}: ${error.message}`);
	}
}

/** Validate every theme/icon contribution from the exact packaged extension payload. */
function checkThemeContributions(config, root) {
	const extensionsRoot = join(root, config.extensionsPath);
	if (!existsSync(extensionsRoot)) {
		record('FAIL', 'theme-contributions', `extensions directory missing: ${config.extensionsPath}`);
		return;
	}

	const forbiddenNameHashes = new Set(config.forbiddenExtensionNameSha256 ?? []);
	const required = new Set(config.requiredThemeLabels ?? []);
	const seenThemeIds = new Map();
	const foundThemeLabels = new Set();
	let checkedFiles = 0;
	const issues = [];
	const parsedResources = new Set();

	const validateThemeResource = (extensionDir, resource, displayPath) => {
		if (parsedResources.has(resource)) { return; }
		parsedResources.add(resource);
		if (!existsSync(resource)) {
			issues.push(`contributed resource missing: ${displayPath}`);
			return;
		}
		let data;
		try {
			data = parseJsonc(readFileSync(resource, 'utf8'), displayPath);
			checkedFiles++;
		} catch (error) {
			issues.push(error.message);
			return;
		}
		if (typeof data.include === 'string') {
			const included = resolve(dirname(resource), data.include);
			const escapedExtension = relative(extensionDir, included).startsWith(`..${sep}`) || relative(extensionDir, included) === '..';
			if (escapedExtension) {
				issues.push(`${displayPath}: include escapes its extension: ${data.include}`);
				return;
			}
			validateThemeResource(extensionDir, included, relative(root, included));
		}
	};

	for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) { continue; }
		const entryNameHash = createHash('sha256').update(entry.name).digest('hex');
		if (forbiddenNameHashes.has(entryNameHash)) {
			issues.push(`forbidden stale extension present: ${entry.name}`);
		}
		const extensionDir = join(extensionsRoot, entry.name);
		const packagePath = join(extensionDir, 'package.json');
		if (!existsSync(packagePath)) { continue; }
		let extensionPackage;
		try {
			extensionPackage = parseJsonc(readFileSync(packagePath, 'utf8'), relative(root, packagePath));
		} catch (error) {
			issues.push(error.message);
			continue;
		}
		for (const contribution of extensionPackage.contributes?.themes ?? []) {
			const id = contribution.id ?? contribution.label;
			if (id) {
				const previous = seenThemeIds.get(id);
				if (previous) {
					issues.push(`duplicate theme id/label "${id}" in ${previous} and ${entry.name}`);
				} else {
					seenThemeIds.set(id, entry.name);
				}
			}
			// Built-in themes commonly localize `label` through package.nls.json
			// (for example "%dark2026ThemeLabel%"). Their stable contribution id
			// is the runtime setting value, so either form can satisfy the package
			// contract.
			if (contribution.id) { foundThemeLabels.add(contribution.id); }
			if (contribution.label) { foundThemeLabels.add(contribution.label); }
		}

		const contributions = [
			...(extensionPackage.contributes?.themes ?? []),
			...(extensionPackage.contributes?.iconThemes ?? []),
		];
		for (const contribution of contributions) {
			if (typeof contribution.path !== 'string') {
				issues.push(`${entry.name}: contribution has no path`);
				continue;
			}
			const resource = resolve(extensionDir, contribution.path);
			const escapedExtension = relative(extensionDir, resource).startsWith(`..${sep}`) || relative(extensionDir, resource) === '..';
			if (escapedExtension) {
				issues.push(`${entry.name}: contribution escapes its extension: ${contribution.path}`);
				continue;
			}
			validateThemeResource(extensionDir, resource, relative(root, resource));
		}
	}

	for (const label of required) {
		if (!foundThemeLabels.has(label)) {
			issues.push(`required product theme id/label is not contributed: ${label}`);
		}
	}
	if (issues.length) {
		for (const [index, issue] of issues.entries()) {
			record('FAIL', `theme-contributions-${index + 1}`, issue);
		}
		return;
	}
	record('PASS', 'theme-contributions', `${checkedFiles} packaged theme/icon JSON files parse; required product themes are present; no stale duplicate extension`);
}

/** Every shared package assertion id must be declared on every platform. */
function parity() {
	const names = Object.keys(manifest.platforms);
	const shared = new Map();
	for (const p of names) {
		const config = resolvePlatformConfig(manifest, p);
		for (const category of ['artifacts', 'forbidden', 'asar', 'content']) {
			for (const e of config[category] ?? []) {
				if (!e.shared) {
					continue;
				}
				const parityId = `${category}:${e.id}`;
				if (!shared.has(parityId)) {
					shared.set(parityId, { present: new Set(), expected: e.platforms ? new Set(e.platforms) : new Set(names) });
				}
				shared.get(parityId).present.add(p);
			}
		}
	}
	for (const [id, { present, expected }] of shared) {
		const missing = [...expected].filter(p => !present.has(p));
		if (missing.length) {
			record('FAIL', id, `shared artifact not declared for: ${missing.join(', ')}`);
		} else {
			record('PASS', id, `declared on required platforms: ${[...expected].join(', ')}`);
		}
	}
}

function runtimeContract() {
	const issues = validateRuntimeAssetContract(manifest, REPO);
	if (issues.length === 0) {
		record('PASS', 'runtime-asset-contract', 'runtime feature groups and local/cloud grammar demand match the package manifest');
		return;
	}
	for (const [index, issue] of issues.entries()) {
		record('FAIL', `runtime-asset-contract-${index + 1}`, issue);
	}
}

function report(title) {
	const width = Math.max(...rows.map(r => r.id.length), 4);
	process.stdout.write(`\n${title}\n`);
	for (const r of rows) {
		process.stdout.write(`  [${r.status}] ${r.id.padEnd(width)}  ${r.detail}\n`);
	}
	process.stdout.write(`\n  ${rows.length - failed} passed, ${failed} failed\n\n`);
}

if (has('parity')) {
	runtimeContract();
	parity();
	report('PACKAGE MANIFEST PARITY');
} else {
	const platform = arg('platform');
	if (!platform || !manifest.platforms[platform]) {
		process.stderr.write(`unknown or missing --platform (have: ${Object.keys(manifest.platforms).join(', ')})\n`);
		process.exit(2);
	}
	const cfg = resolvePlatformConfig(manifest, platform);
	const root = resolve(REPO, arg('root') ?? cfg.root);
	if (!existsSync(root)) {
		process.stderr.write(`package root does not exist: ${root}\n`);
		process.exit(2);
	}
	runtimeContract();
	for (const e of cfg.artifacts ?? []) {
		checkArtifact(e, root, manifest.minBytesDefault);
	}
	for (const e of cfg.forbidden ?? []) {
		checkForbidden(e, root);
	}
	for (const e of cfg.asar ?? []) {
		checkAsar(e, root);
	}
	for (const e of cfg.content ?? []) {
		checkContent(e, root);
	}
	if (cfg.themeContributions) {
		checkThemeContributions(cfg.themeContributions, root);
	}
	report(`PACKAGE VERIFY: ${platform} -> ${root}`);
}

process.exit(failed > 0 ? 1 : 0);
