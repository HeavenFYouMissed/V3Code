/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Security ignore list — files that must NEVER enter the semantic index (and
 * therefore never reach an embedding model or a context window): .env files,
 * private keys, certificates, keystores, credential stores, cloud-provider
 * config directories.
 *
 * Pattern set ported verbatim from Continue's core/indexing/ignore.ts
 * (DEFAULT_SECURITY_IGNORE_FILETYPES / DEFAULT_SECURITY_IGNORE_DIRS +
 * isSecurityConcern). Matching is reimplemented dependency-free (no `ignore`
 * npm package in the renderer): a file is a security concern when its basename
 * matches a file pattern OR any path segment matches a dir pattern.
 *
 * This is a hard denylist: it applies before (and regardless of) gitignore
 * layers and the dotfile whitelist. A workspace cannot opt back in.
 */

export const DEFAULT_SECURITY_IGNORE_FILETYPES = [
	// Environment and configuration files with secrets
	'*.env',
	'*.env.*',
	'.env*',
	'config.json',
	'config.yaml',
	'config.yml',
	'settings.json',
	'appsettings.json',
	'appsettings.*.json',

	// Certificate and key files
	'*.key',
	'*.pem',
	'*.p12',
	'*.pfx',
	'*.crt',
	'*.cer',
	'*.jks',
	'*.keystore',
	'*.truststore',

	// Database files that may contain sensitive data
	'*.db',
	'*.sqlite',
	'*.sqlite3',
	'*.mdb',
	'*.accdb',

	// Credential and secret files
	'*.secret',
	'*.secrets',
	'auth.json',
	'*.token',

	// Backup files that might contain sensitive data
	'*.bak',
	'*.backup',
	'*.old',
	'*.orig',

	// Docker secrets
	'docker-compose.override.yml',
	'docker-compose.override.yaml',

	// SSH and GPG
	'id_rsa',
	'id_dsa',
	'id_ecdsa',
	'id_ed25519',
	'*.ppk',
	'*.gpg',
];

export const DEFAULT_SECURITY_IGNORE_DIRS = [
	// Environment and configuration directories
	'.env/',
	'env/',

	// Cloud provider credential directories
	'.aws/',
	'.gcp/',
	'.azure/',
	'.kube/',
	'.docker/',

	// Secret directories
	'secrets/',
	'.secrets/',
	'private/',
	'.private/',
	'certs/',
	'certificates/',
	'keys/',
	'.ssh/',
	'.gnupg/',
	'.gpg/',

	// Temporary directories that might contain sensitive data
	'tmp/secrets/',
	'temp/secrets/',
	'.tmp/',
];

/** Compile a basename glob (`*` = any chars except `/`, `?` = one char) to an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
	let re = '';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === '*') re += '[^/]*';
		else if (c === '?') re += '[^/]';
		else if ('.+^$()|{}[]\\'.includes(c)) re += '\\' + c;
		else re += c;
	}
	return new RegExp(`^${re}$`, 'i');
}

const FILE_PATTERNS: RegExp[] = DEFAULT_SECURITY_IGNORE_FILETYPES.map(globToRegExp);

/** Single-segment dir names (`secrets`, `.aws`, …) — checked per path segment. */
const DIR_NAMES = new Set(
	DEFAULT_SECURITY_IGNORE_DIRS
		.map(d => d.replace(/\/$/, '').toLowerCase())
		.filter(d => !d.includes('/')),
);

/** Multi-segment dir patterns (`tmp/secrets`, …) — checked against the joined path. */
const DIR_PATHS: RegExp[] = DEFAULT_SECURITY_IGNORE_DIRS
	.map(d => d.replace(/\/$/, ''))
	.filter(d => d.includes('/'))
	.map(d => new RegExp(`(^|/)${d.replace(/[.+^$()|{}[\]\\]/g, '\\$&')}(/|$)`, 'i'));

/**
 * True when `name` is a directory whose entire subtree must be excluded
 * (walk-time skip — cheaper than testing every file underneath).
 */
export function isSecurityIgnoredDirName(name: string): boolean {
	return DIR_NAMES.has(name.toLowerCase());
}

/**
 * True when the workspace-relative POSIX path is a security concern: its
 * basename matches a security file pattern, or any directory on the path
 * matches a security dir pattern.
 */
export function isSecurityConcernPath(relPath: string): boolean {
	if (!relPath) return false;
	const segments = relPath.split('/');
	const basename = segments[segments.length - 1];
	for (const p of FILE_PATTERNS) {
		if (p.test(basename)) return true;
	}
	for (let i = 0; i < segments.length - 1; i++) {
		if (DIR_NAMES.has(segments[i].toLowerCase())) return true;
	}
	if (segments.length > 2) {
		const dirPath = segments.slice(0, -1).join('/');
		for (const p of DIR_PATHS) {
			if (p.test(dirPath)) return true;
		}
	}
	return false;
}
