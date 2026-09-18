/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Cross-lane measurement report. Production retrieval remains untouched: Beast
// candidates come from the real Rust implementations, semantic candidates come
// from run-eval.mjs driving the real TypeScript ranker, and this file only scores.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const argv = process.argv.slice(2);

function flag(name, fallback = '') {
	const at = argv.indexOf(name);
	if (at < 0) { return fallback; }
	const value = argv[at + 1];
	if (!value || value.startsWith('--')) { throw new Error(`${name} requires a value`); }
	argv.splice(at, 2);
	return value;
}

function boolFlag(name) {
	const at = argv.indexOf(name);
	if (at < 0) { return false; }
	argv.splice(at, 1);
	return true;
}

const goldsetPath = resolve(REPO_ROOT, flag('--goldset', 'docs/v3index-beast-packet/eval/golden-vselite-v3.jsonl'));
const beastDb = resolve(REPO_ROOT, flag('--beast-db', 'scripts/retrieval-eval/.scratch/lane-eval-db'));
const beastCandidatesFlag = flag('--beast-candidates', '');
const semanticResultsFlag = flag('--semantic-results', '');
const runSemantic = boolFlag('--run-semantic');
const semanticEmbedder = flag('--semantic-embedder', 'potion');
const semanticMaxFiles = Number(flag('--semantic-max-files', '800'));
const packageRoot = flag('--package-root', '');
const packagePlatform = flag('--package-platform', '');
const diagnoseMissingRuntimeAssets = boolFlag('--diagnose-missing-runtime-assets');
const topK = Number(flag('--topk', '10'));
const outputFlag = flag('--output', '');
if (argv.length) { throw new Error(`unknown argument(s): ${argv.join(' ')}`); }
if (!Number.isInteger(topK) || topK <= 0) { throw new Error('--topk must be a positive integer'); }
if (!Number.isInteger(semanticMaxFiles) || semanticMaxFiles < 0) { throw new Error('--semantic-max-files must be non-negative'); }
if (runSemantic && semanticResultsFlag) { throw new Error('use --run-semantic or --semantic-results, not both'); }

