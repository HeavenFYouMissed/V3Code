/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Memory scope resolution — two isolated stores:
 *
 * 1. GLOBAL (user profile): explicit user-global recall and no-folder sessions.
 *    Path: <userRoamingDataHome>/v3code-memory/{memory.db, notes.json}
 *    (memoryLibraryV2: profiles/<profileId>/global/memory.db)
 *
 * 2. WORKSPACE (opened folder): symbol notes, chat ledger, editorial, and project rollup.
 *    Legacy path: <openedFolder>/.context-bridge/{memory.db, notes.json}
 *    memoryLibraryV2: profiles/<profileId>/workspace/<wsId>/memory.db (UUID keyed)
 *
 * An open workspace is a hard boundary: parent folders and the global store are never
 * merged into its automatic memory. Legacy database migration stays inside that workspace.
 */

import { dirname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoidSettingsService } from '../voidSettingsService.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { resolveProfilePaths } from './memoryAddress.js';
import {
	ensureThreeLayerDirs,
	isLegacyMigrationDone,
	markLegacyMigrationDone,
	resolveWorkspaceAddress,
} from './workspaceRegistry.js';

const STORE_DIR = '.context-bridge';
const MEMORY_DB = 'memory.db';
const NOTES_FILE = 'notes.json';
const GLOBAL_DIR = 'v3code-memory';

/** Stable workspace_id for the user-global SQLite layer. */
export const V3CODE_GLOBAL_WORKSPACE_ID = '__v3code_global__';

export interface ContextBridgeScope {
	memoryRoot: URI;
	dbPath: string;
	workspaceId: string;
	notesUri: URI;
	isGlobal: boolean;
	profileId: string;
	/** The opened root this workspace scope represents. Absent for the profile-global store. */
	folderUri?: URI;
	/** Set when memoryLibraryV2 routes workspace memory by UUID. */
	wsId?: string;
}

export interface IContextBridgeScopeService {
	readonly _serviceBrand: undefined;
	/** Opened-folder project store, or null when no folder is open. */
	getScope(): ContextBridgeScope | null;
	/** User-profile store — always available. */
	getGlobalScope(): ContextBridgeScope;
	getProfileId(): string;
	resolve(): Promise<void>;
}

export const IContextBridgeScopeService = createDecorator<IContextBridgeScopeService>('contextBridgeScopeService');

class ContextBridgeScopeService extends Disposable implements IContextBridgeScopeService {
	_serviceBrand: undefined;
	private workspaceScope: ContextBridgeScope | null = null;
	private workspaceEpoch = 0;
	private globalScope: ContextBridgeScope;

