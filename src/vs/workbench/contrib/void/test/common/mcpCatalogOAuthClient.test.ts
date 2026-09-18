/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CATALOG, CatalogEntry, installEntryForCatalogEntry } from '../../common/mcpCatalog.js';

suite('mcp catalog: V3Code-owned OAuth apps ship their public client id', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const byId = (id: string): CatalogEntry => {
		const entry = CATALOG.find(e => e.id === id);
		assert.ok(entry, `catalog entry ${id}`);
		return entry;
	};

	test('Slack and Google Drive carry a public client id and stay oauth-preregistered', () => {
		for (const id of ['slack', 'google-drive']) {
			const entry = byId(id);
			assert.strictEqual(entry.authHint, 'oauth-preregistered', id);
			assert.ok(entry.oauthClientId && entry.oauthClientId.length > 10, `${id} oauthClientId`);
			assert.ok(!/secret/i.test(entry.oauthClientId), 'never a secret');
		}
	});

	test('the install entry forwards the client id into the remote server config', () => {
		const install = installEntryForCatalogEntry(byId('slack'));
		assert.ok(install?.url);
		assert.deepStrictEqual(install?.oauth, { clientId: byId('slack').oauthClientId });
	});

	test('providers without a V3Code app get no oauth block', () => {
		const figma = byId('figma');
		assert.strictEqual(figma.oauthClientId, undefined);
		assert.strictEqual(installEntryForCatalogEntry(figma)?.oauth, undefined);
	});
});
