/*---------------------------------------------------------------------------------------------
 *  Copyright (c) V3Code. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadOrCreateV3codeMcpToken, matchesV3codeMcpAuthorization } from '../../electron-main/v3codeMcpAuth.js';
import { normalizeV3VoiceOfferSdp } from '../../electron-main/v3codeVoiceSessionChannel.js';

suite('V3Code MCP server authentication', () => {
	const token = '0123456789abcdef0123456789abcdef0123456789abcdef';

	test('accepts the exact bearer token', () => {
		assert.strictEqual(matchesV3codeMcpAuthorization(`Bearer ${token}`, token), true);
	});

	test('rejects missing, malformed, partial, and incorrect credentials', () => {
		assert.strictEqual(matchesV3codeMcpAuthorization(undefined, token), false);
		assert.strictEqual(matchesV3codeMcpAuthorization('Bearer', token), false);
		assert.strictEqual(matchesV3codeMcpAuthorization(token, token), false);
		assert.strictEqual(matchesV3codeMcpAuthorization(`bearer ${token}`, token), false);
		assert.strictEqual(matchesV3codeMcpAuthorization(`Bearer ${token.slice(0, -1)}`, token), false);
		assert.strictEqual(matchesV3codeMcpAuthorization(`Bearer ${'f'.repeat(token.length)}`, token), false);
	});

	test('creates one stable owner-only token across restarts', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3code-mcp-token-'));
		const tokenFile = path.join(dir, 'nested', 'mcp-token');
		try {
			const first = loadOrCreateV3codeMcpToken(tokenFile);
			const second = loadOrCreateV3codeMcpToken(tokenFile);
			assert.match(first, /^[a-f0-9]{48}$/);
			assert.strictEqual(second, first);
			assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), first);
			if (process.platform !== 'win32') {
				assert.strictEqual(fs.statSync(tokenFile).mode & 0o777, 0o600);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('self-heals a malformed persistent token without blocking URL-only MCP', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3code-mcp-token-invalid-'));
		const tokenFile = path.join(dir, 'mcp-token');
		try {
			fs.writeFileSync(tokenFile, 'not-a-token', { mode: 0o600 });
			const repaired = loadOrCreateV3codeMcpToken(tokenFile);
			assert.match(repaired, /^[a-f0-9]{48}$/);
			assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), repaired);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('normalizes a WebRTC offer without changing its payload', () => {
		assert.strictEqual(normalizeV3VoiceOfferSdp('\n\tv=0\r\no=- 1 2 IN IP4 127.0.0.1\n\n'), 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n');
		assert.strictEqual(normalizeV3VoiceOfferSdp('  \r\n'), '');
	});
});
