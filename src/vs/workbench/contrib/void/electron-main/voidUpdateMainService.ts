/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { timeout } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IUpdateService, StateType } from '../../../../platform/update/common/update.js';
import { IVoidUpdateService } from '../common/voidUpdateService.js';
import { VoidCheckUpdateRespose } from '../common/voidUpdateServiceTypes.js';



export class VoidMainUpdateService extends Disposable implements IVoidUpdateService {
	_serviceBrand: undefined;

	constructor(
		@IProductService private readonly _productService: IProductService,
		@IEnvironmentMainService private readonly _envMainService: IEnvironmentMainService,
		@IUpdateService private readonly _updateService: IUpdateService,
		@ILogService private readonly _logService: ILogService,
	) {
		super()
	}

	/** An explicit check should answer with the OUTCOME, not the transient
	 * "checking" state — wait (bounded) for the update state machine to leave
	 * CheckingForUpdates. Plain polling: no listeners to leak, and the moment
	 * the state becomes Downloading/Idle/etc. we map it below. */
	private async _waitWhileChecking(timeoutMs: number): Promise<void> {
		const start = Date.now()
		while (this._updateService.state.type === StateType.CheckingForUpdates && Date.now() - start < timeoutMs) {
			await timeout(250)
		}
	}

	async check(explicit: boolean): Promise<VoidCheckUpdateRespose> {

		const isDevMode = !this._envMainService.isBuilt // found in abstractUpdateService.ts

		if (isDevMode) {
			return { message: explicit ? 'Updates are disabled when running from sources.' : null } as const
		}

		// if disabled and not explicitly checking, return early
		if (this._updateService.state.type === StateType.Disabled) {
			if (!explicit)
				return { message: null } as const
		}

		this._updateService.checkForUpdates(explicit) // kick a check; the result surfaces via state below

		this._logService.trace('voidUpdate#check', this._updateService.state.type)

		if (explicit) {
			await this._waitWhileChecking(30_000)
		}

		if (this._updateService.state.type === StateType.Uninitialized) {
			// The update service hasn't been initialized yet
			return { message: explicit ? 'Checking for updates soon...' : null } as const
		}

		if (this._updateService.state.type === StateType.Idle) {
			// No updates currently available
			return { message: explicit ? 'No updates found!' : null, action: explicit ? 'reinstall' : undefined } as const
		}

		if (this._updateService.state.type === StateType.CheckingForUpdates) {
			// Currently checking for updates
			return { message: explicit ? 'Checking for updates...' : null } as const
		}

		if (this._updateService.state.type === StateType.AvailableForDownload) {
			// Update available but requires manual download (mainly for Linux)
			return { message: 'A new update is available!', action: 'download', } as const
		}

		if (this._updateService.state.type === StateType.Downloading) {
			// Update is currently being downloaded
			return { message: explicit ? 'Currently downloading update...' : null } as const
		}

		if (this._updateService.state.type === StateType.Downloaded) {
			// Update has been downloaded but not yet ready
			return { message: explicit ? 'An update is ready to be applied!' : null, action: 'apply' } as const
		}

		if (this._updateService.state.type === StateType.Updating) {
			// Update is being applied
			return { message: explicit ? 'Applying update...' : null } as const
		}

		if (this._updateService.state.type === StateType.Ready) {
			// Update is ready
			return { message: 'Restart V3Code to update!', action: 'restart' } as const
		}

		if (this._updateService.state.type === StateType.Disabled) {
			return await this._manualCheckGHTagIfDisabled(explicit)
		}
		return null
	}






	/**
	 * Disaster fallback ONLY — not the happy path. The real update route is the
	 * platform update service (DarwinUpdateService + electron.autoUpdater
	 * against product.json's updateUrl — see docs/V3CODE-UPDATE-ROUTE.md); this
	 * manual check runs solely when that service is Disabled (unsigned dev
	 * build, missing update config, or an OS we don't serve updates for). It
	 * reads the static website manifest, which is deliberately independent of
	 * the update worker so it still answers when update.v3code.dev is down.
	 */
	private async _manualCheckGHTagIfDisabled(explicit: boolean): Promise<VoidCheckUpdateRespose> {
		try {
			const response = await fetch('https://app.v3code.dev/releases/latest.json');

			const data = await response.json();
			const latestVersion = data.version ?? data.tag_name;
			const latestCommit = data.commit;

			const myVersion = this._productService.version
			const myCommit = this._productService.commit

			// Prefer the commit comparison (mirrors the update worker's exact-match
			// semantics — the publish script writes `commit` into this manifest).
			// `version` is the upstream appVersion, which does NOT change across
			// V3Code releases on the same VS Code base, so it alone would report
			// "up to date" forever; kept only as a fallback for older manifests.
			const isUpToDate = (latestCommit && myCommit)
				? latestCommit === myCommit
				: myVersion === latestVersion // only makes sense if response.ok

			let message: string | null
			let action: 'reinstall' | undefined

			// explicit
			if (explicit) {
				if (response.ok) {
					if (!isUpToDate) {
						message = 'A new version of V3Code is available! Please reinstall from https://app.v3code.dev/download (auto-updates are unavailable for this build) - it only takes a second!'
						action = 'reinstall'
					}
					else {
						message = 'V3Code is up-to-date!'
					}
				}
				else {
					message = `An error occurred when checking for the latest release. Please try again in ~5 minutes, or reinstall from https://app.v3code.dev/download.`
					action = 'reinstall'
				}
			}
			// not explicit
			else {
				if (response.ok && !isUpToDate) {
					message = 'A new version of V3Code is available! Please reinstall from https://app.v3code.dev/download (auto-updates are unavailable for this build) - it only takes a second!'
					action = 'reinstall'
				}
				else {
					message = null
				}
			}
			return { message, action } as const
		}
		catch (e) {
			if (explicit) {
				return {
					message: `An error occurred when checking for the latest release: ${e}. Please try again in ~5 minutes, or visit https://app.v3code.dev/download.`,
					action: 'reinstall',
				}
			}
			else {
				return { message: null } as const
			}
		}
	}
}