	constructor(
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
	) {
		super();
		this.globalScope = this.buildGlobalScope();
		void this.resolve();
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this.workspaceEpoch++;
			this.workspaceScope = null;
			void this.resolve();
		}));
		this._register(this.userDataProfileService.onDidChangeCurrentProfile(() => {
			this.workspaceEpoch++;
			this.workspaceScope = null;
			this.globalScope = this.buildGlobalScope();
			void this.resolve();
		}));
	}

	getProfileId(): string {
		return this.userDataProfileService.currentProfile.isDefault
			? 'default'
			: this.userDataProfileService.currentProfile.id;
	}

	private useMemoryLibraryV2(): boolean {
		return !!this.voidSettingsService.state.globalSettings.memoryLibraryV2;
	}

	private buildGlobalScope(): ContextBridgeScope {
		const profileId = this.getProfileId();
		if (this.useMemoryLibraryV2()) {
			const profile = resolveProfilePaths(this.environmentService.userRoamingDataHome, profileId);
			return {
				memoryRoot: profile.globalDir,
				dbPath: profile.globalDbPath,
				workspaceId: V3CODE_GLOBAL_WORKSPACE_ID,
				notesUri: joinPath(this.environmentService.userRoamingDataHome, GLOBAL_DIR, NOTES_FILE),
				isGlobal: true,
				profileId,
			};
		}
		const root = joinPath(this.environmentService.userRoamingDataHome, GLOBAL_DIR);
		return {
			memoryRoot: root,
			dbPath: joinPath(root, MEMORY_DB).fsPath,
			workspaceId: V3CODE_GLOBAL_WORKSPACE_ID,
			notesUri: joinPath(root, NOTES_FILE),
			isGlobal: true,
			profileId,
		};
	}

	private buildWorkspaceScope(folderUri: URI): ContextBridgeScope {
		const bridge = joinPath(folderUri, STORE_DIR);
		return {
			memoryRoot: folderUri,
			dbPath: joinPath(bridge, MEMORY_DB).fsPath,
			workspaceId: folderUri.toString(),
			notesUri: joinPath(bridge, NOTES_FILE),
			isGlobal: false,
			profileId: this.getProfileId(),
			folderUri,
		};
	}

	private isCurrentWorkspaceResolution(folderUri: URI, epoch: number): boolean {
		return epoch === this.workspaceEpoch
			&& this.workspaceService.getWorkspace().folders[0]?.uri.toString() === folderUri.toString();
	}

	private async buildWorkspaceScopeV2(folderUri: URI, epoch: number): Promise<ContextBridgeScope | null> {
		const profileId = this.getProfileId();
		const address = await resolveWorkspaceAddress(
			folderUri,
			this.environmentService.userRoamingDataHome,
			this.fileService,
			profileId,
		);
		// Workspace resolution performs filesystem work. A rapid project swap can finish the
		// address lookup for the old root after the new root is already active; do not start
		// directory creation or legacy migration for a scope the editor has abandoned.
		if (!this.isCurrentWorkspaceResolution(folderUri, epoch)) {
			return null;
		}
		await ensureThreeLayerDirs(address, this.fileService);
		if (!this.isCurrentWorkspaceResolution(folderUri, epoch)) {
			return null;
		}
		await this.migrateLegacyWorkspaceDb(folderUri, address.dbPath, address.registryUri, address.wsId);
		if (!this.isCurrentWorkspaceResolution(folderUri, epoch)) {
			return null;
		}
		const bridge = joinPath(folderUri, STORE_DIR);
		return {
			memoryRoot: address.workspaceDir,
			dbPath: address.dbPath,
			workspaceId: address.wsId,
			wsId: address.wsId,
			notesUri: joinPath(bridge, NOTES_FILE),
			isGlobal: false,
			profileId,
			folderUri,
		};
	}

	/** S5: one-time non-destructive copy of legacy folder-local memory.db. */
	private async migrateLegacyWorkspaceDb(
		folderUri: URI,
		newDbPath: string,
		registryUri: URI,
		wsId: string,
	): Promise<void> {
		if (await isLegacyMigrationDone(registryUri, wsId, this.fileService)) {
			return;
		}
		const legacyDbUri = joinPath(folderUri, STORE_DIR, MEMORY_DB);
		const newDbUri = URI.file(newDbPath);
		if (!(await this.fileService.exists(legacyDbUri))) {
			return;
		}
		if (await this.fileService.exists(newDbUri)) {
			await markLegacyMigrationDone(registryUri, wsId, this.fileService);
			return;
		}
		await this.fileService.createFolder(dirname(newDbUri));
		await this.fileService.copy(legacyDbUri, newDbUri);
		await markLegacyMigrationDone(registryUri, wsId, this.fileService);
	}

	getScope(): ContextBridgeScope | null {
		return this.workspaceScope;
	}

	getGlobalScope(): ContextBridgeScope {
		if (this.useMemoryLibraryV2()) {
			const profileId = this.getProfileId();
			const profile = resolveProfilePaths(this.environmentService.userRoamingDataHome, profileId);
			return {
				memoryRoot: profile.globalDir,
				dbPath: profile.globalDbPath,
				workspaceId: V3CODE_GLOBAL_WORKSPACE_ID,
				notesUri: joinPath(this.environmentService.userRoamingDataHome, GLOBAL_DIR, NOTES_FILE),
				isGlobal: true,
				profileId,
			};
		}
		return this.globalScope;
	}

	async resolve(): Promise<void> {
		const epoch = this.workspaceEpoch;
		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) {
			if (epoch === this.workspaceEpoch) this.workspaceScope = null;
			return;
		}
		const folderUri = folders[0].uri;
		let nextScope: ContextBridgeScope | null;
		if (this.useMemoryLibraryV2()) {
			nextScope = await this.buildWorkspaceScopeV2(folderUri, epoch);
		} else {
			nextScope = this.buildWorkspaceScope(folderUri);
		}
		if (!nextScope) {
			return;
		}
		const currentFolder = this.workspaceService.getWorkspace().folders[0]?.uri.toString();
		if (epoch === this.workspaceEpoch && currentFolder === folderUri.toString()) {
			this.workspaceScope = nextScope;
		}
	}

}

registerSingleton(IContextBridgeScopeService, ContextBridgeScopeService, InstantiationType.Eager);
