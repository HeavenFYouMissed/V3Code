/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Structural validation for the locked six-lane V3Code retrieval goldset.
// This deliberately validates source-derived answer keys, not retrieval output.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const args = process.argv.slice(2);

function flag(name, fallback = '') {
	const at = args.indexOf(name);
	if (at < 0) { return fallback; }
	const value = args[at + 1];
	if (!value || value.startsWith('--')) { throw new Error(`${name} requires a value`); }
	args.splice(at, 2);
	return value;
}

const goldsetPath = resolve(REPO_ROOT, flag('--goldset', 'docs/v3index-beast-packet/eval/golden-vselite-v3.jsonl'));
const tagsPathArg = flag('--tags', '');
if (args.length) { throw new Error(`unknown argument(s): ${args.join(' ')}`); }

const raw = readFileSync(goldsetPath, 'utf8');
const rows = raw.split('\n').filter(line => line.trim()).map((line, index) => {
	try { return JSON.parse(line); }
	catch (error) { throw new Error(`invalid JSON on line ${index + 1}: ${error.message}`); }
});

const expectedLanes = ['trigram', 'symbol', 'resolved', 'semantic', 'graph', 'memory'];
const errors = [];
const laneCounts = Object.fromEntries(expectedLanes.map(lane => [lane, 0]));
const ids = new Set();
const queries = new Set();

for (const row of rows) {
	if (!expectedLanes.includes(row.lane)) { errors.push(`${row.id ?? '<no-id>'}: unknown lane '${row.lane}'`); continue; }
	laneCounts[row.lane]++;
	if (typeof row.id !== 'string' || !row.id) { errors.push('row missing id'); }
	else if (ids.has(row.id)) { errors.push(`${row.id}: duplicate id`); }
	else { ids.add(row.id); }
	if (typeof row.query !== 'string' || !row.query.trim()) { errors.push(`${row.id}: missing query`); }
	else if (queries.has(row.query)) { errors.push(`${row.id}: duplicate query text`); }
	else { queries.add(row.query); }
	if (!Array.isArray(row.relevant) || row.relevant.length === 0) { errors.push(`${row.id}: no relevant targets`); continue; }
	if (!row.sample?.source || !row.sample?.stratum) { errors.push(`${row.id}: missing sampling provenance`); }
	for (const target of row.relevant) {
		const path = target.replace(/:\d+-\d+$/, '');
		if (!existsSync(resolve(REPO_ROOT, path))) { errors.push(`${row.id}: target does not exist: ${path}`); }
	}
	if (row.lane === 'trigram' && row.probe?.literal !== true) { errors.push(`${row.id}: trigram query is not explicitly literal`); }
	if ((row.lane === 'symbol' || row.lane === 'resolved') && typeof row.probe?.symbol !== 'string') { errors.push(`${row.id}: missing symbol probe`); }
	if (row.lane === 'graph' && (typeof row.probe?.target !== 'string' || !Number.isInteger(row.probe?.depth))) { errors.push(`${row.id}: missing graph target/depth`); }
	if (row.lane === 'memory' && (!row.fixture?.text || !Array.isArray(row.fixture?.files) || !row.fixture?.tier)) { errors.push(`${row.id}: incomplete memory fixture`); }
}

for (const lane of expectedLanes) {
	if (laneCounts[lane] !== 20) { errors.push(`${lane}: expected 20 queries, found ${laneCounts[lane]}`); }
}

for (const row of rows.filter(row => row.lane === 'trigram')) {
	const found = row.relevant.some(target => {
		const path = resolve(REPO_ROOT, target.replace(/:\d+-\d+$/, ''));
		return existsSync(path) && readFileSync(path, 'utf8').includes(row.query);
	});
	if (!found) { errors.push(`${row.id}: literal is absent from every answer-key file`); }
}

const memoryTierCounts = {};
for (const row of rows.filter(row => row.lane === 'memory')) {
	memoryTierCounts[row.fixture.tier] = (memoryTierCounts[row.fixture.tier] ?? 0) + 1;
}
for (const tier of ['chat', 'workspace', 'editorial', 'archive-page']) {
	if (memoryTierCounts[tier] !== 5) { errors.push(`memory tier ${tier}: expected 5 queries, found ${memoryTierCounts[tier] ?? 0}`); }
}

if (tagsPathArg) {
	const tags = JSON.parse(readFileSync(resolve(REPO_ROOT, tagsPathArg), 'utf8'));
	const definitions = new Map();
	const references = new Map();
	for (const tag of tags) {
		const table = tag.is_definition ? definitions : references;
		let paths = table.get(tag.name);
		if (!paths) { table.set(tag.name, paths = new Set()); }
		paths.add(tag.path);
	}
	for (const row of rows.filter(row => row.lane === 'symbol' || row.lane === 'resolved')) {
		const defs = definitions.get(row.probe.symbol);
		if (!defs?.size) { errors.push(`${row.id}: symbol has no structural definition in tags: ${row.probe.symbol}`); continue; }
		if (row.lane === 'resolved') {
			const refs = references.get(row.probe.symbol);
			if (!refs || ![...refs].some(path => !defs.has(path))) {
				errors.push(`${row.id}: resolved sample has no cross-file reference: ${row.probe.symbol}`);
			}
		}
	}
}

const fingerprint = createHash('sha256').update(raw).digest('hex');
const report = {
	goldset: goldsetPath,
	fingerprint,
	queries: rows.length,
	laneCounts,
	memoryTierCounts,
	tagsValidated: !!tagsPathArg,
	errors,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length) { process.exitCode = 1; }

