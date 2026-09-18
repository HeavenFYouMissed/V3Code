/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { searchSettings } from '../../browser/react/src/void-settings-tsx/settingsSearchIndex.js';

suite('V3Code feedback discoverability', () => {
	test('finds the feedback action from Settings search', () => {
		assert.ok(searchSettings('feedback').some(hit => hit.id === 'feedback.send' && hit.tab === 'feedback'));
	});

	test('finds the issue report action from Settings search', () => {
		assert.ok(searchSettings('report issue').some(hit => hit.id === 'feedback.report' && hit.tab === 'feedback'));
	});

	test('finds the Agents beta vote from Settings search', () => {
		assert.ok(searchSettings('agents vote').some(hit => hit.id === 'feedback.agentsVote' && hit.tab === 'feedback'));
	});

	test('finds the remotely controlled Status & Updates board', () => {
		assert.ok(searchSettings('live status updates').some(hit => hit.id === 'feedback.status' && hit.tab === 'feedback'));
	});
});
