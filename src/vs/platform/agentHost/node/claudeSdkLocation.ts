/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as fs from 'fs';
import { join } from '../../../base/common/path.js';

/**
 * Resolve the `@anthropic-ai/claude-agent-sdk` package bundled into the app's
 * real `node_modules` (it is a production dependency; V3Code ships node modules
 * on disk, not inside an asar). `appRoot` is the repo root in dev and
 * `Contents/Resources/app` when packaged, so the same lookup works in both.
 * Returns the package directory, or `undefined` when this build does not
 * bundle the SDK — callers then keep the 'no SDK on disk -> no provider'
 * invariant instead of registering a provider that throws on first use.
 */
export function getBundledClaudeSdkPath(appRoot: string): string | undefined {
	const candidate = join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
	try {
		return fs.statSync(join(candidate, 'sdk.mjs')).isFile() ? candidate : undefined;
	} catch {
		return undefined;
	}
}
