/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { join, resolve } from '../../../../base/common/path.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';

/**
 * Compile-time view of the SDK module. The package is `"type": "module"`
 * and loaded at runtime through a `file://` dynamic import (see
 * {@link AcpSdkService}), so this file only ever imports its types.
 */
export type AcpSdkModule = typeof import('@agentclientprotocol/sdk');

export const IAcpSdkService = createDecorator<IAcpSdkService>('acpSdkService');

export interface IAcpSdkService {
	readonly _serviceBrand: undefined;
	/** Directory of the SDK package that will be loaded. */
	readonly sdkPath: string;
	/** Loads (once) and returns the SDK module. Rejects when it cannot be loaded. */
	load(): Promise<AcpSdkModule>;
}

/**
 * Loads `@agentclientprotocol/sdk` from an on-disk package directory. The
 * entry is resolved from the package's `exports['.']` (or `main`) so a
 * user-supplied directory works as well as the bundled copy.
 */
export class AcpSdkService implements IAcpSdkService {
	declare readonly _serviceBrand: undefined;

	private _module: Promise<AcpSdkModule> | undefined;

	constructor(
		readonly sdkPath: string,
		@ILogService private readonly _logService: ILogService,
	) { }

	load(): Promise<AcpSdkModule> {
		if (!this._module) {
			this._module = this._load().catch(err => {
				this._module = undefined;
				this._logService.error('[ACP] Failed to load @agentclientprotocol/sdk', err);
				throw err;
			});
		}
		return this._module;
	}

	protected async _load(): Promise<AcpSdkModule> {
		const pkgJson = JSON.parse(fs.readFileSync(join(this.sdkPath, 'package.json'), 'utf8')) as {
			exports?: Record<string, string | Record<string, string>>;
			main?: string;
		};
		const dot = pkgJson.exports?.['.'];
		const mainEntry = typeof dot === 'string'
			? dot
			: dot?.import ?? dot?.default ?? pkgJson.main ?? 'index.js';
		const entry = resolve(this.sdkPath, mainEntry);
		return await import(pathToFileURL(entry).href) as AcpSdkModule;
	}
}
