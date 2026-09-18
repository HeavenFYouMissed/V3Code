/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Grammar A/B — measure what shipping the tree-sitter grammars actually changes.
//
// WHY THIS EXISTS, AND WHY `run-eval.mjs` CANNOT ANSWER IT:
//
//   The bug fixed in 8cf8c69e9 lived in build/.moduleignore — a PACKAGING
//   allowlist. It stripped 10 of 11 grammars from the shipped .app/.exe.
//   run-eval.mjs reads grammars from node_modules (run-eval.mjs:296,311),
//   which always had all 16. So the offline eval NEVER had the bug and cannot
//   observe the fix by re-running against a new build: it has been measuring
//   post-fix behavior the whole time.
//
//   Re-running the eval on build #9 would show a delta of exactly zero and that
//   zero would mean nothing.
//
// WHAT THIS DOES INSTEAD:
//
//   Reproduces both states directly against the real production chunker by
//   controlling which grammar bytes `readGrammarBytes` is allowed to return:
//
//     PRE  = the 6 grammars upstream's .moduleignore allowed
//            (typescript, regex, ini, css, powershell, bash)
//     POST = those + the 10 added in 8cf8c69e9
//
//   TreeSitterChunker falls back to blind line windows when a grammar fails to
//   load (chunker.ts:88-93, catch -> null), silently. So PRE is exactly what
//   every shipped build did for Python/Go/Rust/Java/C#/C++/PHP/Ruby/JS/JSX.
//
//   Emits per-language chunk-boundary statistics for both states. A chunk whose
//   span matches a function/class/method node is a symbol chunk; a chunk that
//   starts mid-body is a fragment. That difference is the whole bug.
//
// Usage:
//   node scripts/retrieval-eval/grammar-ab.mjs [--repo <path>] [--max-files N]

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

function valFlag(name, dflt) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const MAX_FILES = Number(valFlag('--max-files', '0'));

// The exact allowlist upstream's build/.moduleignore carried before 8cf8c69e9.
// Verified: git show 8cf8c69e9 -- build/.moduleignore
const PRE_FIX_GRAMMARS = new Set([
	'tree-sitter-typescript',
	'tree-sitter-regex',
	'tree-sitter-ini',
	'tree-sitter-css',
	'tree-sitter-powershell',
	'tree-sitter-bash',
]);

// Extension -> language id, mirroring chunkerLanguages.ts EXT_TO_LANGUAGE.
const EXT_TO_LANG = {
	ts: 'typescript', mts: 'typescript', cts: 'typescript',
	tsx: 'typescriptreact',
	js: 'javascript', mjs: 'javascript', cjs: 'javascript',
	jsx: 'javascriptreact',
	py: 'python', pyi: 'python',
	go: 'go',
	rs: 'rust',
	java: 'java',
	cs: 'csharp',
	cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
	c: 'c', h: 'c',
	rb: 'ruby',
};

const SKIP_DIRS = new Set([
	'node_modules', '.git', 'dist', 'out', 'build', '.build',
	'target', 'vendor', '__pycache__', 'coverage', '.beast',
]);

// ---------------------------------------------------------------------------
// Bundle the production chunker exactly as run-eval.mjs does.
// ---------------------------------------------------------------------------
const esbuildBin = join(REPO_ROOT, 'node_modules', '.bin', 'esbuild');
const outDir = join(HERE, '.ab-bundle');
mkdirSync(outDir, { recursive: true });
const entry = join(outDir, 'entry.ts');
writeFileSync(entry, `
export { TreeSitterChunker } from '${join(REPO_ROOT, 'src/vs/workbench/contrib/void/browser/semanticIndex/treeSitterChunker.ts').replace(/\\\\/g, '/')}';
export { languageFromExtension, profileFor } from '${join(REPO_ROOT, 'src/vs/workbench/contrib/void/common/semanticIndex/chunkerLanguages.ts').replace(/\\\\/g, '/')}';
`);
const bundlePath = join(outDir, 'bundle.mjs');
execFileSync(esbuildBin, [
	entry, '--bundle', '--format=esm', '--platform=node',
	'--log-level=error', `--outfile=${bundlePath}`,
], { cwd: REPO_ROOT });
const prod = await import(pathToFileURL(bundlePath).href);

