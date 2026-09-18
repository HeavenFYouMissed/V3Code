/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Per-lane attribution for the BEAST side of retrieval.
//
//   node scripts/retrieval-eval/lane-report-beast.mjs
//   node scripts/retrieval-eval/lane-report-beast.mjs --engines trigram,symbol,all
//
// run-eval.mjs attributes the TS lanes (lex / vec / graph / beast) from
// Hit.signals. It CANNOT split beast's internal engines, because by the time
// beast hits reach the TS fusion they are collapsed into one `beast` signal.
//
// This script closes that half: it runs `beast eval` once per engine over the
// SAME lane-labelled golden set and reports MRR per (engine x lane), so a beast
// engine that is dead weight on a lane is visible rather than averaged away.
//
// Measurement only — it shells out to the release binary and parses its report.
// Nothing here can change retrieval behavior.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

const argv = process.argv.slice(2);
const valFlag = (name, def) => {
	const i = argv.indexOf(name);
	if (i === -1) { return def; }
	const v = argv[i + 1];
	if (v === undefined || v.startsWith('--')) { console.error(`${name} requires a value`); process.exit(1); }
	argv.splice(i, 2);
	return v;
};
const goldenRel = valFlag('--golden', 'scripts/retrieval-eval/sets/golden-lanes.jsonl');
const engines = valFlag('--engines', 'trigram,symbol,all').split(',').map(s => s.trim()).filter(Boolean);
const db = valFlag('--db', '.beast');
if (argv.length > 0) { console.error(`unknown argument(s): ${argv.join(' ')}`); process.exit(1); }

const binary = join(REPO_ROOT, 'beast', 'target', 'release', 'beast');
if (!existsSync(binary)) {
	console.error(`beast release binary not found at ${binary}\n  build it: cd beast && cargo build --release`);
	process.exit(1);
}
const goldenAbs = join(REPO_ROOT, goldenRel);
if (!existsSync(goldenAbs)) {
	console.error(`golden set not found: ${goldenAbs}\n  generate it: node scripts/retrieval-eval/mine-lane-goldset.mjs`);
	process.exit(1);
}
if (!existsSync(join(REPO_ROOT, db))) {
	console.error(`no beast index at ${db}\n  build it: ./beast/target/release/beast index . --exclude node_modules --exclude .git`);
	process.exit(1);
}

// query -> lane, from the golden set itself.
const laneOf = new Map();
for (const line of readFileSync(goldenAbs, 'utf8').split('\n')) {
	if (!line.trim()) { continue; }
	const o = JSON.parse(line);
	if (o.lane) { laneOf.set(o.query, o.lane); }
}
if (laneOf.size === 0) {
	console.error(`${goldenRel} carries no "lane" fields — nothing to attribute.`);
	process.exit(1);
}

// beast's report lines: "  [rank  2] <query>" | "  [ miss  ] <query>"
const RANK = /^\s*\[rank\s+(\d+)\]\s+(.*)$/;
const MISS = /^\s*\[ miss\s*\]\s+(.*)$/;

console.log(`per-lane beast attribution — ${laneOf.size} labelled queries, db=${db}`);

for (const eng of engines) {
	let out;
	try {
		out = execFileSync(binary, ['eval', '--golden', goldenRel, '--engines', eng, '--db', db],
			{ cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	} catch (err) {
		console.error(`  engines=${eng}: beast eval failed — ${err.message.split('\n')[0]}`);
		continue;
	}
	/** lane -> {n, mrrSum, miss} */
	const agg = new Map();
	let overallN = 0, overallMrr = 0;
	for (const line of out.split('\n')) {
		let rank = null, query = null;
		const r = RANK.exec(line);
		if (r) { rank = Number(r[1]); query = r[2].trim(); }
		else {
			const m = MISS.exec(line);
			if (!m) { continue; }
			query = m[1].trim();
		}
		const lane = laneOf.get(query);
		if (!lane) { continue; }
		if (!agg.has(lane)) { agg.set(lane, { n: 0, mrrSum: 0, miss: 0 }); }
		const a = agg.get(lane);
		a.n++;
		const contrib = rank ? 1 / rank : 0;
		a.mrrSum += contrib;
		if (!rank) { a.miss++; }
		overallN++; overallMrr += contrib;
	}
	console.log(`\n  engines=${eng}`);
	console.log('    lane              n     MRR   miss');
	for (const [lane, a] of [...agg].sort()) {
		console.log(`    ${lane.padEnd(16)} ${String(a.n).padStart(3)}   ${(a.mrrSum / a.n).toFixed(3)}   ${String(a.miss).padStart(4)}`);
	}
	console.log(`    ${'—'.repeat(44)}`);
	console.log(`    overall          ${String(overallN).padStart(3)}   ${(overallMrr / Math.max(overallN, 1)).toFixed(3)}`);
}