const scratch = join(REPO_ROOT, 'scripts', 'retrieval-eval', '.scratch');
mkdirSync(scratch, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const measurementExcludes = [
	'scripts/index-measurement',
	'beast/tests/incremental_oracle.rs',
	'beast/examples/lane_candidates.rs',
	'docs/v3index-beast-packet/eval/golden-vselite-v3.jsonl',
	'docs/v3index-beast-packet/eval/MEASUREMENT-V3.md',
	'docs/HANDOFF-index-measurement.md',
];

function run(command, args, label) {
	const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
	if (result.status !== 0) {
		throw new Error(`${label} failed (${result.status}):\n${result.stderr || result.stdout}`);
	}
	return result;
}

let beastCandidatesPath;
if (beastCandidatesFlag) {
	beastCandidatesPath = resolve(REPO_ROOT, beastCandidatesFlag);
} else {
	// Always enter Beast through its real freshness gate. An existing directory
	// is not evidence that its corpus fingerprint still matches this checkout.
	console.log(`Checking/building Beast DB ${beastDb}`);
	run(
		'cargo',
		[
			'run', '--quiet', '--manifest-path', 'beast/Cargo.toml', '--bin', 'beast', '--',
			'index', REPO_ROOT, '--db', beastDb, '--exclude', 'scripts/retrieval-eval/.scratch',
			...measurementExcludes.flatMap(prefix => ['--exclude', prefix]),
		],
		'Beast corpus build',
	);
	beastCandidatesPath = join(scratch, `beast-lane-candidates-${stamp}.json`);
	console.log('Collecting Beast-backed lane candidates in one process...');
	run(
		'cargo',
		['run', '--quiet', '--manifest-path', 'beast/Cargo.toml', '--example', 'lane_candidates', '--', '--goldset', goldsetPath, '--db', beastDb, '--output', beastCandidatesPath, '--topk', String(topK)],
		'Beast lane candidate collection',
	);
}

let semanticResultsPath = semanticResultsFlag ? resolve(REPO_ROOT, semanticResultsFlag) : '';
if (runSemantic) {
	semanticResultsPath = join(scratch, `semantic-lane-candidates-${stamp}.json`);
	console.log(`Running production semantic evaluator (${semanticEmbedder}, max-files=${semanticMaxFiles || 'all'})...`);
	run(
		process.execPath,
		[
			'scripts/retrieval-eval/run-eval.mjs',
			'--goldset', goldsetPath,
			'--embedder', semanticEmbedder,
			'--configs', '+headers',
			'--max-files', String(semanticMaxFiles),
			'--topk', String(topK),
			...(packageRoot ? ['--package-root', packageRoot, '--package-platform', packagePlatform] : []),
			...(diagnoseMissingRuntimeAssets ? ['--diagnose-missing-runtime-assets'] : []),
			...measurementExcludes.flatMap(prefix => ['--corpus-exclude', prefix]),
			'--output', semanticResultsPath,
		],
		'semantic evaluator',
	);
}

const gold = readFileSync(goldsetPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const byId = new Map(gold.map(row => [row.id, row]));
const beast = JSON.parse(readFileSync(beastCandidatesPath, 'utf8'));
if (!Array.isArray(beast.queries) || beast.queries.length !== gold.length) {
	throw new Error(`Beast candidates contain ${beast.queries?.length ?? 0} queries; expected ${gold.length}`);
}
for (const candidateQuery of beast.queries) {
	const expected = byId.get(candidateQuery.id);
	if (!expected
		|| candidateQuery.query !== expected.query
		|| JSON.stringify(candidateQuery.relevant) !== JSON.stringify(expected.relevant)) {
		throw new Error(`Beast candidate/goldset mismatch at ${candidateQuery.id ?? '<missing-id>'}`);
	}
}
const candidatesById = new Map(beast.queries.map(query => [query.id, query.candidates]));
let semanticMetadata = null;

if (semanticResultsPath) {
	semanticMetadata = JSON.parse(readFileSync(semanticResultsPath, 'utf8'));
	const config = semanticMetadata.results?.find(result => result.config === '+headers') ?? semanticMetadata.results?.[0];
	if (!config) { throw new Error('semantic results contain no config'); }
	if (semanticMetadata.goldsetTotalQueries !== undefined && semanticMetadata.goldsetTotalQueries !== gold.length) {
		throw new Error(`semantic results were built for ${semanticMetadata.goldsetTotalQueries} queries; expected ${gold.length}`);
	}
	const importedSemanticIds = new Set();
	for (const result of config.perQuery) {
		const id = result.id ?? [...byId.values()].find(row => row.query === result.query)?.id;
		const expected = id ? byId.get(id) : undefined;
		if (!expected || !candidatesById.has(id) || result.query !== expected.query) {
			throw new Error(`semantic result/goldset mismatch at ${id ?? result.query ?? '<missing-id>'}`);
		}
		importedSemanticIds.add(id);
		const semanticCandidates = (result.topCandidates ?? result.topFiles?.map(file => ({ file, sources: ['semantic'] })) ?? [])
			.map(candidate => ({
				file: candidate.file,
				start: 1,
				end: Number.MAX_SAFE_INTEGER,
				why: `semantic[${(candidate.sources ?? ['semantic']).join('+')}]`,
			}));
		candidatesById.get(id).semantic = semanticCandidates;
	}
	if (importedSemanticIds.size !== gold.length) {
		throw new Error(`semantic results cover ${importedSemanticIds.size} queries; expected ${gold.length}`);
	}
}

const lanes = ['trigram', 'symbol', 'resolved', 'memory', 'semantic', 'graph'];

function targetOf(raw) {
	const match = /^(?<path>.+):(?<start>\d+)-(?<end>\d+)$/.exec(raw);
	return match
		? { path: match.groups.path.replaceAll('\\', '/'), start: Number(match.groups.start), end: Number(match.groups.end) }
		: { path: raw.replaceAll('\\', '/'), start: 1, end: Number.MAX_SAFE_INTEGER };
}

function isRelevant(candidate, targets) {
	return targets.some(target => candidate.file.replaceAll('\\', '/').endsWith(target.path)
		&& (candidate.start ?? 1) <= target.end
		&& (candidate.end ?? Number.MAX_SAFE_INTEGER) >= target.start);
}

function uniqueFiles(candidates) {
	const seen = new Set();
	return (candidates ?? []).filter(candidate => {
		if (seen.has(candidate.file)) { return false; }
		seen.add(candidate.file);
		return true;
	});
}

function firstRank(candidates, targets) {
	const at = uniqueFiles(candidates).slice(0, topK).findIndex(candidate => isRelevant(candidate, targets));
	return at < 0 ? null : at + 1;
}

function diagnosticRrf(laneCandidates, excludedLane = '') {
	const scores = new Map();
	for (const lane of lanes) {
		if (lane === excludedLane) { continue; }
		for (const [rank, candidate] of uniqueFiles(laneCandidates[lane]).entries()) {
			scores.set(candidate.file, (scores.get(candidate.file) ?? 0) + 1 / (60 + rank + 1));
		}
	}
	return [...scores.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([file, score]) => ({ file, start: 1, end: Number.MAX_SAFE_INTEGER, why: `diagnostic-rrf=${score}` }));
}

const perQuery = [];
for (const row of gold) {
	const targets = row.relevant.map(targetOf);
	const laneCandidates = candidatesById.get(row.id) ?? {};
	for (const lane of lanes) { laneCandidates[lane] ??= []; }
	const laneRanks = Object.fromEntries(lanes.map(lane => [lane, firstRank(laneCandidates[lane], targets)]));
	const foundRanks = lanes.filter(lane => laneRanks[lane] !== null).map(lane => laneRanks[lane]);
	const bestRank = foundRanks.length ? Math.min(...foundRanks) : null;
	const winningLanes = bestRank === null ? [] : lanes.filter(lane => laneRanks[lane] === bestRank);
	const fused = diagnosticRrf(laneCandidates);
	const fusedRank = firstRank(fused, targets);
	const leaveOneOut = {};
	for (const lane of lanes) {
		const rank = firstRank(diagnosticRrf(laneCandidates, lane), targets);
		leaveOneOut[lane] = {
			firstRank: rank,
			mrrDeltaVsAll: (rank ? 1 / rank : 0) - (fusedRank ? 1 / fusedRank : 0),
		};
	}
	perQuery.push({
		id: row.id,
		query: row.query,
		intent: row.intent,
		intendedLane: row.lane,
		laneRanks,
		winningLanes,
		intendedLaneWon: winningLanes.includes(row.lane),
		diagnosticFusion: { firstRank: fusedRank, leaveOneOut },
		topFilesByLane: Object.fromEntries(lanes.map(lane => [lane, uniqueFiles(laneCandidates[lane]).slice(0, 5).map(candidate => candidate.file)])),
	});
}

function metric(rows, lane) {
	const ranks = rows.map(row => row.laneRanks[lane]);
	return {
		queries: rows.length,
		covered: ranks.filter(rank => rank !== null).length,
		recallAt5: rows.length ? ranks.filter(rank => rank !== null && rank <= 5).length / rows.length : 0,
		recallAt10: rows.length ? ranks.filter(rank => rank !== null && rank <= 10).length / rows.length : 0,
		mrr: rows.length ? ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / rows.length : 0,
	};
}

const laneMetrics = {};
const attribution = {};
for (const lane of lanes) {
	const intended = perQuery.filter(query => query.intendedLane === lane);
	const all = metric(perQuery, lane);
	const leaveOneOutDelta = perQuery.reduce((sum, query) => sum + query.diagnosticFusion.leaveOneOut[lane].mrrDeltaVsAll, 0) / perQuery.length;
	laneMetrics[lane] = {
		intended: metric(intended, lane),
		allQueries: all,
		available: lane !== 'semantic' || !!semanticResultsPath,
	};
	attribution[lane] = {
		winnerQueries: perQuery.filter(query => query.winningLanes.includes(lane)).length,
		uniqueWinnerQueries: perQuery.filter(query => query.winningLanes.length === 1 && query.winningLanes[0] === lane).length,
		candidateButNoRelevantQueries: perQuery.filter(query => query.topFilesByLane[lane].length > 0 && query.laneRanks[lane] === null).length,
		leaveOneOutMrrDelta: leaveOneOutDelta,
		interpretation: leaveOneOutDelta > 1e-12 ? 'harmful in equal-weight diagnostic fusion' : leaveOneOutDelta < -1e-12 ? 'helpful in equal-weight diagnostic fusion' : 'neutral in equal-weight diagnostic fusion',
	};
}

const intendedRanks = perQuery.map(query => query.laneRanks[query.intendedLane]);
const overall = {
	queries: perQuery.length,
	intendedLaneRecallAt5: intendedRanks.filter(rank => rank !== null && rank <= 5).length / perQuery.length,
	intendedLaneRecallAt10: intendedRanks.filter(rank => rank !== null && rank <= 10).length / perQuery.length,
	intendedLaneMrr: intendedRanks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / perQuery.length,
	intendedLaneWins: perQuery.filter(query => query.intendedLaneWon).length,
};

const outputPath = outputFlag
	? resolve(REPO_ROOT, outputFlag)
	: join(REPO_ROOT, 'scripts', 'index-measurement', 'results', `${stamp}.json`);
mkdirSync(dirname(outputPath), { recursive: true });
const report = {
	schema: 1,
	at: new Date().toISOString(),
	goldset: goldsetPath,
	topK,
	inputs: {
		beastCandidates: beastCandidatesPath,
		semanticResults: semanticResultsPath || null,
		semanticComparable: semanticMetadata ? {
			embedder: semanticMetadata.embedder,
			corpus: semanticMetadata.corpus,
			chunker: semanticMetadata.chunker,
		} : null,
	},
	overall,
	laneMetrics,
	attribution,
	perQuery,
};
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');

const pct = value => `${(value * 100).toFixed(1)}%`;
console.log('\nIntended-lane quality');
console.log('lane       queries  R@5    R@10   MRR    winners');
for (const lane of lanes) {
	const m = laneMetrics[lane].intended;
	const wins = perQuery.filter(query => query.intendedLane === lane && query.intendedLaneWon).length;
	console.log(`${lane.padEnd(10)} ${String(m.queries).padStart(7)}  ${pct(m.recallAt5).padStart(6)} ${pct(m.recallAt10).padStart(6)}  ${m.mrr.toFixed(3)}  ${String(wins).padStart(7)}${laneMetrics[lane].available ? '' : '  unavailable'}`);
}
console.log('\nAttribution (equal-weight diagnostic fusion; not production ranking)');
console.log('lane       wins  unique  no-gold  leave-one-out delta-MRR');
for (const lane of lanes) {
	const a = attribution[lane];
	console.log(`${lane.padEnd(10)} ${String(a.winnerQueries).padStart(4)}  ${String(a.uniqueWinnerQueries).padStart(6)}  ${String(a.candidateButNoRelevantQueries).padStart(5)}  ${a.leaveOneOutMrrDelta.toFixed(4).padStart(18)}`);
}
console.log(`\nsaved ${outputPath}`);
