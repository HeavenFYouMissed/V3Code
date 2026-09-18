/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isV3CodeAgentIdentity, isV3TranscriptModeName, isV3TranscriptResponse, V3_TRANSCRIPT_MODE_NAMES } from '../../browser/v3TranscriptResponse.js';

suite('V3Code transcript response identity', () => {
	const byMode = (modeName: string) => ({ model: { request: { modeInfo: { modeName } } } });
	const byAgent = (agent: object) => ({ agent });

	test('every mode this editor owns counts as a transcript response, whatever the case', () => {
		for (const modeName of V3_TRANSCRIPT_MODE_NAMES) {
			assert.strictEqual(isV3TranscriptResponse(byMode(modeName)), true, `${modeName} should be a transcript response`);
			assert.strictEqual(isV3TranscriptResponse(byMode(modeName.toUpperCase())), true, `${modeName} upper-cased should be too`);
		}
	});

	test('a response from outside this editor is never a transcript response', () => {
		assert.strictEqual(isV3TranscriptResponse(byMode('copilot-agent')), false);
		assert.strictEqual(isV3TranscriptResponse(byAgent({ id: 'github.copilot', name: 'GitHub Copilot' })), false);
		assert.strictEqual(isV3TranscriptResponse(undefined), false);
		assert.strictEqual(isV3TranscriptResponse(null), false);
		assert.strictEqual(isV3TranscriptResponse('agent'), false);
		assert.strictEqual(isV3TranscriptResponse({}), false);
	});

	test('agent identity alone is enough, so a row that has not attached its mode still counts', () => {
		assert.strictEqual(isV3TranscriptResponse({ agent: { id: 'v3code.agent' } }), true);
		assert.strictEqual(isV3TranscriptResponse({ agent: { extensionPublisherId: 'v3code' } }), true);
		assert.strictEqual(isV3TranscriptResponse({ agent: { name: 'V' } }), true);
	});

	test('an unattached row is not cached as a negative', () => {
		// Caching a negative here would permanently deny the craft to a row that simply had not
		// attached yet — the exact failure that would look like "the transcript randomly stopped".
		const element: { model?: { request?: { modeInfo: { modeName: string } } } } = {};
		assert.strictEqual(isV3TranscriptResponse(element), false);
		element.model = { request: { modeInfo: { modeName: 'agent' } } };
		assert.strictEqual(isV3TranscriptResponse(element), true, 'the same row must be picked up once its mode attaches');
	});

	test('agent identity is precise about who belongs to this editor', () => {
		assert.strictEqual(isV3CodeAgentIdentity(undefined), false);
		assert.strictEqual(isV3CodeAgentIdentity({}), false);
		assert.strictEqual(isV3CodeAgentIdentity({ id: 'v3code.agent' }), true);
		assert.strictEqual(isV3CodeAgentIdentity({ id: 'v3code.explore' }), true);
		assert.strictEqual(isV3CodeAgentIdentity({ id: 'other.agent' }), false);
		assert.strictEqual(isV3CodeAgentIdentity({ name: 'Something Else' }), false);
	});

	test('mode-name matching ignores an empty or missing name', () => {
		assert.strictEqual(isV3TranscriptModeName('AGENT'), true);
		assert.strictEqual(isV3TranscriptModeName(''), false);
		assert.strictEqual(isV3TranscriptModeName(undefined), false);
	});
});
