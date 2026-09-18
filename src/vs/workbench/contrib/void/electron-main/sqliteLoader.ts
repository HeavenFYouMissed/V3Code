/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * ESM-safe loader for `@vscode/sqlite3`. Dynamic `import()` exposes the native
 * addon on `default`, not as a named `Database` export — see storage.ts /
 * sessionDatabase.ts (`sqlite3.default.Database`). Using `mod.Database` alone
 * yields undefined and breaks every store open silently.
 */

import type { Database } from '@vscode/sqlite3';

export type SqliteDatabaseConstructor = new (path: string, callback: (err: Error | null) => void) => Database;

export async function loadSqliteDatabaseConstructor(): Promise<SqliteDatabaseConstructor> {
	const mod = await import('@vscode/sqlite3' as any);
	const sqlite3 = mod.default ?? mod;
	const ctor = sqlite3.Database as SqliteDatabaseConstructor | undefined;
	if (!ctor) {
		throw new Error('@vscode/sqlite3: Database export missing (expected default.Database)');
	}
	return ctor;
}
