/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { normalizeMcpEntryPlaceholders } from '../../common/mcpPlaceholderNormalization.js';

suite('mcp placeholder normalization', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the published GitHub config: Authorization header becomes a masked input prompt', () => {
		const { entry, inputs, notices } = normalizeMcpEntryPlaceholders({
			url: 'https://api.githubcopilot.com/mcp/' as never,
			headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' },
		});
		assert.strictEqual(entry.headers?.Authorization, 'Bearer ${input:GITHUB_PERSONAL_ACCESS_TOKEN}');
		assert.deepStrictEqual(inputs.map(i => ({ id: i.id, type: i.type, password: i.password })), [
			{ id: 'GITHUB_PERSONAL_ACCESS_TOKEN', type: 'promptString', password: true },
		]);
		assert.ok(notices.length === 1 && notices[0].includes('securely'), 'rewrite is logged without the value');
	});

	test('any header placeholder is credential-shaped, even with an innocent name', () => {
		const { entry, inputs } = normalizeMcpEntryPlaceholders({
			url: 'https://mcp.example.com/mcp' as never,
			headers: { 'X-Tenant': '${TENANT}' },
		});
		assert.strictEqual(entry.headers?.['X-Tenant'], '${input:TENANT}');
		assert.strictEqual(inputs[0].password, true);
	});

	test('catalog metadata wins over the name heuristic in both directions', () => {
		const { entry, inputs } = normalizeMcpEntryPlaceholders(
			{ command: 'npx', args: ['-y', 'thing'], env: { WIDGET_COLOR_TOKEN: '${WIDGET_COLOR_TOKEN}', QUIET_NAME: '${QUIET_NAME}' } },
			[
				{ name: 'WIDGET_COLOR_TOKEN', target: 'env', isSecret: false, description: 'A color, not a credential.' },
				{ name: 'QUIET_NAME', target: 'env', isSecret: true },
			],
		);
		// The declared non-secret is demoted past the TOKEN-name heuristic all the way
		// to environment passthrough; the declared secret is promoted to a masked prompt.
		assert.strictEqual(entry.env?.WIDGET_COLOR_TOKEN, '${env:WIDGET_COLOR_TOKEN}');
		const byId = new Map(inputs.map(i => [i.id, i]));
		assert.strictEqual(byId.get('WIDGET_COLOR_TOKEN'), undefined, 'metadata demotes a TOKEN-named non-secret');
		assert.strictEqual(byId.get('QUIET_NAME')?.password, true, 'metadata promotes an innocent-named secret');
	});

	test('secret-shaped env vars prompt; plain env vars keep environment passthrough', () => {
		const { entry, inputs } = normalizeMcpEntryPlaceholders({
			command: 'npx', args: ['-y', 'thing'],
			env: { API_KEY: '${API_KEY}', LOG_LEVEL: '${LOG_LEVEL}' },
		});
		assert.strictEqual(entry.env?.API_KEY, '${input:API_KEY}');
		assert.strictEqual(entry.env?.LOG_LEVEL, '${env:LOG_LEVEL}');
		assert.deepStrictEqual(inputs.map(i => i.id), ['API_KEY']);
	});

	test('a required env input never silently rides the process environment', () => {
		const { entry } = normalizeMcpEntryPlaceholders(
			{ command: 'npx', args: ['-y', 'thing'], env: { PLAIN_FLAG: '${PLAIN_FLAG}' } },
			[{ name: 'PLAIN_FLAG', target: 'env', isRequired: true }],
		);
		assert.strictEqual(entry.env?.PLAIN_FLAG, '${input:PLAIN_FLAG}');
	});

	test('docker -e passthrough: a required env var absent from env gets injected as a prompt', () => {
		const { entry, inputs } = normalizeMcpEntryPlaceholders(
			{ command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/example/server'] },
			[{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', target: 'env', isSecret: true, isRequired: true }],
		);
		assert.strictEqual(entry.env?.GITHUB_PERSONAL_ACCESS_TOKEN, '${input:GITHUB_PERSONAL_ACCESS_TOKEN}');
		assert.strictEqual(inputs[0].password, true);
		assert.deepStrictEqual(entry.args, ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/example/server'], 'bare arg names are not placeholders');
	});

	test('templated URLs prompt instead of connecting verbatim', () => {
		const { entry, inputs } = normalizeMcpEntryPlaceholders({ url: 'https://${TENANT_HOST}/mcp' as never });
		assert.strictEqual(String(entry.url), 'https://${input:TENANT_HOST}/mcp');
		assert.strictEqual(inputs[0].id, 'TENANT_HOST');
	});

	test('editor-resolvable forms and clean configs pass through untouched', () => {
		const raw = {
			command: 'npx',
			args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'],
			env: { HOME_BIN: '${env:HOME}/bin', PAT: '${input:pat}' },
		};
		const { entry, inputs, notices } = normalizeMcpEntryPlaceholders(raw);
		assert.deepStrictEqual(entry.args, raw.args);
		assert.deepStrictEqual(entry.env, raw.env);
		assert.deepStrictEqual(inputs, []);
		assert.deepStrictEqual(notices, []);
	});

	test('the same variable in two places yields one input definition', () => {
		const { inputs } = normalizeMcpEntryPlaceholders({
			url: 'https://mcp.example.com/mcp' as never,
			headers: { Authorization: 'Bearer ${T}', 'X-Alt': '${T}' },
		});
		assert.strictEqual(inputs.length, 1);
	});

	test('a pre-registered oauth client id survives normalization untouched', () => {
		// The "use your own OAuth app" flow (Slack/Google Drive class) rides the client id
		// through this pipeline into the upstream remote config; dropping it here would
		// silently send the user back to the blind DCR-failure prompt.
		const { entry } = normalizeMcpEntryPlaceholders({
			url: 'https://mcp.slack.com/mcp' as never,
			oauth: { clientId: '1234567890.abcdef' },
		});
		assert.deepStrictEqual(entry.oauth, { clientId: '1234567890.abcdef' });
	});
});
