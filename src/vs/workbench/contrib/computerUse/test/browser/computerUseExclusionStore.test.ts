/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ComputerUseExclusionRecord,
	ComputerUseExclusionStore,
	IComputerUseExclusionStorage,
} from '../../browser/computerUseExclusionStore.js';

/** In-memory storage, so the semantics are exercised with no storage service and no async. */
class TestStorage implements IComputerUseExclusionStorage {
	records: ComputerUseExclusionRecord[] = [];
	writes = 0;

	read(): readonly ComputerUseExclusionRecord[] {
		return this.records;
	}

	write(records: readonly ComputerUseExclusionRecord[]): void {
		this.records = [...records];
		this.writes++;
	}
}

suite('ComputerUse - exclusion store', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(seed: ComputerUseExclusionRecord[] = []): { subject: ComputerUseExclusionStore; storage: TestStorage } {
		const storage = new TestStorage();
		storage.records = [...seed];
		const subject = store.add(new ComputerUseExclusionStore(storage));
		return { subject, storage };
	}

	test('permits everything by default — an empty list is not an empty allow-list', () => {
		// The single most important property. This replaced an allow-list, and the whole point of the change
		// is that the empty state means "go ahead" rather than "nothing is approved". If this ever inverts,
		// computer use silently stops working for every application.
		const { subject } = create();
		assert.deepStrictEqual(
			[
				subject.isExcluded('com.apple.Terminal'),
				subject.isExcluded('com.example.Anything'),
				subject.isExcluded(''),
				subject.list(),
			],
			[false, false, false, []],
		);
	});

	test('excludes and re-includes one application', () => {
		const { subject } = create();
		subject.exclude({ id: 'com.1password.1password', name: '1Password' });
		const excludedAfterAdd = subject.isExcluded('com.1password.1password');
		const removed = subject.include('com.1password.1password');
		assert.deepStrictEqual(
			[excludedAfterAdd, removed, subject.isExcluded('com.1password.1password'), subject.list().length],
			[true, true, false, 0],
		);
	});

	test('matches identifiers case- and whitespace-insensitively', () => {
		// macOS bundle ids and Windows executable names disagree about case, and an id arriving from the
		// helper can carry padding. A near-miss here would silently fail to honour an exclusion.
		const { subject } = create();
		subject.exclude({ id: 'COM.Apple.Terminal', name: 'Terminal' });
		assert.deepStrictEqual(
			[
				subject.isExcluded('com.apple.terminal'),
				subject.isExcluded('  com.apple.Terminal  '),
				subject.isExcluded('com.apple.TerminalX'),
			],
			[true, true, false],
		);
	});

	test('excluding twice replaces rather than duplicating', () => {
		const { subject } = create();
		subject.exclude({ id: 'com.example.App', name: 'Old name' });
		subject.exclude({ id: 'com.example.app', name: 'New name' });
		assert.deepStrictEqual(
			subject.list().map(record => record.appName),
			['New name'],
		);
	});

	test('include() reports whether anything was actually removed, and never writes when not', () => {
		const { subject, storage } = create();
		subject.exclude({ id: 'com.example.App', name: 'App' });
		const writesAfterExclude = storage.writes;
		assert.deepStrictEqual(
			[subject.include('com.other.App'), storage.writes === writesAfterExclude],
			[false, true],
		);
	});

	test('clear() empties the list and is a no-op when already empty', () => {
		const { subject, storage } = create();
		subject.exclude({ id: 'a', name: 'A' });
		subject.exclude({ id: 'b', name: 'B' });
		subject.clear();
		const writesAfterClear = storage.writes;
		subject.clear();
		assert.deepStrictEqual(
			[subject.list(), storage.writes === writesAfterClear],
			[[], true],
		);
	});

	test('hydrates from storage and lists most recent first', () => {
		const { subject } = create([
			{ appId: 'old', appName: 'Old', excludedAt: 1_000 },
			{ appId: 'new', appName: 'New', excludedAt: 9_000 },
		]);
		assert.deepStrictEqual(
			subject.list().map(record => record.appId),
			['new', 'old'],
		);
	});

	test('fires a change event on every mutation and only on mutations', () => {
		const { subject } = create();
		let fired = 0;
		store.add(subject.onDidChangeExclusions(() => { fired++; }));
		subject.exclude({ id: 'a', name: 'A' });   // 1
		subject.include('a');                       // 2
		subject.include('a');                       // no-op
		subject.clear();                            // no-op, already empty
		assert.strictEqual(fired, 2);
	});
});
