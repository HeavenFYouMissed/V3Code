/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseRawToolParamsString } from '../../common/prompt/toolCallParams.js';

suite('Streamed tool-call arguments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts blank arguments as an empty object for all-optional tools', () => {
		assert.deepStrictEqual(parseRawToolParamsString(''), {});
		assert.deepStrictEqual(parseRawToolParamsString('   '), {});
	});

	test('parses object arguments and rejects truncated or non-object JSON', () => {
		assert.deepStrictEqual(parseRawToolParamsString('{"rebuild":false}'), { rebuild: false });
		assert.strictEqual(parseRawToolParamsString('{"rebuild":'), null);
		assert.strictEqual(parseRawToolParamsString('null'), null);
		assert.strictEqual(parseRawToolParamsString('[]'), null);
	});
});
