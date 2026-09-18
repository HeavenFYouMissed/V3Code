/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { shouldRestoreFlow, V3RightSideState } from '../../common/v3FlowLayoutState.js';

const state = (overrides: Partial<V3RightSideState>): V3RightSideState => ({
	v3ModeActive: true,
	activeSurface: 'flow',
	openEditorCount: 0,
	editorPartVisible: true,
	panelVisible: false,
	auxiliaryBarMaximized: false,
	trigger: 'editor-close',
	panelWasVisibleBeforeTrigger: false,
	...overrides,
});

suite('V3 Flow rubber band', () => {
	test('the last editor closing hands the window back to Chat', () => {
		assert.strictEqual(shouldRestoreFlow(state({ openEditorCount: 0, editorPartVisible: true })), true);
	});

	test('closing ONE editor while others stay open never snaps Chat back (the random snap-back bug)', () => {
		assert.strictEqual(shouldRestoreFlow(state({ openEditorCount: 2, editorPartVisible: true })), false);
		assert.strictEqual(shouldRestoreFlow(state({ openEditorCount: 1, activeSurface: 'browser' })), false);
	});

	test('an empty right side restores Flow from the Editor and Browser surfaces too (no grey editor)', () => {
		assert.strictEqual(shouldRestoreFlow(state({ activeSurface: 'editor', openEditorCount: 0, editorPartVisible: true })), true);
		assert.strictEqual(shouldRestoreFlow(state({ activeSurface: 'browser', openEditorCount: 0, editorPartVisible: true })), true);
	});

	test('a terminal the user opened by hand in Flow is content — the band must not hide it', () => {
		assert.strictEqual(shouldRestoreFlow(state({ trigger: 'part-visibility', panelVisible: true, openEditorCount: 0 })), false);
	});

	test('the user closing that terminal empties the right side → Chat slides back', () => {
		assert.strictEqual(shouldRestoreFlow(state({ trigger: 'part-visibility', panelVisible: false, editorPartVisible: true, openEditorCount: 0 })), true);
	});

	test('closing the last file while the terminal was already up leaves the terminal alone', () => {
		assert.strictEqual(shouldRestoreFlow(state({ trigger: 'editor-close', panelWasVisibleBeforeTrigger: true, panelVisible: true, openEditorCount: 0 })), false);
	});

	test('closing the last browser that made core layout reopen the remembered terminal still restores (stray panel)', () => {
		assert.strictEqual(shouldRestoreFlow(state({ trigger: 'editor-close', panelWasVisibleBeforeTrigger: false, panelVisible: true, editorPartVisible: false, openEditorCount: 0 })), true);
	});

	test('the Terminal surface the user chose is a real right side while its panel shows', () => {
		assert.strictEqual(shouldRestoreFlow(state({ activeSurface: 'terminal', openEditorCount: 0, panelVisible: true, trigger: 'part-visibility' })), false);
		assert.strictEqual(shouldRestoreFlow(state({ activeSurface: 'terminal', openEditorCount: 0, panelVisible: false, trigger: 'part-visibility' })), true, 'closing the terminal panel empties the right side');
	});

	test('canonical Flow is a no-op (no restore loop)', () => {
		assert.strictEqual(shouldRestoreFlow(state({ openEditorCount: 0, editorPartVisible: false, panelVisible: false, auxiliaryBarMaximized: true, trigger: 'part-visibility' })), false);
	});

	test('does nothing outside V3 mode', () => {
		assert.strictEqual(shouldRestoreFlow(state({ v3ModeActive: false, openEditorCount: 0 })), false);
	});
});
