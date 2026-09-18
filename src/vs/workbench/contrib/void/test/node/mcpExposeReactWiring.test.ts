/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function repoRoot(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, '..', '..', '..', '..', '..', '..', '..');
}

suite('V3Code MCP expose React wiring', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers the main-process channel service used by the Expose V3Code card', () => {
		const servicesPath = path.join(
			repoRoot(),
			'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react', 'src', 'util', 'services.tsx'
		);
		const source = fs.readFileSync(servicesPath, 'utf8');

		assert.match(source, /import\s*\{\s*IMainProcessService\s*\}/);
		assert.match(source, /IMainProcessService:\s*accessor\.get\(IMainProcessService\)/);
	});
});
