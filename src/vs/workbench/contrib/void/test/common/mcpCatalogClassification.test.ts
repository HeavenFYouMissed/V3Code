/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	CATALOG,
	classifyGalleryServer,
	galleryServerToCatalogEntry,
	primaryActionFor,
	recoveryActionFor,
	GalleryServerLike,
} from '../../common/mcpCatalog.js';

function galleryServer(overrides: Partial<GalleryServerLike> & { configuration?: GalleryServerLike['configuration'] }): GalleryServerLike {
	return {
		name: 'acme/thing',
		displayName: 'Thing',
		description: 'A thing.',
		status: 'active',
		configuration: {},
		...overrides,
	};
}

suite('mcp catalog classification', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('kind is an explicit editorial claim with a consistent shape per kind', () => {
		for (const entry of CATALOG) {
			switch (entry.kind) {
				case 'one-click':
				case 'token-or-config':
					assert.ok(entry.url, `${entry.id}: remote kinds must declare a url`);
					assert.strictEqual(entry.command, undefined, `${entry.id}: remote kinds must not carry a command`);
					break;
				case 'local-command':
					assert.ok(entry.command, `${entry.id}: local-command must declare a command`);
					assert.strictEqual(entry.url, undefined, `${entry.id}: local-command must not carry a url`);
					break;
				case 'skill-or-guide':
					assert.ok(entry.docsUrl, `${entry.id}: guides must have somewhere to open`);
					break;
				case 'unavailable':
					break;
			}
		}
	});

	test('providers that reject dynamic client registration are not sold as one-click', () => {
		// First-party verified 2026-08-30: these providers refuse arbitrary-client OAuth.
		for (const id of ['google-drive', 'canva', 'slack', 'figma']) {
			const entry = CATALOG.find(e => e.id === id);
			assert.ok(entry, `${id} present`);
			assert.strictEqual(entry.kind, 'token-or-config', `${id} must not offer one-click Connect`);
			assert.strictEqual(entry.authHint, 'oauth-preregistered', `${id} needs a pre-registered client`);
		}
	});

	test('github connects with a token: its hosted server refuses unregistered OAuth clients', () => {
		const entry = CATALOG.find(e => e.id === 'github');
		assert.ok(entry);
		assert.strictEqual(entry.kind, 'token-or-config');
		assert.strictEqual(entry.authHint, 'token');
		assert.strictEqual(entry.headers?.Authorization, 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}');
		assert.strictEqual(entry.requiredInputs?.[0]?.isSecret, true);
	});

	test('gmail is honestly a setup guide, never a Connect button', () => {
		const entry = CATALOG.find(e => e.id === 'gmail');
		assert.ok(entry);
		assert.strictEqual(entry.kind, 'skill-or-guide');
		assert.ok(entry.docsUrl);
		assert.strictEqual(primaryActionFor(entry), 'open-guide');
	});

	test('no entry ships verified: the provider matrix has no completed rows yet', () => {
		for (const entry of CATALOG) {
			assert.notStrictEqual(entry.verified, true, `${entry.id} may not claim Verified without a matrix row`);
		}
	});

	test('primary action per kind: local commands always review, guides never connect', () => {
		assert.strictEqual(primaryActionFor({ kind: 'one-click' }), 'connect');
		assert.strictEqual(primaryActionFor({ kind: 'token-or-config' }), 'set-up');
		assert.strictEqual(primaryActionFor({ kind: 'local-command' }), 'review-command');
		assert.strictEqual(primaryActionFor({ kind: 'skill-or-guide' }), 'open-guide');
		assert.strictEqual(primaryActionFor({ kind: 'unavailable' }), null);
	});

	suite('recovery action truthfulness', () => {
		const remote = { kind: 'one-click' as const, url: 'https://mcp.example.com/mcp' };
		const local = { kind: 'local-command' as const, url: undefined };

		test('needs-user-interaction always means Sign in', () => {
			assert.strictEqual(recoveryActionFor(remote, { status: 'needs-user-interaction' }, true), 'sign-in');
			assert.strictEqual(recoveryActionFor(local, { status: 'needs-user-interaction' }, true), 'sign-in');
		});

		test('a remote with zero tools is NOT healthy — Reconnect, never Sign in again', () => {
			assert.strictEqual(recoveryActionFor(remote, { status: 'success', tools: [] }, true), 'reconnect');
		});

		test('healthy remote (success + tools + enabled) offers the full fresh sign-in', () => {
			assert.strictEqual(recoveryActionFor(remote, { status: 'success', tools: [{}] }, true), 'sign-in-again');
		});

		test('disabled or failed remotes offer Reconnect', () => {
			assert.strictEqual(recoveryActionFor(remote, { status: 'success', tools: [{}] }, false), 'reconnect');
			assert.strictEqual(recoveryActionFor(remote, { status: 'error' }, true), 'reconnect');
			assert.strictEqual(recoveryActionFor(remote, undefined, true), 'reconnect');
		});

		test('local commands get no auth recovery button', () => {
			assert.strictEqual(recoveryActionFor(local, { status: 'success', tools: [{}] }, true), null);
			assert.strictEqual(recoveryActionFor(local, { status: 'error' }, true), null);
		});
	});

	suite('gallery server → five states', () => {
		test('deprecatedWithRepo: deprecated with a repository degrades to a guide', () => {
			const g = galleryServer({ status: 'deprecated', repositoryUrl: 'https://example.com/acme/thing' });
			assert.strictEqual(classifyGalleryServer(g), 'skill-or-guide');
		});

		test('deprecatedBare: deprecated with nothing to open is unavailable', () => {
			assert.strictEqual(classifyGalleryServer(galleryServer({ status: 'deprecated' })), 'unavailable');
		});

		test('remoteSecretHeader: a secret or required header means Set up, not Connect', () => {
			const g = galleryServer({
				configuration: { remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp', headers: [{ name: 'Authorization', isSecret: true, isRequired: true }] }] },
			});
			assert.strictEqual(classifyGalleryServer(g), 'token-or-config');
		});

		test('remoteTemplatedUrl: a templated URL cannot be connected verbatim', () => {
			const g = galleryServer({
				configuration: { remotes: [{ type: 'streamable-http', url: 'https://{tenant}.acme.dev/mcp' }] },
			});
			assert.strictEqual(classifyGalleryServer(g), 'token-or-config');
		});

		test('remotePlain: a plain remote is one-click shaped but NEVER verified', () => {
			const g = galleryServer({
				configuration: { remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' }] },
			});
			assert.strictEqual(classifyGalleryServer(g), 'one-click');
			assert.notStrictEqual(galleryServerToCatalogEntry(g).verified, true);
			assert.strictEqual(galleryServerToCatalogEntry(g).authHint, undefined, 'auth is runtime-discovered, never derived from registry data');
		});

		test('remoteAndPackage: remotes win over packages', () => {
			const g = galleryServer({
				configuration: {
					remotes: [{ type: 'sse', url: 'https://mcp.acme.dev/sse' }],
					packages: [{ registryType: 'npm', identifier: '@acme/thing' }],
				},
			});
			assert.strictEqual(classifyGalleryServer(g), 'one-click');
			assert.strictEqual(galleryServerToCatalogEntry(g).transport, 'sse');
		});

		test('packageNpm: npm package synthesizes an npx command and env inputs', () => {
			const g = galleryServer({
				configuration: {
					packages: [{ registryType: 'npm', identifier: '@acme/thing', version: '1.2.3', environmentVariables: [{ name: 'ACME_TOKEN', isSecret: true, isRequired: true }] }],
				},
			});
			assert.strictEqual(classifyGalleryServer(g), 'local-command');
			const entry = galleryServerToCatalogEntry(g);
			assert.strictEqual(entry.command, 'npx');
			assert.deepStrictEqual(entry.args, ['-y', '@acme/thing@1.2.3']);
			assert.deepStrictEqual(entry.requiredInputs?.map(i => ({ name: i.name, target: i.target, isSecret: i.isSecret })), [{ name: 'ACME_TOKEN', target: 'env', isSecret: true }]);
		});

		test('packageOci: docker package synthesizes docker run', () => {
			const g = galleryServer({ configuration: { packages: [{ registryType: 'oci', identifier: 'ghcr.io/acme/thing' }] } });
			const entry = galleryServerToCatalogEntry(g);
			assert.strictEqual(entry.kind, 'local-command');
			assert.strictEqual(entry.command, 'docker');
			assert.deepStrictEqual(entry.args, ['run', '-i', '--rm', 'ghcr.io/acme/thing']);
		});

		test('runtimeHint overrides the synthesized runner', () => {
			const g = galleryServer({ configuration: { packages: [{ registryType: 'npm', identifier: '@acme/thing', runtimeHint: 'bunx' }] } });
			assert.strictEqual(galleryServerToCatalogEntry(g).command, 'bunx');
		});

		test('unknownRegistry: an uninstallable package type degrades to a guide', () => {
			const g = galleryServer({
				webUrl: 'https://acme.dev/docs',
				configuration: { packages: [{ registryType: 'mystery', identifier: 'thing' }] },
			});
			assert.strictEqual(classifyGalleryServer(g), 'skill-or-guide');
		});

		test('docsOnly: no config but a website is a guide; empty is unavailable', () => {
			assert.strictEqual(classifyGalleryServer(galleryServer({ webUrl: 'https://acme.dev' })), 'skill-or-guide');
			assert.strictEqual(classifyGalleryServer(galleryServer({})), 'unavailable');
		});
	});
});
