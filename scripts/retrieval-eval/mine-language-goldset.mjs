/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Language-stratified gold-set miner — the set that can actually SEE the
// tree-sitter grammar fix (8cf8c69e9).
//
// WHY THIS EXISTS
// ---------------
// golden-lanes.jsonl (mine-lane-goldset.mjs) draws symbol definitions from
// `git ls-files <void>/**/*.ts` only. Measured on the produced set: 332 of 346
// ground-truth files are .ts and 14 are .tsx — 96% TypeScript, which is the one
// language whose structural chunking ALWAYS worked. Only 4.0% of its ground
// truth is in a grammar-affected language, so it cannot detect a change to
// Python/Go/Rust/Java/C#/C++/Ruby/JS chunk boundaries even in principle.
//
// This miner stratifies BY LANGUAGE instead of by retrieval lane: an equal
// budget of queries per language, so a chunking regression in any one of them
// is visible rather than averaged away under 10,000 TypeScript files.
//
// GROUND TRUTH COMES FROM THE REPO, NOT FROM THE ENGINE
// -----------------------------------------------------
// Same anti-self-serving rule as mine-lane-goldset.mjs. Every query's relevant
// file is the file that literally contains the definition, found by a
// per-language definition regex over the source. The retrieval engine is never
// consulted about what is relevant. If a lane cannot find a definition that
// provably exists at a known path, that is a REAL miss.
//
// SAMPLING METHOD — documented so it can be audited and reproduced
// ----------------------------------------------------------------
//   * Candidates: every git-tracked file in a grammar-affected language,
//     excluding test/fixture/vendor paths (fixtures contain deliberately
//     malformed source and would measure the parser, not retrieval).
//   * Definitions: per-language regex for top-level declarations, mirroring the
//     node types chunkerLanguages.ts actually maps to chunk kinds. A regex is
//     used rather than the chunker itself so ground truth stays independent of
//     the component under test.
//   * UNIQUE definition sites only — if two files define `parse`, ground truth
//     is genuinely ambiguous and the query is unfair to every engine.
//   * Names shorter than 6 chars and `_`-prefixed names are dropped: too
//     ambiguous to score, and nobody searches for them.
//   * Deterministic stride over the SORTED list, never the first N (the first N
//     of a sorted symbol list is every symbol starting with 'A').
//
// Usage:
//   node scripts/retrieval-eval/mine-language-goldset.mjs
//   node scripts/retrieval-eval/mine-language-goldset.mjs --per-lang 12 --out <path>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

function valFlag(name, dflt) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PER_LANG = Number(valFlag('--per-lang', '12'));
const OUT = valFlag('--out', join(HERE, 'sets', 'golden-languages.jsonl'));

/**
 * Deterministic stride sampler over a SORTED list — spread evenly rather than
 * taking the first n, which would bias the set toward one corner of the
 * codebase. Deterministic so the gold set is reproducible.
 */
function strideSample(sorted, n) {
	if (sorted.length <= n) { return [...sorted]; }
	const out = [];
	const step = sorted.length / n;
	for (let i = 0; i < n; i++) { out.push(sorted[Math.floor(i * step)]); }
	return out;
}

// Definition regexes mirror the node types chunkerLanguages.ts maps to chunk
// kinds, so a query targets something the chunker is supposed to produce as a
// standalone symbol chunk.
const LANGS = {
	python: {
		exts: ['py'],
		re: [/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/, /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/],
	},
	rust: {
		exts: ['rs'],
		re: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/,
		/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/,
		/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/,
		/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/],
	},
	go: {
		exts: ['go'],
		re: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/, /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)/],
	},
	java: {
		exts: ['java'],
		re: [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/,
		/^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)/],
	},
	csharp: {
		exts: ['cs'],
		re: [/^\s*(?:public|private|protected|internal)?\s*(?:static\s+|sealed\s+|abstract\s+|partial\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/,
		/^\s*(?:public|private|protected|internal)?\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)/],
	},
	cpp: {
		exts: ['cpp', 'cc', 'cxx', 'hpp', 'hh'],
		re: [/^\s*(?:class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/,
		/^\s*(?:[A-Za-z_][A-Za-z0-9_:<>,\s*&]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:const\s*)?\{/],
	},
	ruby: {
		exts: ['rb'],
		re: [/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/, /^\s*(?:class|module)\s+([A-Za-z_][A-Za-z0-9_]*)/],
	},
	javascript: {
		exts: ['js', 'mjs', 'cjs'],
		re: [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
		/^\s*(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/],
	},
	typescriptreact: {
		exts: ['tsx'],
		re: [/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
		/^\s*export\s+(?:const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/],
	},
	// typescript is included as the CONTROL: it always worked, so its numbers
	// should not move when grammars change. A delta here means something else
	// broke.
	typescript: {
		exts: ['ts', 'mts'],
		re: [/^\s*export\s+(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/],
	},
};

// Fixtures hold deliberately malformed source; tests hold throwaway symbols.
// Including either would measure the parser or the test corpus, not retrieval.
const EXCLUDE = /(^|\/)(test|tests|fixtures?|vendor|node_modules|third_party|\.beast|out|dist)(\/|$)/;

const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
	.toString().split('\n').map(s => s.trim()).filter(Boolean);

const queries = [];
const summary = [];

for (const [lang, spec] of Object.entries(LANGS)) {
	const extSet = new Set(spec.exts);
	const files = tracked.filter(f => {
		if (EXCLUDE.test(f)) { return false; }
		if (/\.d\.ts$/.test(f)) { return false; }
		const dot = f.lastIndexOf('.');
		return dot > 0 && extSet.has(f.slice(dot + 1).toLowerCase());
	});

	/** identifier -> Set<file> */
	const defs = new Map();
	for (const rel of files) {
		let text;
		try { text = readFileSync(join(REPO_ROOT, rel), 'utf8'); } catch { continue; }
		if (text.length > 800_000) { continue; }
		for (const line of text.split('\n')) {
			for (const re of spec.re) {
				const m = re.exec(line);
				if (!m) { continue; }
				const name = m[1];
				if (name.length < 6) { continue; }
				if (name.startsWith('_')) { continue; }
				if (!defs.has(name)) { defs.set(name, new Set()); }
				defs.get(name).add(rel);
				break;
			}
		}
	}

	const unique = [...defs.entries()]
		.filter(([, fs]) => fs.size === 1)
		.map(([name, fs]) => ({ name, file: [...fs][0] }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const picked = strideSample(unique, PER_LANG);
	for (const d of picked) {
		queries.push({
			query: d.name,
			relevant: [d.file],
			lane: 'exact-symbol',
			language: lang,
			provenance: `unique ${lang} definition in ${d.file}`,
		});
	}
	summary.push({ lang, files: files.length, uniqueDefs: unique.length, sampled: picked.length });
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, queries.map(q => JSON.stringify(q)).join('\n') + '\n');

console.log(`wrote ${queries.length} queries -> ${OUT}`);
console.log('');
console.log('lang                 files  uniqueDefs  sampled');
console.log('-------------------- -----  ----------  -------');
for (const s of summary) {
	console.log(`${s.lang.padEnd(20)} ${String(s.files).padStart(5)}  ${String(s.uniqueDefs).padStart(10)}  ${String(s.sampled).padStart(7)}`);
}
console.log('');
console.log('typescript is the CONTROL lane — it always chunked structurally, so its');
console.log('score should NOT move when grammars change. Movement there means something');
console.log('other than the grammar set changed.');
