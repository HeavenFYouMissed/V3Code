/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert'
import { URI } from '../../../../../base/common/uri.js'
import { planProjectWorkspaceChange } from '../../common/projectWorkspace.js'

suite('V3Code project workspace changes', () => {
	const a = URI.file('/projects/a')
	const b = URI.file('/projects/b')
	const c = URI.file('/projects/c')

	test('replace removes every previous root', () => {
		const plan = planProjectWorkspaceChange([a, b], c, 'replace')
		assert.strictEqual(plan.kind, 'replace')
		assert.deepStrictEqual(plan.folders.map(folder => folder.fsPath), [c.fsPath])
	})

	test('replace removes unrelated roots even when the target is already attached', () => {
		const plan = planProjectWorkspaceChange([a, b], b, 'replace')
		assert.strictEqual(plan.kind, 'replace')
		assert.deepStrictEqual(plan.folders.map(folder => folder.fsPath), [b.fsPath])
	})

	test('replace is a no-op only when the target is already exclusive', () => {
		const plan = planProjectWorkspaceChange([b], b, 'replace')
		assert.strictEqual(plan.kind, 'none')
		assert.deepStrictEqual(plan.folders.map(folder => folder.fsPath), [b.fsPath])
	})

	test('add preserves prior roots and does not duplicate an attached target', () => {
		const added = planProjectWorkspaceChange([a], b, 'add')
		assert.strictEqual(added.kind, 'add')
		assert.deepStrictEqual(added.folders.map(folder => folder.fsPath), [a.fsPath, b.fsPath])

		const duplicate = planProjectWorkspaceChange([a, b], b, 'add')
		assert.strictEqual(duplicate.kind, 'none')
		assert.deepStrictEqual(duplicate.folders.map(folder => folder.fsPath), [a.fsPath, b.fsPath])
	})
})
