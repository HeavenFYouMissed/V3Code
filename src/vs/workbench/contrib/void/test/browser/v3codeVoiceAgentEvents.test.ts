/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import {
	answerV3VoiceAgentQuestion,
	classifyV3VoiceFinalOutcome,
	matchV3VoiceQuestionOption,
	parseV3VoiceFinalResult,
	publishV3VoiceAgentEvent,
	registerV3VoiceAgentEventSink,
	registerV3VoiceQuestionAnswerHandler,
	type V3VoiceAgentEvent,
} from '../../browser/v3codeVoiceAgentEvents.js';
import { formatV3VoiceCaptionLines, formatV3VoiceCheckpoint, getV3VoiceByokSetupStep, splitV3VoiceActiveCaptionWord } from '../../browser/v3codeVoiceOrbSurface.js';
import { normalizeV3VoiceInputLevel } from '../../browser/v3codeVoiceRealtimeClient.js';

suite('V Voice agent event bridge', () => {
	test('uses the BYOK key as the complete Voice setup gate', () => {
		assert.strictEqual(getV3VoiceByokSetupStep(''), 'api-key');
		assert.strictEqual(getV3VoiceByokSetupStep('   '), 'api-key');
		assert.strictEqual(getV3VoiceByokSetupStep('  sk-proj-configured  '), 'ready');
	});

	test('formats task checkpoints as compact plain speech text', () => {
		assert.strictEqual(
			formatV3VoiceCheckpoint('Build complete — **What you got** — [five files](https://example.test) and `npm test`.'),
			'Build complete — What you got — five files and npm test.',
		);
		assert.strictEqual(formatV3VoiceCheckpoint('abcdef', 5), 'abcd…');
	});

	test('does not call a completed preview handoff blocked', () => {
		assert.strictEqual(
			classifyV3VoiceFinalOutcome("I'm done — the browser is open and idle, waiting on you."),
			'completed',
		);
		assert.strictEqual(classifyV3VoiceFinalOutcome('I cannot continue without your credential.'), 'blocked');
		assert.strictEqual(classifyV3VoiceFinalOutcome('The plan is ready.', true), 'question');
		assert.strictEqual(
			classifyV3VoiceFinalOutcome('Computer use is blocked by Accessibility permission. There is no further action I can take.'),
			'blocked',
		);
	});

	test('prefers and strips the structured final outcome control line', () => {
		assert.deepStrictEqual(
			parseV3VoiceFinalResult('Accessibility permission is still required.\n\n<!-- V3VOICE_OUTCOME: blocked — needs macOS approval -->'),
			{
				text: 'Accessibility permission is still required.',
				outcome: 'blocked',
				structured: true,
			},
		);
		assert.strictEqual(parseV3VoiceFinalResult('Done.\nOUTCOME: completed').outcome, 'completed');
	});

	test('breaks the live voice transcript into a small readable rain stack', () => {
		assert.deepStrictEqual(
			formatV3VoiceCaptionLines('First stage is complete. The agent is now checking the browser. Final verification comes next.', 5, 48),
			['First stage is complete.', 'The agent is now checking the browser.', 'Final verification comes next.'],
		);
		assert.deepStrictEqual(formatV3VoiceCaptionLines('one two three four five six', 2, 10), ['three four', 'five six']);
	});

	test('isolates the live trailing word without changing the completed caption', () => {
		assert.deepStrictEqual(splitV3VoiceActiveCaptionWord('V is checking now.'), { before: 'V is checking ', active: 'now.' });
		assert.deepStrictEqual(splitV3VoiceActiveCaptionWord('Listening'), { before: '', active: 'Listening' });
	});

	test('normalizes quiet and loud microphone energy without inventing a VAD threshold', () => {
		assert.strictEqual(normalizeV3VoiceInputLevel(0), 0);
		assert.ok(normalizeV3VoiceInputLevel(0.002) < normalizeV3VoiceInputLevel(0.02));
		assert.strictEqual(normalizeV3VoiceInputLevel(10), 1);
	});

	test('keeps task events isolated to the selected chat session', () => {
		const first: V3VoiceAgentEvent[] = [];
		const second: V3VoiceAgentEvent[] = [];
		const firstBinding = registerV3VoiceAgentEventSink('session:first', event => first.push(event));
		const secondBinding = registerV3VoiceAgentEventSink('session:second', event => second.push(event));

		publishV3VoiceAgentEvent({
			kind: 'plan',
			sessionResource: 'session:first',
			todos: [{ id: '1', content: 'Trace the path', status: 'completed' }],
			merge: false,
		});

		assert.strictEqual(first.length, 1);
		assert.strictEqual(second.length, 0);
		firstBinding.dispose();
		secondBinding.dispose();
	});

	test('routes one spoken choice to the pending native question and cleans up', () => {
		let received = '';
		const binding = registerV3VoiceQuestionAnswerHandler('session:question', choice => {
			received = choice;
			return { accepted: true, message: 'accepted' };
		});

		assert.deepStrictEqual(answerV3VoiceAgentQuestion('session:question', 'Use the safer option', 'voice'), { accepted: true, message: 'accepted', source: 'voice' });
		assert.strictEqual(received, 'Use the safer option');

		binding.dispose();
		assert.deepStrictEqual(answerV3VoiceAgentQuestion('session:question', 'again', 'click'), {
			accepted: false,
			message: 'The main agent is not waiting for a decision.',
			source: 'click',
		});
	});

	test('matches spoken A/B and refuses ambiguous fuzzy choices', () => {
		assert.strictEqual(matchV3VoiceQuestionOption('A', ['Use editor tools', 'Fix permissions']), 0);
		assert.strictEqual(matchV3VoiceQuestionOption('the second', ['Use editor tools', 'Fix permissions']), 1);
		assert.strictEqual(matchV3VoiceQuestionOption('yes', ['Yes', 'No']), 0);
		assert.strictEqual(matchV3VoiceQuestionOption('use', ['Use editor tools', 'Use browser tools']), undefined);
	});

	test('never sends one chat session answer to another waiting agent', () => {
		const received: string[] = [];
		const firstBinding = registerV3VoiceQuestionAnswerHandler('session:first', choice => {
			received.push(`first:${choice}`);
			return { accepted: true, message: 'first accepted' };
		});
		const secondBinding = registerV3VoiceQuestionAnswerHandler('session:second', choice => {
			received.push(`second:${choice}`);
			return { accepted: true, message: 'second accepted' };
		});

		assert.strictEqual(answerV3VoiceAgentQuestion('session:first', 'Option A').message, 'first accepted');
		assert.deepStrictEqual(received, ['first:Option A']);

		firstBinding.dispose();
		secondBinding.dispose();
	});
});
