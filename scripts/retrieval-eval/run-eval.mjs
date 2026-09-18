/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Offline retrieval eval — drive the REAL production chunking + ranking code
// (browser/semanticIndex/{treeSitterChunker,hybridRetriever,dependencyGraph,
// embedText}.ts, esbuild-bundled at runtime) over this repo as the corpus, and
// score it against the git-history gold set from mine-goldset.mjs.
//
//   node scripts/retrieval-eval/mine-goldset.mjs
//   node scripts/retrieval-eval/run-eval.mjs                                  # potion, mined goldset
//   node scripts/retrieval-eval/run-eval.mjs \
//     --goldset docs/v3index-beast-packet/eval/golden-vselite.jsonl           # B0 scorekeeper run
//   node scripts/retrieval-eval/run-eval.mjs --embedder qwen --max-files 800 \
//     --goldset docs/v3index-beast-packet/eval/golden-vselite.jsonl           # quality path (slow)
//
// Flags:
//   --embedder hash|potion|qwen
//                           vector backend (default potion — the production
//                           static embedder; hard-fails if its assets are not
//                           cached under ~/.v3code/models). hash = deterministic
//                           FNV bag-of-tokens (lexical proxy, NOT semantic).
//                           qwen = Qwen3-Embedding-0.6B GGUF via node-llama-cpp,
//                           the production quality path (query instruct prefix +
//                           L2 norm); hard-fails if the GGUF is not on disk.
//   --potion-repo <id>      override the production Potion repo for an A/B run
//                           (measurement only; valid with --embedder potion).
//   --model-cache-dir <dir> isolate model downloads/caches for a measurement.
//   --goldset <path>        .json (mine-goldset.mjs format) or .jsonl (beast
//                           golden format — switches scoring to the SHARED rule,
//                           see Metrics below). Default sets/goldset.json.
//   --configs <csv|all>     which embed-text configs to run (default all;
//                           default '+headers' only under --embedder qwen)
//   --baseline <results.json>
//                           compare per-query first ranks against a prior saved
//                           run and print the ranking-change gate verdict:
//                           PASS = no per-query regressions + net win (jsonl mode)
//   --topk <n>              ranking depth scored (default 10)
//   --max-files <n>         cap corpus size; gold files are always kept (0 = all)
//   --lane <name>           score only one metadata lane in a stratified JSONL
//                           goldset (measurement only; default scores all)
//   --corpus-exclude <path> omit a repo-relative path prefix from the corpus;
//                           repeatable (measurement self-reference control)
//   --corpus-root <path>    read the corpus from another git checkout while
//                           bundling retrieval code from this checkout. This
//                           locks before/after evaluations to identical bytes.
//   --package-root <path>   resolve runtime assets from an extracted app/package,
//                           never workspace node_modules (requires --package-platform)
//   --package-platform <id> package layout/manifest id, e.g. darwin-arm64 or win32-x64
//   --diagnose-missing-runtime-assets
//                           continue through a known-bad package to measure its
//                           fallback behavior; forbidden with --release-gate
//   --release-gate          refuse toy/stub runs and require an exactly comparable
//                           baseline (real embedder, shared goldset with >=30 queries)
//   --output <path>         write the result to an explicit new file (refuses overwrite)
//
// Configs compared:
//   baseline   embed text = chunk content        (pre-PR-E behavior)
//   +headers   embed text = embedTextFor(chunk)  ('// basename :: parent :: name', hdr2)
// Queries are embedded RAW in both configs (contextual-retrieval convention).
// The lexical channel reads chunk tokens from chunking, NOT embed text, so it
// is IDENTICAL across configs — headers can only move the vector channel. The
// run prints exactly which channels are live per config.
//
// Metrics (file-level, .json goldset): a hit is relevant iff hit.chunk.file is
// in the commit's gold files. Hits are collapsed to distinct files in rank
// order, then Recall@5 / Recall@10 (fraction of gold files present) and MRR
// (1/rank of the first relevant file) are averaged over queries.
//
// Metrics (.jsonl goldset — the SHARED rule, mirrors beast engine-c src/eval.rs
// so numbers are comparable across engines): a hit is relevant iff its file
// path SUFFIX-matches a golden "relevant" entry (and its line span overlaps the
// golden span when one is given). The engine is asked topk*3 deep, hits are
// collapsed to unique files in rank order and truncated to topk; rank = first
// relevant unique file. MRR = mean(1/rank), Recall@k = fraction of queries with
// rank <= k (BINARY per query — not fraction-of-gold-files). Do not compare
// numbers across the two goldset modes.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
	loadArtifactManifest,
	packageAppRoot as resolvePackageAppRoot,
	validateRuntimeAssetContract,
	verifyRuntimeAssetGroups,
} from '../../build/verify/runtime-asset-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const VOID = join(REPO_ROOT, 'src', 'vs', 'workbench', 'contrib', 'void');
const SCRATCH_DIR = join(HERE, '.scratch');
const RESULTS_DIR = join(HERE, 'results');
const EVALUATION_SCHEMA = 2;
let sourceRevision = 'unknown';
try { sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(); }
catch { /* corpus fingerprint remains the source-of-truth identity */ }

