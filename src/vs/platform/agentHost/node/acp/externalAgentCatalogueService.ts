/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { findExecutable } from '../../../../base/node/processes.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../files/common/files.js';
import { ILogService } from '../../../log/common/log.js';
import { EXTERNAL_AGENTS_CATALOGUE_FILENAME, emptyExternalAgentCatalogue, parseExternalAgentCatalogue, resolveExternalAgentLaunch, type IExternalAgentCatalogue, type IExternalAgentEntry } from '../../common/externalAgentCatalogue.js';
import type { IExternalAgentProbe } from './acpAgent.js';

/** Where the renderer and the host agree to keep the catalogue. */
export function externalAgentCatalogueResource(appSettingsHome: URI): URI {
	return joinPath(appSettingsHome, 'globalStorage', EXTERNAL_AGENTS_CATALOGUE_FILENAME);
}

/**
 * Host-side, read-only view of the external agent catalogue. The renderer
 * owns writes (settings UI); the host watches the file so enabling or
 * disabling an agent takes effect without a relaunch.
 */
export class ExternalAgentCatalogueService extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<IExternalAgentCatalogue>());
	readonly onDidChange: Event<IExternalAgentCatalogue> = this._onDidChange.event;

	private _catalogue: IExternalAgentCatalogue = emptyExternalAgentCatalogue();
	private readonly _reload: RunOnceScheduler;
	readonly resource: URI;

	constructor(
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this.resource = externalAgentCatalogueResource(environmentService.appSettingsHome);
		this._reload = this._register(new RunOnceScheduler(() => this._load(true), 250));
		// Watch the folder, not the file: the file may not exist until the
		// settings UI writes it, and a watch on a missing path never fires.
		this._register(this._fileService.watch(dirname(this.resource)));
		this._register(this._fileService.onDidFilesChange(e => {
			if (e.contains(this.resource)) {
				this._reload.schedule();
			}
		}));
	}

	get catalogue(): IExternalAgentCatalogue {
		return this._catalogue;
	}

	/** Reads the catalogue once; call after construction. */
	async initialize(): Promise<IExternalAgentCatalogue> {
		try {
			await this._fileService.createFolder(dirname(this.resource));
		} catch (err) {
			this._logService.warn('[ACP] could not create the catalogue folder', err);
		}
		await this._load(false);
		return this._catalogue;
	}

	private async _load(fire: boolean): Promise<void> {
		let text: string | undefined;
		try {
			text = (await this._fileService.readFile(this.resource)).value.toString();
		} catch (err) {
			if (!(err instanceof FileOperationError && err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this._logService.warn('[ACP] failed to read external agent catalogue', err);
			}
		}
		this._catalogue = parseExternalAgentCatalogue(text);
		if (fire) {
			this._onDidChange.fire(this._catalogue);
		}
	}

	/**
	 * Checks, without executing anything, whether the entry's launch command
	 * resolves on `PATH`. The result is shown to the user as the provider's
	 * description so a missing runtime is visible before the first message.
	 */
	async probe(entry: IExternalAgentEntry): Promise<IExternalAgentProbe> {
		const launch = resolveExternalAgentLaunch(entry);
		if (!launch) {
			return { launch: undefined, ok: false, status: 'No launch command for this platform' };
		}
		const env = { ...process.env, ...(launch.env ?? {}) };
		const resolved = await findExecutable(launch.command, undefined, undefined, env).catch(() => undefined);
		if (!resolved) {
			return { launch, ok: false, status: `Command not found: ${launch.command}` };
		}
		return { launch, ok: true, status: entry.description ?? `Runs "${launch.command}" over the Agent Client Protocol` };
	}
}
