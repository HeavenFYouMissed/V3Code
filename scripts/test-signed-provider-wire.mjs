/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { GoogleGenAI } from '@google/genai';

test('SDK preserves signed parts on both sides of an actual HTTP round trip', async () => {
	const parts = [{ functionCall: { name: 'read_file', args: { path: 'fixture.ts' } }, thoughtSignature: 'opaque-fixture-signature' }];
	const bodies = [];
	const server = createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) { body += chunk; }
		bodies.push(JSON.parse(body));
		response.writeHead(200, { 'Content-Type': 'text/event-stream' });
		response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] })}\n\n`);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		const client = new GoogleGenAI({ apiKey: 'test-only', httpOptions: { baseUrl: `http://127.0.0.1:${server.address().port}` } });
		const stream = await client.models.generateContentStream({ model: 'gemini-3.1-pro-preview', contents: 'test' });
		const received = [];
		for await (const chunk of stream) { received.push(...chunk.candidates[0].content.parts); }
		assert.deepEqual(received, parts);
		const next = await client.models.generateContentStream({ model: 'gemini-3.1-pro-preview', contents: [{ role: 'model', parts: received }, { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'ok' } } }] }] });
		for await (const chunk of next) { assert.ok(chunk); }
		assert.deepEqual(bodies[1].contents[0].parts, parts);
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});
