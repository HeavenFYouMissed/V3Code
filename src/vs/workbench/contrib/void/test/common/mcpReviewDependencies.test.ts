/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { runGetFileDependencies } from '../../browser/contextBridge/contextBridgeTools.js';
import { buildV3codeMcpbManifest } from '../../common/mcpExpose/mcpExposeTypes.js';

suite('MCP review dependency and extension contracts', () => {
	test('missing file errors before scanning the project', async () => {
		const adapter = { resolveFile: () => URI.file('/fixture/missing.ts') } as unknown as Parameters<typeof runGetFileDependencies>[0];
		const files = { exists: async () => false } as unknown as Parameters<typeof runGetFileDependencies>[1];
		const workspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('/fixture') }] }) } as unknown as Parameters<typeof runGetFileDependencies>[2];
		await assert.rejects(runGetFileDependencies(adapter, files, workspace, { filePath: 'missing.ts' }), /File not found/);
	});
	test('no workspace is not a successful empty dependency graph', async () => {
		const workspace = { getWorkspace: () => ({ folders: [] }) } as unknown as Parameters<typeof runGetFileDependencies>[2];
		await assert.rejects(runGetFileDependencies({} as Parameters<typeof runGetFileDependencies>[0], {} as Parameters<typeof runGetFileDependencies>[1], workspace, { filePath: 'x.ts' }), /No workspace/);
	});
	test('extension discovers live tools and runs its packaged connector copy', () => {
		const manifest = JSON.parse(buildV3codeMcpbManifest('1.2.3'));
		assert.strictEqual(manifest.tools_generated, true);
		assert.strictEqual(manifest.server.entry_point, 'server/v3code-mcp-bridge.mjs');
		assert.deepStrictEqual(manifest.server.mcp_config.args, ['${__dirname}/server/v3code-mcp-bridge.mjs']);
	});
});