// ---------------------------------------------------------------------------
// Tree-sitter runtime.
// ---------------------------------------------------------------------------
const wasmDir = join(REPO_ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
const require = createRequire(import.meta.url);
const tsMod = require(join(wasmDir, 'tree-sitter.js'));
await tsMod.Parser.init({ locateFile: (f) => join(wasmDir, f) });
const runtime = { Parser: tsMod.Parser, Language: tsMod.Language };

/**
 * Builds a chunker whose grammar loading is restricted to `allowed`. Passing
 * null for `allowed` permits every grammar present in node_modules.
 * This is the mechanism that reproduces the packaging bug offline.
 */
function makeChunker(allowed) {
	return new prod.TreeSitterChunker({
		loadRuntime: async () => runtime,
		readGrammarBytes: async (grammarName) => {
			if (allowed && !allowed.has(grammarName)) { return null; }  // == absent from the package
			try { return new Uint8Array(await readFile(join(wasmDir, `${grammarName}.wasm`))); }
			catch { return null; }
		},
		log: () => { },
	});
}

// ---------------------------------------------------------------------------
// Corpus.
// ---------------------------------------------------------------------------
let files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
	.toString().split('\n').map(s => s.trim()).filter(rel => {
		if (!rel) { return false; }
		const parts = rel.split('/');
		if (parts.some((p, i) => i < parts.length - 1 && SKIP_DIRS.has(p))) { return false; }
		const base = parts[parts.length - 1];
		const dot = base.lastIndexOf('.');
		if (dot <= 0) { return false; }
		return EXT_TO_LANG[base.slice(dot + 1).toLowerCase()] !== undefined;
	});
if (MAX_FILES > 0) { files = files.slice(0, MAX_FILES); }

console.log(`corpus: ${files.length} code files`);

// ---------------------------------------------------------------------------
// Chunk under both grammar sets.
// ---------------------------------------------------------------------------
async function chunkAll(chunker, label) {
	const byLang = new Map();   // lang -> { files, chunks, named, spans:[] }
	const t0 = Date.now();
	for (const rel of files) {
		const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
		const lang = EXT_TO_LANG[ext];
		if (!lang) { continue; }
		let text;
		try { text = await readFile(join(REPO_ROOT, rel), 'utf8'); } catch { continue; }
		if (!text || text.length > 800_000) { continue; }

		// extract() returns null when no grammar loaded -> production falls back
		// to windowUnits(), which is exactly what a shipped build did.
		let units;
		try { units = await chunker.extract(rel, text, lang); }
		catch { continue; }
		let structural = true;
		if (!units) { units = chunker.windowUnits(rel, text); structural = false; }

		let e = byLang.get(lang);
		if (!e) { e = { files: 0, structuralFiles: 0, chunks: 0, symbol: 0, window: 0, kinds: new Map() }; byLang.set(lang, e); }
		e.files++;
		if (structural) { e.structuralFiles++; }
		e.chunks += units.length;
		for (const u of units) {
			// windowUnits() emits kind:'block' with a LINE LABEL as the name
			// ("file.py:41") — that is a fragment, not a symbol. Only chunks
			// produced by the structural path carry a real identifier.
			if (u.kind === 'block') { e.window++; } else { e.symbol++; }
			e.kinds.set(u.kind, (e.kinds.get(u.kind) ?? 0) + 1);
		}
	}
	console.log(`${label}: chunked in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	return byLang;
}

const preChunker = makeChunker(PRE_FIX_GRAMMARS);
const postChunker = makeChunker(null);

const pre = await chunkAll(preChunker, 'PRE ');
const post = await chunkAll(postChunker, 'POST');

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const langs = [...new Set([...pre.keys(), ...post.keys()])].sort();
const EMPTY = { files: 0, structuralFiles: 0, chunks: 0, symbol: 0, window: 0 };
console.log('');
console.log('                            PRE (shipped builds)      POST (with grammars)');
console.log('lang                files   symbol   window  struct   symbol   window  struct   delta symbol');
console.log('------------------- ------- -------- ------- ------- -------- ------- -------  ------------');
let tPreSym = 0, tPostSym = 0, tPreWin = 0, tPostWin = 0;
for (const lang of langs) {
	const a = pre.get(lang) ?? EMPTY;
	const b = post.get(lang) ?? EMPTY;
	tPreSym += a.symbol; tPostSym += b.symbol;
	tPreWin += a.window; tPostWin += b.window;
	const d = b.symbol - a.symbol;
	const mark = d !== 0 ? '  <-- FIXED' : '';
	console.log(
		`${lang.padEnd(19)} ${String(b.files).padStart(7)} ${String(a.symbol).padStart(8)} ${String(a.window).padStart(7)} ${String(a.structuralFiles).padStart(7)} ${String(b.symbol).padStart(8)} ${String(b.window).padStart(7)} ${String(b.structuralFiles).padStart(7)}  ${String(d > 0 ? '+' + d : d).padStart(12)}${mark}`
	);
}
console.log('------------------- ------- -------- ------- ------- -------- ------- -------  ------------');
console.log(
	`${'TOTAL'.padEnd(19)} ${String(files.length).padStart(7)} ${String(tPreSym).padStart(8)} ${String(tPreWin).padStart(7)} ${''.padStart(7)} ${String(tPostSym).padStart(8)} ${String(tPostWin).padStart(7)} ${''.padStart(7)}  ${String(tPostSym - tPreSym > 0 ? '+' + (tPostSym - tPreSym) : tPostSym - tPreSym).padStart(12)}`
);
console.log('');
console.log('symbol = structural chunk (function/class/method/type) carrying a real identifier.');
console.log('window = windowUnits() line-window fragment; its "name" is a line label like');
console.log('         "file.py:41", NOT a symbol. struct = files that parsed structurally.');
console.log('A language with symbol=0 under PRE was split by blind line windows in every');
console.log('shipped build, so every downstream stage scored fragments instead of symbols.');