// ---- args ----
const rawArgs = process.argv.slice(2);
const argv = [...rawArgs];
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
const boolFlag = (name) => {
	const i = argv.indexOf(name);
	if (i === -1) { return false; }
	argv.splice(i, 1);
	return true;
};
const multiFlag = (name) => {
	const values = [];
	for (let i = argv.indexOf(name); i !== -1; i = argv.indexOf(name)) {
		const value = argv[i + 1];
		if (value === undefined || value.startsWith('--')) {
			console.error(`${name} requires a value`);
			process.exit(1);
		}
		values.push(value.replaceAll('\\', '/').replace(/^\.\//, ''));
		argv.splice(i, 2);
	}
	return values;
};
const embedderKind = valFlag('--embedder', 'potion');
const potionRepo = valFlag('--potion-repo', undefined);
const modelCacheDir = valFlag('--model-cache-dir', undefined);
const goldsetPath = valFlag('--goldset', join(HERE, 'sets', 'goldset.json'));
const TOP_K = Number(valFlag('--topk', '10'));
const MAX_FILES = Number(valFlag('--max-files', '0'));
const selectedLane = valFlag('--lane', '');
const corpusExcludes = multiFlag('--corpus-exclude');
const corpusRootFlag = valFlag('--corpus-root', '');
const configsFlag = valFlag('--configs', '');
const baselinePath = valFlag('--baseline', '');
const outputPathFlag = valFlag('--output', '');
const packageRootFlag = valFlag('--package-root', '');
const packagePlatform = valFlag('--package-platform', '');
const diagnoseMissingRuntimeAssets = boolFlag('--diagnose-missing-runtime-assets');
// Beast sidecar as a 4th RRF channel (the Phase B gate): builds a beast index
// over the repo in .scratch/ and injects per-query trigram hits into the REAL
// production fusion via query.beastHits — identical code path to the editor.
const useBeast = boolFlag('--beast');
const BEAST_WEIGHT = Number(valFlag('--beast-weight', '0.4'));
// 'fuse' = beast votes in every query's RRF; 'rescue' = the beast-free head is
// locked and beast-fused results only fill below it (see hybridRetriever).
const BEAST_MODE = valFlag('--beast-mode', 'fuse');
// Cross-encoder precision pass over each query's head (the REAL production
// Qwen3-Reranker GGUF via node-llama-cpp) — measures the rerank path end to
// end and proves the model actually loads. Hard-fails if the GGUF is missing.
const useRerank = boolFlag('--rerank');
// Leading fused positions the cross-encoder may not demote (0 = pure rerank).
// Every per-query regression the reranker caused in the golden eval was a fused
// rank-1 answer being overtaken by a lower-ranked candidate.
const RERANK_GUARD = Number(valFlag('--rerank-guard', '0'));
// 0 = pin unconditionally when --rerank-guard > 0; >1 = pin only when the fused
// rank-1 leads rank-2 by this ratio (narrows the pin to confident winners).
const RERANK_GUARD_LEAD = Number(valFlag('--rerank-guard-lead', '0'));
const releaseGate = boolFlag('--release-gate');
// Simulates the packaging state BEFORE 8cf8c69e9 — see the chunker setup below.
// Consumed here so it is stripped before the unknown-argument check.
const preFixGrammars = boolFlag('--pre-fix-grammars');
if (argv.length > 0) {
	console.error(`unknown argument${argv.length === 1 ? '' : 's'}: ${argv.join(' ')}`);
	process.exit(1);
}
if (!Number.isInteger(TOP_K) || TOP_K <= 0 || !Number.isInteger(MAX_FILES) || MAX_FILES < 0 || !Number.isFinite(BEAST_WEIGHT) || BEAST_WEIGHT < 0) {
	console.error('--topk must be a positive integer, --max-files a non-negative integer, and --beast-weight a non-negative number');
	process.exit(1);
}
if (!['fuse', 'rescue'].includes(BEAST_MODE)) {
	console.error(`--beast-mode must be 'fuse' or 'rescue'`);
	process.exit(1);
}
if (!Number.isInteger(RERANK_GUARD) || RERANK_GUARD < 0) {
	console.error('--rerank-guard must be a non-negative integer');
	process.exit(1);
}
if (!Number.isFinite(RERANK_GUARD_LEAD) || RERANK_GUARD_LEAD < 0) {
	console.error('--rerank-guard-lead must be a non-negative number');
	process.exit(1);
}
if (!!packageRootFlag !== !!packagePlatform) {
	console.error('--package-root and --package-platform must be provided together');
	process.exit(1);
}
if (releaseGate && diagnoseMissingRuntimeAssets) {
	console.error('--diagnose-missing-runtime-assets is forbidden with --release-gate');
	process.exit(1);
}

const packageRoot = packageRootFlag ? resolve(REPO_ROOT, packageRootFlag) : '';
const corpusRoot = corpusRootFlag ? resolve(REPO_ROOT, corpusRootFlag) : REPO_ROOT;
const packageAppRoot = packageRoot ? resolvePackageAppRoot(packageRoot, packagePlatform) : '';
if (!existsSync(corpusRoot)) {
	console.error(`corpus root does not exist: ${corpusRoot}`);
	process.exit(1);
}
let runtimeAssetAudit = null;
if (packageRoot) {
	if (!existsSync(packageRoot)) {
		console.error(`package root does not exist: ${packageRoot}`);
		process.exit(1);
	}
	const manifest = loadArtifactManifest();
	const contractIssues = validateRuntimeAssetContract(manifest, REPO_ROOT);
	if (contractIssues.length) {
		console.error(`runtime asset contract is invalid:\n- ${contractIssues.join('\n- ')}`);
		process.exit(1);
	}
	const groupNames = ['semantic-index-structural'];
	if (embedderKind === 'potion') { groupNames.push('semantic-index-potion'); }
	if (embedderKind === 'qwen' || useRerank) { groupNames.push('semantic-index-qwen'); }
	if (useBeast) { groupNames.push('beast-local-index'); }
	const results = verifyRuntimeAssetGroups({ manifest, platform: packagePlatform, root: packageRoot, groupNames });
	const failures = results.filter(result => result.status === 'FAIL');
	runtimeAssetAudit = { packageRoot, packageAppRoot, platform: packagePlatform, groupNames, results, diagnosticOverride: diagnoseMissingRuntimeAssets };
	if (failures.length) {
		const message = `package runtime asset gate failed (${failures.length}):\n- ${failures.map(result => `${result.id}: ${result.detail}`).join('\n- ')}`;
		if (!diagnoseMissingRuntimeAssets) {
			console.error(message);
			process.exit(1);
		}
		console.warn(`${message}\nDIAGNOSTIC OVERRIDE: continuing only to measure fallback behavior; this is not release evidence.`);
	} else {
		console.log(`package runtime assets: PASS (${groupNames.join(', ')}) from ${packageRoot}`);
	}
}

if (!existsSync(goldsetPath)) {
	console.error(`gold set not found at ${goldsetPath} — run: node scripts/retrieval-eval/mine-goldset.mjs`);
	process.exit(1);
}
const explicitOutputPath = outputPathFlag ? resolve(REPO_ROOT, outputPathFlag) : '';
if (explicitOutputPath && existsSync(explicitOutputPath)) {
	console.error(`--output refuses to overwrite existing file: ${explicitOutputPath}`);
	process.exit(1);
}
if (baselinePath && !existsSync(baselinePath)) {
	console.error(`baseline not found at ${baselinePath}`);
	process.exit(1);
}

// .jsonl goldsets score with the SHARED rule (beast engine-c src/eval.rs) —
// suffix match + unique-file collapse + binary Recall@k. See header comment.
const sharedRule = goldsetPath.endsWith('.jsonl');
function parseTarget(s) {
	// "path/to/file.ts:10-400" | "path/to/file.ts" — mirrors beast eval.rs parse_target.
	const m = /^(?<path>.+):(?<start>\d+)-(?<end>\d+)$/.exec(s);
	if (m) { return { suffix: m.groups.path.replaceAll('\\', '/'), start: Number(m.groups.start), end: Number(m.groups.end) }; }
	return { suffix: s.replaceAll('\\', '/'), start: 1, end: Number.MAX_SAFE_INTEGER };
}
let goldset;
if (sharedRule) {
	const lines = readFileSync(goldsetPath, 'utf8').split('\n').filter(l => l.trim());
	goldset = {
		queries: lines.map((l, index) => {
			const o = JSON.parse(l);
			return {
				id: typeof o.id === 'string' ? o.id : `q-${index + 1}`,
				lane: typeof o.lane === 'string' ? o.lane : 'unclassified',
				intent: typeof o.intent === 'string' ? o.intent : undefined,
				query: o.query,
				targets: o.relevant.map(parseTarget),
			};
		}),
	};
} else {
	goldset = JSON.parse(readFileSync(goldsetPath, 'utf8'));
}
const goldsetTotalQueries = goldset.queries.length;
if (selectedLane) {
	if (!sharedRule) {
		console.error('--lane requires a metadata-bearing .jsonl goldset');
		process.exit(1);
	}
	goldset.queries = goldset.queries.filter(query => query.lane === selectedLane);
	if (goldset.queries.length === 0) {
		console.error(`--lane '${selectedLane}' matched no queries`);
		process.exit(1);
	}
}
let baselineForComparison = null;
if (baselinePath && existsSync(baselinePath)) {
	try { baselineForComparison = JSON.parse(readFileSync(baselinePath, 'utf8')); }
	catch (error) {
		console.error(`baseline is not valid JSON: ${baselinePath}\n${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
if (releaseGate) {
	const problems = [];
	if (!sharedRule) { problems.push('goldset must be the shared .jsonl format'); }
	if (goldset.queries.length < 30) { problems.push(`goldset has ${goldset.queries.length} queries; at least 30 are required`); }
	if (new Set(goldset.queries.map(query => query.query)).size !== goldset.queries.length) { problems.push('goldset contains duplicate query text'); }
	if (embedderKind === 'hash') { problems.push('hash is a lexical proxy; use potion or qwen'); }
	if (!baselinePath) { problems.push('--baseline is required'); }
	else if (baselineForComparison?.evaluationSchema !== EVALUATION_SCHEMA) {
		problems.push(`baseline uses evaluation schema ${baselineForComparison?.evaluationSchema ?? 'legacy'}; schema ${EVALUATION_SCHEMA} is required`);
	}
	if (problems.length) {
		console.error(`release gate refused this run:\n- ${problems.join('\n- ')}`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// Mirrored private internals of semanticIndexBrowserImpl.ts (chunkFile's id /
// token / language plumbing is not exported; the RANKING code itself is the
// real bundled production code below). Keep in sync manually.
// ---------------------------------------------------------------------------
const MAX_FILE_BYTES = 1_000_000;
const MAX_CHUNKS_PER_FILE = 120;
const EMBED_MAX_CHARS = 8_000;
const NON_EMBED_LANGS = new Set(['json', 'yaml', 'toml', 'xml', 'css', 'scss', 'html', 'ini']);
const SKIP_DIRS = new Set([
	'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build',
	'.next', '.turbo', '.cache', '.parcel-cache', 'coverage',
	'.v3code', '.vscode-test', '__pycache__', 'venv', '.venv', 'target',
	'.gradle', '.idea', '.vs', 'bin', 'obj', '.terraform',
]);
const CODE_EXT_TO_LANG = {
	ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
	mjs: 'javascript', cjs: 'javascript', py: 'python', rs: 'rust', go: 'go',
	java: 'java', cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c',
	hpp: 'cpp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
};
const STOPWORDS = new Set([
	'the', 'is', 'are', 'was', 'were', 'a', 'an', 'and', 'or', 'but',
	'if', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'from', 'by',
	'as', 'be', 'it', 'its', 'this', 'that', 'these', 'those', 'not',
	'no', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
	'can', 'could', 'may', 'might', 'should', 'must', 'into', 'over',
	'under', 'about', 'such', 'like', 'just', 'also', 'then', 'than',
	'so', 'very', 'too', 'only', 'how', 'what', 'when', 'where', 'who',
	'which', 'why', 'we', 'you', 'they', 'he', 'she', 'me', 'my', 'our',
	'their', 'your', 'all', 'some', 'any', 'each', 'every', 'both',
]);

function tokenize(text) {
	const parts = [];
	const re = /[A-Z]?[a-z0-9]+|[A-Z]+(?=[A-Z][a-z]|\d|$)/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const tok = m[0].toLowerCase();
		if (tok.length >= 2) { parts.push(tok); }
	}
	return parts;
}
function hash64Hex(str) {
	let h1 = 0x811c9dc5 >>> 0;
	let h2 = 5381 >>> 0;
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = (((h2 << 5) + h2) + c) >>> 0;
	}
	return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
function fnv1a(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h >>> 0;
}
const firstLine = (text) => {
	const nl = text.indexOf('\n');
	return nl < 0 ? text : text.slice(0, nl);
};

// ---------------------------------------------------------------------------
// 1. Bundle the production modules with esbuild (zero new deps — esbuild and
//    @vscode/tree-sitter-wasm are existing repo dependencies).
// ---------------------------------------------------------------------------
mkdirSync(SCRATCH_DIR, { recursive: true });
const entryPath = join(SCRATCH_DIR, 'entry.ts');
const bundlePath = join(SCRATCH_DIR, 'prod-bundle.mjs');
writeFileSync(entryPath, [
	`export { TreeSitterChunker } from ${JSON.stringify(join(VOID, 'browser/semanticIndex/treeSitterChunker.ts'))};`,
	`export { hybridSearch } from ${JSON.stringify(join(VOID, 'browser/semanticIndex/hybridRetriever.ts'))};`,
	`export { internTokens } from ${JSON.stringify(join(VOID, 'browser/semanticIndex/tokenDict.ts'))};`,
	`export { DependencyGraph } from ${JSON.stringify(join(VOID, 'browser/semanticIndex/dependencyGraph.ts'))};`,
	`export { embedTextFor } from ${JSON.stringify(join(VOID, 'browser/semanticIndex/embedText.ts'))};`,
	`export { effectiveEmbedIdentity } from ${JSON.stringify(join(VOID, 'common/semanticIndex/embedIdentity.ts'))};`,
	`export { quantizeDynamic } from ${JSON.stringify(join(VOID, 'browser/semanticIndex/quantizer.ts'))};`,
	`export { StaticEmbedder } from ${JSON.stringify(join(VOID, 'common/semanticIndex/staticEmbedder.ts'))};`,
	`export { formatForQwen3Embedding, l2Normalize, QWEN3_EMBED_MODEL } from ${JSON.stringify(join(VOID, 'common/semanticIndex/llamaEmbedder.ts'))};`,
	`export { LlamaReranker, buildRerankDoc, applyRerankOrder, RERANK_MAX_CANDIDATES, resolveQwen3RerankModelPath } from ${JSON.stringify(join(VOID, 'common/semanticIndex/llamaReranker.ts'))};`,
	`export { profileFor } from ${JSON.stringify(join(VOID, 'common/semanticIndex/chunkerLanguages.ts'))};`,
].join('\n'));
const esbuildBin = join(REPO_ROOT, 'node_modules', '.bin', 'esbuild');
const esb = spawnSync(esbuildBin, [
	entryPath, '--bundle', '--format=esm', '--platform=node',
	'--external:@xenova/transformers', // StaticEmbedder loads it dynamically at runtime
	'--external:node-llama-cpp', // LlamaEmbedder loads it dynamically at runtime
	`--outfile=${bundlePath}`, '--log-level=warning',
], { stdio: 'inherit' });
if (esb.status !== 0) {
	console.error('esbuild bundling of production modules failed');
	process.exit(1);
}
const prod = await import(pathToFileURL(bundlePath).href);

// ---------------------------------------------------------------------------
// 2. Tree-sitter runtime (same @vscode/tree-sitter-wasm the renderer uses).
//    If wasm init fails in-script we fall back to the production line-window
//    chunker (chunker.windowUnits) and SAY SO.
// ---------------------------------------------------------------------------
const wasmDir = join(packageAppRoot || REPO_ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
let runtime = null;
let chunkerMode = 'line-window fallback (windowUnits)';
try {
	const require = createRequire(import.meta.url);
	const tsMod = require(join(wasmDir, 'tree-sitter.js'));
	await tsMod.Parser.init({ locateFile: (f) => join(wasmDir, f) });
	runtime = { Parser: tsMod.Parser, Language: tsMod.Language };
	chunkerMode = 'tree-sitter structural parent/child chunking';
} catch (e) {
	console.warn(`tree-sitter wasm unavailable in-script (${e?.message ?? e}) — using windowUnits fallback`);
}
// --pre-fix-grammars simulates the packaging state BEFORE 8cf8c69e9: only the
// six grammars upstream's build/.moduleignore allowed shipped in the app, so
// every other language silently fell back to blind line windows. This eval
// reads grammars from node_modules, which always had all 16 — so without this
// flag it has only ever measured POST-fix behavior and cannot show the delta.
// Off by default; a normal run is unaffected.
const PRE_FIX_GRAMMARS = new Set([
	'tree-sitter-typescript', 'tree-sitter-regex', 'tree-sitter-ini',
	'tree-sitter-css', 'tree-sitter-powershell', 'tree-sitter-bash',
]);
if (preFixGrammars) {
	console.warn('--pre-fix-grammars: restricting grammars to the 6 that shipped before 8cf8c69e9');
}
const chunker = new prod.TreeSitterChunker({
	loadRuntime: async () => runtime,
	readGrammarBytes: async (grammarName) => {
		if (preFixGrammars && !PRE_FIX_GRAMMARS.has(grammarName)) { return null; }
		try { return new Uint8Array(await readFile(join(wasmDir, `${grammarName}.wasm`))); }
		catch { return null; }
	},
	log: () => { },
});

// ---------------------------------------------------------------------------
// 3. Corpus: chunk every git-tracked code file (mirrors chunkFile()).
// ---------------------------------------------------------------------------
// Gold membership: exact file match for the mined .json set; path-suffix match
// for the shared-rule .jsonl set (its entries are workspace-relative suffixes).
const isGoldFile = sharedRule
	? (() => { const targets = goldset.queries.flatMap(q => q.targets); return (rel) => targets.some(t => rel.endsWith(t.suffix)); })()
	: (() => { const s = new Set(goldset.queries.flatMap(q => q.files)); return (rel) => s.has(rel); })();
let corpusFiles = execFileSync('git', ['ls-files'], { cwd: corpusRoot, maxBuffer: 64 * 1024 * 1024 })
	.toString().split('\n').map(l => l.trim()).filter(rel => {
		if (!rel) { return false; }
		if (corpusExcludes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) { return false; }
		const parts = rel.split('/');
		if (parts.some((p, i) => i < parts.length - 1 && SKIP_DIRS.has(p))) { return false; }
		const base = parts[parts.length - 1];
		const dot = base.lastIndexOf('.');
		if (dot <= 0) { return false; }
		return CODE_EXT_TO_LANG[base.slice(dot + 1).toLowerCase()] !== undefined;
	});
if (MAX_FILES > 0 && corpusFiles.length > MAX_FILES) {
	// Deterministic cap that never evicts gold files (they must be findable).
	const gold = corpusFiles.filter(f => isGoldFile(f));
	const rest = corpusFiles.filter(f => !isGoldFile(f));
	corpusFiles = [...gold, ...rest.slice(0, Math.max(0, MAX_FILES - gold.length))];
}

const chunks = new Map();          // id -> IndexedChunk-shaped object
const corpusFileSet = new Set();   // files that actually produced chunks
const corpusDigest = createHash('sha256');
const t0 = Date.now();
let filesChunked = 0;
let structuralFiles = 0;
const languageCoverage = {};
for (const rel of corpusFiles) {
	const abs = join(corpusRoot, rel);
	let content;
	try {
		if (statSync(abs).size > MAX_FILE_BYTES) { continue; }
		content = readFileSync(abs, 'utf8');
	} catch { continue; }
	corpusDigest.update(rel).update('\0').update(content).update('\0');
	const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
	const language = CODE_EXT_TO_LANG[ext] ?? 'plaintext';
	const coverage = languageCoverage[language] ??= { files: 0, structuralFiles: 0, fallbackFiles: 0, supported: !!prod.profileFor(language), grammar: prod.profileFor(language)?.grammar ?? null };
	coverage.files++;

	let units = await chunker.extract(rel, content, language);
	if (units && units.length > 0) { structuralFiles++; coverage.structuralFiles++; }
	if (!units || units.length === 0) { coverage.fallbackFiles++; units = chunker.windowUnits(rel, content); }
	if (units.length > MAX_CHUNKS_PER_FILE) { units = units.slice(0, MAX_CHUNKS_PER_FILE); }

	const idByLocal = units.map(u => hash64Hex(`${rel}:${u.startLine}:${u.endLine}`));
	for (let i = 0; i < units.length; i++) {
		const u = units[i];
		const parent = u.parentLocalId !== undefined ? units[u.parentLocalId] : undefined;
		const sig = parent ? `${parent.name}\n${firstLine(parent.text)}` : '';
		chunks.set(idByLocal[i], {
			id: idByLocal[i], file: rel, startLine: u.startLine, endLine: u.endLine,
			kind: u.kind, name: u.name, language, contentHash: hash64Hex(u.text),
			content: u.text,
			tokens: u.scored ? prod.internTokens(tokenize(`${sig}\n${u.name}\n${u.text}`)) : new Uint32Array(0),
			scored: u.scored,
			parentId: u.parentLocalId !== undefined ? idByLocal[u.parentLocalId] : undefined,
			defines: u.defines.length ? u.defines : undefined,
			refs: u.refs.length ? u.refs : undefined,
		});
	}
	if (units.length > 0) { corpusFileSet.add(rel); }
	if (++filesChunked % 2000 === 0) {
		console.log(`  chunked ${filesChunked}/${corpusFiles.length} files (${chunks.size} chunks)…`);
	}
}
const corpusFingerprint = corpusDigest.digest('hex');
console.log(`corpus: ${filesChunked} files -> ${chunks.size} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`chunker: ${chunkerMode} (${structuralFiles}/${filesChunked} files parsed structurally)`);
for (const [language, coverage] of Object.entries(languageCoverage).sort(([a], [b]) => a.localeCompare(b))) {
	console.log(`  ${language.padEnd(20)} ${String(coverage.structuralFiles).padStart(4)}/${String(coverage.files).padEnd(4)} structural${coverage.supported ? ` (${coverage.grammar})` : ' (unsupported language)'}`);
}
console.log(`corpus fingerprint: ${corpusFingerprint.slice(0, 16)}`);
if (releaseGate && sharedRule) {
	const stale = goldset.queries.filter(query => !query.targets.some(target => [...corpusFileSet].some(file => file.endsWith(target.suffix))));
	if (stale.length) {
		console.error(`release gate failed: ${stale.length} gold queries have no relevant file in this corpus:\n- ${stale.map(query => query.query).join('\n- ')}`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// 4. Embedders.
// ---------------------------------------------------------------------------
const HASH_DIM = 256;
function hashEmbed(text) {
	const v = new Float32Array(HASH_DIM);
	for (const tok of tokenize(text)) { v[fnv1a(tok) % HASH_DIM] += 1; }
	let norm = 0;
	for (let d = 0; d < HASH_DIM; d++) { norm += v[d] * v[d]; }
	norm = Math.sqrt(norm);
	if (norm > 0) { for (let d = 0; d < HASH_DIM; d++) { v[d] /= norm; } }
	return v;
}

let embedBatch;   // async (texts: string[], kind?: 'doc'|'query') => Float32Array[]
let embedderId;
let embedderDim;
if (embedderKind === 'potion') {
	const packagedTransformers = packageAppRoot
		? () => import(pathToFileURL(join(packageAppRoot, 'node_modules', '@xenova', 'transformers', 'src', 'transformers.js')).href)
		: undefined;
	const se = new prod.StaticEmbedder(potionRepo, modelCacheDir, packagedTransformers);
	try {
		await se.init();
		embedderId = prod.effectiveEmbedIdentity(se.modelId);
		embedderDim = se.dim;
		embedBatch = async (texts) => se.embed(texts.map(t => t.length > EMBED_MAX_CHARS ? t.slice(0, EMBED_MAX_CHARS) : t));
		console.log(`embedder: ${se.modelId} (dim=${se.dim}, the production static embedder)`);
	} catch (e) {
		console.error(`potion embedder not loadable (${e?.message ?? e}) — rerun with --embedder hash or with network/cached assets`);
		process.exit(1);
	}
} else if (embedderKind === 'qwen') {
	// The production quality path: Qwen3-Embedding-0.6B GGUF through
	// node-llama-cpp, using the SAME pure helpers the editor uses (query-side
	// instruct prefix + L2 normalization). Engine plumbing (context/batch sizing)
	// mirrors llamaEmbedder.ts; batching does not change the vectors.
	// The GGUF on disk is named the way node-llama-cpp's downloader writes it
	// (hf_<org>_<file>), NOT the declared canonical filename — resolve by
	// directory scan and accept either, skipping the .nopool experiment copy.
	const modelsDir = join(homedir(), '.v3code', 'models');
	let ggufs = [];
	try {
		ggufs = readdirSync(modelsDir).filter(f =>
			/qwen3-embedding/i.test(f) && f.endsWith('.gguf') && !/nopool/i.test(f)).sort();
	} catch { /* missing dir handled below */ }
	if (ggufs.length === 0) {
		console.error(`--embedder qwen: no Qwen3-Embedding GGUF under ${modelsDir} — set "v3code.semanticIndex.embedModel": "qwen3-embed" in the editor once to download it (~610MB)`);
		process.exit(1);
	}
	const modelPath = join(modelsDir, ggufs[0]);
		const nlc = packageAppRoot
			? await import(pathToFileURL(join(packageAppRoot, 'node_modules', 'node-llama-cpp', 'dist', 'index.js')).href)
			: await import('node-llama-cpp');
	const llama = await nlc.getLlama();
	const model = await llama.loadModel({ modelPath, gpuLayers: 'auto' });
	// contextSize/batchSize as in llamaEmbedder.ts: one chunk = one GPU dispatch.
	const qwenCtx = await model.createEmbeddingContext({ contextSize: 3072, batchSize: 3072 });
	embedderId = prod.QWEN3_EMBED_MODEL.id;
	embedderDim = prod.QWEN3_EMBED_MODEL.dim;
	embedBatch = async (texts, kind = 'doc') => {
		const out = [];
		for (const t of texts) {
			const capped = t.length > EMBED_MAX_CHARS ? t.slice(0, EMBED_MAX_CHARS) : t;
			const e = await qwenCtx.getEmbeddingFor(prod.formatForQwen3Embedding(capped, kind));
			out.push(prod.l2Normalize(new Float32Array(e.vector)));
		}
		return out;
	};
	console.log(`embedder: ${ggufs[0]} via node-llama-cpp (dim=${prod.QWEN3_EMBED_MODEL.dim}, the production quality path)`);
} else if (embedderKind === 'hash') {
	embedderId = 'fnv-bag-of-tokens-256';
	embedderDim = HASH_DIM;
	embedBatch = async (texts) => texts.map(t => hashEmbed(t.length > EMBED_MAX_CHARS ? t.slice(0, EMBED_MAX_CHARS) : t));
	console.log(`embedder: deterministic FNV bag-of-tokens (dim=${HASH_DIM}) — a lexical proxy, NOT semantic`);
} else {
	console.error(`unknown --embedder '${embedderKind}' (hash|potion|qwen)`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// 4a2. Local cross-encoder (--rerank): the production LlamaReranker.
// ---------------------------------------------------------------------------
let reranker = null;
if (useRerank) {
	const modelsDir = join(homedir(), '.v3code', 'models');
	if (!prod.resolveQwen3RerankModelPath(modelsDir)) {
		console.error(`--rerank: Qwen3-Reranker GGUF not found under ${modelsDir}`);
		process.exit(1);
	}
	reranker = new prod.LlamaReranker();
	const tRr = Date.now();
	await reranker.init(modelsDir);
	console.log(`reranker: Qwen3-Reranker-0.6B loaded in ${((Date.now() - tRr) / 1000).toFixed(1)}s — cross-encoder pass on each query head (top ${prod.RERANK_MAX_CANDIDATES})`);
}

// ---------------------------------------------------------------------------
// 4b. Beast sidecar channel (--beast): real binary, fresh index in .scratch/.
// ---------------------------------------------------------------------------
let beastSearch = null;   // (query: string) => [{file, line}] rank-ordered
if (useBeast) {
	const beastBin = process.env.BEAST_BIN || join(homedir(), '.v3code', 'bin', 'beast');
	if (!existsSync(beastBin)) {
		console.error(`--beast: binary not found at ${beastBin} (install to ~/.v3code/bin/beast or set BEAST_BIN)`);
		process.exit(1);
	}
	const beastDb = join(SCRATCH_DIR, 'beastdb');
	console.log('beast: indexing the repo (fresh db in .scratch/)…');
	const bi = spawnSync(beastBin, ['index', corpusRoot, '--db', beastDb], { maxBuffer: 16 * 1024 * 1024 });
	if (bi.status !== 0) {
		console.error(`--beast: index failed: ${bi.stderr?.toString().slice(0, 400)}`);
		process.exit(1);
	}
	console.log('beast: ' + bi.stdout.toString().trim().split('\n').slice(-2).join(' | ').replace(/\s+/g, ' '));
	beastSearch = (q) => {
		const r = spawnSync(beastBin, ['search', q, '--k', '30', '--db', beastDb, '--json'], { maxBuffer: 16 * 1024 * 1024 });
		if (r.status !== 0) { return []; }
		const hits = [];
		for (const line of r.stdout.toString().split('\n')) {
			const t = line.trim();
			if (!t) { continue; }
			try {
				const o = JSON.parse(t);
				if (typeof o.file === 'string' && typeof o.line === 'number') { hits.push({ file: o.file, line: o.line }); }
			} catch { /* noise line */ }
		}
		return hits;
	};
	console.log(`beast channel: LIVE (weight ${BEAST_WEIGHT}, k=30 per query, fused in production hybridSearch)`);
}

// ---------------------------------------------------------------------------
// 5. Configs: same chunks/tokens, different EMBED TEXT (that is the PR).
//
// hdr* variants probe the potion regression hypothesis: potion mean-pools
// token vectors, and a long path prefix shared by most of the corpus
// (src/vs/workbench/contrib/...) homogenizes chunk vectors. Variants shorten
// or drop the FILE segment only; parent/name segments are unchanged and the
// elision rules mirror embedTextFor exactly.
// ---------------------------------------------------------------------------
const headerWith = (c, fileSeg) => {
	const body = c.content || c.name;
	const parent = c.parentId ? chunks.get(c.parentId) : undefined;
	const segments = [];
	for (const seg of [fileSeg, parent?.name ?? '', c.name]) {
		const s = (seg ?? '').trim();
		if (s) { segments.push(s); }
	}
	return segments.length === 0 ? body : `// ${segments.join(' :: ')}\n${body}`;
};
const lastSegs = (file, n) => file.split('/').slice(-n).join('/');
{
	// Experiment "strip the shared workspace prefix": production chunk.file is
	// already workspace-relative (chunkFile relPath), so the only strippable
	// prefix is the corpus-wide common directory prefix — computed and logged
	// here. If it is empty, that variant degenerates to the full-path header.
	let p = null;
	for (const f of corpusFileSet) {
		const dirs = f.split('/').slice(0, -1);
		if (p === null) { p = dirs; continue; }
		let i = 0;
		while (i < p.length && i < dirs.length && p[i] === dirs[i]) { i++; }
		p.length = i;
		if (p.length === 0) { break; }
	}
	console.log(`corpus common dir prefix: ${p && p.length ? p.join('/') + '/' : '(empty — strip-prefix variant degenerates to the full path)'}`);
}
const embeddable = [...chunks.values()].filter(c => c.scored && !NON_EMBED_LANGS.has(c.language));
const allConfigs = [
	{ name: 'baseline', embedInput: (c) => c.content || c.name },
	{ name: '+headers', embedInput: (c) => prod.embedTextFor(c, chunks) }, // the SHIPPED embedTextFor, whatever scheme it currently implements
	{ name: 'last3', embedInput: (c) => headerWith(c, lastSegs(c.file, 3)) },
	{ name: 'last2', embedInput: (c) => headerWith(c, lastSegs(c.file, 2)) },
	{ name: 'basename', embedInput: (c) => headerWith(c, lastSegs(c.file, 1)) },
	{ name: 'parent-name', embedInput: (c) => headerWith(c, '') }, // file segment dropped entirely
];
// Under qwen, every config re-embeds the corpus through the transformer —
// default to the shipped config only unless the caller asks for more.
const wantedConfigs = configsFlag || (embedderKind === 'qwen' ? '+headers' : 'all');
const configs = wantedConfigs === 'all' ? allConfigs : wantedConfigs.split(',').map(n => {
	const c = allConfigs.find(x => x.name === n.trim());
	if (!c) {
		console.error(`unknown config '${n.trim()}' — known: ${allConfigs.map(x => x.name).join(', ')}, all`);
		process.exit(1);
	}
	return c;
});
if (!configsFlag && embedderKind === 'qwen') {
	console.log(`configs: '+headers' (shipped) only by default under qwen — pass --configs all to compare header variants`);
}
// Doc-vector cache, CONTENT-ADDRESSED: each vector is keyed by the hash of the
// exact TEXT that was embedded (which captures chunk content, headers, names —
// everything the embedder sees). Corpus/code drift therefore re-embeds only
// the chunks whose embed text actually changed, not the whole corpus — a
// ranking-code edit that touches one indexed file costs seconds, not 25 min.
/** Cap on cache entries so the monolithic JSON never nears V8 string limits. */
const VEC_CACHE_MAX_ENTRIES = 80_000;
function vecCachePath(cfg) {
	return join(SCRATCH_DIR, `veccache2-${cfg.name.replace(/[^a-z0-9]/gi, '_')}-${hash64Hex(embedderId)}.json`);
}
function loadVecStore(cfg, expectDim) {
	const p = vecCachePath(cfg);
	if (!existsSync(p)) { return new Map(); }
	try {
		const raw = JSON.parse(readFileSync(p, 'utf8'));
		if (raw.embedder !== embedderId) { return new Map(); }
		const store = new Map();
		for (const [textHash, v] of Object.entries(raw.vectors)) {
			// Int8Array(buffer-view) — NEVER .buffer.slice(): Buffer.from(base64)
			// lives in Node's shared 8KiB pool, so .buffer is the whole pool.
			const q = new Int8Array(Buffer.from(v.q, 'base64'));
			if (q.length !== expectDim) { return new Map(); } // stale dim — rebuild
			store.set(textHash, { q, scale: v.scale });
		}
		return store;
	} catch { return new Map(); }
}
function saveVecStore(cfg, store) {
	if (store.size > VEC_CACHE_MAX_ENTRIES) {
		console.log(`vector cache SKIPPED for '${cfg.name}' (${store.size} entries > ${VEC_CACHE_MAX_ENTRIES} cap)`);
		return;
	}
	const vectors = {};
	for (const [textHash, v] of store) {
		vectors[textHash] = { q: Buffer.from(v.q.buffer, v.q.byteOffset, v.q.byteLength).toString('base64'), scale: v.scale };
	}
	const path = vecCachePath(cfg);
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, JSON.stringify({ embedder: embedderId, config: cfg.name, vectors }));
	renameSync(temporaryPath, path);
}

for (const cfg of configs) {
	const store = loadVecStore(cfg, embedderDim);
	cfg.vectors = new Map();
	const misses = [];
	const missTexts = [];
	const missHashes = [];
	for (const c of embeddable) {
		const text = cfg.embedInput(c);
		const th = hash64Hex(text);
		const hit = store.get(th);
		if (hit) { cfg.vectors.set(c.id, hit); }
		else { misses.push(c); missTexts.push(text); missHashes.push(th); }
	}
	if (store.size > 0 || misses.length < embeddable.length) {
		console.log(`vector cache: ${embeddable.length - misses.length}/${embeddable.length} hits for '${cfg.name}' — embedding ${misses.length} changed chunks`);
	}
	const tEmbed = Date.now();
	const BATCH = 512;
	for (let i = 0; i < misses.length; i += BATCH) {
		const vecs = await embedBatch(missTexts.slice(i, i + BATCH), 'doc');
		for (let j = 0; j < vecs.length; j++) {
			const packed = prod.quantizeDynamic(vecs[j]);
			cfg.vectors.set(misses[i + j].id, packed);
			store.set(missHashes[i + j], packed);
		}
		if (embedderKind === 'qwen' && (i / BATCH) % 4 === 3) {
			console.log(`  embedded ${Math.min(i + BATCH, misses.length)}/${misses.length} chunks ('${cfg.name}')…`);
		}
		if (embedderKind === 'qwen' && (i / BATCH) % 8 === 7 && i + BATCH < misses.length) {
			saveVecStore(cfg, store);
			console.log(`  checkpointed vector cache for '${cfg.name}'`);
		}
	}
	if (misses.length > 0) {
		console.log(`embedded ${misses.length} chunks for config '${cfg.name}' in ${((Date.now() - tEmbed) / 1000).toFixed(1)}s`);
		saveVecStore(cfg, store);
	}
}

// ---------------------------------------------------------------------------
// 6. Run the gold queries through the REAL hybridSearch per config.
// ---------------------------------------------------------------------------
function ndcgAt(relevances, idealRelevant, k = 10) {
	let dcg = 0;
	for (let i = 0; i < Math.min(k, relevances.length); i++) {
		if (relevances[i]) { dcg += 1 / Math.log2(i + 2); }
	}
	let idcg = 0;
	for (let i = 0; i < Math.min(k, idealRelevant); i++) { idcg += 1 / Math.log2(i + 2); }
	return idcg > 0 ? dcg / idcg : 0;
}

function percentile(values, p) {
	if (!values.length) { return 0; }
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Explain which production retrieval signals contributed to one displayed hit.
 *  This is reporting-only: it reads the existing `Hit.signals` contract and
 *  never changes candidate generation, weights, or ordering. */
function hitSources(hit) {
	const out = [];
	if ((hit.signals?.terms ?? 0) > 0) { out.push('lexical'); }
	if ((hit.signals?.vec ?? 0) > 0) { out.push('semantic'); }
	if ((hit.signals?.beast ?? 0) > 0) { out.push('trigram'); }
	if ((hit.signals?.graphBoost ?? 0) > 0 || hit.signals?.neighbor === 1) { out.push('graph'); }
	if (hit.signals?.rerank !== undefined) { out.push('reranker'); }
	return out;
}

async function evaluate(cfg) {
	// Install this config's vectors on the shared chunk map.
	for (const c of embeddable) {
		const q = cfg.vectors.get(c.id);
		c.embedding = q ? q.q : undefined;
		c.vecScale = q ? q.scale : undefined;
	}
	const ctx = { chunks, graph: new prod.DependencyGraph(), embeddingsAvailable: true };
	const perQuery = [];
	let sumR5 = 0, sumR10 = 0, sumMrr = 0, sumNdcg10 = 0, tookMs = 0, skipped = 0, emptyResults = 0;
	const latencies = [];
	for (const g of goldset.queries) {
		let gold = null;
		if (!sharedRule) {
			gold = g.files.filter(f => corpusFileSet.has(f)); // only score files the corpus can surface
			if (gold.length === 0) { skipped++; continue; }
		}
		const queryTokens = Array.from(new Set(tokenize(g.query))).filter(t => !STOPWORDS.has(t));
		if (queryTokens.length === 0) { skipped++; continue; }
		// Query embedding: RAW for potion/hash (production static path); the qwen
		// backend applies its instruct prefix via kind, exactly like retrieve().
		const queryEmbedding = (await embedBatch([g.query], 'query'))[0];
		const beastHits = beastSearch ? beastSearch(g.query) : null;
		const t = Date.now();
		// Shared rule asks the engine topk*3 deep BEFORE the unique-file collapse
		// (beast eval.rs does the same); mined mode keeps its original topk call.
		let hits = prod.hybridSearch(
			ctx,
			{ queryTokens, queryText: g.query, queryEmbedding, recentFiles: null, beastHits },
			{ topK: sharedRule ? TOP_K * 3 : TOP_K, fileFilter: null, beastWeight: BEAST_WEIGHT, beastRescue: BEAST_MODE === 'rescue' },
		);
		if (reranker) {
			// Mirror retrieve()'s _localRerank: score the primary head only, keep
			// neighbors in their tail position. Latency counts toward avg ms.
			let head = 0;
			while (head < hits.length && head < prod.RERANK_MAX_CANDIDATES && hits[head].signals?.neighbor !== 1) { head++; }
			if (head >= 2) {
				const docs = hits.slice(0, head).map(prod.buildRerankDoc);
				const scores = await reranker.rankAll(g.query, docs);
				hits = prod.applyRerankOrder(hits, scores, { protectHead: RERANK_GUARD, protectMinLead: RERANK_GUARD_LEAD > 0 ? RERANK_GUARD_LEAD : undefined });
			}
		}
		const elapsedMs = Date.now() - t;
		tookMs += elapsedMs;
		latencies.push(elapsedMs);
		if (hits.length === 0) { emptyResults++; }
		if (sharedRule) {
			// Unique files in rank order, keeping the first (= best) hit's span per
			// file; golden spans are 1-based, chunk lines 0-based.
			const files = [];
			const seenFiles = new Set();
			for (const h of hits) {
				if (seenFiles.has(h.chunk.file)) { continue; }
				seenFiles.add(h.chunk.file);
				files.push({
					file: h.chunk.file,
					start: h.chunk.startLine + 1,
					end: h.chunk.endLine + 1,
					sources: hitSources(h),
				});
				if (files.length >= TOP_K) { break; }
			}
			const firstIdx = files.findIndex(f =>
				g.targets.some(tg => f.file.endsWith(tg.suffix) && f.start <= tg.end && f.end >= tg.start));
			const firstRank = firstIdx === -1 ? null : firstIdx + 1;
			const mrr = firstRank ? 1 / firstRank : 0;
			const relevances = files.map(f => g.targets.some(tg => f.file.endsWith(tg.suffix) && f.start <= tg.end && f.end >= tg.start));
			const ndcg10 = ndcgAt(relevances, new Set(g.targets.map(tg => tg.suffix)).size);
			sumMrr += mrr;
			sumR5 += firstRank && firstRank <= 5 ? 1 : 0;
			sumR10 += firstRank && firstRank <= 10 ? 1 : 0;
			sumNdcg10 += ndcg10;
			perQuery.push({
				id: g.id,
				lane: g.lane,
				intent: g.intent,
				query: g.query,
				targets: g.targets.map(tg => tg.suffix),
				firstRank,
				winningSources: firstIdx >= 0 ? files[firstIdx].sources : [],
				topCandidates: files.map(f => ({ file: f.file, sources: f.sources })),
				topFiles: files.map(f => f.file),
				mrr,
				ndcg10,
				elapsedMs,
			});
		} else {
			const rankedFiles = [];
			const seen = new Set();
			for (const h of hits) {
				if (!seen.has(h.chunk.file)) { seen.add(h.chunk.file); rankedFiles.push(h.chunk.file); }
			}
			const goldSet = new Set(gold);
			const hitsAt = (k) => rankedFiles.slice(0, k).filter(f => goldSet.has(f)).length;
			const r5 = hitsAt(5) / gold.length;
			const r10 = hitsAt(10) / gold.length;
			const firstIdx = rankedFiles.findIndex(f => goldSet.has(f));
			const mrr = firstIdx === -1 ? 0 : 1 / (firstIdx + 1);
			const ndcg10 = ndcgAt(rankedFiles.slice(0, 10).map(file => goldSet.has(file)), goldSet.size);
			sumR5 += r5; sumR10 += r10; sumMrr += mrr; sumNdcg10 += ndcg10;
			perQuery.push({ id: g.id, lane: g.lane, intent: g.intent, query: g.query, gold, rankedFiles: rankedFiles.slice(0, TOP_K), r5, r10, mrr, ndcg10, elapsedMs, firstRank: firstIdx === -1 ? null : firstIdx + 1 });
		}
	}
	const n = perQuery.length;
	const sourceAttribution = {};
	for (const q of perQuery) {
		for (const source of q.winningSources ?? []) {
			sourceAttribution[source] = (sourceAttribution[source] ?? 0) + 1;
		}
	}
	return {
		config: cfg.name,
		queries: n,
		skipped,
		recallAt5: n ? sumR5 / n : 0,
		recallAt10: n ? sumR10 / n : 0,
		mrr: n ? sumMrr / n : 0,
		ndcgAt10: n ? sumNdcg10 / n : 0,
		emptyResultRate: n ? emptyResults / n : 0,
		avgRetrieveMs: n ? tookMs / n : 0,
		p50RetrieveMs: percentile(latencies, 0.50),
		p95RetrieveMs: percentile(latencies, 0.95),
		sourceAttribution,
		perQuery,
	};
}

/**
 * Which retrieval CHANNELS produced this hit, read out of the production
 * ranker's own `signals` (semanticIndexTypes.ts::Hit.signals). Pure
 * observation — nothing here is fed back into ranking.
 *
 * V3Code's six lanes split across two engines, and only these are visible from
 * the TS side. Beast's internal split (trigram / symbol / resolved / memory) is
 * collapsed into the single `beast` signal by the time hits reach the fusion,
 * so per-ENGINE beast attribution has to come from `beast eval` itself, which
 * emits `rrf[trigram#1+symbol#3]` in its `why` string (rrf.rs:46).
 *
 * A hit can be produced by several channels at once — that is the normal case
 * for a strong result, and 'lex+vec' means both agreed rather than either
 * winning alone.
 */
function channelsOf(sig) {
	if (!sig) { return ['none']; }
	const out = [];
	// hybridRetriever.ts:401 names the lexical channel `terms` (token overlap),
	// NOT `fts` — `fts` is set only by the SQLite retriever (retriever.ts:131).
	// Both are checked so this stays correct for either producer, but `terms` is
	// the one that fires in this harness.
	//
	// `terms` is ALWAYS present (it is not spread-conditional), so a bare
	// `!== undefined` would mark every hit lexical and make the column useless.
	// Only a non-zero overlap means the lexical channel actually contributed.
	if (sig.terms > 0 || sig.fts > 0) { out.push('lex'); }
	// `vec` is spread only when embeddingsAvailable, and is 0 when the vector
	// channel scored nothing — same reasoning as above.
	if (sig.vec > 0) { out.push('vec'); }
	if (sig.beast !== undefined) { out.push('beast'); }
	if (sig.graphBoost !== undefined) { out.push('graph'); }
	if (sig.neighbor === 1) { out.push('neighbor'); }
	if (sig.xenc !== undefined) { out.push('xenc'); }
	// A hit with no channel signal reached the head only via parent-collapse of a
	// matched child chunk — worth naming rather than reporting as 'none'.
	if (out.length === 0 && sig.parent === 1) { out.push('parent-collapse'); }
	return out.length ? out : ['none'];
}

const results = [];
for (const cfg of configs) { results.push(await evaluate(cfg)); }

// ---------------------------------------------------------------------------
// 7. Report.
// ---------------------------------------------------------------------------
console.log('');
console.log('channel liveness per config:');
console.log('  lexical: LIVE in both configs and IDENTICAL — chunk tokens come from');
console.log('           chunking (chunkFile), never from embed text.');
if (embedderKind === 'potion') {
	console.log(`  vector:  LIVE, ${embedderId} — headers change the embedded text, so`);
	console.log('           this run measures the real semantic effect of the header line.');
} else if (embedderKind === 'qwen') {
	console.log('  vector:  LIVE, Qwen3-Embedding-0.6B — the production quality path');
	console.log('           (instruct-prefixed queries, raw documents, L2-normalized).');
} else {
	console.log('  vector:  LIVE, hash embedder — headers add file/parent/name TOKENS to');
	console.log('           the chunk vector only. This measures the lexical value of the');
	console.log('           header line through the vec channel; it UNDER-measures the');
	console.log('           semantic gains a real embedder gets from the same context.');
}
console.log('');
const pct = (x) => (100 * x).toFixed(1).padStart(5) + '%';
if (sharedRule) {
	console.log('scoring: SHARED rule (beast eval.rs) — suffix match, unique-file collapse,');
	console.log('         Recall@k = fraction of queries whose first relevant file ranks <= k.');
}
console.log(`config      queries  Recall@5  Recall@10   MRR   nDCG@10  empty   p50/p95 ms`);
for (const r of results) {
	console.log(`${r.config.padEnd(11)} ${String(r.queries).padStart(6)}   ${pct(r.recallAt5)}    ${pct(r.recallAt10)}   ${r.mrr.toFixed(3)}   ${r.ndcgAt10.toFixed(3)}   ${pct(r.emptyResultRate)}   ${String(r.p50RetrieveMs).padStart(3)}/${String(r.p95RetrieveMs).padEnd(3)}`);
}
// --- per-lane attribution -------------------------------------------------
// The point of the lane split: an overall MRR cannot tell you WHICH lane moved.
// A lane whose MRR is near zero is dead weight; a lane that never appears in
// `wonBy` is not contributing to any win it is credited with.
if (sharedRule && results.some(r => r.perQuery.some(q => q.lane))) {
	for (const r of results) {
		const byLane = new Map();
		for (const q of r.perQuery) {
			const lane = q.lane ?? 'unlabeled';
			if (!byLane.has(lane)) { byLane.set(lane, { n: 0, mrr: 0, r5: 0, miss: 0, channels: new Map() }); }
			const b = byLane.get(lane);
			b.n++;
			b.mrr += q.mrr;
			if (q.firstRank && q.firstRank <= 5) { b.r5++; }
			if (!q.firstRank) { b.miss++; }
			for (const ch of q.wonBy ?? []) { b.channels.set(ch, (b.channels.get(ch) ?? 0) + 1); }
		}
		console.log(`\nper-lane [${r.config}]:`);
		console.log('  lane              n    MRR   R@5   miss   winning channels');
		for (const [lane, b] of [...byLane].sort()) {
			const chans = [...b.channels].sort((a, c) => c[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' ') || '—';
			console.log(`  ${lane.padEnd(16)} ${String(b.n).padStart(3)}  ${(b.mrr / b.n).toFixed(3)}  ${(100 * b.r5 / b.n).toFixed(0).padStart(3)}%  ${String(b.miss).padStart(4)}   ${chans}`);
		}
		// Channel totals across every lane — a channel absent here never produced
		// a single winning hit in this run.
		const total = new Map();
		for (const q of r.perQuery) { for (const ch of q.wonBy ?? []) { total.set(ch, (total.get(ch) ?? 0) + 1); } }
		const wins = r.perQuery.filter(q => q.firstRank).length;
		console.log(`  ${'—'.repeat(60)}`);
		console.log(`  winning hits: ${wins}/${r.perQuery.length}  channels: ${[...total].sort((a, c) => c[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' ') || '—'}`);
	}
}

if (sharedRule) {
	for (const r of results) {
		console.log(`\nper query [${r.config}]:`);
		for (const q of r.perQuery) {
			const tag = q.lane ? ` (${q.lane}${q.wonBy ? ` via ${q.wonBy.join('+')}` : ''})` : '';
			console.log(q.firstRank ? `  [rank ${String(q.firstRank).padStart(2)}] ${q.query}${tag}` : `  [ miss  ] ${q.query}${tag}`);
			if (!q.firstRank || q.firstRank > 1) {
				q.topFiles.slice(0, 3).forEach((f, i) => console.log(`             ${i + 1}. ${f}`));
			}
		}
	}
}

// Ranking-change gate (the Phase B rule): compare per-query first ranks against
// a prior saved run — a change ships only on "no per-query regressions + net win".
if (baselinePath) {
	const base = baselineForComparison;
	const comparable = base.evaluationSchema === EVALUATION_SCHEMA && base.goldset === goldsetPath && base.corpus?.files === filesChunked && base.corpus?.fingerprint === corpusFingerprint && base.topK === TOP_K && base.embedder === embedderId;
	if (!comparable) {
		console.log(`\nWARNING: baseline does not match this goldset, corpus fingerprint, topK, and embedder exactly. Deltas are not release evidence.`);
		if (releaseGate) {
			console.error(`release gate failed: baseline must match the corpus fingerprint, topK, goldset, and embedder exactly`);
			process.exitCode = 2;
		}
	}
	for (const r of results) {
		const br = (base.results ?? []).find(b => b.config === r.config);
		if (!br) {
			console.log(`\nbaseline has no config '${r.config}' — gate skipped for it`);
			if (releaseGate) { process.exitCode = 2; }
			continue;
		}
		const baseRank = new Map(br.perQuery.map(q => [q.query, q.firstRank ?? null]));
		const baseNdcg = new Map(br.perQuery.map(q => [q.query, q.ndcg10]));
		const regressions = [], wins = [];
		let matchedQueries = 0;
		for (const q of r.perQuery) {
			if (!baseRank.has(q.query)) { continue; }
			matchedQueries++;
			const b = baseRank.get(q.query);
			const bv = b ?? Infinity, cv = q.firstRank ?? Infinity;
			const label = `${q.query}: ${b ?? 'miss'} -> ${q.firstRank ?? 'miss'}`;
			if (cv > bv) { regressions.push(label); }
			else if (cv < bv) { wins.push(label); }
			else if (releaseGate && typeof baseNdcg.get(q.query) === 'number') {
				const beforeNdcg = baseNdcg.get(q.query);
				if (q.ndcg10 + 1e-12 < beforeNdcg) { regressions.push(`${q.query}: nDCG ${beforeNdcg.toFixed(3)} -> ${q.ndcg10.toFixed(3)}`); }
				else if (q.ndcg10 > beforeNdcg + 1e-12) { wins.push(`${q.query}: nDCG ${beforeNdcg.toFixed(3)} -> ${q.ndcg10.toFixed(3)}`); }
			}
		}
		if (releaseGate && (matchedQueries !== r.perQuery.length || matchedQueries !== br.perQuery.length)) {
			regressions.push(`query-set mismatch: matched ${matchedQueries}, current ${r.perQuery.length}, baseline ${br.perQuery.length}`);
		}
		if (releaseGate && typeof br.emptyResultRate === 'number' && r.emptyResultRate > br.emptyResultRate) {
			regressions.push(`empty-result rate: ${pct(br.emptyResultRate)} -> ${pct(r.emptyResultRate)}`);
		}
		console.log(`\ngate [${r.config}] vs ${baselinePath}: ${wins.length} improved, ${regressions.length} regressed`);
		for (const w of wins) { console.log(`  + ${w}`); }
		for (const x of regressions) { console.log(`  - ${x}`); }
		const verdict = regressions.length > 0 ? 'FAIL (per-query regression)' : wins.length > 0 ? 'PASS' : 'NEUTRAL';
		console.log(`  verdict: ${verdict}`);
		if (regressions.length > 0) { process.exitCode = 2; }
		else if (releaseGate && comparable) { console.log(`  release evidence: PASS (strictly comparable, no per-query regression)`); }
	}
}

mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = explicitOutputPath || join(RESULTS_DIR, `${stamp}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
	evaluationSchema: EVALUATION_SCHEMA,
	at: new Date().toISOString(),
	arguments: rawArgs,
	runtime: { node: process.version, platform: process.platform, arch: process.arch },
	runtimeAssets: runtimeAssetAudit,
	repoRoot: REPO_ROOT,
	corpusRoot,
	sourceRevision,
	goldset: goldsetPath,
	goldsetTotalQueries,
	queryFilter: selectedLane ? { lane: selectedLane } : null,
	corpusExcludes,
	mode: sharedRule ? 'shared-suffix-rule' : 'mined-file-fraction',
	embedder: embedderId,
	beast: useBeast ? { weight: BEAST_WEIGHT, k: 30, mode: BEAST_MODE } : null,
	rerank: useRerank,
	rerankGuard: useRerank ? RERANK_GUARD : null,
	rerankGuardLead: useRerank && RERANK_GUARD_LEAD > 0 ? RERANK_GUARD_LEAD : null,
	chunker: chunkerMode,
	corpus: { files: filesChunked, chunks: chunks.size, embeddable: embeddable.length, structuralFiles, languageCoverage, fingerprint: corpusFingerprint },
	topK: TOP_K,
	results: results.map(({ perQuery, ...summary }) => ({ ...summary, perQuery })),
}, null, '\t') + '\n');
console.log(`\nsaved ${outPath}`);
