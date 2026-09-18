/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Minimal `.gitignore` matcher — deliberately dependency-free so the semantic
 * indexer doesn't pull `ignore`/`micromatch` into the renderer bundle.
 *
 * Supported subset (the ~90% of real-world gitignores):
 *   - blank lines + `#` comments are skipped
 *   - trailing `/`  => directory-only pattern
 *   - leading `!`   => negation (un-ignore previously matched path)
 *   - leading `/`   => anchored to the gitignore file's own directory
 *   - `*`           => matches any chars except `/`
 *   - `**`          => matches any chars including `/`
 *   - `?`           => single non-slash char
 *
 * Not yet supported: character classes (`[a-z]`), brace expansion (`{a,b}`).
 * Both are rare in practice; add when a real workspace surfaces the need.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface IgnoreRule {
	readonly re: RegExp;
	readonly negate: boolean;
	readonly dirOnly: boolean;
}

export interface IgnoreLayer {
	/** Absolute path of the directory containing the gitignore. */
	readonly dir: string;
	readonly rules: IgnoreRule[];
}

/** Compile a single gitignore pattern. Returns null for blank/comment lines. */
export function compilePattern(raw: string): IgnoreRule | null {
	const trimmed = raw.trim();
	if (!trimmed || trimmed.startsWith('#')) return null;

	let pat = trimmed;
	const negate = pat.startsWith('!');
	if (negate) pat = pat.slice(1);
	const dirOnly = pat.endsWith('/');
	if (dirOnly) pat = pat.slice(0, -1);
	const rooted = pat.startsWith('/');
	if (rooted) pat = pat.slice(1);
	if (!pat) return null;

	let re = '';
	for (let i = 0; i < pat.length; i++) {
		const c = pat[i];
		if (c === '*') {
			if (pat[i + 1] === '*') { re += '.*'; i++; }
			else re += '[^/]*';
		} else if (c === '?') {
			re += '[^/]';
		} else if ('.+^$()|{}[]\\'.includes(c)) {
			re += '\\' + c;
		} else {
			re += c;
		}
	}
	const prefix = rooted ? '^' : '(^|/)';
	return { re: new RegExp(prefix + re + '($|/)'), negate, dirOnly };
}

/**
 * Load a `.gitignore` file from `dir`. Returns `null` if the file is missing or
 * unreadable (silent — gitignores are advisory).
 */
export async function loadGitignoreLayer(dir: string): Promise<IgnoreLayer | null> {
	let raw: string;
	try {
		raw = await fs.readFile(join(dir, '.gitignore'), 'utf8');
	} catch {
		return null;
	}
	const rules: IgnoreRule[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const rule = compilePattern(line);
		if (rule) rules.push(rule);
	}
	return rules.length ? { dir, rules } : null;
}

/**
 * Decide whether `relFromLayer` (path relative to the deepest layer's dir) is
 * ignored, given the stack of active layers ordered outer→inner. Negations in
 * deeper layers override matches in shallower ones, matching real git semantics.
 *
 * `relFromLayer` MUST already be relative to `layers[layers.length-1].dir` and
 * use forward slashes.
 */
export function isIgnored(relFromLayer: string, isDir: boolean, layers: readonly IgnoreLayer[]): boolean {
	let ignored = false;
	for (const layer of layers) {
		for (const rule of layer.rules) {
			if (rule.dirOnly && !isDir) continue;
			if (rule.re.test(relFromLayer)) ignored = !rule.negate;
		}
	}
	return ignored;
}
