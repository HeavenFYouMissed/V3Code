/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isWorkspaceIndexPathSchemeCompatible, MULTI_ROOT_PATH_SCHEME, workspaceFolderAlias, workspaceIndexPath, workspaceIndexPathScheme, workspaceIndexUri } from '../../common/semanticIndex/workspaceIndexPath.js';

function folder(path: string, name: string, index: number): IWorkspaceFolder {
	const uri = URI.file(path);
	return { uri, name, index, toResource: relative => URI.joinPath(uri, relative) };
}

suite('semanticIndex / multi-root path identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('single-root paths remain unchanged', () => {
		const roots = [folder('/work/app', 'app', 0)];
		assert.strictEqual(workspaceIndexPath(roots, URI.file('/work/app/src/index.ts')), 'src/index.ts');
		assert.strictEqual(workspaceIndexUri(roots, '@roots/user-owned/file.ts')?.fsPath, URI.file('/work/app/@roots/user-owned/file.ts').fsPath);
		assert.strictEqual(workspaceIndexPathScheme(roots), 'single-root-v1');
	});

	test('same relative path in two roots gets distinct cloud-safe keys', () => {
		const roots = [folder('/work/app', 'app', 0), folder('/work/api', 'api', 1)];
		const app = workspaceIndexPath(roots, URI.file('/work/app/src/index.ts'));
		const api = workspaceIndexPath(roots, URI.file('/work/api/src/index.ts'));
		assert.strictEqual(app, `@roots/${workspaceFolderAlias(roots[0])}/src/index.ts`);
		assert.strictEqual(api, `@roots/${workspaceFolderAlias(roots[1])}/src/index.ts`);
		assert.notStrictEqual(app, api);
		assert.ok(!app!.split('/').includes('..'));
		assert.ok(workspaceIndexPathScheme(roots).startsWith(`${MULTI_ROOT_PATH_SCHEME}:`));
	});

	test('aliases are readable and carry no root position', () => {
		const roots = [folder('/work/app', 'app', 0), folder('/work/api', 'api', 1)];
		assert.ok(/^app-[0-9a-f]{8}$/.test(workspaceFolderAlias(roots[0])));
		assert.ok(/^api-[0-9a-f]{8}$/.test(workspaceFolderAlias(roots[1])));
	});

	test('reordering roots changes neither aliases nor the folder-set signature', () => {
		const app = folder('/work/app', 'app', 0);
		const api = folder('/work/api', 'api', 1);
		const swappedApi = folder('/work/api', 'api', 0);
		const swappedApp = folder('/work/app', 'app', 1);

		assert.strictEqual(workspaceFolderAlias(app), workspaceFolderAlias(swappedApp));
		assert.strictEqual(workspaceFolderAlias(api), workspaceFolderAlias(swappedApi));
		assert.strictEqual(
			workspaceIndexPathScheme([app, api]),
			workspaceIndexPathScheme([swappedApi, swappedApp]),
		);
		// The persisted snapshot therefore survives a reorder.
		assert.strictEqual(
			isWorkspaceIndexPathSchemeCompatible([swappedApi, swappedApp], workspaceIndexPathScheme([app, api])),
			true,
		);
		// Keys are identical too, so nothing has to be re-walked.
		assert.strictEqual(
			workspaceIndexPath([app, api], URI.file('/work/api/src/index.ts')),
			workspaceIndexPath([swappedApi, swappedApp], URI.file('/work/api/src/index.ts')),
		);
	});

	test('adding or removing a root never renames the roots that remain', () => {
		const app = folder('/work/app', 'app', 0);
		const api = folder('/work/api', 'api', 1);
		const web = folder('/work/web', 'web', 2);

		const before = workspaceIndexPath([app, api, web], URI.file('/work/web/src/a.ts'));
		// Drop the FIRST root — under positional aliases this renumbered everything.
		const afterRemoval = workspaceIndexPath(
			[folder('/work/api', 'api', 0), folder('/work/web', 'web', 1)],
			URI.file('/work/web/src/a.ts'),
		);
		assert.strictEqual(before, afterRemoval);

		// Adding a root likewise leaves existing keys untouched.
		const afterAdd = workspaceIndexPath(
			[app, api, web, folder('/work/docs', 'docs', 3)],
			URI.file('/work/web/src/a.ts'),
		);
		assert.strictEqual(before, afterAdd);
	});

	test('duplicate folder names in different locations remain distinct and round-trip', () => {
		const roots = [folder('/one/app', 'app', 0), folder('/two/app', 'app', 1)];
		assert.notStrictEqual(workspaceFolderAlias(roots[0]), workspaceFolderAlias(roots[1]));
		const key = workspaceIndexPath(roots, URI.file('/two/app/lib/a.ts'))!;
		assert.strictEqual(workspaceIndexUri(roots, key)?.fsPath, URI.file('/two/app/lib/a.ts').fsPath);
		// ...and the shared display name still leads the alias, so keys stay readable.
		assert.ok(workspaceFolderAlias(roots[0]).startsWith('app-'));
		assert.ok(workspaceFolderAlias(roots[1]).startsWith('app-'));
	});

	test('rejects traversal and unknown root aliases', () => {
		const roots = [folder('/work/app', 'app', 0), folder('/work/api', 'api', 1)];
		const api = workspaceFolderAlias(roots[1]);
		assert.strictEqual(workspaceIndexUri(roots, `@roots/${api}/../secret.ts`), undefined);
		assert.strictEqual(workspaceIndexUri(roots, '@roots/missing-00000000/src/a.ts'), undefined);
	});

	test('legacy cache identity is accepted only where paths stayed unambiguous', () => {
		const single = [folder('/work/app', 'app', 0)];
		const multi = [single[0], folder('/work/api', 'api', 1)];
		assert.strictEqual(isWorkspaceIndexPathSchemeCompatible(single, undefined), true);
		assert.strictEqual(isWorkspaceIndexPathSchemeCompatible(multi, undefined), false);
		assert.strictEqual(isWorkspaceIndexPathSchemeCompatible(multi, workspaceIndexPathScheme(multi)), true);
	});

	test('v1 snapshots are rejected rather than reinterpreted as v2 keys', () => {
		const multi = [folder('/work/app', 'app', 0), folder('/work/api', 'api', 1)];
		// A v1 signature must never be honoured: its keys embed positional
		// aliases, so replaying them under v2 would mis-address every chunk.
		assert.strictEqual(isWorkspaceIndexPathSchemeCompatible(multi, 'multi-root-alias-v1:1-app|2-api'), false);
		assert.strictEqual(isWorkspaceIndexPathSchemeCompatible(multi, 'multi-root-alias-v1:2-api|1-app'), false);
		assert.ok(!workspaceIndexPathScheme(multi).startsWith('multi-root-alias-v1:'));
		// A v1 key names a root that no longer exists, so it resolves to nothing
		// instead of silently pointing at the wrong root.
		assert.strictEqual(workspaceIndexUri(multi, '@roots/2-api/src/index.ts'), undefined);
	});

	test('single-root snapshots stay valid and keys are unprefixed', () => {
		const single = [folder('/work/app', 'app', 0)];
		assert.strictEqual(workspaceIndexPathScheme(single), 'single-root-v1');
		assert.strictEqual(workspaceIndexPath(single, URI.file('/work/app/src/index.ts')), 'src/index.ts');
		assert.strictEqual(isWorkspaceIndexPathSchemeCompatible(single, 'single-root-v1'), true);
	});
});
