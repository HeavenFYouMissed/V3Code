/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	PLAN_WEB_SEARCH_MAX,
	PLAN_WEB_SEARCH_MAX_GREENFIELD,
	planWebSearchLimit,
	shouldBlockPlanWebSearch,
} from '../../common/memory/planResearchBudget.js';

suite('memory plan research budget (coffee-site plan spiral)', () => {

	test('limits: greenfield is tighter than existing codebase', () => {
		assert.ok(PLAN_WEB_SEARCH_MAX_GREENFIELD < PLAN_WEB_SEARCH_MAX);
		assert.strictEqual(planWebSearchLimit(true), PLAN_WEB_SEARCH_MAX_GREENFIELD);
		assert.strictEqual(planWebSearchLimit(false), PLAN_WEB_SEARCH_MAX);
	});

	test('blocks after cap (greenfield = 3 searches)', () => {
		assert.strictEqual(shouldBlockPlanWebSearch(0, true), false);
		assert.strictEqual(shouldBlockPlanWebSearch(2, true), false);
		assert.strictEqual(shouldBlockPlanWebSearch(3, true), true);
	});

	test('coffee-site repro: fourth plan-mode search on empty folder is blocked', () => {
		// Simulates the 50-search spiral — hard stop at 3 on greenfield.
		let count = 0;
		for (let i = 0; i < 50; i++) {
			if (shouldBlockPlanWebSearch(count, true)) { break; }
			count++;
		}
		assert.strictEqual(count, PLAN_WEB_SEARCH_MAX_GREENFIELD);
	});
});
