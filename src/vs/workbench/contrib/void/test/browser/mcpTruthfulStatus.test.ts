/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isMcpServerConnected, isMcpServerUsable, type MCPServer } from '../../common/mcpServiceTypes.js';

const server = (status: 'success' | 'offline' | 'ready', toolCount = 0): MCPServer => ({
	status,
	tools: Array.from({ length: toolCount }, (_, index) => ({
		name: `tool-${index}`,
		description: '',
		inputSchema: {},
	})),
});

suite('V3Code MCP truthful connection state', () => {
	test('requires both a successful connection and enabled server', () => {
		assert.strictEqual(isMcpServerConnected(server('success'), true), true);
		assert.strictEqual(isMcpServerConnected(server('success'), false), false);
		assert.strictEqual(isMcpServerConnected(server('offline'), true), false);
		assert.strictEqual(isMcpServerConnected(undefined, true), false);
	});

	test('requires authenticated remote servers to expose a usable tool', () => {
		assert.strictEqual(isMcpServerUsable(server('success'), true, true), false);
		assert.strictEqual(isMcpServerUsable(server('success', 1), true, true), true);
		assert.strictEqual(isMcpServerUsable(server('success'), true, false), true);
	});

	test('ready (stopped with cached tools) is honest: usable on demand, but never Connected', () => {
		assert.strictEqual(isMcpServerConnected(server('ready', 3), true), false);
		assert.strictEqual(isMcpServerUsable(server('ready', 3), true, true), false);
	});
});
