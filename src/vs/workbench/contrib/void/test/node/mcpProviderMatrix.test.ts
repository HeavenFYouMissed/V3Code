/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CATALOG } from '../../common/mcpCatalog.js';

/**
 * The truthfulness gate for the catalog's `verified` flag: an entry may claim
 * Verified ONLY while docs/MCP-PROVIDER-MATRIX.md carries a COMPLETE live-run row
 * for it. A missing file with zero verified entries passes (vacuous); a missing or
 * incomplete row for any verified entry fails the build.
 */

interface MatrixRow {
	readonly id: string;
	readonly cells: readonly string[];
	readonly complete: boolean;
}

function repoRoot(): string {
	// Compiled to out/vs/workbench/contrib/void/test/node/, so the repo root is 7 up.
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, '..', '..', '..', '..', '..', '..', '..');
}

function readMatrixRows(): MatrixRow[] | undefined {
	const matrixPath = path.join(repoRoot(), 'docs', 'MCP-PROVIDER-MATRIX.md');
	if (!fs.existsSync(matrixPath)) {
		return undefined;
	}
	const lines = fs.readFileSync(matrixPath, 'utf8').split('\n');
	const rows: MatrixRow[] = [];
	for (const line of lines) {
		if (!line.trimStart().startsWith('|')) { continue; }
		const cells = line.split('|').slice(1, -1).map(c => c.trim());
		if (cells.length < 10 || cells[0] === 'id' || /^-+$/.test(cells[0])) { continue; }
		rows.push({
			id: cells[0],
			cells,
			complete: cells.every(c => c.length > 0),
		});
	}
	return rows;
}

suite('mcp provider matrix', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every row names a real catalog entry', () => {
		const rows = readMatrixRows();
		if (rows === undefined) { return; }
		const ids = new Set(CATALOG.map(e => e.id));
		for (const row of rows) {
			assert.ok(ids.has(row.id), `matrix row "${row.id}" does not match any catalog entry`);
		}
	});

	test('verified: true requires a complete live-run row', () => {
		const rows = readMatrixRows();
		const rowById = new Map((rows ?? []).map(r => [r.id, r]));
		for (const entry of CATALOG) {
			if (entry.verified !== true) { continue; }
			const row = rowById.get(entry.id);
			assert.ok(row !== undefined, `"${entry.id}" claims verified but has no matrix row${rows === undefined ? ' (matrix file missing)' : ''}`);
			assert.ok(row.complete, `"${entry.id}" claims verified but its matrix row is incomplete: [${row.cells.join(' | ')}]`);
			assert.ok(row.cells[5]?.toLowerCase() === 'yes', `"${entry.id}" claims verified but 'usable tools listed' is not yes — an opened browser is not a connection`);
		}
	});
});
