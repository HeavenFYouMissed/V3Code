/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = join(import.meta.dirname, '..', '..');
const VOID = join(REPO, 'src', 'vs', 'workbench', 'contrib', 'void');
const scratch = join(import.meta.dirname, '.scratch');
mkdirSync(scratch, { recursive: true });
const entry = join(scratch, 'smoke-entry.ts');
const out = join(scratch, 'smoke-bundle.mjs');
writeFileSync(entry, [
	`export { hybridSearch } from '${join(VOID, 'browser/semanticIndex/hybridRetriever.ts')}';`,
	`export { DependencyGraph } from '${join(VOID, 'browser/semanticIndex/dependencyGraph.ts')}';`,
	`export { internTokens } from '${join(VOID, 'browser/semanticIndex/tokenDict.ts')}';`,
].join('\n'));
const esb = spawnSync(join(REPO, 'node_modules', '.bin', 'esbuild'), [
	entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`,
], { stdio: 'inherit' });
if (esb.status) { process.exit(1); }

const { hybridSearch, DependencyGraph, internTokens } = await import(pathToFileURL(out).href);

function chunk(id, file, tokens, opts = {}) {
	return {
		id, file, startLine: 1, endLine: 10, kind: 'function', name: id,
		language: 'typescript', contentHash: `h-${id}`, content: 'fn',
		tokens: internTokens(tokens), scored: true, ...opts,
	};
}

const chunks = [
	chunk('rememberTool', 'tools/remember.ts', ['memory', 'persistent', 'notes'], { refs: ['MemoryStore'] }),
	chunk('listNotes', 'tools/listNotes.ts', ['memory', 'notes', 'list'], { refs: ['MemoryStore'] }),
	chunk('memoryDb', 'memory/memoryDatabase.ts', ['store', 'sqlite'], { defines: ['MemoryStore'], lspDefines: ['MemoryStore'] }),
	chunk('notebook', 'notebook/persist.ts', ['persistent', 'options', 'transient'], { defines: ['TransientOptions'] }),
];
const graph = new DependencyGraph();
graph.ensure(chunks);
const hits = hybridSearch(
	{ chunks: new Map(chunks.map(c => [c.id, c])), graph, embeddingsAvailable: false },
	{ queryTokens: ['persistent', 'memory', 'store', 'notes'], queryEmbedding: null },
	{ topK: 5, fileFilter: null },
);
const prim = hits.filter(h => !h.signals.neighbor);
console.log('ranking:');
for (const h of prim) {
	console.log(`  ${h.chunk.file} score=${h.score.toFixed(4)}${h.signals.graphBoost ? ` graph=${h.signals.graphBoost.toFixed(4)}` : ''}${h.signals.weak ? ' WEAK' : ''}`);
}
const dbRank = prim.findIndex(h => h.chunk.file.includes('memoryDatabase'));
const nbRank = prim.findIndex(h => h.chunk.file.includes('persist.ts'));
if (dbRank === -1 || (nbRank !== -1 && dbRank > nbRank)) {
	console.error('FAIL: memory hub should outrank notebook');
	process.exit(1);
}
console.log('PASS graph propagation smoke');
