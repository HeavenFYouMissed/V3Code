/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IColorCustomizations, IThemeScopedColorCustomizations } from '../../../../services/themes/common/workbenchThemeService.js';
import { mergeScopedGreyChromeCustomizations, sanitizeV3UserColorCustomizations } from '../../browser/v3codeGreyChromeContribution.js';

suite('V3Code grey chrome customizations', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('USER cleanup is immutable and idempotent', () => {
		const input: IColorCustomizations = {
			'contrastBorder': '#ff0000',
			'editorError.foreground': '#d16969',
			'[V3Code Dark Classic]': {
				'panel.border': '#7343ff',
				'contrastActiveBorder': '#123456',
				'editor.foreground': '#ededed',
			},
		};
		const snapshot = JSON.parse(JSON.stringify(input));

		const once = sanitizeV3UserColorCustomizations(input);
		const twice = sanitizeV3UserColorCustomizations(once);
		const houseScope = once['[V3Code Dark Classic]'] as IThemeScopedColorCustomizations;

		assert.deepStrictEqual(input, snapshot, 'cleanup must never mutate live configuration objects');
		assert.strictEqual(once['contrastBorder'], undefined);
		assert.strictEqual(houseScope['panel.border'], undefined);
		assert.strictEqual(houseScope['contrastActiveBorder'], undefined);
		assert.strictEqual(houseScope['editor.foreground'], '#ededed');
		assert.strictEqual(once['editorError.foreground'], '#d16969', 'ordinary error colors remain intact');
		assert.deepStrictEqual(twice, once, 'a second startup cleanup must be a no-op');
	});

	test('APPLICATION overlay is idempotent and owns transparent house-theme borders', () => {
		const once = mergeScopedGreyChromeCustomizations({
			'[V3Code Dark Classic]': {
				'contrastBorder': '#ff0000',
				'editor.foreground': '#f0f0f0',
			},
		});
		const twice = mergeScopedGreyChromeCustomizations(once);
		const houseScope = once['[V3Code Dark Classic]'] as IThemeScopedColorCustomizations;

		assert.strictEqual(houseScope['contrastBorder'], 'transparent');
		assert.strictEqual(houseScope['contrastActiveBorder'], 'transparent');
		assert.strictEqual(houseScope['panel.border'], 'transparent');
		assert.strictEqual(houseScope['editor.foreground'], '#f0f0f0', 'user-selected non-border colors remain top coat');
		assert.deepStrictEqual(twice, once, 'theme-change reapplication must not produce another write');
	});
});
