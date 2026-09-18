/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { ESLint } from 'eslint';
import { eslintFilter } from './filters.ts';

async function eslint(): Promise<void> {
	const linter = new ESLint({
		cache: true,
		cacheLocation: '.eslintcache',
		cacheStrategy: 'content',
		concurrency: 'auto',
		errorOnUnmatchedPattern: false,
	});
	const formatter = await linter.loadFormatter('compact');

	// Honor explicit file/dir arguments (e.g. `node build/eslint.ts src/foo.ts src/bar.ts`) so a
	// caller who lints specific paths gets ONLY those results. Without this, passed paths were
	// silently ignored and the entire repo was scanned. Fall back to the full repo filter when
	// no paths are given.
	const cliPaths = process.argv.slice(2).filter(a => !a.startsWith('-'));
	const patterns = cliPaths.length > 0 ? cliPaths : Array.from(eslintFilter);

	const results = await linter.lintFiles(patterns);
	const message = await formatter.format(results);
	if (message) {
		console.log(message);
	}

	let warningCount = 0;
	let errorCount = 0;
	for (const r of results) {
		warningCount += r.warningCount;
		errorCount += r.errorCount;
	}
	if (warningCount > 0 || errorCount > 0) {
		throw new Error(`eslint failed with ${warningCount + errorCount} warnings and/or errors`);
	}
}

if (import.meta.main) {
	eslint().catch((err) => {
		console.error();
		console.error(err);
		process.exit(1);
	});
}
