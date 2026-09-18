/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseBeastHits } from '../../common/beastTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('beastTypes parseBeastHits', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses real beast --json output, skipping blanks and noise lines', () => {
		// First two lines captured verbatim from `beast search --json` on this repo;
		// the banner and truncated-JSON lines mimic llama/stderr noise on stdout.
		const stdout = [
			'',
			'some non-json banner line',
			'{"file":"src/vs/workbench/contrib/void/browser/semanticIndex/hybridRetriever.ts","line":173,"span":[173,173],"score":0.014754098,"why":"rrf[trigram#1] trigram bm25 #1 → confirmed [rrf+weighted+merge] @L173","symbol":null}',
			'{"file":"src/vs/workbench/contrib/void/common/semanticIndex/retriever.ts","line":10,"span":[10,10],"score":0.014516128,"why":"rrf[trigram#2]","symbol":null}',
			'{"file":"broken.ts","line":',
			'{"notAHit":true}',
			'',
		].join('\n');
		assert.deepStrictEqual(parseBeastHits(stdout).map(h => ({ file: h.file, line: h.line })), [
			{ file: 'src/vs/workbench/contrib/void/browser/semanticIndex/hybridRetriever.ts', line: 173 },
			{ file: 'src/vs/workbench/contrib/void/common/semanticIndex/retriever.ts', line: 10 },
		]);
	});

	test('empty stdout parses to no hits', () => {
		assert.deepStrictEqual(parseBeastHits(''), []);
	});
});
