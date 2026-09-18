/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isV3CodeLoopbackSelfDefinition, v3codeConfigToServerDefinition } from '../../common/discovery/v3codeMcpDiscoveryAdapter.js';
import { McpServerTransportType } from '../../common/mcpTypes.js';

suite('V3Code MCP discovery adapter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves HTTP authorization headers without inventing OAuth', async () => {
		const definitions = await v3codeConfigToServerDefinition('v3code.local', VSBuffer.fromString(JSON.stringify({
			mcpServers: {
				memory: {
					url: 'http://127.0.0.1:7333/mcp',
					headers: { Authorization: 'Bearer local-token', 'X-Test': 'yes' },
				},
			},
		})), URI.file('/workspace'));

		assert.strictEqual(definitions?.length, 1);
		const launch = definitions?.[0].launch;
		assert.strictEqual(launch?.type, McpServerTransportType.HTTP);
		if (launch?.type !== McpServerTransportType.HTTP) { return; }
		assert.deepStrictEqual(launch.headers, [['Authorization', 'Bearer local-token'], ['X-Test', 'yes']]);
		assert.strictEqual(launch.oauth, undefined);
	});

	test('preserves stdio cwd and environment', async () => {
		const cwd = URI.file('/workspace');
		const definitions = await v3codeConfigToServerDefinition('v3code.local', VSBuffer.fromString(JSON.stringify({
			mcpServers: {
				filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: { SAFE: '1' } },
			},
		})), cwd);

		const launch = definitions?.[0].launch;
		assert.strictEqual(launch?.type, McpServerTransportType.Stdio);
		if (launch?.type !== McpServerTransportType.Stdio) { return; }
		assert.strictEqual(launch.cwd, cwd.fsPath);
		assert.deepStrictEqual(launch.args, ['-y', '@modelcontextprotocol/server-filesystem']);
		assert.deepStrictEqual(launch.env, { SAFE: '1' });
	});

	test('ignores malformed and empty configs', async () => {
		assert.strictEqual(await v3codeConfigToServerDefinition('v3code.local', VSBuffer.fromString('{bad')), undefined);
		assert.strictEqual(await v3codeConfigToServerDefinition('v3code.local', VSBuffer.fromString('{}')), undefined);
	});

	test('tolerates trailing commas and comments instead of vaporizing every server', async () => {
		const contents = VSBuffer.fromString([
			'{',
			'	// hand-edited config',
			'	"mcpServers": {',
			'		"example": { "url": "https://mcp.example.com/mcp" },',
			'	},',
			'}',
		].join('\n'));
		const definitions = await v3codeConfigToServerDefinition('v3code.local', contents);
		assert.strictEqual(definitions?.length, 1);
		assert.strictEqual(definitions[0].label, 'example');
	});

	test('recognizes only V3Code self-connections on loopback', async () => {
		const selfOnly = await v3codeConfigToServerDefinition('workspace', VSBuffer.fromString(JSON.stringify({
			mcpServers: { v3code: { url: 'http://127.0.0.1:7333/mcp' } },
		})));
		assert.deepStrictEqual(selfOnly, []);

		const definitions = await v3codeConfigToServerDefinition('workspace', VSBuffer.fromString(JSON.stringify({
			mcpServers: {
				localDatabase: { url: 'http://127.0.0.1:9000/mcp' },
				remoteV3Code: { url: 'https://memory.v3code.dev/mcp' },
			},
		})));
		assert.strictEqual(definitions?.length, 2);
		assert.strictEqual(isV3CodeLoopbackSelfDefinition(definitions![0]), false);
		assert.strictEqual(isV3CodeLoopbackSelfDefinition(definitions![1]), false);
	});
});
