/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { emptyExternalAgentCatalogue, externalAgentIdFromProvider, externalAgentLaunchEquals, isExternalAgentProvider, isValidExternalAgentId, mapRegistryToExternalAgentEntries, mergeRegistryEntries, normalizeExternalAgentId, parseExternalAgentCatalogue, providerIdForExternalAgent, removeExternalAgent, resolveExternalAgentLaunch, serializeExternalAgentCatalogue, setExternalAgentEnabled, upsertExternalAgent, type IExternalAgentEntry } from '../../../common/externalAgentCatalogue.js';

function entry(id: string, distribution: IExternalAgentEntry['distribution'], source: IExternalAgentEntry['source'] = 'custom', name = id): IExternalAgentEntry {
	return { id, name, source, distribution };
}

suite('External agent catalogue – ids', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ids must be URI-scheme safe', () => {
		assert.ok(isValidExternalAgentId('my-agent'));
		assert.ok(isValidExternalAgentId('agent.v2+beta'));
		assert.ok(!isValidExternalAgentId('My Agent'));
		assert.ok(!isValidExternalAgentId('-leading'));
		assert.ok(!isValidExternalAgentId(''));
		assert.ok(!isValidExternalAgentId('a'.repeat(65)));
		assert.ok(!isValidExternalAgentId(42));
	});

	test('normalization lowercases and strips unsupported characters', () => {
		assert.strictEqual(normalizeExternalAgentId('  My Agent!  '), 'my-agent');
		assert.strictEqual(normalizeExternalAgentId('___'), undefined);
		assert.strictEqual(normalizeExternalAgentId('Agent_2'), 'agent-2');
	});

	test('provider ids round-trip with the prefix', () => {
		assert.strictEqual(providerIdForExternalAgent('foo'), 'acp-foo');
		assert.strictEqual(externalAgentIdFromProvider('acp-foo'), 'foo');
		assert.strictEqual(externalAgentIdFromProvider('local'), undefined);
		assert.ok(isExternalAgentProvider('acp-foo'));
		assert.ok(!isExternalAgentProvider('copilot'));
	});
});

suite('External agent catalogue – launch resolution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('user command wins over package runners', () => {
		const e = entry('a', { command: { command: '/opt/agent', args: ['--acp'], env: { A: '1' } }, npx: { package: 'x' } });
		assert.deepStrictEqual(resolveExternalAgentLaunch(e), { command: '/opt/agent', args: ['--acp'], env: { A: '1' } });
	});

	test('npx and uvx forms produce package-runner command lines', () => {
		assert.deepStrictEqual(resolveExternalAgentLaunch(entry('a', { npx: { package: '@scope/agent', args: ['--stdio'] } })), { command: 'npx', args: ['--yes', '@scope/agent', '--stdio'] });
		assert.deepStrictEqual(resolveExternalAgentLaunch(entry('b', { uvx: { package: 'agent-py' } })), { command: 'uvx', args: ['agent-py'] });
	});

	test('binary-only entries have no launch form', () => {
		assert.strictEqual(resolveExternalAgentLaunch(entry('c', { binaryOnly: true })), undefined);
	});

	test('launch equality ignores display names and compares command, args and env', () => {
		const a = entry('a', { command: { command: 'x', args: ['1'] } }, 'custom', 'One');
		const b = entry('a', { command: { command: 'x', args: ['1'] } }, 'custom', 'Two');
		const c = entry('a', { command: { command: 'x', args: ['2'] } }, 'custom', 'One');
		assert.ok(externalAgentLaunchEquals(a, b));
		assert.ok(!externalAgentLaunchEquals(a, c));
		assert.ok(externalAgentLaunchEquals(entry('z', { binaryOnly: true }), entry('z', {})));
		assert.ok(!externalAgentLaunchEquals(entry('z', { binaryOnly: true }), a));
	});
});

