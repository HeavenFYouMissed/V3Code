/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Retrieval gold-set miner — turn recent git history into query→relevant-files
// pairs for the offline retrieval eval (run-eval.mjs).
//
//   node scripts/retrieval-eval/mine-goldset.mjs
//   node scripts/retrieval-eval/mine-goldset.mjs --commits 400 --max 100
//
// Each non-merge commit becomes a candidate { query: <subject>, files: <changed
// code files that still exist> }. The premise: a commit subject is a short
// natural-language description of a change, and the files it touched are the
// files a retrieval system SHOULD surface for that description. It is a noisy
// proxy (see README.md) — hence the filters:
//   • trivial subjects dropped: wip / typo / version bumps / merges / <15 chars
//   • churn files (changed in a large fraction of commits — lockfiles,
//     changelogs, product.json-style rev files) are removed from every gold
//     set; commits left with nothing but churn are dropped entirely
//   • mega-commits (> --max-files-per-commit files) dropped — "relevant files"
//     is meaningless for a 60-file refactor
//   • duplicate subjects deduped, newest kept
//
// Output: scripts/retrieval-eval/sets/goldset.json (capped at --max queries).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SETS_DIR = join(HERE, 'sets');

// ---- args ----
const argv = process.argv.slice(2);
const valFlag = (name, def) => {
	const i = argv.indexOf(name);
	if (i === -1) { return def; }
	const v = argv[i + 1];
	argv.splice(i, v !== undefined ? 2 : 1);
	return v !== undefined ? v : def;
};
const N_COMMITS = Number(valFlag('--commits', '200'));
const MAX_QUERIES = Number(valFlag('--max', '100'));
const MAX_FILES_PER_COMMIT = Number(valFlag('--max-files-per-commit', '20'));

// Code extensions the indexer actually embeds (mirror of the language map in
// semanticIndexBrowserImpl.ts langFromExt, minus config/markup formats).
const CODE_EXTS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'cs',
	'cpp', 'cc', 'cxx', 'c', 'h', 'hpp', 'rb', 'php', 'swift', 'kt', 'scala',
]);

// Directories the indexer never walks (mirror of SKIP_DIRS) — a gold file the
// corpus can never contain would just deflate recall for every config equally.
const SKIP_DIRS = new Set([
	'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build',
	'.next', '.turbo', '.cache', '.parcel-cache', 'coverage',
	'.v3code', '.vscode-test', '__pycache__', 'venv', '.venv', 'target',
	'.gradle', '.idea', '.vs', 'bin', 'obj', '.terraform',
]);

const TRIVIAL_SUBJECT_RES = [
	/^wip\b/i,
	/\btypo(s)?\b/i,
	/^(chore|build)(\([^)]*\))?:?\s*(bump|update)\b/i,
	/\b(bump|update)\b.*\b(version|dep(endencie)?s)\b/i,
	/^v?\d+\.\d+(\.\d+)?/,
	/^(release|merge|revert release)\b/i,
	/^update\s+\S+\.(md|json|lock)\b/i,
];

function isIndexablePath(rel) {
	const parts = rel.split('/');
	if (parts.some((p, i) => i < parts.length - 1 && SKIP_DIRS.has(p))) { return false; }
	const base = parts[parts.length - 1];
	const dot = base.lastIndexOf('.');
	if (dot <= 0) { return false; }
	return CODE_EXTS.has(base.slice(dot + 1).toLowerCase());
}

// ---- mine ----
const run = promisify(execFile);
const { stdout } = await run(
	'git',
	['log', '--no-merges', '-n', String(N_COMMITS), '--pretty=format:%x01%H%x00%s', '--name-only'],
	{ cwd: REPO_ROOT, maxBuffer: 128 * 1024 * 1024 },
);

const candidates = [];
for (const record of stdout.split('\x01')) {
	if (!record.trim()) { continue; }
	const lines = record.split('\n');
	const [sha, subject = ''] = lines[0].split('\x00');
	const files = [...new Set(
		lines.slice(1)
			.map(l => l.trim())
			.filter(l => l && isIndexablePath(l) && existsSync(join(REPO_ROOT, l)))
	)];
	if (files.length > 0) { candidates.push({ sha, subject: subject.trim(), files }); }
}

// Churn files: touched in a large fraction of the mined commits (lockfile /
// changelog / version-file loops). They are "relevant" to everything, i.e. to
// nothing.
const fileCommitCount = new Map();
for (const c of candidates) {
	for (const f of c.files) { fileCommitCount.set(f, (fileCommitCount.get(f) ?? 0) + 1); }
}
const churnThreshold = Math.max(4, Math.ceil(candidates.length * 0.15));
const churnFiles = new Set([...fileCommitCount].filter(([, n]) => n >= churnThreshold).map(([f]) => f));

const seenSubjects = new Set();
const queries = [];
const dropped = { trivial: 0, short: 0, mega: 0, churnOnly: 0, dup: 0 };
for (const c of candidates) {
	if (queries.length >= MAX_QUERIES) { break; }
	if (c.subject.length < 15) { dropped.short++; continue; }
	if (TRIVIAL_SUBJECT_RES.some(re => re.test(c.subject))) { dropped.trivial++; continue; }
	if (c.files.length > MAX_FILES_PER_COMMIT) { dropped.mega++; continue; }
	const gold = c.files.filter(f => !churnFiles.has(f));
	if (gold.length === 0) { dropped.churnOnly++; continue; }
	const key = c.subject.toLowerCase();
	if (seenSubjects.has(key)) { dropped.dup++; continue; }
	seenSubjects.add(key);
	queries.push({ query: c.subject, files: gold, sha: c.sha });
}

mkdirSync(SETS_DIR, { recursive: true });
const outPath = join(SETS_DIR, 'goldset.json');
writeFileSync(outPath, JSON.stringify({
	generatedAt: new Date().toISOString(),
	repoRoot: REPO_ROOT,
	minedCommits: N_COMMITS,
	candidateCommits: candidates.length,
	churnThresholdCommits: churnThreshold,
	churnFiles: [...churnFiles].sort(),
	dropped,
	queries,
}, null, '\t') + '\n');

console.log(`mined ${candidates.length} candidate commits (of last ${N_COMMITS} non-merge)`);
console.log(`churn files excluded (touched in >= ${churnThreshold} commits): ${churnFiles.size}`);
console.log(`dropped: ${JSON.stringify(dropped)}`);
console.log(`gold queries: ${queries.length} -> ${outPath}`);
