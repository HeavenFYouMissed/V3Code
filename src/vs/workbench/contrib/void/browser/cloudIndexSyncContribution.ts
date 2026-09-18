/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Cloud index sync contribution — wires CloudIndexSyncer to the workbench.
 *
 *  - Automatic for signed-in paid plans; manual settings remain an advanced override.
 *  - Periodic sync with exponential backoff + circuit breaker on failures.
 *  - First run 30s after startup so the local index restores from cache first.
 */

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { cloudIndexConfigurationAffects, deriveCloudIndexWorkspaceId, readCloudIndexSettings } from '../common/cloudIndex/cloudIndexConfiguration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { resolveCloudIndexRepositoryIdentity, CloudIndexRepositoryIdentity } from '../common/cloudIndex/cloudIndexRepositoryIdentity.js';
import { effectiveEmbedIdentity } from '../common/semanticIndex/embedIdentity.js';
import { ISemanticIndexService } from '../common/semanticIndex/semanticIndexTypes.js';
import { CloudIndexQueryResult, CloudSyncSnapshotProvider } from '../common/cloudIndex/cloudIndexProtocol.js';
import { ICloudIndexTransportService } from './cloudIndexProxy.js';
import { ICloudIndexSyncService } from './cloudIndexSyncService.js';
import { CloudIndexSyncer, CloudSyncHost } from './semanticIndex/cloudIndexSyncer.js';
import { IV3CodeAccountService, V3CodeCloudIndexSession } from '../common/v3codeAccountService.js';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_SYNC_DELAY_MS = 30 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const CIRCUIT_BREAKER_FAILURES = 5;

