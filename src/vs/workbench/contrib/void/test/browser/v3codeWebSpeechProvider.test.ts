/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TextToSpeechStatus } from '../../../speech/common/speechService.js';
import { WebTextToSpeechSession } from '../../browser/v3codeWebSpeechProvider.js';

suite('V3Code system text to speech', () => {
	test('speaks a chat chunk and balances the speech lifecycle', async () => {
		const synthesis = window.speechSynthesis;
		const originalSpeak = synthesis.speak;
		const originalGetVoices = synthesis.getVoices;
		let spoken: SpeechSynthesisUtterance | undefined;
		Object.defineProperty(synthesis, 'getVoices', {
			configurable: true,
			value: () => [],
		});
		Object.defineProperty(synthesis, 'speak', {
			configurable: true,
			value: (utterance: SpeechSynthesisUtterance) => {
				spoken = utterance;
				utterance.onstart?.call(utterance, {} as SpeechSynthesisEvent);
				utterance.onend?.call(utterance, {} as SpeechSynthesisEvent);
			},
		});

		try {
			const session = new WebTextToSpeechSession(CancellationToken.None, 'en-US', new NullLogService());
			const statuses: TextToSpeechStatus[] = [];
			const listener = session.onDidChange(event => statuses.push(event.status));

			await session.synthesize(' Read this answer. ');

			assert.strictEqual(spoken?.text, 'Read this answer.');
			assert.strictEqual(spoken?.lang, 'en-US');
			assert.strictEqual(spoken?.voice, null);
			assert.deepStrictEqual(statuses, [TextToSpeechStatus.Started, TextToSpeechStatus.Stopped]);
			listener.dispose();
			session.dispose();
		} finally {
			Object.defineProperty(synthesis, 'speak', { configurable: true, value: originalSpeak });
			Object.defineProperty(synthesis, 'getVoices', { configurable: true, value: originalGetVoices });
		}
	});

	test('cancels an active platform utterance and resolves the pending chat chunk', async () => {
		const synthesis = window.speechSynthesis;
		const originalSpeak = synthesis.speak;
		const originalCancel = synthesis.cancel;
		const originalGetVoices = synthesis.getVoices;
		let cancelCalls = 0;
		Object.defineProperty(synthesis, 'getVoices', { configurable: true, value: () => [] });
		Object.defineProperty(synthesis, 'speak', {
			configurable: true,
			value: (utterance: SpeechSynthesisUtterance) => utterance.onstart?.call(utterance, {} as SpeechSynthesisEvent),
		});
		Object.defineProperty(synthesis, 'cancel', {
			configurable: true,
			value: () => { cancelCalls++; },
		});

		const cancellation = new CancellationTokenSource();
		try {
			const session = new WebTextToSpeechSession(cancellation.token, 'en-US', new NullLogService());
			const pending = session.synthesize('This sentence is still speaking.');
			cancellation.cancel();
			await pending;

			assert.strictEqual(cancelCalls, 1);
			session.dispose();
		} finally {
			cancellation.dispose();
			Object.defineProperty(synthesis, 'speak', { configurable: true, value: originalSpeak });
			Object.defineProperty(synthesis, 'cancel', { configurable: true, value: originalCancel });
			Object.defineProperty(synthesis, 'getVoices', { configurable: true, value: originalGetVoices });
		}
	});
});
