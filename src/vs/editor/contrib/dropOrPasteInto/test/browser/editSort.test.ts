/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { createStringDataTransferItem, VSDataTransfer } from '../../../../../base/common/dataTransfer.js';
import { HierarchicalKind } from '../../../../../base/common/hierarchicalKind.js';
import { Mimes } from '../../../../../base/common/mime.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DocumentDropEdit, DocumentPasteTriggerKind } from '../../../../common/languages.js';
import { DefaultTextPasteOrDropEditProvider } from '../../browser/defaultProviders.js';
import { sortEditsByYieldTo } from '../../browser/edit.js';


function createTestEdit(kind: string, args?: Partial<DocumentDropEdit>): DocumentDropEdit {
	return {
		title: '',
		insertText: '',
		kind: new HierarchicalKind(kind),
		...args,
	};
}

suite('sortEditsByYieldTo', () => {

	test('Should noop for empty edits', () => {
		const edits: DocumentDropEdit[] = [];

		assert.deepStrictEqual(sortEditsByYieldTo(edits), []);
	});

	test('Yielded to edit should get sorted after target', () => {
		const edits: DocumentDropEdit[] = [
			createTestEdit('a', { yieldTo: [{ kind: new HierarchicalKind('b') }] }),
			createTestEdit('b'),
		];
		assert.deepStrictEqual(sortEditsByYieldTo(edits).map(x => x.kind?.value), ['b', 'a']);
	});

	test('Should handle chain of yield to', () => {
		{
			const edits: DocumentDropEdit[] = [
				createTestEdit('c', { yieldTo: [{ kind: new HierarchicalKind('a') }] }),
				createTestEdit('a', { yieldTo: [{ kind: new HierarchicalKind('b') }] }),
				createTestEdit('b'),
			];

			assert.deepStrictEqual(sortEditsByYieldTo(edits).map(x => x.kind?.value), ['b', 'a', 'c']);
		}
		{
			const edits: DocumentDropEdit[] = [
				createTestEdit('a', { yieldTo: [{ kind: new HierarchicalKind('b') }] }),
				createTestEdit('c', { yieldTo: [{ kind: new HierarchicalKind('a') }] }),
				createTestEdit('b'),
			];

			assert.deepStrictEqual(sortEditsByYieldTo(edits).map(x => x.kind?.value), ['b', 'a', 'c']);
		}
	});

	test('Should prefer an image attachment edit over clipboard file paths', () => {
		const edits: DocumentDropEdit[] = [
			createTestEdit('uri.path.absolute', {
				handledMimeType: 'text/uri-list',
				yieldTo: [{ mimeType: 'image/png' }],
			}),
			createTestEdit('uri.path.relative', {
				handledMimeType: 'text/uri-list',
				yieldTo: [{ mimeType: 'image/png' }],
			}),
			createTestEdit('chat.attach.image', { handledMimeType: 'image/png' }),
		];
		assert.deepStrictEqual(sortEditsByYieldTo(edits).map(x => x.kind?.value), [
			'chat.attach.image',
			'uri.path.absolute',
			'uri.path.relative',
		]);
	});

	test('Plain text from a screenshot clipboard yields to the image attachment', async () => {
		const dataTransfer = new VSDataTransfer();
		dataTransfer.append(Mimes.text, createStringDataTransferItem('/var/folders/example/Screenshot.png'));
		dataTransfer.append('image/png', createStringDataTransferItem('image bytes'));

		const session = await new DefaultTextPasteOrDropEditProvider().provideDocumentPasteEdits(
			null!,
			[],
			dataTransfer,
			{ triggerKind: DocumentPasteTriggerKind.Automatic },
			CancellationToken.None,
		);

		assert.deepStrictEqual(session?.edits[0].yieldTo, [{ mimeType: 'image/png' }]);
		session?.dispose();
	});

	test(`Should not reorder when yield to isn't used`, () => {
		const edits: DocumentDropEdit[] = [
			createTestEdit('c', { yieldTo: [{ kind: new HierarchicalKind('x') }] }),
			createTestEdit('a', { yieldTo: [{ kind: new HierarchicalKind('y') }] }),
			createTestEdit('b'),
		];

		assert.deepStrictEqual(sortEditsByYieldTo(edits).map(x => x.kind?.value), ['c', 'a', 'b']);
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