suite('External agent catalogue – parsing and serialization', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty, blank and malformed input yield an empty catalogue', () => {
		assert.deepStrictEqual(parseExternalAgentCatalogue(undefined), emptyExternalAgentCatalogue());
		assert.deepStrictEqual(parseExternalAgentCatalogue('   '), emptyExternalAgentCatalogue());
		assert.deepStrictEqual(parseExternalAgentCatalogue('{ not json'), emptyExternalAgentCatalogue());
		assert.deepStrictEqual(parseExternalAgentCatalogue('[]'), emptyExternalAgentCatalogue());
	});

	test('invalid rows are dropped, duplicates collapse, enabledIds only keep known ids', () => {
		const parsed = parseExternalAgentCatalogue(JSON.stringify({
			version: 1,
			registryUrl: 'https://example.invalid/registry.json',
			agents: [
				{ id: 'good', name: 'Good', source: 'custom', distribution: { command: { command: 'good-agent' } } },
				{ id: 'good', name: 'Duplicate', source: 'custom', distribution: { command: { command: 'other' } } },
				{ id: 'Bad Id', name: 'Bad', source: 'custom', distribution: { command: { command: 'x' } } },
				{ id: 'no-name', source: 'custom', distribution: { command: { command: 'x' } } },
				{ id: 'no-dist', name: 'No dist', source: 'custom' },
				{ id: 'bin', name: 'Binary', source: 'registry', distribution: { binaryOnly: true } },
			],
			enabledIds: ['good', 'missing', 'good', 'bin'],
		}));
		assert.deepStrictEqual(parsed.agents.map(a => a.id), ['good', 'bin']);
		assert.strictEqual(parsed.agents[0].name, 'Good');
		assert.deepStrictEqual(parsed.enabledIds, ['good', 'bin']);
		assert.strictEqual(parsed.registryUrl, 'https://example.invalid/registry.json');
	});

	test('serialize → parse is lossless for valid catalogues', () => {
		let catalogue = emptyExternalAgentCatalogue();
		catalogue = upsertExternalAgent(catalogue, entry('one', { command: { command: 'one', args: ['--a'], env: { K: 'v' } } }));
		catalogue = upsertExternalAgent(catalogue, { ...entry('two', { npx: { package: 'two' } }, 'registry'), description: 'd', version: '1.0', website: 'https://example.invalid', license: 'MIT' });
		catalogue = setExternalAgentEnabled(catalogue, 'two', true);
		const text = serializeExternalAgentCatalogue(catalogue);
		assert.ok(text.endsWith('\n'));
		// JSON drops undefined-valued keys; compare the JSON shapes.
		assert.deepStrictEqual(JSON.parse(serializeExternalAgentCatalogue(parseExternalAgentCatalogue(text))), JSON.parse(text));
	});
});

