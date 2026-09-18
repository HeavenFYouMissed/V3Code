/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideInstallName,
	installConfigsEquivalent,
	parseCatalogInstallMap,
	resolveServerForName,
	serializeCatalogInstallMap,
} from '../../common/mcpCatalogIdentity.js';

const srv = (id: string, label: string) => ({ definition: { id, label } });

suite('mcp catalog install identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('resolveServerForName', () => {
		test('the install map wins and resolves by exact definition id', () => {
			const servers = [srv('coll.abc', 'github'), srv('v3code.local.github', 'github')];
			const map = { github: { serverDefinitionId: 'coll.abc', installedName: 'github' } };
			const r = resolveServerForName(servers, 'github', map);
			assert.strictEqual(r.via, 'install-map');
			assert.strictEqual(r.server?.definition.id, 'coll.abc');
		});

		test('a stale map record falls through to normal resolution', () => {
			const servers = [srv('coll.new', 'github')];
			const map = { github: { serverDefinitionId: 'coll.gone', installedName: 'github' } };
			const r = resolveServerForName(servers, 'github', map);
			assert.strictEqual(r.via, 'label');
			assert.strictEqual(r.server?.definition.id, 'coll.new');
		});

		test('exact definition id beats label', () => {
			const servers = [srv('github', 'Some Label'), srv('coll.x', 'github')];
			assert.strictEqual(resolveServerForName(servers, 'github', {}).via, 'definition-id');
		});

		test('an installed server outranks a same-labelled legacy-file server', () => {
			const servers = [srv('v3code.local.github', 'github'), srv('coll.abc', 'github')];
			const r = resolveServerForName(servers, 'github', {});
			assert.strictEqual(r.via, 'label');
			assert.strictEqual(r.server?.definition.id, 'coll.abc');
		});

		test('two installed servers with one label resolve to nothing, never first-match', () => {
			const servers = [srv('coll.a', 'github'), srv('coll.b', 'github')];
			const r = resolveServerForName(servers, 'github', {});
			assert.strictEqual(r.via, 'ambiguous-label');
			assert.strictEqual(r.server, undefined);
		});

		test('the cloudflare-docs class of bug: no substring or slug matching', () => {
			const servers = [srv('coll.cf', 'cloudflare'), srv('coll.cfd', 'cloudflare-docs')];
			assert.strictEqual(resolveServerForName(servers, 'cloudflare', {}).server?.definition.id, 'coll.cf');
			assert.strictEqual(resolveServerForName(servers, 'cloudflare-docs', {}).server?.definition.id, 'coll.cfd');
			assert.strictEqual(resolveServerForName(servers, 'cloud', {}).server, undefined);
		});
	});

	suite('decideInstallName', () => {
		const remote = { url: 'https://mcp.example.com/mcp' };

		test('a free name installs fresh', () => {
			assert.deepStrictEqual(decideInstallName('github', [], remote), { kind: 'fresh', name: 'github' });
		});

		test('a taken name with an equivalent config is adopted, not duplicated', () => {
			const existing = [{ name: 'github', config: { url: 'https://mcp.example.com/mcp/' } }];
			assert.deepStrictEqual(decideInstallName('github', existing, remote), { kind: 'adopt', name: 'github' });
		});

		test('a taken name with a different config suffixes and leaves the user\'s server alone', () => {
			const existing = [{ name: 'github', config: { url: 'https://something-else.example.com' } }];
			assert.deepStrictEqual(decideInstallName('github', existing, remote), { kind: 'suffixed', name: 'github-2' });
		});

		test('suffix scanning adopts an equivalent earlier suffix instead of piling up copies', () => {
			const existing = [
				{ name: 'github', config: { url: 'https://something-else.example.com' } },
				{ name: 'github-2', config: { url: 'https://mcp.example.com/mcp' } },
			];
			assert.deepStrictEqual(decideInstallName('github', existing, remote), { kind: 'adopt', name: 'github-2' });
		});

		test('local commands compare by full command line', () => {
			const a = { command: 'npx', args: ['-y', 'thing'] };
			assert.ok(installConfigsEquivalent(a, { command: 'npx', args: ['-y', 'thing'] }));
			assert.ok(!installConfigsEquivalent(a, { command: 'npx', args: ['-y', 'other'] }));
			assert.ok(!installConfigsEquivalent(a, { url: 'https://mcp.example.com' }));
		});
	});

	suite('persistence round trip', () => {
		test('serialize -> parse preserves records; garbage parses to empty', () => {
			const map = { github: { serverDefinitionId: 'coll.abc', installedName: 'github-2' } };
			assert.deepStrictEqual(parseCatalogInstallMap(serializeCatalogInstallMap(map)), map);
			assert.deepStrictEqual(parseCatalogInstallMap(undefined), {});
			assert.deepStrictEqual(parseCatalogInstallMap('not json'), {});
			assert.deepStrictEqual(parseCatalogInstallMap('[1,2]'), {});
			assert.deepStrictEqual(parseCatalogInstallMap('{"x": {"serverDefinitionId": 5}}'), {});
		});
	});
});
