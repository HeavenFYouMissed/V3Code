/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getExternalAgentSessionIcon } from '../../browser/agentSessions/agentSessions.js';

suite('External agent session icons', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('provider identity and session type select the same mark', () => {
		for (const provider of ['acp-claude-acp', 'acp-grok-build', 'acp-github-copilot-cli', 'acp-gemini', 'acp-codex-acp']) {
			assert.ok(getExternalAgentSessionIcon(provider));
			assert.strictEqual(getExternalAgentSessionIcon(provider), getExternalAgentSessionIcon(`agent-host-${provider}`));
		}
	});

	test('different providers keep distinct recognizable marks', () => {
		const ids = ['acp-claude-acp', 'acp-grok-build', 'acp-github-copilot-cli', 'acp-gemini'].map(provider => getExternalAgentSessionIcon(provider)?.id);
		assert.strictEqual(new Set(ids).size, ids.length);
	});

	test('unknown and local providers retain the caller fallback', () => {
		assert.strictEqual(getExternalAgentSessionIcon('acp-fixture'), undefined);
		assert.strictEqual(getExternalAgentSessionIcon('local'), undefined);
	});
});
