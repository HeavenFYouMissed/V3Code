/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — file extension → languageId mapping for the scanner.
 *
 * Kept separate from the editor's own chunkerLanguages.ts so the security engine has no editor
 * import. Only languages Sentinel actually MODELS (has a normalize.ts kind map for) return an id;
 * everything else returns undefined so the scanner skips it rather than parsing code it can't
 * analyze. v1 targets the JS/TS family (the vibe-code surface); Python is partially modeled.
 */

/** Extensions Sentinel can analyze → the languageId normalize.ts understands. */
const EXT_TO_LANGUAGE: Readonly<Record<string, string>> = {
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	tsx: 'typescriptreact',
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	jsx: 'javascriptreact',
	py: 'python',
	pyi: 'python',
};

/** Map a file path to a modeled languageId, or undefined when Sentinel doesn't analyze it. */
export function languageIdFromPath(path: string): string | undefined {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	const base = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = base.lastIndexOf('.');
	if (dot < 0) { return undefined; }
	return EXT_TO_LANGUAGE[base.slice(dot + 1).toLowerCase()];
}

/** The set of extensions worth listing for a scan (host can pre-filter with this). */
export function scannableExtensions(): readonly string[] {
	return Object.keys(EXT_TO_LANGUAGE);
}
