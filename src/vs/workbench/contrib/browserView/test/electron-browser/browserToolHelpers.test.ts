/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { hasKey } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService } from '../../common/browserView.js';
import { resolveBrowserPageId } from '../../electron-browser/tools/browserToolHelpers.js';

suite('Browser page routing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function resolve(id: string | undefined, ids: string[]) {
		const pages = ids.map(pageId => ({ id: pageId, model: { sharingState: BrowserViewSharingState.Shared } } as BrowserEditorInput));
		const browser = { getKnownBrowserViews: () => new Map(pages.map(page => [page.id, page])) } as IBrowserViewWorkbenchService;
		const editor = { activeEditor: pages[0], visibleEditors: pages } as unknown as IEditorService;
		return resolveBrowserPageId(id, browser, editor);
	}

	test('dead explicit id cannot bind to the only shared page', () => {
		assert.ok(hasKey(resolve('dead-page', ['live-page']), { error: true }));
	});

	test('dead explicit id cannot bind to any of multiple shared pages', () => {
		assert.ok(hasKey(resolve('dead-page', ['page-x', 'page-y']), { error: true }));
	});

	test('unknown id fails with no pages', () => {
		assert.ok(hasKey(resolve('dead-page', []), { error: true }));
	});

	test('explicit ids retain their exact target', () => {
		assert.deepStrictEqual(resolve('page-y', ['page-x', 'page-y']), { pageId: 'page-y' });
		assert.deepStrictEqual(resolve(' [page-x] ', ['page-x', 'page-y']), { pageId: 'page-x' });
	});

	test('omitted id and known aliases may resolve one shared page', () => {
		assert.deepStrictEqual(resolve(undefined, ['page-x']), { pageId: 'page-x' });
		assert.deepStrictEqual(resolve('shared', ['page-x']), { pageId: 'page-x' });
	});
});
