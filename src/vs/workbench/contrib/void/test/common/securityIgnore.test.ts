/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isSecurityConcernPath, isSecurityIgnoredDirName } from '../../common/semanticIndex/securityIgnore.js';

suite('semanticIndex / securityIgnore', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('env files are concerns in every variant', () => {
		for (const p of ['.env', '.env.local', '.env.production', 'prod.env', 'app.env.backup', 'packages/api/.env.development']) {
			assert.strictEqual(isSecurityConcernPath(p), true, p);
		}
	});

	test('keys, certs and keystores are concerns', () => {
		for (const p of ['server.key', 'tls/cert.pem', 'certs/ca.crt', 'app.p12', 'release.keystore', 'id_rsa', '.ssh/id_ed25519', 'backup.gpg']) {
			assert.strictEqual(isSecurityConcernPath(p), true, p);
		}
	});

	test('credential files and databases are concerns', () => {
		for (const p of ['auth.json', 'config.json', 'settings.json', 'appsettings.Production.json', 'users.sqlite3', 'api.token', 'deploy.secret']) {
			assert.strictEqual(isSecurityConcernPath(p), true, p);
		}
	});

	test('security directories poison the whole subtree', () => {
		for (const p of ['secrets/plain.txt', '.aws/credentials.csv', 'infra/keys/deploy.txt', 'tmp/secrets/x.txt', 'a/tmp/secrets/x.txt', '.kube/kubecfg']) {
			assert.strictEqual(isSecurityConcernPath(p), true, p);
		}
	});

	test('ordinary source files are not concerns', () => {
		for (const p of ['src/main.ts', 'README.md', 'environment.ts', 'envelope.py', 'src/keys.ts', 'monkey.tsx', 'docs/private-notes.md', 'src/config/app.ts', 'tokenizer.rs']) {
			assert.strictEqual(isSecurityConcernPath(p), false, p);
		}
	});

	test('walk-time dir skip matches single-segment security dirs case-insensitively', () => {
		for (const d of ['secrets', '.aws', '.ssh', 'Private', 'CERTS', 'env']) {
			assert.strictEqual(isSecurityIgnoredDirName(d), true, d);
		}
		for (const d of ['src', 'environment', 'keychain', 'enveloping']) {
			assert.strictEqual(isSecurityIgnoredDirName(d), false, d);
		}
	});

	test('multi-segment dir patterns only match whole segments', () => {
		assert.strictEqual(isSecurityConcernPath('mytmp/secretsandmore/x.txt'), false);
		assert.strictEqual(isSecurityConcernPath('temp/secrets/x.txt'), true);
	});
});