export class CloudIndexSyncContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3codeCloudIndexSync';

	private readonly _timer = this._register(new MutableDisposable());
	private readonly _gitHeadTimer = this._register(new MutableDisposable());
	private _syncer: CloudIndexSyncer | undefined;
	private _consecutiveFailures = 0;
	private _syncStartedAt: number | undefined;
	private _automaticSession: V3CodeCloudIndexSession | undefined;
	private _automaticIdentity: CloudIndexRepositoryIdentity | undefined;
	private _configurationGeneration = 0;
	private _lastAccountEligible = false;
	private _lastPrivacyMode = false;
	private _lastEmbedIdentity = '';
	private _notifiedContributionBlock = '';

	constructor(
		@ISemanticIndexService private readonly semanticIndexService: ISemanticIndexService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IV3CodeAccountService private readonly accountService: IV3CodeAccountService,
		@ICloudIndexTransportService private readonly cloudIndexTransport: ICloudIndexTransportService,
		@ICloudIndexSyncService private readonly cloudIndexSyncService: ICloudIndexSyncService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._lastAccountEligible = this._accountEligible();
		this._lastPrivacyMode = this.accountService.getPrivacyMode();
		this._lastEmbedIdentity = this._resolveEmbedIdentity();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (cloudIndexConfigurationAffects(e)) {
				this._reconfigure();
			}
		}));
		this._register(this.accountService.onDidChangeState(() => {
			const eligible = this._accountEligible();
			if (eligible !== this._lastAccountEligible) {
				this._lastAccountEligible = eligible;
				this._reconfigure();
			}
		}));
		this._register(this.accountService.onDidChangePrefs(() => {
			const privacyMode = this.accountService.getPrivacyMode();
			if (privacyMode !== this._lastPrivacyMode) {
				this._lastPrivacyMode = privacyMode;
				this._reconfigure();
			}
		}));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this._reconfigure()));
		this._register(this.workspaceService.onDidChangeWorkbenchState(() => this._reconfigure()));
		this._register(this.semanticIndexService.onDidChangeStatus(() => {
			const identity = this._resolveEmbedIdentity();
			if (identity !== this._lastEmbedIdentity) {
				this._lastEmbedIdentity = identity;
				this._reconfigure();
			}
		}));
		this._register(this.fileService.onDidFilesChange(event => {
			const changed = [...event.rawAdded, ...event.rawUpdated, ...event.rawDeleted]
				.some(resource => /\/(?:\.git|worktrees\/[^/]+)\/HEAD$/.test(resource.path));
			if (!changed) return;
			const timer = setTimeout(() => this._reconfigure(), 150);
			this._gitHeadTimer.value = { dispose: () => clearTimeout(timer) };
		}));
		this.cloudIndexSyncService.registerSyncNow(() => this._runSync(true));
		this.cloudIndexSyncService.registerRetrieve((query, options) => this._runRetrieve(query, options));
		this._reconfigure();
	}

	private _provider(): CloudSyncSnapshotProvider | undefined {
		const svc = this.semanticIndexService as Partial<CloudSyncSnapshotProvider>;
		return typeof svc.getCloudSyncSnapshot === 'function' && typeof svc.getRecentEditRanks === 'function'
			? (svc as CloudSyncSnapshotProvider) : undefined;
	}

	private _resolveEmbedIdentity(): string {
		const status = this.semanticIndexService.getStatus();
		const raw = (status.modelId ?? '').replace(/\s*\((?:cached|hybrid-ipc)\)/g, '').trim();
		return effectiveEmbedIdentity(raw) || 'lexical-only';
	}

	private _accountEligible(): boolean {
		const state = this.accountService.state;
		return state.status === 'signedIn' && state.isPaid && state.tierId !== 'free';
	}

	private _buildManualHost(s: ReturnType<typeof readCloudIndexSettings>): CloudSyncHost | undefined {
		const provider = this._provider();
		if (!provider) {
			return undefined;
		}
		const workspaceId = deriveCloudIndexWorkspaceId(this.workspaceService, s.workspaceId);
		return {
			endpoint: s.endpoint,
			token: s.token,
			workspaceId,
			privacyMode: 'full',
			getSnapshot: () => provider.getCloudSyncSnapshot(),
			getRecentEditRanks: () => provider.getRecentEditRanks(),
			getEmbedIdentity: () => this._resolveEmbedIdentity(),
			log: (m) => this.logService.info(m),
			postJson: (path, body) => this.cloudIndexTransport.postJson(s.endpoint, workspaceId, s.token, path, body),
			onProgress: (p) => this._reportProgress(p),
		};
	}

	private _buildAutomaticHost(session: V3CodeCloudIndexSession, generation: number): CloudSyncHost | undefined {
		const provider = this._provider();
		if (!provider || !session.writeToken) return undefined;
		return {
			endpoint: session.endpoint,
			token: session.writeToken,
			workspaceId: session.workspaceId,
			privacyMode: session.privacyMode,
			getSnapshot: () => provider.getCloudSyncSnapshot(),
			getRecentEditRanks: () => provider.getRecentEditRanks(),
			getEmbedIdentity: () => this._resolveEmbedIdentity(),
			log: (m) => this.logService.info(m),
			postJson: (path, body) => this._postAutomatic(generation, session.workspaceId, path, body),
			onProgress: (p) => this._reportProgress(p),
		};
	}

	private _activateHost(host: CloudSyncHost): void {
		this._syncer = new CloudIndexSyncer(host);
		const blocked = this._syncer.contributionBlock;
		if (blocked) {
			this._pauseForContributionBlock(host.workspaceId, blocked, true);
			return;
		}
		this._notifiedContributionBlock = '';
		this.cloudIndexSyncService.setState({
			enabled: true,
			readOnly: false,
			phase: 'idle',
			workspaceId: host.workspaceId,
			consecutiveFailures: this._consecutiveFailures,
		});
		if (!this._timer.value) {
			this._consecutiveFailures = 0;
			const first = setTimeout(() => { void this._runSync(false); }, FIRST_SYNC_DELAY_MS);
			this._timer.value = { dispose: () => clearTimeout(first) };
		}
	}

	private _pauseForContributionBlock(workspaceId: string, result: import('../common/cloudIndex/cloudIndexProtocol.js').CloudSyncResult, notify: boolean): void {
		this._consecutiveFailures = 0;
		this.cloudIndexSyncService.setState({
			enabled: true,
			readOnly: true,
			phase: 'paused',
			workspaceId,
			lastResult: result,
			consecutiveFailures: 0,
			nextSyncAt: undefined,
		});
		this.logService.warn(`[cloud-index] contribution paused: ${result.error}`);
		const notificationKey = `${workspaceId}:${result.failureCode ?? result.error}`;
		if (notify && notificationKey !== this._notifiedContributionBlock) {
			this._notifiedContributionBlock = notificationKey;
			this.notificationService.notify({
				severity: Severity.Warning,
				message: localize('v3code.cloudIndex.contributionPaused', 'Cloud contribution paused: {0}', result.error ?? 'incompatible local embedding model'),
			});
		}
	}

	private async _configureAutomatic(generation: number): Promise<void> {
		const identity = await resolveCloudIndexRepositoryIdentity(this.workspaceService.getWorkspace(), this.fileService);
		if (generation !== this._configurationGeneration) return;
		const session = await this.accountService.getCloudIndexSession({
			repositoryLocator: identity.repositoryLocator,
			displayName: identity.displayName,
			provider: identity.provider,
			branchName: identity.branchName,
			shareable: identity.shareable,
		});
		if (generation !== this._configurationGeneration) return;
		if (!session) {
			this.cloudIndexSyncService.setState({ enabled: false, readOnly: false, phase: 'off', workspaceId: '' });
			return;
		}
		this._automaticIdentity = identity;
		this._automaticSession = session;
		if (!session.writeToken) {
			this.logService.info(`[cloud-index] shared base ready read-only for ${identity.repositoryLocator}; local index is the live overlay`);
			this.cloudIndexSyncService.setState({ enabled: true, readOnly: true, phase: 'idle', workspaceId: session.workspaceId });
			return;
		}
		const host = this._buildAutomaticHost(session, generation);
		if (!host) {
			this.logService.warn('[cloud-index] semantic index service lacks snapshot provider — automatic sync disabled');
			this.cloudIndexSyncService.setState({ enabled: true, readOnly: false, phase: 'error', workspaceId: session.workspaceId });
			return;
		}
		this.logService.info(`[cloud-index] automatic ${session.team.kind} index ready for ${identity.repositoryLocator} (${session.privacyMode})`);
		this._activateHost(host);
	}

	private async _refreshAutomaticSession(generation: number, expectedWorkspaceId: string): Promise<V3CodeCloudIndexSession> {
		if (generation !== this._configurationGeneration || !this._automaticIdentity) {
			throw new Error('cloud index configuration changed');
		}
		const current = this._automaticSession;
		if (current && current.expiresAt > Date.now() + 2 * 60 * 1000) return current;

		const fresh = await this.accountService.getCloudIndexSession({
			repositoryLocator: this._automaticIdentity.repositoryLocator,
			displayName: this._automaticIdentity.displayName,
			provider: this._automaticIdentity.provider,
			branchName: this._automaticIdentity.branchName,
			shareable: this._automaticIdentity.shareable,
		});
		if (!fresh) throw new Error('paid cloud index session is unavailable');
		if (generation !== this._configurationGeneration) throw new Error('cloud index configuration changed');
		if (fresh.workspaceId !== expectedWorkspaceId) {
			// A team admin connected this repo since the last session. Do not mix a
			// personal snapshot into the new team namespace mid-sync; rebuild cleanly.
			this._automaticSession = fresh;
			queueMicrotask(() => this._reconfigure());
			throw new Error('cloud index space changed; retrying with the shared team index');
		}
		this._automaticSession = fresh;
		return fresh;
	}

	private async _postAutomatic(generation: number, workspaceId: string, path: string, body: unknown): Promise<unknown> {
		let session = await this._refreshAutomaticSession(generation, workspaceId);
		if (!session.writeToken) throw new Error('shared cloud index is read-only for this checkout');
		try {
			return await this.cloudIndexTransport.postJson(session.endpoint, workspaceId, session.writeToken, path, body);
		} catch (error) {
			if (!/HTTP 401/.test(String((error as { message?: string })?.message ?? error))) throw error;
			this._automaticSession = undefined;
			session = await this._refreshAutomaticSession(generation, workspaceId);
			if (!session.writeToken) throw new Error('shared cloud index is read-only for this checkout');
			return this.cloudIndexTransport.postJson(session.endpoint, workspaceId, session.writeToken, path, body);
		}
	}

	private async _postAutomaticRead(generation: number, workspaceId: string, path: string, body: unknown): Promise<unknown> {
		let session = await this._refreshAutomaticSession(generation, workspaceId);
		try {
			return await this.cloudIndexTransport.postJson(session.endpoint, workspaceId, session.readToken, path, body);
		} catch (error) {
			if (!/HTTP 401/.test(String((error as { message?: string })?.message ?? error))) throw error;
			this._automaticSession = undefined;
			session = await this._refreshAutomaticSession(generation, workspaceId);
			return this.cloudIndexTransport.postJson(session.endpoint, workspaceId, session.readToken, path, body);
		}
	}

	private _isCloudQueryResult(value: unknown): value is CloudIndexQueryResult {
		if (!value || typeof value !== 'object') return false;
		const result = value as Partial<CloudIndexQueryResult>;
		if (!Array.isArray(result.hits)) return false;
		return result.hits.every(hit => {
			if (!hit || typeof hit !== 'object') return false;
			const h = hit as Partial<CloudIndexQueryResult['hits'][number]>;
			return typeof h.chunkId === 'string' && typeof h.casKey === 'string'
				&& typeof h.file === 'string' && typeof h.startLine === 'number'
				&& typeof h.endLine === 'number' && typeof h.kind === 'string'
				&& typeof h.name === 'string' && typeof h.language === 'string'
				&& typeof h.score === 'number' && !!h.signals && typeof h.signals === 'object';
		});
	}

	private async _runRetrieve(query: string, options: { topK?: number; files?: string[] }): Promise<CloudIndexQueryResult | undefined> {
		if (!query.trim()) return undefined;
		const s = readCloudIndexSettings(this.configurationService, this.workspaceService);
		try {
			let raw: unknown;
			if (s.enabled && s.endpoint && s.token) {
				const workspaceId = deriveCloudIndexWorkspaceId(this.workspaceService, s.workspaceId);
				raw = await this.cloudIndexTransport.postJson(s.endpoint, workspaceId, s.token, '/retrieve', { query, ...options });
			} else {
				const session = this._automaticSession;
				if (!session || !this._accountEligible() || this.accountService.getPrivacyMode()) return undefined;
				raw = await this._postAutomaticRead(this._configurationGeneration, session.workspaceId, '/retrieve', { query, ...options });
			}
			if (!this._isCloudQueryResult(raw)) throw new Error('cloud index returned an invalid retrieval payload');
			return raw;
		} catch (error) {
			// The local overlay is always useful by itself. A cloud outage must degrade
			// search quality, never turn semantic_search into a failed agent tool.
			this.logService.warn(`[cloud-index] retrieve unavailable; using local overlay: ${String((error as { message?: string })?.message ?? error)}`);
			return undefined;
		}
	}

	private _reconfigure(): void {
		const generation = ++this._configurationGeneration;
		this._timer.clear();
		this._syncer = undefined;
		this._automaticSession = undefined;
		this._automaticIdentity = undefined;
		this._consecutiveFailures = 0;
		const s = readCloudIndexSettings(this.configurationService, this.workspaceService);
		const workspaceId = deriveCloudIndexWorkspaceId(this.workspaceService, s.workspaceId);
		if (s.enabled && s.endpoint && s.token) {
			const host = this._buildManualHost(s);
			if (!host) {
				this.logService.warn('[cloud-index] semantic index service lacks snapshot provider — sync disabled');
				this.cloudIndexSyncService.setState({ enabled: true, readOnly: false, phase: 'error', workspaceId });
				return;
			}
			this._activateHost(host);
			return;
		}

		if (!this._accountEligible() || this.accountService.getPrivacyMode()) {
			this.cloudIndexSyncService.setState({
				enabled: false,
				readOnly: false,
				phase: 'off',
				workspaceId,
				consecutiveFailures: 0,
				nextSyncAt: undefined,
			});
			return;
		}
		// Paid automatic path: the hub supplies endpoint, workspace and a scoped
		// credential. Keep the UI enabled while the bounded request is in flight.
		this.cloudIndexSyncService.setState({
			enabled: true,
			readOnly: false,
			phase: 'idle',
			workspaceId: '',
			consecutiveFailures: 0,
		});
		void this._configureAutomatic(generation);
	}

	private _reportProgress(p: { changedFilesTotal: number; filesProcessed: number; chunksUploaded: number }): void {
		const startedAt = this._syncStartedAt ?? Date.now();
		const elapsedSec = Math.max(0.5, (Date.now() - startedAt) / 1000);
		const chunksPerSecond = p.chunksUploaded / elapsedSec;
		this.cloudIndexSyncService.setState({
			phase: 'syncing',
			changedFilesTotal: p.changedFilesTotal,
			filesProcessed: p.filesProcessed,
			chunksUploaded: p.chunksUploaded,
			chunksPerSecond,
			startedAt,
			consecutiveFailures: this._consecutiveFailures,
		});
	}

	private _backoffMs(): number {
		if (this._consecutiveFailures === 0) {
			return SYNC_INTERVAL_MS;
		}
		const scaled = SYNC_INTERVAL_MS * Math.pow(2, Math.min(this._consecutiveFailures - 1, 4));
		return Math.min(scaled, MAX_BACKOFF_MS);
	}

	private _scheduleNext(delayMs: number): void {
		const nextSyncAt = Date.now() + delayMs;
		this.cloudIndexSyncService.setState({ nextSyncAt, consecutiveFailures: this._consecutiveFailures });
		const t = setTimeout(() => { void this._runSync(false); }, delayMs);
		this._timer.value = { dispose: () => clearTimeout(t) };
	}

	private async _runSync(manual: boolean): Promise<import('../common/cloudIndex/cloudIndexProtocol.js').CloudSyncResult | undefined> {
		if (!this._syncer) {
			if (this._automaticSession && !this._automaticSession.writeToken) {
				const result = { ok: true, error: 'shared base is read-only for this checkout; local index is the live overlay', changedFiles: 0, removedFiles: 0, uploadedChunks: 0, tookMs: 0 };
				this.cloudIndexSyncService.setState({ enabled: true, readOnly: true, phase: 'idle', workspaceId: this._automaticSession.workspaceId, lastResult: result });
				return result;
			}
			const s = readCloudIndexSettings(this.configurationService, this.workspaceService);
			const workspaceId = deriveCloudIndexWorkspaceId(this.workspaceService, s.workspaceId);
			const automaticEligible = this._accountEligible() && !this.accountService.getPrivacyMode();
			const error = automaticEligible
				? 'cloud index session is still provisioning or temporarily unavailable'
				: 'cloud index is available automatically on paid plans (Privacy Mode disables cloud sync)';
			if (manual) {
				this.cloudIndexSyncService.setState({
					enabled: automaticEligible || s.enabled,
					readOnly: false,
					phase: automaticEligible || s.enabled ? 'error' : 'off',
					workspaceId,
					lastResult: { ok: false, error, changedFiles: 0, removedFiles: 0, uploadedChunks: 0, tookMs: 0 },
				});
			}
			return { ok: false, error, changedFiles: 0, removedFiles: 0, uploadedChunks: 0, tookMs: 0 };
		}
		if (this._automaticIdentity && this._automaticSession?.writeToken) {
			const current = await resolveCloudIndexRepositoryIdentity(this.workspaceService.getWorkspace(), this.fileService);
			if (current.repositoryLocator !== this._automaticIdentity.repositoryLocator || current.branchName !== this._automaticIdentity.branchName) {
				this.logService.info('[cloud-index] Git identity changed before sync; refreshing scoped session');
				this._reconfigure();
				return { ok: false, error: 'Git branch changed; cloud index session is refreshing', changedFiles: 0, removedFiles: 0, uploadedChunks: 0, tookMs: 0 };
			}
		}
		if (this._syncer.isRunning) {
			if (!manual) {
				this._scheduleNext(SYNC_INTERVAL_MS);
			}
			return undefined;
		}
		const contributionBlock = this._syncer.contributionBlock;
		if (contributionBlock) {
			this._pauseForContributionBlock(this.cloudIndexSyncService.getState().workspaceId, contributionBlock, manual);
			return contributionBlock;
		}
		if (!manual && this._consecutiveFailures >= CIRCUIT_BREAKER_FAILURES) {
			this.cloudIndexSyncService.setState({ phase: 'paused', consecutiveFailures: this._consecutiveFailures });
			this.logService.warn(`[cloud-index] circuit open after ${this._consecutiveFailures} failures — pausing auto-sync until manual sync`);
			return undefined;
		}
		if (manual) {
			this._consecutiveFailures = 0;
			this.cloudIndexSyncService.resetBackoff();
		}

		this._syncStartedAt = Date.now();
		this.cloudIndexSyncService.setState({
			phase: 'syncing',
			changedFilesTotal: 0,
			filesProcessed: 0,
			chunksUploaded: 0,
			chunksPerSecond: 0,
			startedAt: this._syncStartedAt,
			consecutiveFailures: this._consecutiveFailures,
		});

		const r = await this._syncer!.syncNow();
		this._syncStartedAt = undefined;

		if (!r.ok) {
			if (r.failureCode === 'incompatible-vector-space') {
				this._pauseForContributionBlock(this.cloudIndexSyncService.getState().workspaceId, r, manual);
				return r;
			}
			if (r.error === 'sync already in flight') {
				if (!manual) { this._scheduleNext(SYNC_INTERVAL_MS); }
				return r;
			}
			this._consecutiveFailures++;
			this.logService.warn(`[cloud-index] sync failed (${this._consecutiveFailures}): ${r.error}`);
			this.cloudIndexSyncService.setState({
				phase: this._consecutiveFailures >= CIRCUIT_BREAKER_FAILURES ? 'paused' : 'error',
				lastResult: r,
				chunksPerSecond: 0,
				consecutiveFailures: this._consecutiveFailures,
			});
			if (manual || this._consecutiveFailures <= 2) {
				this.notificationService.notify({
					severity: Severity.Warning,
					message: localize('v3code.cloudIndex.syncFailBg', 'Cloud index sync failed: {0}', r.error ?? 'unknown error'),
				});
			}
			if (!manual) {
				this._scheduleNext(this._backoffMs());
			}
			return r;
		}

		this._consecutiveFailures = 0;
		this.cloudIndexSyncService.setState({
			phase: 'idle',
			lastResult: r,
			chunksPerSecond: 0,
			changedFilesTotal: r.changedFiles,
			filesProcessed: r.changedFiles,
			chunksUploaded: r.uploadedChunks,
			consecutiveFailures: 0,
		});
		if (r.changedFiles > 0 || r.uploadedChunks > 0) {
			this.logService.info(`[cloud-index] synced: ${r.changedFiles} files changed, ${r.uploadedChunks} chunks uploaded in ${r.tookMs}ms`);
			if (manual) {
				this.notificationService.notify({
					severity: Severity.Info,
					message: localize('v3code.cloudIndex.syncOkBg', 'Cloud index synced: {0} files, {1} chunks ({2}ms).', r.changedFiles, r.uploadedChunks, r.tookMs),
				});
			}
		} else {
			this.logService.info('[cloud-index] sync ok — manifest unchanged');
		}

		if (!manual) {
			this._scheduleNext(SYNC_INTERVAL_MS);
		}
		return r;
	}
}

registerWorkbenchContribution2(CloudIndexSyncContribution.ID, CloudIndexSyncContribution, WorkbenchPhase.AfterRestored);
