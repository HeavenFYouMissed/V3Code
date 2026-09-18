/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { availableTools } from '../../common/prompt/prompts.js';

suite('Plan mode tools', () => {
	test('publishes unique tool names while retaining memory tools', () => {
		const tools = availableTools('plan', []) ?? [];
		const names = tools.map(tool => tool.name);

		assert.strictEqual(new Set(names).size, names.length, 'Plan mode must not publish duplicate tool names');
		assert.strictEqual(names.filter(name => name === 'remember').length, 1);
		assert.strictEqual(names.filter(name => name === 'forget').length, 1);
	});
});
