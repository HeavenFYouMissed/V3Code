/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Lane-separating gold-set miner — builds a golden set whose queries are
// DESIGNED to discriminate between V3Code's six retrieval lanes, so a lane that
// is dead weight (or actively hurting) becomes visible in the eval.
//
//   node scripts/retrieval-eval/mine-lane-goldset.mjs
//   node scripts/retrieval-eval/mine-lane-goldset.mjs --per-lane 20 --out <path>
//
// WHY THIS EXISTS
// ---------------
// The pre-existing 11-query golden-vselite.jsonl is hand-written and mixes lane
// characteristics, so an overall MRR movement cannot be attributed to a lane.
// mine-goldset.mjs samples git history (good, unbiased) but its queries are
// commit subjects — overwhelmingly conceptual, so the exact-symbol lanes
// (symbol / resolved) are barely exercised.
//
// GROUND TRUTH COMES FROM THE REPO, NOT FROM THE ENGINE
// -----------------------------------------------------
// This is the anti-self-serving property, and it is the whole point. Every
// query's `relevant` files are derived from one of three REPO facts:
//
//   (a) ctags-style structural facts — a symbol's DEFINITION site, read out of
//       the source by regex over `export (function|class|const|interface)`.
//       Ground truth = the file that literally contains the definition.
//   (b) git history — a commit subject and the files that commit touched.
//       Ground truth = what a human actually changed together.
//   (c) the import graph — file A statically imports file B.
//       Ground truth = a real, checkable edge in the source.
//
// At no point is the retrieval engine consulted to decide what is relevant. A
// query whose answer came from running the engine would score whatever the
// engine already does, which measures nothing. If a lane cannot find a
// definition that provably exists at a known path, that is a REAL miss.
//
// SAMPLING METHOD (per lane) — documented so it can be audited/reproduced
// -----------------------------------------------------------------------
//   exact-symbol   : sample exported symbols with a UNIQUE definition site,
//                    query = the bare identifier. Targets symbol/resolved.
//                    Sampled deterministically (seeded stride over the sorted
//                    symbol list) so re-running produces the same set.
//   conceptual     : sample git commit subjects (>= 5 words, no symbol-looking
//                    tokens) — natural language a user would actually type.
//                    Targets semantic/trigram.
//   architectural  : sample DIRECTORY-level subsystems and describe them from
//                    their own doc-comment header, never from the engine.
//                    Targets semantic + graph.
//                    KNOWN BIAS — read this before trusting the number: the
//                    header's OWN file is relevant[0], and the query is that
//                    header's text verbatim, so a pure substring engine can win
//                    by matching the comment it was sampled from. Measured:
//                    beast trigram scores 0.975 on this lane vs 0.30-0.49 on
//                    the others. Treat architectural MRR as an UPPER bound and
//                    compare lanes to their own history, not to each other.
//   cross-file     : sample real import edges; query names the IMPORTED symbol
//                    and asks for its consumers. Targets graph/resolved.
//   memory-recall  : queries phrased as recall of a saved decision, anchored to
//                    the files that decision is about. Targets memory.
//   historical     : commit subjects that describe a FIX, anchored to the files
//                    that fix touched. Targets trigram + memory.
//
// Output: JSONL in the SHARED beast golden format so both engines score it
// with the identical relevance rule:
//   {"query": "...", "relevant": ["path/to/file.ts", ...], "lane": "...", "provenance": "..."}
//
// `lane` and `provenance` are EXTRA fields. beast's eval.rs and run-eval.mjs
// both deserialize only {query, relevant} and ignore unknown keys, so the file
// stays byte-compatible with every existing consumer.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const VOID_REL = 'src/vs/workbench/contrib/void';

// ---- args ----
const argv = process.argv.slice(2);
const valFlag = (name, def) => {
	const i = argv.indexOf(name);
	if (i === -1) { return def; }
	const v = argv[i + 1];
	if (v === undefined || v.startsWith('--')) {
		console.error(`${name} requires a value`);
		process.exit(1);
	}
	argv.splice(i, 2);
	return v;
};
const PER_LANE = Number(valFlag('--per-lane', '20'));
const N_COMMITS = Number(valFlag('--commits', '400'));
const OUT = valFlag('--out', join(HERE, 'sets', 'golden-lanes.jsonl'));
if (argv.length > 0) {
	console.error(`unknown argument${argv.length === 1 ? '' : 's'}: ${argv.join(' ')}`);
	process.exit(1);
}
if (!Number.isInteger(PER_LANE) || PER_LANE <= 0) {
	console.error('--per-lane must be a positive integer');
	process.exit(1);
}

