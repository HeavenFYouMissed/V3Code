/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { buildV3VoiceSessionConfig, V3_VOICE_BYOK_MODEL, V3_VOICE_BYOK_VOICE } from '../../common/v3codeVoiceSessionConfig.js';

suite('V3 Voice BYOK session contract', () => {
	test('gives BYOK voice a local and user-funded routing contract', () => {
		const session = buildV3VoiceSessionConfig();
		assert.strictEqual(session.type, 'realtime');
		assert.strictEqual(session.model, V3_VOICE_BYOK_MODEL);
		assert.deepStrictEqual(session.output_modalities, ['audio']);
		assert.strictEqual(session.audio.output.voice, V3_VOICE_BYOK_VOICE);
		assert.strictEqual(session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
		assert.strictEqual(session.audio.input.turn_detection.eagerness, 'low');
		assert.strictEqual(session.audio.input.turn_detection.create_response, true);
		assert.strictEqual(session.audio.input.turn_detection.interrupt_response, true);
		assert.match(session.instructions, /consult_v_operator/);
		assert.match(session.instructions, /delegate_to_main_agent/);
		assert.doesNotMatch(session.instructions, /consult_v_brain/);
		assert.deepStrictEqual(
			session.tools.map(tool => tool.name),
			['consult_v_operator', 'remember_voice_context', 'delegate_to_main_agent', 'answer_main_agent_question', 'get_main_agent_status'],
		);
	});
});
