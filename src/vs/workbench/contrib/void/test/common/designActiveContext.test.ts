/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { capDesignBlock, formatDesignActiveBlock } from '../../common/designActiveContext.js';

suite('designActiveContext', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formatDesignActiveBlock includes plugin title and query', () => {
		const block = formatDesignActiveBlock({ title: 'Stripe', query: 'SaaS landing', skill: 'design-rag/plugins/stripe/SKILL.md' });
		assert.ok(block.includes('<design_system_active>'));
		assert.ok(block.includes('Plugin: Stripe'));
		assert.ok(block.includes('Query: SaaS landing'));
		assert.ok(block.includes('read_skill v3code-design-rag'));
	});

	test('capDesignBlock truncates at cap', () => {
		const long = 'x'.repeat(10_000);
		const capped = capDesignBlock(long, 100);
		assert.ok(capped.length < 200);
		assert.ok(capped.includes('truncated'));
	});
});