const git = async (...args) => {
	const { stdout } = await execFileAsync('git', args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
	return stdout;
};

/**
 * Deterministic stride sampler. Takes `n` items spread evenly across a SORTED
 * list rather than taking the first n — the first n of a sorted symbol list is
 * every symbol starting with 'A', which would silently bias the set toward one
 * corner of the codebase. Deterministic so the gold set is reproducible.
 */
function strideSample(sorted, n) {
	if (sorted.length <= n) { return [...sorted]; }
	const out = [];
	const step = sorted.length / n;
	for (let i = 0; i < n; i++) { out.push(sorted[Math.floor(i * step)]); }
	return out;
}

const isCodeFile = (f) => /\.(ts|tsx|rs|mjs|js)$/.test(f) && !/\.d\.ts$/.test(f) && !/\/test\//.test(f);

// ---------------------------------------------------------------------------
// Fact source (a): exported symbol definitions, read out of the source.
// ---------------------------------------------------------------------------
const DEF_RE = /^\s*export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

async function collectSymbolDefs() {
	const listed = (await git('ls-files', `${VOID_REL}/**/*.ts`)).split('\n').filter(Boolean).filter(isCodeFile);
	/** identifier -> Set<file> */
	const defs = new Map();
	for (const rel of listed) {
		let text;
		try { text = readFileSync(join(REPO_ROOT, rel), 'utf8'); } catch { continue; }
		for (const line of text.split('\n')) {
			const m = DEF_RE.exec(line);
			if (!m) { continue; }
			const name = m[1];
			// Single-letter / very short names are ambiguous by nature — a query
			// for "x" cannot be scored fairly against any engine.
			if (name.length < 6) { continue; }
			// Private-by-convention (`_foo`) exports are an implementation detail;
			// nobody types them as a search. Excluded so the lane measures the
			// queries users actually issue.
			if (name.startsWith('_')) { continue; }
			if (!defs.has(name)) { defs.set(name, new Set()); }
			defs.get(name).add(rel);
		}
	}
	// UNIQUE definition sites only: if two files both define `Foo`, the ground
	// truth is genuinely ambiguous and the query is unfair to every lane.
	return [...defs.entries()]
		.filter(([, files]) => files.size === 1)
		.map(([name, files]) => ({ name, file: [...files][0] }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Fact source (b): git history.
// ---------------------------------------------------------------------------
async function collectCommits() {
	const raw = await git('log', `-${N_COMMITS}`, '--no-merges', '--pretty=format:%H%x00%s', '--name-only');
	const out = [];
	for (const block of raw.split('\n\n')) {
		const lines = block.split('\n').filter(Boolean);
		if (lines.length === 0) { continue; }
		const [sha, subject] = lines[0].split('\0');
		if (!sha || !subject) { continue; }
		const files = lines.slice(1).filter(isCodeFile).filter(f => existsSync(join(REPO_ROOT, f)));
		if (files.length === 0 || files.length > 12) { continue; }
		out.push({ sha, subject, files });
	}
	return out;
}

const TRIVIAL = /^(wip|typo|fixup|merge|revert|bump|release|chore\(deps\)|version)/i;
const hasSymbolToken = (s) => /[A-Za-z]+[A-Z][A-Za-z]*|_|\(\)|\.\w+\(/.test(s);
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

/** Strip a conventional-commit prefix so the query reads like a user request. */
const deprefix = (s) => s.replace(/^[a-z]+(\([^)]*\))?:\s*/, '').trim();

// ---------------------------------------------------------------------------
// Fact source (c): import edges.
// ---------------------------------------------------------------------------
const IMPORT_RE = /import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g;

async function collectImportEdges(symbolDefs) {
	const byName = new Map(symbolDefs.map(d => [d.name, d.file]));
	const listed = (await git('ls-files', `${VOID_REL}/**/*.ts`)).split('\n').filter(Boolean).filter(isCodeFile);
	/** imported symbol -> { def, consumers:Set } */
	const edges = new Map();
	for (const rel of listed) {
		let text;
		try { text = readFileSync(join(REPO_ROOT, rel), 'utf8'); } catch { continue; }
		IMPORT_RE.lastIndex = 0;
		let m;
		while ((m = IMPORT_RE.exec(text)) !== null) {
			for (const raw of m[1].split(',')) {
				const name = raw.trim().split(/\s+as\s+/)[0].trim();
				const def = byName.get(name);
				// Only keep edges whose definition site we independently proved.
				if (!def || def === rel) { continue; }
				if (!edges.has(name)) { edges.set(name, { def, consumers: new Set() }); }
				edges.get(name).consumers.add(rel);
			}
		}
	}
	return [...edges.entries()]
		.filter(([, e]) => e.consumers.size >= 2 && e.consumers.size <= 15)
		.map(([name, e]) => ({ name, def: e.def, consumers: [...e.consumers].sort() }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Fact source (a'): subsystem directories described by their OWN header comment.
// ---------------------------------------------------------------------------
async function collectSubsystems() {
	const listed = (await git('ls-files', `${VOID_REL}/**/*.ts`)).split('\n').filter(Boolean).filter(isCodeFile);
	/** dir -> files */
	const byDir = new Map();
	for (const rel of listed) {
		const dir = dirname(rel);
		if (!byDir.has(dir)) { byDir.set(dir, []); }
		byDir.get(dir).push(rel);
	}
	const out = [];
	for (const [dir, files] of byDir) {
		if (files.length < 3) { continue; }
		// Every file with a substantial doc header is a candidate. Ground truth is
		// the file that OWNS the header plus its directory siblings — an
		// architectural query should surface the subsystem, and the header's own
		// file is unambiguously part of it.
		//
		// One header per directory would cap this lane at the directory count
		// (15 here), which is why the first pass could not reach its quota.
		for (const f of files) {
			let text;
			try { text = readFileSync(join(REPO_ROOT, f), 'utf8'); } catch { continue; }
			const m = /\/\*\*([\s\S]{80,900}?)\*\//.exec(text);
			if (!m) { continue; }
			const body = m[1].replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ').trim();
			// Header file FIRST: it is the one file guaranteed to be relevant.
			const siblings = files.filter(x => x !== f).sort().slice(0, 4);
			out.push({ dir, files: [f, ...siblings], header: body, headerFile: f });
		}
	}
	return out.sort((a, b) => a.headerFile.localeCompare(b.headerFile));
}

/** First sentence of a doc header, trimmed to a query-sized natural phrase. */
function headerToQuery(header) {
	const first = header.split(/(?<=[.!?])\s/)[0] ?? header;
	return first.replace(/^[-—\s]*/, '').replace(/[.]$/, '').slice(0, 120).trim();
}

/**
 * Reject doc-header sentences that do not describe the subsystem. Observed junk:
 * status markers ("SUPERSEDED — now a cleanup pass"), provenance notes ("Inlined
 * from Continue's core/util/lcs.ts"), and sentences truncated mid-enumeration
 * ("Memory scope resolution — TWO stores, always: 1"). A bad architectural query
 * scores every lane as a miss and silently drags the whole lane's MRR down, so
 * this filter protects the MEASUREMENT, not the engine.
 */
function isUsableHeaderQuery(q) {
	if (wordCount(q) < 5) { return false; }
	if (/^(SUPERSEDED|DEPRECATED|TODO|NOTE|FIXME|WARNING)\b/i.test(q)) { return false; }
	if (/^(Inlined|Copied|Vendored|Ported|Adapted)\s+from\b/i.test(q)) { return false; }
	// Trailing enumeration/colon means the sentence splitter cut mid-thought.
	if (/[:,]\s*\d*$/.test(q)) { return false; }
	// Headers describing ONE narrow mechanism ("Executable name — Windows needs
	// the extension...") are not architectural; they would be scored against a
	// whole directory and register as a miss for reasons unrelated to retrieval.
	if (/^(Executable name|Derive a|Returns?|Wrapper|Helper)\b/i.test(q)) { return false; }
	return true;
}

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------
const rows = [];
const push = (lane, query, relevant, provenance) => {
	const q = query.trim();
	if (q.length < 4 || relevant.length === 0) { return; }
	rows.push({ query: q, relevant, lane, provenance });
};

console.log('mining lane-separating gold set...');
const symbolDefs = await collectSymbolDefs();
console.log(`  symbols with a unique definition site : ${symbolDefs.length}`);
const commits = await collectCommits();
console.log(`  usable non-merge commits              : ${commits.length}`);
const importEdges = await collectImportEdges(symbolDefs);
console.log(`  import edges (2-15 consumers)         : ${importEdges.length}`);
const subsystems = await collectSubsystems();
console.log(`  subsystem dirs with a doc header      : ${subsystems.length}`);

// 1. exact-symbol — bare identifier, ground truth = its proven definition file.
for (const d of strideSample(symbolDefs, PER_LANE)) {
	push('exact-symbol', d.name, [d.file], `unique export definition in ${d.file}`);
}

// 2. conceptual — commit subjects that read as natural language.
const conceptual = commits
	.filter(c => !TRIVIAL.test(c.subject))
	.map(c => ({ ...c, q: deprefix(c.subject) }))
	.filter(c => wordCount(c.q) >= 5 && !hasSymbolToken(c.q))
	.sort((a, b) => a.q.localeCompare(b.q));
for (const c of strideSample(conceptual, PER_LANE)) {
	push('conceptual', c.q, c.files, `commit ${c.sha.slice(0, 9)} touched these files`);
}

// 3. architectural — the subsystem's own header sentence.
// Filter BEFORE sampling: filtering after would silently shrink the lane below
// its quota (the first run produced 14 of 20 for exactly this reason).
const usableSubsystems = subsystems
	.map(s => ({ ...s, q: headerToQuery(s.header) }))
	.filter(s => isUsableHeaderQuery(s.q));
for (const s of strideSample(usableSubsystems, PER_LANE)) {
	push('architectural', s.q, s.files.slice(0, 6), `doc header of ${s.headerFile}`);
}

// 4. cross-file impact — who consumes this symbol.
for (const e of strideSample(importEdges, PER_LANE)) {
	push('cross-file', `what breaks if I change ${e.name}`, [e.def, ...e.consumers].slice(0, 8),
		`${e.consumers.length} files statically import ${e.name} from ${e.def}`);
}

// 5. memory-recall — phrased as recalling a decision, anchored to the files the
//    decision is about. Provenance is the commit that made the decision.
const decisions = commits
	.filter(c => /^(fix|perf|refactor|feat)\b/i.test(c.subject) && wordCount(deprefix(c.subject)) >= 4)
	.sort((a, b) => a.subject.localeCompare(b.subject));
for (const c of strideSample(decisions, PER_LANE)) {
	push('memory-recall', `why did we ${deprefix(c.subject).toLowerCase()}`, c.files,
		`decision recorded in commit ${c.sha.slice(0, 9)}`);
}

// 6. historical — fixes, phrased as a past-tense lookup.
const fixes = commits
	.filter(c => /^fix/i.test(c.subject) && wordCount(deprefix(c.subject)) >= 4)
	.sort((a, b) => a.subject.localeCompare(b.subject));
for (const c of strideSample(fixes, PER_LANE)) {
	push('historical', `the bug where ${deprefix(c.subject).toLowerCase()}`, c.files,
		`fix commit ${c.sha.slice(0, 9)}`);
}

// De-dupe identical queries, keeping the first (lane order above is the priority).
const seen = new Set();
const final = rows.filter(r => {
	const k = r.query.toLowerCase();
	if (seen.has(k)) { return false; }
	seen.add(k);
	return true;
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, final.map(r => JSON.stringify(r)).join('\n') + '\n');

const byLane = new Map();
for (const r of final) { byLane.set(r.lane, (byLane.get(r.lane) ?? 0) + 1); }
console.log('');
console.log(`wrote ${final.length} queries -> ${relative(REPO_ROOT, OUT)}`);
for (const [lane, n] of [...byLane].sort()) { console.log(`  ${lane.padEnd(16)} ${n}`); }
