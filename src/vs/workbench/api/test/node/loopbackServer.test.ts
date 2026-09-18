/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as httpTypes from 'http';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogger } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { LoopbackAuthServer } from '../../node/loopbackServer.js';

// V3Code: exercises the hardened port behavior with injected test ports —
// never binds the real registered auth flow port in CI.

const appUri = URI.parse('test-app://dynamicauthprovider/example.com/redirect?nonce=abc');

function makeServer(port: number): LoopbackAuthServer {
	return new LoopbackAuthServer(new NullLogger(), appUri, 'Test App', port);
}

async function freePort(): Promise<number> {
	const http = await import('http');
	return new Promise<number>((resolve, reject) => {
		const probe: httpTypes.Server = http.createServer();
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			const port = typeof address === 'object' && address !== null ? address.port : undefined;
			probe.close(() => port !== undefined ? resolve(port) : reject(new Error('no port')));
		});
	});
}

suite('LoopbackAuthServer (V3Code hardening)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('binds the preferred port and advertises exactly that redirect URI', async () => {
		const port = await freePort();
		const server = makeServer(port);
		await server.start();
		try {
			assert.strictEqual(server.redirectUri, `http://127.0.0.1:${port}/`);
			assert.strictEqual(server.usedFallbackPort, false);
		} finally {
			await server.stop();
		}
	});

	test('retries a briefly-busy preferred port instead of falling back', async () => {
		const port = await freePort();
		const blocker = makeServer(port);
		await blocker.start();

		const server = makeServer(port);
		const started = server.start();
		// Release the port inside the retry window — the second server must land on it.
		setTimeout(() => void blocker.stop(), 600);
		await started;
		try {
			assert.strictEqual(server.usedFallbackPort, false, 'must not fall back while retries can still win the port');
			assert.strictEqual(server.redirectUri, `http://127.0.0.1:${port}/`);
		} finally {
			await server.stop();
		}
	});

	test('a persistently busy port falls back loudly with usedFallbackPort set', async function () {
		this.timeout(10000);
		const port = await freePort();
		const blocker = makeServer(port);
		await blocker.start();

		const server = makeServer(port);
		try {
			await server.start();
			assert.strictEqual(server.usedFallbackPort, true, 'fallback must be visible to the caller, never silent');
			assert.notStrictEqual(server.redirectUri, `http://127.0.0.1:${port}/`);
		} finally {
			await server.stop();
			await blocker.stop();
		}
	});

	test('rejects a callback whose state does not match', async () => {
		const port = await freePort();
		const server = makeServer(port);
		await server.start();
		try {
			const resultPromise = server.waitForOAuthResponse();
			const http = await import('http');
			await new Promise<void>((resolve, reject) => {
				http.get(`http://127.0.0.1:${port}/?code=abc&state=WRONG`, res => {
					res.resume();
					resolve();
				}).on('error', reject);
			});
			await assert.rejects(resultPromise, /State does not match/);
		} finally {
			await server.stop();
		}
	});

	test('accepts a matching state and resolves the code', async () => {
		const port = await freePort();
		const server = makeServer(port);
		await server.start();
		try {
			const resultPromise = server.waitForOAuthResponse();
			const http = await import('http');
			await new Promise<void>((resolve, reject) => {
				http.get(`http://127.0.0.1:${port}/?code=abc123&state=${encodeURIComponent(server.state)}`, res => {
					res.resume();
					resolve();
				}).on('error', reject);
			});
			const result = await resultPromise;
			assert.strictEqual(result.code, 'abc123');
		} finally {
			await server.stop();
		}
	});
});