suite('External agent catalogue – registry mapping and merge', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const registry = {
		agents: [
			{ id: 'Node Agent', name: 'Node Agent', version: '2.0.0', description: 'via npx', repository: 'https://example.invalid/node', license: 'Apache-2.0', distribution: { npx: { package: '@example/node-agent', args: ['--acp'] } } },
			{ id: 'py-agent', name: 'Py Agent', distribution: { uvx: { package: 'py-agent' } } },
			{ id: 'bin-agent', name: 'Bin Agent', distribution: { binary: { 'darwin-arm64': { archive: 'https://example.invalid/x.zip' } } } },
			{ id: 'nothing', name: 'Nothing', distribution: {} },
			{ id: 'no-name', distribution: { npx: { package: 'x' } } },
			{ id: 'py-agent', name: 'Duplicate', distribution: { uvx: { package: 'dupe' } } },
			'not an object',
		],
	};

	test('keeps npx/uvx forms, records binary-only rows, skips the rest', () => {
		const entries = mapRegistryToExternalAgentEntries(registry);
		assert.deepStrictEqual(entries.map(e => e.id), ['node-agent', 'py-agent', 'bin-agent']);
		assert.deepStrictEqual(entries[0].distribution, { npx: { package: '@example/node-agent', args: ['--acp'] } });
		assert.strictEqual(entries[0].website, 'https://example.invalid/node');
		assert.strictEqual(entries[0].license, 'Apache-2.0');
		assert.strictEqual(entries[0].source, 'registry');
		assert.deepStrictEqual(entries[1].distribution, { uvx: { package: 'py-agent', args: undefined } });
		assert.deepStrictEqual(entries[2].distribution, { binaryOnly: true });
		assert.strictEqual(resolveExternalAgentLaunch(entries[2]), undefined);
	});

	test('garbage registries map to nothing', () => {
		assert.deepStrictEqual(mapRegistryToExternalAgentEntries(null), []);
		assert.deepStrictEqual(mapRegistryToExternalAgentEntries({ agents: 'nope' }), []);
		assert.deepStrictEqual(mapRegistryToExternalAgentEntries([]), []);
	});

	test('merge replaces registry rows, keeps custom rows and never changes enablement', () => {
		let catalogue = emptyExternalAgentCatalogue();
		catalogue = upsertExternalAgent(catalogue, entry('mine', { command: { command: 'mine' } }));
		catalogue = upsertExternalAgent(catalogue, { ...entry('py-agent', { uvx: { package: 'old' } }, 'registry'), version: '0.1' });
		catalogue = upsertExternalAgent(catalogue, entry('gone', { npx: { package: 'gone' } }, 'registry'));
		catalogue = setExternalAgentEnabled(catalogue, 'mine', true);
		catalogue = setExternalAgentEnabled(catalogue, 'py-agent', true);
		catalogue = setExternalAgentEnabled(catalogue, 'gone', true);

		const merged = mergeRegistryEntries(catalogue, mapRegistryToExternalAgentEntries(registry));
		assert.deepStrictEqual(merged.agents.map(a => a.id), ['mine', 'node-agent', 'py-agent', 'bin-agent']);
		assert.deepStrictEqual(merged.agents.find(a => a.id === 'py-agent')?.distribution, { uvx: { package: 'py-agent', args: undefined } });
		// Newly fetched rows are never enabled by a refresh; removed rows drop out of enabledIds.
		assert.deepStrictEqual(merged.enabledIds, ['mine', 'py-agent']);
	});

	test('a custom row shadows a registry row with the same id', () => {
		let catalogue = upsertExternalAgent(emptyExternalAgentCatalogue(), entry('py-agent', { command: { command: 'local-py' } }));
		catalogue = mergeRegistryEntries(catalogue, mapRegistryToExternalAgentEntries(registry));
		const row = catalogue.agents.find(a => a.id === 'py-agent');
		assert.strictEqual(row?.source, 'custom');
		assert.deepStrictEqual(resolveExternalAgentLaunch(row!), { command: 'local-py', args: [] });
	});
});

suite('External agent catalogue – enable, upsert, remove', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('enabling an unknown id is a no-op and enabling is idempotent', () => {
		let catalogue = upsertExternalAgent(emptyExternalAgentCatalogue(), entry('a', { command: { command: 'a' } }));
		assert.deepStrictEqual(setExternalAgentEnabled(catalogue, 'nope', true).enabledIds, []);
		catalogue = setExternalAgentEnabled(catalogue, 'a', true);
		catalogue = setExternalAgentEnabled(catalogue, 'a', true);
		assert.deepStrictEqual(catalogue.enabledIds, ['a']);
		catalogue = setExternalAgentEnabled(catalogue, 'a', false);
		assert.deepStrictEqual(catalogue.enabledIds, []);
	});

	test('upsert replaces in place and remove clears enablement', () => {
		let catalogue = upsertExternalAgent(emptyExternalAgentCatalogue(), entry('a', { command: { command: 'a' } }));
		catalogue = upsertExternalAgent(catalogue, entry('b', { command: { command: 'b' } }));
		catalogue = upsertExternalAgent(catalogue, entry('a', { command: { command: 'a2' } }));
		assert.deepStrictEqual(catalogue.agents.map(a => resolveExternalAgentLaunch(a)?.command), ['a2', 'b']);
		catalogue = setExternalAgentEnabled(catalogue, 'a', true);
		catalogue = removeExternalAgent(catalogue, 'a');
		assert.deepStrictEqual(catalogue.agents.map(a => a.id), ['b']);
		assert.deepStrictEqual(catalogue.enabledIds, []);
	});
});
