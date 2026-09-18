/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getExternalAgentPickerItems } from '../../common/externalAgentPickerItems.js';
import type { IExternalAgentsState } from '../../common/externalAgentsService.js';

suite('External agent composer picker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	function state(description = 'Ready'): IExternalAgentsState {
		return {
			catalogue: { version: 1, registryUrl: '', agents: [
				{ id: 'fixture', name: 'Fixture Agent', source: 'custom', distribution: { command: { command: 'fixture' } } },
				{ id: 'disabled', name: 'Disabled Agent', source: 'custom', distribution: {} },
			], enabledIds: ['fixture'] },
			hosted: new Map([['fixture', { provider: 'acp-fixture', displayName: 'Fixture Agent', description, modelCount: 0 }]]),
			hostEnabled: true, refreshing: false, lastRefreshAt: undefined, lastError: undefined,
		};
	}
	test('only explicit enabled agents appear and selection uses provider identity', () => {
		const items = getExternalAgentPickerItems(state(), 'agent-host-acp-fixture');
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].checked, true);
		assert.strictEqual(items[0].enabled, true);
		assert.strictEqual(items[0].name, 'Fixture Agent');
		assert.strictEqual(getExternalAgentPickerItems(state(), 'local')[0].checked, false);
	});
	test('host off and pending registration remain visible with a reason', () => {
		for (const input of [{ ...state(), hostEnabled: false }, { ...state(), hosted: new Map() }]) {
			const item = getExternalAgentPickerItems(input, 'local')[0];
			assert.strictEqual(item.enabled, false);
			assert.ok(item.reason);
		}
	});
	test('unavailable launch forms cannot be selected', () => {
		for (const reason of ['Command not found: fixture', 'No launch command for this platform']) {
			const item = getExternalAgentPickerItems(state(reason), 'local')[0];
			assert.strictEqual(item.enabled, false);
			assert.strictEqual(item.reason, reason);
		}
	});
	test('an empty catalogue produces no external rows', () => {
		assert.deepStrictEqual(getExternalAgentPickerItems({ ...state(), catalogue: { ...state().catalogue, enabledIds: [] } }, 'local'), []);
	});
});
