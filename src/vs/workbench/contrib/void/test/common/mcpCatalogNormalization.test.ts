/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CATALOG, configEntryStrings, findUnresolvedVariables, installEntryForCatalogEntry } from '../../common/mcpCatalog.js';
import { normalizeMcpEntryPlaceholders } from '../../common/mcpPlaceholderNormalization.js';

suite('mcp catalog normalization — unresolved variables', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a bare ${VAR} is flagged', () => {
		assert.deepStrictEqual(findUnresolvedVariables(['Bearer ${API_KEY}']), ['API_KEY']);
	});

	test('the exact published GitHub header that once went over the wire is caught', () => {
		// This literal string reached api.githubcopilot.com verbatim and produced
		// "Authorization header is badly formatted". It must never pass silently.
		assert.deepStrictEqual(
			findUnresolvedVariables(['Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}']),
			['GITHUB_PERSONAL_ACCESS_TOKEN'],
		);
	});

	test('editor-resolvable forms pass: input, env, config, workspaceFolder family', () => {
		assert.deepStrictEqual(findUnresolvedVariables([
			'${input:github_pat}',
			'${env:HOME}/bin',
			'${config:editor.fontSize}',
			'${workspaceFolder}',
			'${workspaceFolderBasename}',
			'${userHome}/x',
			'${pathSeparator}',
			'${cwd}',
		]), []);
	});

	test('workspaceFolder must match exactly — a lookalike is still unresolved', () => {
		assert.deepStrictEqual(findUnresolvedVariables(['${workspaceFolderX}']), ['workspaceFolderX']);
	});

	test('prefix lookalikes of resolvable kinds are unresolved: the colon is required', () => {
		assert.deepStrictEqual(
			findUnresolvedVariables(['${environment}', '${input_token}', '${configuration}', '${commander}', '${inputs}']),
			['commander', 'configuration', 'environment', 'input_token', 'inputs'],
		);
	});

	test('the scoped workspaceFolder form passes', () => {
		assert.deepStrictEqual(findUnresolvedVariables(['${workspaceFolder:api}']), []);
	});

	test('placeholders in header and env KEYS are detected and normalized', () => {
		const strings = configEntryStrings({
			headers: { '${HEADER_NAME}': 'x' },
			env: { '${ENV_NAME}': 'y' },
		});
		assert.deepStrictEqual(findUnresolvedVariables(strings), ['ENV_NAME', 'HEADER_NAME']);

		const { entry } = normalizeMcpEntryPlaceholders({ url: 'https://mcp.example.com/mcp' as never, headers: { '${HEADER_NAME}': 'x' } });
		assert.deepStrictEqual(Object.keys(entry.headers ?? {}), ['${input:HEADER_NAME}']);
	});

	test('duplicates collapse and results sort', () => {
		assert.deepStrictEqual(
			findUnresolvedVariables(['${B_TOKEN} ${A_TOKEN}', 'x ${B_TOKEN}']),
			['A_TOKEN', 'B_TOKEN'],
		);
	});

	test('undefined values and placeholder-free strings produce nothing', () => {
		assert.deepStrictEqual(findUnresolvedVariables([undefined, 'plain', 'https://mcp.example.com/mcp']), []);
	});

	test('configEntryStrings covers every field that can reach the network or a process', () => {
		const strings = configEntryStrings({
			url: 'https://${TENANT}.example.com/mcp',
			headers: { Authorization: 'Bearer ${TOKEN}', Accept: 'application/json' },
			command: 'npx',
			args: ['-y', 'thing', '${workspaceFolder}'],
			env: { API_KEY: '${API_KEY}' },
		});
		assert.deepStrictEqual(findUnresolvedVariables(strings), ['API_KEY', 'TENANT', 'TOKEN']);
	});

	test('declared headers are never double-synthesized: the github entry end-to-end', () => {
		const github = CATALOG.find(e => e.id === 'github');
		assert.ok(github);
		const install = installEntryForCatalogEntry(github);
		assert.ok(install);
		// Exactly the declared Authorization header — no extra synthesized header for the
		// same input, and the placeholder is exactly what the secure-prompt pipeline expects.
		assert.deepStrictEqual(install.headers, { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' });
		assert.deepStrictEqual(
			findUnresolvedVariables(configEntryStrings(install)),
			['GITHUB_PERSONAL_ACCESS_TOKEN'],
		);
	});

	test('configEntryStrings tolerates URL objects and sparse entries', () => {
		const strings = configEntryStrings({ url: new URL('https://mcp.example.com/mcp') });
		assert.deepStrictEqual(findUnresolvedVariables(strings), []);
		assert.deepStrictEqual(findUnresolvedVariables(configEntryStrings({})), []);
	});
});
