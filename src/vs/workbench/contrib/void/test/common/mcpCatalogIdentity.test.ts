/*--------------------------------------------------------------------------------------
 *  Copyright 2026 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BRAND_ICON_PATHS, CATALOG, brandIconSvg, catalogEntryForServerName, monogramOf } from '../../common/mcpCatalog.js';

suite('mcp catalog identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every id is unique', () => {
		const ids = CATALOG.map(e => e.id);
		assert.strictEqual(new Set(ids).size, ids.length);
	});

	test('no alias collides with another entry\'s id, name, or aliases', () => {
		const claims = new Map<string, string>(); // lowercase claim -> entry id
		for (const entry of CATALOG) {
			for (const claim of [entry.id, entry.name, ...(entry.aliases ?? [])]) {
				const key = claim.toLowerCase();
				const owner = claims.get(key);
				assert.ok(owner === undefined || owner === entry.id, `"${claim}" claimed by both ${owner} and ${entry.id}`);
				claims.set(key, entry.id);
			}
		}
	});

	test('server names resolve by exact id, display name, or alias — case-insensitive', () => {
		assert.strictEqual(catalogEntryForServerName('github')?.id, 'github');
		assert.strictEqual(catalogEntryForServerName('GitHub')?.id, 'github');
		assert.strictEqual(catalogEntryForServerName('Cloudflare Docs')?.id, 'cloudflare-docs');
		const withAlias = [{ ...CATALOG[0], id: 'x', name: 'X', aliases: ['legacy-x'] }];
		assert.strictEqual(catalogEntryForServerName('LEGACY-X', withAlias)?.id, 'x');
	});

	test('substring and slug guessing never match — the cloudflare-docs regression', () => {
		// The failed port's alias expansion let the Cloudflare card claim a server
		// literally named cloudflare-docs. Resolution must be exact-only.
		assert.strictEqual(catalogEntryForServerName('cloudflare-docs')?.id, 'cloudflare-docs');
		assert.strictEqual(catalogEntryForServerName('cloudflare')?.id, 'cloudflare');
		assert.strictEqual(catalogEntryForServerName('cloud'), undefined);
		assert.strictEqual(catalogEntryForServerName('cloudflare-doc'), undefined);
	});

	test('every declared brand icon resolves to real path data', () => {
		for (const entry of CATALOG) {
			if (entry.brandIcon !== undefined) {
				const d = BRAND_ICON_PATHS[entry.brandIcon];
				assert.ok(d !== undefined && d.length > 20, `${entry.id}: brandIcon "${entry.brandIcon}" has no path data`);
				const svg = brandIconSvg(entry);
				assert.ok(svg !== undefined && svg.startsWith('<svg') && svg.includes(d.slice(0, 20)), `${entry.id}: svg markup`);
			}
		}
	});

	test('entries without a brand icon fall back to a monogram, never a broken image', () => {
		const neon = CATALOG.find(e => e.id === 'neon');
		assert.ok(neon);
		assert.strictEqual(brandIconSvg(neon), undefined);
		assert.strictEqual(monogramOf(neon), 'N');
		assert.strictEqual(monogramOf({ name: 'thing', monogram: 'th' }), 'TH');
	});

	test('no icon strategy hotlinks a third-party favicon service', () => {
		for (const [slug, d] of Object.entries(BRAND_ICON_PATHS)) {
			assert.ok(!/https?:/.test(d), `${slug}: icon data must be inline path data, not a URL`);
		}
	});
});
