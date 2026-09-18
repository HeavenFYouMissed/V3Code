/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Handshake only: no prompt, install, sign-in or model request. Isolated CLI state.
const executable = process.argv[2];
if (!executable) { throw new Error('Pass the absolute path of an installed terminal executable.'); }
const scratch = await mkdtemp(join(tmpdir(), 'v3-terminal-acp-smoke-'));
const child = spawn(executable, ['acp'], { cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'], env: {
	...process.env, XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'data'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state'),
} });
let output = '';
let stderr = '';
child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
const response = new Promise((resolve, reject) => {
	child.on('error', reject);
	child.on('exit', code => reject(new Error(`Terminal exited before initialize: ${code}. ${stderr}`)));
	child.stdout.on('data', data => {
		output += data;
		let newline;
		while ((newline = output.indexOf('\n')) >= 0) {
			const line = output.slice(0, newline); output = output.slice(newline + 1);
			try { const message = JSON.parse(line); if (message.id === 1) { resolve(message); } } catch { /* non-protocol output is not success */ }
		}
	});
});
const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
try {
	child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'v3code-smoke', version: '1' } } }) + '\n');
	const reply = await response;
	if (reply.error || reply.result?.protocolVersion !== 1) { throw new Error(`Handshake failed: ${JSON.stringify(reply)}`); }
	console.log(JSON.stringify({ protocolVersion: reply.result.protocolVersion, capabilities: reply.result.agentCapabilities, scratch }));
} finally {
	clearTimeout(timer);
	child.stdin.end();
	child.kill('SIGTERM');
	const force = setTimeout(() => child.kill('SIGKILL'), 3000);
	force.unref();
}
