/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Renderer-side proxy for the 3-layer memory store (Build Packet 1).
 *
 * GLOBAL layer: explicit user-profile recall only when scope=global is requested.
 * WORKSPACE layer: opened-folder store — chat_events, editorial, project rollup.
 *
 * An open workspace is a hard isolation boundary: automatic injection and default
 * search never merge another project's facts through the global store.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import {
	ChatEvent, ChatEventInput, WsFact, WsFactKind, MemorySnapshot, AgentRole,
	EditorialBranch, EscalationLogEntry, SearchChatOpts, LearnedProcedure, ProcedureTarget,
	TimelineEntry, TimelineHydration, ShadowHit, ShadowRecord, MemoryCheckpoint,
	CreateMemoryCheckpointInput, MemoryCheckpointEvidence, MemoryIndexDocument, MemoryStats,
	MemorySearchHit, SearchMemoryOptions,
} from '../common/memory/memoryTypes.js';
import { automaticMemoryTarget, memorySearchTargets, workspaceMemoryIdentity } from '../common/memory/memoryScopePolicy.js';
import { ContextBridgeScope, IContextBridgeScopeService, V3CODE_GLOBAL_WORKSPACE_ID } from '../common/contextBridge/contextBridgeScopeService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { resolveChatJsonlPath, resolveProfilePaths, resolveShadowDir, resolveWorkspacePaths, workspaceIdMarkerUri } from '../common/contextBridge/memoryAddress.js';
import { buildCompactionBoundaryChannelParams, CompactionBoundaryCheckpointInput } from '../common/memory/compactionBoundaryContract.js';
import { ISemanticEmbedService } from './semanticEmbedProxy.js';
import { IBeastService } from './beastService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { isUUID } from '../../../../base/common/uuid.js';
import { SymbolNote } from '../common/contextBridge/contextBridgeTypes.js';
import {
	dedupeSessionAnchors, PendingSessionTransition, SessionAnchor, SessionAnchorInput, SessionContinuitySummary,
	SessionTransitionKind, SessionWorkspaceTransition, sessionAnchorUpdateIdentity,
	isActivePlanPayload, isPendingTransitionFresh, stableAnchorId, summarizeSessionContinuity, transitionId, transitionShapeMatches,
	mayAttributeLegacyThreadlessMemory, mayRecoverSessionOrigin,
} from '../common/memory/sessionAnchors.js';

export type RecordInput = Omit<ChatEventInput, 'workspaceId'>;
export type UpsertFactInput = {
	kind: WsFactKind; subject: string; body: string;
	confidence?: number; priority?: number; source?: string[]; meta?: Record<string, unknown>;
};
export type MemoryFactTarget = 'workspace' | 'global';
export type SessionStateKey = 'durable-task' | 'active-plan';
export type SessionStateRecord = { value: string; revision: number; updatedAt: number };
export type SessionAnchorWrite = Omit<SessionAnchorInput, 'profileId' | 'originWorkspaceId' | 'originRoot'> & {
	originWorkspaceId?: string;
	originRoot?: string;
};
export type SessionAnchorRecoveryResult = { imported: number; skipped: string[]; missing: string[] };

export interface IMemoryService {
	readonly _serviceBrand: undefined;
	/** True when memory is usable (global store is always on; workspace needs an open folder). */
	readonly isAvailable: boolean;
	readonly hasWorkspace: boolean;
	record(input: RecordInput, expectedWorkspaceIdentity?: string): Promise<ChatEvent | null>;
	getSession(sessionId: string): Promise<ChatEvent[]>;
	searchChat(query: string, opts?: SearchChatOpts): Promise<ChatEvent[]>;
	getThread(eventId: string): Promise<ChatEvent[]>;
	createCheckpoint(input: CreateMemoryCheckpointInput, expectedWorkspaceIdentity?: string): Promise<MemoryCheckpoint | null>;
	/** Atomic compaction/digest boundary write: the summary note and its checkpoint land
	 *  together or not at all (single DB transaction in electron-main). Returns null when
	 *  memory scope/identity is unavailable; throws with the exact failing stage otherwise. */
	recordCompactionBoundary(
		note: RecordInput,
		checkpoint: CompactionBoundaryCheckpointInput,
		expectedWorkspaceIdentity?: string,
	): Promise<{ note: ChatEvent; checkpoint: MemoryCheckpoint } | null>;
	/** True when a complete checkpoint exists for the given end event. Boundary restores
	 *  must require this — a note without its checkpoint is an aborted write, never a boundary. */
	hasCheckpointForEndEvent(endEventId: string): Promise<boolean>;
	getSessionState(sessionId: string, stateKey: SessionStateKey): Promise<SessionStateRecord | null>;
	putSessionState(sessionId: string, stateKey: SessionStateKey, value: string, expectedRevision: number | null): Promise<(SessionStateRecord & { saved: boolean })>;
	deleteSessionState(sessionId: string, stateKey: SessionStateKey): Promise<void>;
	upsertSessionAnchor(anchor: SessionAnchorWrite): Promise<SessionAnchor | null>;
	listSessionAnchors(threadId: string, includeDeleted?: boolean): Promise<SessionAnchor[]>;
	getSessionContinuity(threadId: string): Promise<SessionContinuitySummary>;
	/** Fires when a workspace swap's transition is recorded for a thread (including the
	 *  reload-reconciled case, where the original renderer is gone) with what carried. */
	readonly onDidCompleteSessionTransition: Event<{ threadId: string; summary: SessionContinuitySummary }>;
	listSessionTransitions(threadId: string): Promise<SessionWorkspaceTransition[]>;
	beginSessionTransition(threadId: string, kind: SessionTransitionKind, targetRoot: string): Promise<string | null>;
	cancelSessionTransition(token: string | null): void;
	recoverSessionAnchors(threadId: string, originRoot?: string, confirmed?: boolean): Promise<SessionAnchorRecoveryResult>;
	listCheckpoints(sessionId?: string, limit?: number): Promise<MemoryCheckpoint[]>;
	getCheckpoint(checkpointId: string, includeEvents?: boolean, eventPage?: number, eventPageSize?: number, sessionId?: string): Promise<MemoryCheckpointEvidence | null>;
	/** Index/storage counts for the Memory Ledger's health panels. Null when no folder is open. */
	getStats(): Promise<MemoryStats | null>;
	backfillMemoryFacts(limit?: number): Promise<number>;
	listMemorySessionIds(limit?: number): Promise<string[]>;
	rebuildArchivePages(sessionId: string, batchSize?: number): Promise<number>;
	drainMemoryIndex(limit?: number): Promise<number>;
	searchMemory(query: string, options?: SearchMemoryOptions): Promise<MemorySearchHit[]>;
	searchWorkspace(query: string, limit?: number): Promise<WsFact[]>;
	/** Ranked hybrid search (vector + BM25 -> decay -> MMR). Embeds the query via the
	 *  shared embedder when memoryLibraryV2 is on; otherwise BM25-only. */
	rankedSearch(query: string, limit?: number): Promise<WsFact[]>;
	getFactsForFile(path: string): Promise<WsFact[]>;
	getCochange(path: string): Promise<{ file: string; count: number }[]>;
	upsertFact(fact: UpsertFactInput, target?: MemoryFactTarget): Promise<WsFact | null>;
	buildSnapshot(sessionId: string, role: AgentRole, budgetTokens: number, activeContext?: { files?: string[]; symbols?: string[] }): Promise<MemorySnapshot | null>;
	rollup(): Promise<void>;
	/** Embed any facts still waiting (embed_pending=1), in batches, across both stores.
	 *  No-op unless memoryLibraryV2 is on. Returns how many facts it processed. */
	drainEmbeddings(limit?: number): Promise<number>;
	pin(factId: string): Promise<void>;
	correct(factId: string, body: string): Promise<void>;
	forget(factId: string, target?: MemoryFactTarget): Promise<void>;
	recordEscalation(entry: Omit<EscalationLogEntry, 'id' | 'workspaceId'>): Promise<string | null>;
	getProjectReadme(): Promise<string>;
	getEditorialOverview(): Promise<{
		projectId: string | null;
		projectName: string;
		readme: string;
		branches: EditorialBranch[];
	}>;
	getBranches(projectId: string): Promise<EditorialBranch[]>;
	searchEditorial(query: string, crossProject?: boolean): Promise<EditorialBranch[]>;
	writeEditorialBranch(opts: { topic: string; worked?: string; didntWork?: string; buildNotes?: string; miniReadme?: string; mode?: 'append' | 'replace' }): Promise<{ branchId: string; created: boolean; mode: 'append' | 'replace' }>;
	deleteEditorialBranch(opts: { topic: string; section?: 'worked' | 'didnt_work' | 'build_notes' | 'mini_readme' }): Promise<{ deleted: boolean }>;
	migrateSymbolNotes(notes: { filePath: string; symbolName: string; note: string; ts: number }[], target?: MemoryFactTarget): Promise<number>;
	/** Procedural memory (C7): store a verified how-to under a trigger; retrieve from
	 *  the active workspace (or the global store only in an empty window). */
	saveProcedure(p: { triggerPattern: string; steps: string[]; verifiedByTest?: boolean; provenance?: string; target?: ProcedureTarget }): Promise<LearnedProcedure | null>;
	retrieveProcedures(query: string, limit?: number): Promise<LearnedProcedure[]>;
	markProcedureUsed(id: string, target?: ProcedureTarget): Promise<void>;
	/** Phase 3 MemLegend: the workspace memory timeline (rail), newest first, + hydrate one rung. */
	getTimeline(limit?: number): Promise<TimelineEntry[]>;
	hydrateTimeline(id: string): Promise<TimelineHydration | null>;
	/** Break-glass deep search over the raw shadow archive (build packet "shadow memory").
	 *  Reaches records the curated layer decayed/filtered; returns a tight ranked set. */
	deepRecall(query: string, limit?: number): Promise<ShadowHit[]>;
	getShadowRecord(id: string): Promise<ShadowRecord | null>;
}

export const IMemoryService = createDecorator<IMemoryService>('memoryService');

// Renderer-side proxy for the 3-layer persistent memory store — the agent's long-term
// memory system. Every chat turn injects facts from the active workspace store only;
// global recall is explicit. Also owns ranked hybrid search (vector+BM25),
// editorial rollups, procedural memory, timeline, and break-glass deepRecall over the
// raw shadow archive. All storage lives in the main process; this service talks to it
// over the void-channel-memory IPC channel.
export class MemoryService extends Disposable implements IMemoryService {
	readonly _serviceBrand: undefined;
	private readonly channel: IChannel;
	private pendingTransition: PendingSessionTransition | null = null;
	private readonly _onDidCompleteSessionTransition = this._register(new Emitter<{ threadId: string; summary: SessionContinuitySummary }>());
	readonly onDidCompleteSessionTransition = this._onDidCompleteSessionTransition.event;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IContextBridgeScopeService private readonly scopeService: IContextBridgeScopeService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ISemanticEmbedService private readonly embedService: ISemanticEmbedService,
		@IBeastService private readonly beastService: IBeastService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this.channel = this.mainProcessService.getChannel('void-channel-memory');
		// Startup reconcile AFTER scope resolution: the first swap of a session reloads the
		// window, so its write-ahead pending record can only be completed here, and
		// completing before the scope resolves would compute a wrong destination.
		void this.scopeService.resolve().then(() => this._completePendingTransition());
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			void this._completePendingTransition();
		}));
	}

	private _embeddingsOn(): boolean {
		return !!this.voidSettingsService.state.globalSettings.memoryLibraryV2;
	}

	private async ensureWorkspaceScope(): Promise<ContextBridgeScope | null> {
		await this.scopeService.resolve();
		return this.scopeService.getScope();
	}

	private async ensureGlobalScope(): Promise<ContextBridgeScope> {
		await this.scopeService.resolve();
		return this.scopeService.getGlobalScope();
	}

	private async ensureSessionStateScope(): Promise<{ dbPath: string; workspaceId: string }> {
		// Durable task authority follows the native thread. The existing profile-global DB
		// is the canonical home; workspace files/databases are compatibility projections.
		return this.ensureAnchorScope();
	}

	private async ensureAnchorScope(): Promise<{ dbPath: string; workspaceId: string }> {
		// Session anchors must remain profile-isolated even while the optional v2 memory
		// library is disabled. Reuse its already-established per-profile global DB path;
		// do not fall back to the legacy shared global database.
		const paths = resolveProfilePaths(this.environmentService.userRoamingDataHome, this.scopeService.getProfileId());
		return { dbPath: paths.globalDbPath, workspaceId: V3CODE_GLOBAL_WORKSPACE_ID };
	}

	private async currentOrigin(): Promise<{ workspaceId: string; root: string }> {
		const scope = await this.ensureWorkspaceScope();
		return {
			workspaceId: scope?.workspaceId ?? V3CODE_GLOBAL_WORKSPACE_ID,
			root: scope?.folderUri?.scheme === 'file' ? scope.folderUri.fsPath : (scope?.folderUri?.toString(true) ?? ''),
		};
	}

	private async scopeFor(target: MemoryFactTarget): Promise<{ dbPath: string; workspaceId: string } | null> {
		return target === 'global' ? await this.ensureGlobalScope() : await this.ensureWorkspaceScope();
	}

	get isAvailable(): boolean {
		return true;
	}

	get hasWorkspace(): boolean {
		return this.workspaceService.getWorkspace().folders.length > 0;
	}

	private _workspaceIdentity(): string {
		return workspaceMemoryIdentity(this.workspaceService.getWorkspace().folders.map(folder => folder.uri.toString()));
	}

	private async _workspaceRead<T>(
		fallback: T,
		read: (scope: { dbPath: string; workspaceId: string; wsId?: string }) => Promise<T>,
	): Promise<T> {
		const workspaceIdentity = this._workspaceIdentity();
		const scope = await this.ensureWorkspaceScope();
		if (!scope || workspaceIdentity !== this._workspaceIdentity()) return fallback;
		const result = await read(scope);
		return workspaceIdentity === this._workspaceIdentity() ? result : fallback;
	}

	// Records a single chat event (prompt, reply, tool call, diff, decision, phase,
	// escalation, note) into the workspace memory store. Also writes a raw copy to the
	// shadow archive (chat JSONL) when memoryLibraryV2 is on, so deepRecall can reach
	// events the curated layer filtered out. Returns the stored event or null if no
	// workspace is open.
	async record(input: RecordInput, expectedWorkspaceIdentity?: string): Promise<ChatEvent | null> {
		if (expectedWorkspaceIdentity && expectedWorkspaceIdentity !== this._workspaceIdentity()) return null;
		const s = await this.ensureWorkspaceScope();
		if (!s) return null;
		if (expectedWorkspaceIdentity && expectedWorkspaceIdentity !== this._workspaceIdentity()) return null;
		const useV2 = !!this.voidSettingsService.state.globalSettings.memoryLibraryV2;
		const chatJsonlPath = useV2 && s.wsId
			? resolveChatJsonlPath(this.environmentService.userRoamingDataHome, s.wsId, input.sessionId)
			: undefined;
		// The raw shadow archive (everything, never deleted). Same flag-gate as the chat floor.
		const shadowDir = useV2 && s.wsId
			? resolveShadowDir(this.environmentService.userRoamingDataHome, s.wsId)
			: undefined;
		return this.channel.call('record', {
			dbPath: s.dbPath,
			chatJsonlPath,
			shadowDir,
			input: { ...input, workspaceId: s.workspaceId },
		});
	}

	async getSession(sessionId: string): Promise<ChatEvent[]> {
		return this._workspaceRead([], s => this.channel.call('getSession', { dbPath: s.dbPath, sessionId }));
	}

	async searchChat(query: string, opts?: SearchChatOpts): Promise<ChatEvent[]> {
		return this._workspaceRead([], s => this.channel.call('searchChat', { dbPath: s.dbPath, workspaceId: s.workspaceId, query, opts }));
	}

	async getThread(eventId: string): Promise<ChatEvent[]> {
		return this._workspaceRead([], s => this.channel.call('getThread', { dbPath: s.dbPath, eventId }));
	}

	async createCheckpoint(input: CreateMemoryCheckpointInput, expectedWorkspaceIdentity?: string): Promise<MemoryCheckpoint | null> {
		if (expectedWorkspaceIdentity && expectedWorkspaceIdentity !== this._workspaceIdentity()) return null;
		const s = await this.ensureWorkspaceScope();
		if (!s) return null;
		if (expectedWorkspaceIdentity && expectedWorkspaceIdentity !== this._workspaceIdentity()) return null;
		const checkpoint = await this.channel.call('createMemoryCheckpoint', { dbPath: s.dbPath, workspaceId: s.workspaceId, input }) as MemoryCheckpoint | null;
		if (checkpoint) await this._anchorCheckpoint(checkpoint, s.workspaceId, s.folderUri);
		return checkpoint;
	}

	async recordCompactionBoundary(
		note: RecordInput,
		checkpoint: CompactionBoundaryCheckpointInput,
		expectedWorkspaceIdentity?: string,
	): Promise<{ note: ChatEvent; checkpoint: MemoryCheckpoint } | null> {
		if (expectedWorkspaceIdentity && expectedWorkspaceIdentity !== this._workspaceIdentity()) return null;
		const s = await this.ensureWorkspaceScope();
		if (!s) return null;
		if (expectedWorkspaceIdentity && expectedWorkspaceIdentity !== this._workspaceIdentity()) return null;
		const useV2 = !!this.voidSettingsService.state.globalSettings.memoryLibraryV2;
		const chatJsonlPath = useV2 && s.wsId
			? resolveChatJsonlPath(this.environmentService.userRoamingDataHome, s.wsId, note.sessionId)
			: undefined;
		const shadowDir = useV2 && s.wsId
			? resolveShadowDir(this.environmentService.userRoamingDataHome, s.wsId)
			: undefined;
		const pair = await this.channel.call('recordCompactionBoundary', buildCompactionBoundaryChannelParams(
			s,
			note,
			checkpoint,
			chatJsonlPath,
			shadowDir,
		)) as { note: ChatEvent; checkpoint: MemoryCheckpoint };
		await this._anchorCheckpoint(pair.checkpoint, s.workspaceId, s.folderUri);
		return pair;
	}

	private async _anchorCheckpoint(checkpoint: MemoryCheckpoint, originWorkspaceId: string, folderUri?: import('../../../../base/common/uri.js').URI): Promise<void> {
		const originRoot = folderUri?.scheme === 'file' ? folderUri.fsPath : (folderUri?.toString(true) ?? '');
		await this.upsertSessionAnchor({
			anchorId: stableAnchorId('snapshot', checkpoint.sessionId, checkpoint.id),
			threadId: checkpoint.sessionId,
			originWorkspaceId,
			originRoot,
			kind: 'snapshot',
			relativePath: checkpoint.id,
			updateIdentity: sessionAnchorUpdateIdentity(checkpoint),
			payload: checkpoint,
			updatedAt: checkpoint.createdAt,
		}).catch(() => { /* checkpoint is still durable in its origin DB; continuity reports what is actually anchored */ });
	}

	async hasCheckpointForEndEvent(endEventId: string): Promise<boolean> {
		return this._workspaceRead(false, s => this.channel.call('hasCompleteCheckpointForEndEvent', { dbPath: s.dbPath, workspaceId: s.workspaceId, endEventId }));
	}

	async getSessionState(sessionId: string, stateKey: SessionStateKey): Promise<SessionStateRecord | null> {
		const workspaceIdentity = this._workspaceIdentity();
		const scope = await this.ensureSessionStateScope();
		if (workspaceIdentity !== this._workspaceIdentity()) return null;
		const canonical = await this.channel.call('getSessionState', { dbPath: scope.dbPath, workspaceId: scope.workspaceId, sessionId, stateKey }) as SessionStateRecord | null;
		if (canonical || workspaceIdentity !== this._workspaceIdentity()) return canonical;
		// One-time compatibility adoption from the pre-portability workspace row. This
		// reads only the active workspace and copies only the same native session key.
		const legacy = await this.ensureWorkspaceScope();
		if (!legacy || legacy.dbPath === scope.dbPath || workspaceIdentity !== this._workspaceIdentity()) return null;
		const prior = await this.channel.call('getSessionState', { dbPath: legacy.dbPath, workspaceId: legacy.workspaceId, sessionId, stateKey }) as SessionStateRecord | null;
		if (!prior || workspaceIdentity !== this._workspaceIdentity()) return null;
		const adopted = await this.channel.call('putSessionState', {
			dbPath: scope.dbPath, workspaceId: scope.workspaceId, sessionId, stateKey,
			value: prior.value, expectedRevision: null,
		}) as SessionStateRecord & { saved: boolean };
		return adopted.saved ? adopted : await this.channel.call('getSessionState', { dbPath: scope.dbPath, workspaceId: scope.workspaceId, sessionId, stateKey });
	}

	async putSessionState(sessionId: string, stateKey: SessionStateKey, value: string, expectedRevision: number | null): Promise<SessionStateRecord & { saved: boolean }> {
		const workspaceIdentity = this._workspaceIdentity();
		const scope = await this.ensureSessionStateScope();
		if (workspaceIdentity !== this._workspaceIdentity()) return { saved: false, value: '', revision: 0, updatedAt: 0 };
		return this.channel.call('putSessionState', { dbPath: scope.dbPath, workspaceId: scope.workspaceId, sessionId, stateKey, value, expectedRevision });
	}

	async deleteSessionState(sessionId: string, stateKey: SessionStateKey): Promise<void> {
		const workspaceIdentity = this._workspaceIdentity();
		const scope = await this.ensureSessionStateScope();
		if (workspaceIdentity !== this._workspaceIdentity()) return;
		await this.channel.call('deleteSessionState', { dbPath: scope.dbPath, workspaceId: scope.workspaceId, sessionId, stateKey });
	}

	async upsertSessionAnchor(anchor: SessionAnchorWrite): Promise<SessionAnchor | null> {
		if (!anchor.threadId?.trim()) return null;
		const global = await this.ensureAnchorScope();
		const origin = await this.currentOrigin();
		const input: SessionAnchorInput = {
			...anchor,
			profileId: this.scopeService.getProfileId(),
			originWorkspaceId: anchor.originWorkspaceId ?? origin.workspaceId,
			originRoot: anchor.originRoot ?? origin.root,
		};
		return this.channel.call('upsertSessionAnchor', { dbPath: global.dbPath, anchor: input });
	}

	async listSessionAnchors(threadId: string, includeDeleted = false): Promise<SessionAnchor[]> {
		if (!threadId?.trim()) return [];
		const global = await this.ensureAnchorScope();
		const rows = await this.channel.call('listSessionAnchors', {
			dbPath: global.dbPath,
			profileId: this.scopeService.getProfileId(),
			threadId,
			includeDeleted,
		}) as SessionAnchor[];
		return dedupeSessionAnchors(rows, includeDeleted);
	}

	async getSessionContinuity(threadId: string): Promise<SessionContinuitySummary> {
		const origin = await this.currentOrigin();
		const anchors = await this.listSessionAnchors(threadId);
		return summarizeSessionContinuity(threadId, origin.workspaceId, origin.root, anchors);
	}

	async listSessionTransitions(threadId: string): Promise<SessionWorkspaceTransition[]> {
		if (!threadId?.trim()) return [];
		const global = await this.ensureAnchorScope();
		return this.channel.call('listSessionTransitions', {
			dbPath: global.dbPath,
			profileId: this.scopeService.getProfileId(),
			threadId,
		});
	}

	async beginSessionTransition(threadId: string, kind: SessionTransitionKind, targetRoot: string): Promise<string | null> {
		if (!threadId?.trim() || !targetRoot.trim()) return null;
		const origin = await this.currentOrigin();
		const createdAt = Date.now();
		const token = `${threadId}:${createdAt}:${Math.random().toString(36).slice(2)}`;
		const pending: PendingSessionTransition = {
			token, profileId: this.scopeService.getProfileId(), threadId, kind, targetRoot,
			fromWorkspaceId: origin.workspaceId, fromRoot: origin.root, createdAt,
		};
		this.pendingTransition = pending;
		// Write-ahead: the replacement swap reloads the window, killing this renderer (and
		// the field above) before any folder-change event fires. The durable row is what
		// the next startup reconciles. Best-effort — a failed write degrades to the old
		// same-renderer behavior, never blocks the swap itself.
		try {
			const global = await this.ensureAnchorScope();
			await this.channel.call('recordPendingSessionTransition', { dbPath: global.dbPath, pending });
		} catch { /* keep the in-memory pending; the in-place swap path still completes it */ }
		return token;
	}

	cancelSessionTransition(token: string | null): void {
		if (!token) return;
		if (this.pendingTransition?.token === token) this.pendingTransition = null;
		// The swap failed or left the workspace unchanged — the write-ahead row must die
		// too, or a later legitimate open of the same target root would "complete" a
		// transition that never happened.
		void this.ensureAnchorScope()
			.then(global => this.channel.call('deletePendingSessionTransition', { dbPath: global.dbPath, token }))
			.catch(() => { });
	}

	private async _completePendingTransition(): Promise<void> {
		const candidates = new Map<string, PendingSessionTransition>();
		if (this.pendingTransition) candidates.set(this.pendingTransition.token, this.pendingTransition);
		try {
			const global = await this.ensureAnchorScope();
			const persisted: PendingSessionTransition[] = await this.channel.call('listPendingSessionTransitions', {
				dbPath: global.dbPath, profileId: this.scopeService.getProfileId(),
			});
			for (const pending of persisted) {
				if (!candidates.has(pending.token)) candidates.set(pending.token, pending);
			}
		} catch { /* persisted pendings unavailable — the in-memory one still completes */ }
		for (const pending of candidates.values()) {
			await this._tryCompleteTransition(pending);
		}
	}

	private async _tryCompleteTransition(pending: PendingSessionTransition): Promise<void> {
		const folders = this.workspaceService.getWorkspace().folders;
		const roots = folders.map(folder => folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString(true));
		// A pending from another window (shared profile DB) whose target doesn't match
		// THIS workspace stays put — the window that actually lands on the target claims it.
		if (!transitionShapeMatches(pending.kind, pending.targetRoot, roots)) return;
		// A stale pending never completes — a shape match hours later is almost surely a
		// fresh unrelated open of the same folder, not the swap resuming. Delete it: it
		// can never legitimately complete after this window.
		if (!isPendingTransitionFresh(pending.createdAt, Date.now())) {
			if (this.pendingTransition?.token === pending.token) this.pendingTransition = null;
			void this.ensureAnchorScope()
				.then(global => this.channel.call('deletePendingSessionTransition', { dbPath: global.dbPath, token: pending.token }))
				.catch(() => { });
			return;
		}
		// Claim the pending transition before awaiting scope resolution so duplicate folder
		// events cannot write duplicates. The transition id is deterministic regardless, and
		// recordSessionTransition inserts with ON CONFLICT DO NOTHING, so a concurrent
		// second window completing the same token is idempotent.
		if (this.pendingTransition?.token === pending.token) this.pendingTransition = null;
		await this.scopeService.resolve();
		const global = await this.ensureAnchorScope();
		void this.channel.call('deletePendingSessionTransition', { dbPath: global.dbPath, token: pending.token }).catch(() => { });
		const destination = await this.currentOrigin();
		if (destination.workspaceId === pending.fromWorkspaceId && pending.kind === 'replacement') return;
		const profileId = this.scopeService.getProfileId();
		const base = {
			profileId,
			threadId: pending.threadId,
			kind: pending.kind,
			fromWorkspaceId: pending.fromWorkspaceId,
			fromRoot: pending.fromRoot,
			toWorkspaceId: destination.workspaceId,
			toRoot: pending.kind === 'multi-root-attach' ? pending.targetRoot : destination.root,
			createdAt: pending.createdAt,
		};
		const transition: SessionWorkspaceTransition = { id: transitionId(base), ...base };
		await this.channel.call('recordSessionTransition', { dbPath: global.dbPath, transition });
		// Warm the canonical thread record. The hook is only a convenience; every reader
		// still resolves anchors directly, so a missed warm cannot lose continuity.
		await this.listSessionAnchors(pending.threadId);
		// Report the manifest: the thread (via chatThreadService) gets told exactly what
		// carried and what stayed behind, instead of discovering a partial carry by accident.
		try {
			const summary = await this.getSessionContinuity(pending.threadId);
			this._onDidCompleteSessionTransition.fire({ threadId: pending.threadId, summary });
		} catch { /* manifest is informational */ }
	}

	async recoverSessionAnchors(threadId: string, originRoot?: string, confirmed = false): Promise<SessionAnchorRecoveryResult> {
		const result: SessionAnchorRecoveryResult = { imported: 0, skipped: [], missing: [] };
		if (!threadId?.trim()) {
			result.skipped.push('Recovery requires an active native thread id.');
			return result;
		}
		const transitions = await this.listSessionTransitions(threadId);
		const current = await this.currentOrigin();
		const recordedRoots = new Set(transitions.flatMap(transition => [transition.fromRoot, transition.toRoot]).filter(Boolean));
		const selected = originRoot?.trim()
			|| [...transitions].reverse().flatMap(transition => [transition.fromRoot, transition.toRoot]).find(root => root && root !== current.root);
		if (!selected) {
			result.skipped.push('No recorded origin is available. Supply origin_root with confirmed=true.');
			return result;
		}
		if (!isAbsolute(selected)) {
			result.skipped.push('origin_root must be an absolute local folder path.');
			return result;
		}
		if (!mayRecoverSessionOrigin(selected, recordedRoots, confirmed)) {
			result.skipped.push('Origin is not tied to this thread transition history; explicit confirmation is required.');
			return result;
		}

		const transition = [...transitions].reverse().find(item => item.fromRoot === selected || item.toRoot === selected);
		const originWorkspaceId = transition
			? (transition.fromRoot === selected ? transition.fromWorkspaceId : transition.toWorkspaceId)
			: `confirmed-origin:${selected}`;
		const rootUri = URI.file(selected);
		const readJson = async (uri: URI): Promise<unknown | undefined> => {
			if (!(await this.fileService.exists(uri))) { result.missing.push(uri.fsPath); return undefined; }
			try { return JSON.parse((await this.fileService.readFile(uri)).value.toString()) as unknown; }
			catch { result.skipped.push(`Unreadable JSON: ${uri.fsPath}`); return undefined; }
		};

		const planUri = joinPath(rootUri, '.v3code', 'active-plan.json');
		const plan = await readJson(planUri);
		if (plan !== undefined) {
			if (isActivePlanPayload(plan) && plan.threadId === threadId) {
				await this.upsertSessionAnchor({
					anchorId: stableAnchorId('plan', threadId, 'active-plan'), threadId, kind: 'plan',
					originWorkspaceId, originRoot: selected,
					updateIdentity: sessionAnchorUpdateIdentity(plan), payload: plan, updatedAt: plan.updatedAt,
				});
				result.imported++;
			} else {
				result.skipped.push(`Plan did not belong to active thread: ${planUri.fsPath}`);
			}
		}

		const notesUri = joinPath(rootUri, '.context-bridge', 'notes.json');
		const notesFile = await readJson(notesUri);
		if (notesFile !== undefined) {
			if (!mayAttributeLegacyThreadlessMemory(confirmed)) {
				result.skipped.push('Legacy notes have no thread identity; confirmed=true is required before attributing them to this thread.');
			} else {
				const notes = notesFile && typeof notesFile === 'object' && Array.isArray((notesFile as { notes?: unknown[] }).notes)
					? (notesFile as { notes: SymbolNote[] }).notes
					: [];
				for (const note of notes) {
					if (!note?.id || note.filePath === '__team__') continue;
					const recoveredNote: SymbolNote = { ...note, threadId };
					await this.upsertSessionAnchor({
						anchorId: stableAnchorId('note', threadId, note.id), threadId, kind: 'note',
						originWorkspaceId, originRoot: selected, relativePath: note.filePath, symbol: note.symbolName,
						updateIdentity: sessionAnchorUpdateIdentity(recoveredNote), payload: recoveredNote,
						updatedAt: Date.parse(note.updatedAt) || Date.parse(note.createdAt) || Date.now(),
					});
					result.imported++;
				}
			}
		}

		const dbCandidates: Array<{ dbPath: string; workspaceId: string }> = [];
		let v2WorkspaceId = isUUID(originWorkspaceId) ? originWorkspaceId : undefined;
		if (!v2WorkspaceId) {
			const marker = workspaceIdMarkerUri(rootUri);
			if (await this.fileService.exists(marker)) {
				const markerId = (await this.fileService.readFile(marker)).value.toString().trim();
				if (isUUID(markerId)) v2WorkspaceId = markerId;
				else result.skipped.push(`Invalid workspace memory marker: ${marker.fsPath}`);
			}
		}
		if (v2WorkspaceId) {
			const v2 = resolveWorkspacePaths(this.environmentService.userRoamingDataHome, v2WorkspaceId, this.scopeService.getProfileId());
			dbCandidates.push({ dbPath: v2.dbPath, workspaceId: v2WorkspaceId });
		}
		dbCandidates.push({ dbPath: joinPath(rootUri, '.context-bridge', 'memory.db').fsPath, workspaceId: rootUri.toString() });
		let foundDb = false;
		for (const candidate of dbCandidates) {
			if (!(await this.fileService.exists(URI.file(candidate.dbPath)))) continue;
			foundDb = true;
			const checkpoints = await this.channel.call('listMemoryCheckpoints', {
				dbPath: candidate.dbPath, workspaceId: candidate.workspaceId, sessionId: threadId, limit: 500,
			}) as MemoryCheckpoint[];
			for (const checkpoint of checkpoints) {
				await this.upsertSessionAnchor({
					anchorId: stableAnchorId('snapshot', threadId, checkpoint.id), threadId, kind: 'snapshot',
					originWorkspaceId, originRoot: selected, relativePath: checkpoint.id,
					updateIdentity: sessionAnchorUpdateIdentity(checkpoint), payload: checkpoint, updatedAt: checkpoint.createdAt,
				});
				result.imported++;
			}
			if (mayAttributeLegacyThreadlessMemory(confirmed)) {
				const overview = await this.channel.call('getEditorialOverview', { dbPath: candidate.dbPath, workspaceId: candidate.workspaceId }) as { branches: EditorialBranch[] };
				for (const branch of overview.branches ?? []) {
					await this.upsertSessionAnchor({
						anchorId: stableAnchorId('editorial', threadId, branch.id), threadId, kind: 'editorial',
						originWorkspaceId, originRoot: selected, symbol: branch.name,
						updateIdentity: sessionAnchorUpdateIdentity(branch), payload: branch, updatedAt: branch.tsUpdated,
					});
					result.imported++;
				}
			} else {
				result.skipped.push('Legacy editorial rows have no thread identity; confirmed=true is required before attribution.');
			}
			break;
		}
		if (!foundDb) result.missing.push(`${selected}/.context-bridge/memory.db or profile workspace memory.db`);
		return result;
	}

	async listCheckpoints(sessionId?: string, limit = 50): Promise<MemoryCheckpoint[]> {
		const local = await this._workspaceRead([], s => this.channel.call('listMemoryCheckpoints', { dbPath: s.dbPath, workspaceId: s.workspaceId, sessionId, limit })) as MemoryCheckpoint[];
		if (!sessionId) return local;
		const carried = (await this.listSessionAnchors(sessionId))
			.filter(anchor => anchor.kind === 'snapshot' && anchor.payload && typeof anchor.payload === 'object')
			.map(anchor => anchor.payload as MemoryCheckpoint);
		const byId = new Map<string, MemoryCheckpoint>();
		for (const checkpoint of [...local, ...carried]) byId.set(checkpoint.id, checkpoint);
		return [...byId.values()].sort((a, b) => b.endedAt - a.endedAt || a.id.localeCompare(b.id)).slice(0, limit);
	}

	async getCheckpoint(checkpointId: string, includeEvents = true, eventPage = 1, eventPageSize = 50, sessionId?: string): Promise<MemoryCheckpointEvidence | null> {
		const local = await this._workspaceRead(null, async s => {
			if (!includeEvents) {
				const checkpoint = await this.channel.call('getMemoryCheckpoint', { dbPath: s.dbPath, workspaceId: s.workspaceId, checkpointId }) as MemoryCheckpoint | null;
				return checkpoint ? { checkpoint, events: [], page: 1, totalPages: 1, rawAvailable: checkpoint.status === 'complete' } : null;
			}
			return this.channel.call('getMemoryCheckpointEvidence', { dbPath: s.dbPath, workspaceId: s.workspaceId, checkpointId, page: eventPage, pageSize: eventPageSize });
		});
		if (local) return local;
		// Carried checkpoints remain visible even if their source event range is not in
		// the destination database. Report that honestly instead of claiming it vanished.
		const anchor = sessionId
			? (await this.listSessionAnchors(sessionId)).find(candidate => candidate.kind === 'snapshot' && candidate.relativePath === checkpointId)
			: undefined;
		const checkpoint = anchor?.payload as MemoryCheckpoint | undefined;
		return checkpoint ? { checkpoint, events: [], page: 1, totalPages: 1, rawAvailable: false } : null;
	}

	async getStats(): Promise<MemoryStats | null> {
		return this._workspaceRead(null, s => this.channel.call('getMemoryStats', { dbPath: s.dbPath, workspaceId: s.workspaceId }));
	}

	async backfillMemoryFacts(limit = 50): Promise<number> {
		const s = await this.ensureWorkspaceScope();
		if (!s) return 0;
		return this.channel.call('backfillMemoryFacts', { dbPath: s.dbPath, workspaceId: s.workspaceId, limit });
	}

	async listMemorySessionIds(limit = 100): Promise<string[]> {
		return this._workspaceRead([], s => this.channel.call('listMemorySessionIds', { dbPath: s.dbPath, workspaceId: s.workspaceId, limit }));
	}

	async rebuildArchivePages(sessionId: string, batchSize = 100): Promise<number> {
		const s = await this.ensureWorkspaceScope();
		if (!s) return 0;
		const pages = await this.channel.call('rebuildMemoryArchivePages', { dbPath: s.dbPath, workspaceId: s.workspaceId, sessionId, batchSize }) as unknown[];
		return pages.length;
	}

	async drainMemoryIndex(limit = 24): Promise<number> {
		if (!this._embeddingsOn()) return 0;
		const s = await this.ensureWorkspaceScope();
		if (!s) return 0;
		const pending = await this.channel.call('getMemoryIndexPending', { dbPath: s.dbPath, workspaceId: s.workspaceId, limit }) as MemoryIndexDocument[];
		if (!pending.length) return 0;
		await this.embedService.init();
		const model = await this.embedService.getModelInfo();
		if (!model.modelId) return 0;
		const vectors = await this.embedService.embed(pending.map(document => document.text));
		let stored = 0;
		for (let i = 0; i < pending.length; i++) {
			const vector = vectors[i];
			if (!vector?.length) continue;
			await this.channel.call('storeMemoryIndexEmbedding', { dbPath: s.dbPath, documentId: pending[i].id, text: pending[i].text, modelId: model.modelId, dim: vector.length, vec: Array.from(vector) });
			stored++;
		}
		return stored;
	}

	async searchMemory(query: string, options: SearchMemoryOptions = {}): Promise<MemorySearchHit[]> {
		const workspaceIdentity = this._workspaceIdentity();
		const workspace = await this.ensureWorkspaceScope();
		if (workspaceIdentity !== this._workspaceIdentity()) return [];
		const targets = memorySearchTargets(options.scope, !!workspace);
		const global = targets.global ? await this.ensureGlobalScope() : null;
		if (!workspace && !global) return [];
		let queryVec: number[] | null = null;
		let modelId: string | null = null;
		if (this._embeddingsOn()) {
			try {
				await this.embedService.init();
				const info = await this.embedService.getModelInfo();
				const [vector] = info.modelId ? await this.embedService.embed([query]) : [];
				if (vector?.length) { queryVec = Array.from(vector); modelId = info.modelId; }
			} catch { /* SQLite FTS remains the complete local fallback. */ }
		}
		const searchStore = async (store: { dbPath: string; workspaceId: string } | null, scope: SearchMemoryOptions['scope']) => store
			? this.channel.call('searchMemory', { dbPath: store.dbPath, workspaceId: store.workspaceId, query, queryVec, modelId, options: { ...options, scope } }) as Promise<MemorySearchHit[]>
			: [];
		const [workspaceHits, globalHits] = await Promise.all([
			searchStore(targets.workspace ? workspace : null, options.scope === 'session' ? 'session' : 'workspace'),
			searchStore(global, 'global'),
		]);
		if (workspaceIdentity !== this._workspaceIdentity()) return [];
		const anchorHits: MemorySearchHit[] = [];
		if (options.sessionId && options.scope !== 'global') {
			const terms = query.toLowerCase().split(/\s+/).filter(term => term.length > 1);
			for (const anchor of await this.listSessionAnchors(options.sessionId)) {
				if (options.before !== undefined && anchor.updatedAt >= options.before) continue;
				if (options.after !== undefined && anchor.updatedAt <= options.after) continue;
				const kind = anchor.kind === 'note' ? 'symbol-note' : anchor.kind === 'snapshot' ? 'checkpoint' : 'fact';
				if (options.kinds?.length && !options.kinds.includes(kind)) continue;
				const summary = typeof anchor.payload === 'string' ? anchor.payload : JSON.stringify(anchor.payload);
				const haystack = `${anchor.symbol ?? ''} ${anchor.relativePath ?? ''} ${summary}`.toLowerCase();
				const matched = terms.filter(term => haystack.includes(term)).length;
				if (terms.length && matched === 0 && !haystack.includes(query.toLowerCase())) continue;
				const sourceId = anchor.payload && typeof anchor.payload === 'object' && typeof (anchor.payload as { id?: unknown }).id === 'string'
					? (anchor.payload as { id: string }).id : anchor.anchorId;
				anchorHits.push({
					kind, id: sourceId, workspaceId: anchor.originWorkspaceId, sessionId: anchor.threadId,
					summary, score: terms.length ? 0.55 + 0.35 * (matched / terms.length) : 0.55,
					signals: { lexical: terms.length ? matched / terms.length : 0.5, confidence: 1 },
					rawAvailable: anchor.kind === 'snapshot', sourcePruned: anchor.kind === 'snapshot', ts: anchor.updatedAt,
				});
			}
		}
		const merged = new Map<string, MemorySearchHit>();
		for (const hit of [...workspaceHits, ...globalHits, ...anchorHits]) {
			const key = `${hit.kind}:${hit.id}`;
			const current = merged.get(key);
			if (!current || hit.score > current.score) merged.set(key, hit);
		}
		return [...merged.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, options.limit ?? 12);
	}

	async searchWorkspace(query: string, limit?: number): Promise<WsFact[]> {
		return this._workspaceRead([], ws => this.channel.call('searchWorkspace', { dbPath: ws.dbPath, workspaceId: ws.workspaceId, query, limit }));
	}

	// Hybrid search over the workspace memory store: embeds the query (when v2 is on),
	// runs vector + BM25 scoring, applies decay, then MMR-deduplicates the result set.
	// Falls back to BM25-only if the embedder isn't ready. Returns the top-k workspace
	// facts ranked by relevance to the query.
	async rankedSearch(query: string, limit = 12): Promise<WsFact[]> {
		const workspaceIdentity = this._workspaceIdentity();
		const ws = await this.ensureWorkspaceScope();
		if (!ws || workspaceIdentity !== this._workspaceIdentity()) return [];
		// Embed the query with the shared embedder when v2 is on. Any failure (model not
		// ready, embedder error) falls through to a BM25-only ranking -- never throws.
		let queryVec: number[] | null = null;
		let modelId: string | null = null;
		if (this._embeddingsOn()) {
			try {
				await this.embedService.init();
				const info = await this.embedService.getModelInfo();
				if (info.modelId) {
					const [f32] = await this.embedService.embed([query]);
					if (f32) { queryVec = Array.from(f32); modelId = info.modelId; }
				}
			} catch { /* BM25-only fallback */ }
		}
		const result = await this.channel.call('rankedSearch', {
			dbPath: ws.dbPath, workspaceId: ws.workspaceId, queryText: query, queryVec, modelId, limit,
		}) as WsFact[];
		return workspaceIdentity === this._workspaceIdentity() ? result : [];
	}

	async getFactsForFile(path: string): Promise<WsFact[]> {
		return this._workspaceRead([], ws => this.channel.call('getFactsForFile', { dbPath: ws.dbPath, workspaceId: ws.workspaceId, path }));
	}

	async getCochange(path: string): Promise<{ file: string; count: number }[]> {
		return this._workspaceRead([], s => this.channel.call('getCochange', { dbPath: s.dbPath, workspaceId: s.workspaceId, path }));
	}

	// Creates or updates a durable fact (symbol note, decision, quirk) in the memory
	// store. The fact is persisted across sessions and auto-injected into future turns
	// whose active context matches. After saving, eagerly embeds the fact if v2 is on
	// so it's searchable immediately — if that fails, the drain loop retries later.
	async upsertFact(fact: UpsertFactInput, target: MemoryFactTarget = 'workspace'): Promise<WsFact | null> {
		const s = await this.scopeFor(target);
		if (!s) return null;
		const saved = await this.channel.call('upsertFact', { dbPath: s.dbPath, fact: { ...fact, workspaceId: s.workspaceId } }) as WsFact | null;
		// embed-on-upsert (catalog C3): make the new fact searchable promptly. Best-effort,
		// non-blocking; if it fails the fact stays embed_pending=1 and the drain catches it.
		if (saved && this._embeddingsOn()) {
			const text = [saved.subject, saved.body].filter(Boolean).join('\n');
			void this._embedAndStore(s.dbPath, [{ id: saved.id, text }]).catch(() => { /* drain will retry */ });
		}
		// Beast graph-pull mirror (Phase C2): facts anchored to code also land in the
		// sidecar's memory index, so recall-near-file can pull them via the dependency
		// graph later. Fire-and-forget; the service never throws and re-saving the
		// same text just re-confirms the note (raises its confidence).
		if (saved && target === 'workspace') {
			const fileAnchors = this._codeAnchorsOf(saved);
			if (fileAnchors.length > 0) {
				const text = [saved.subject, saved.body].filter(Boolean).join(' — ');
				void this.beastService.remember(text, { files: fileAnchors });
			}
		}
		return saved;
	}

	/** Workspace-relative file paths a fact is anchored to. `subject` is documented
	 *  as "file path, symbol, or decision title" — symbol notes use
	 *  "path/to/file.ts::symbol"; `meta.files` (when present) lists extra anchors. */
	private _codeAnchorsOf(fact: WsFact): string[] {
		const anchors = new Set<string>();
		const pathLike = (s: string) => s.includes('/') && /\.[a-z0-9]{1,10}(::|$)/i.test(s);
		if (typeof fact.subject === 'string' && pathLike(fact.subject)) {
			anchors.add(fact.subject.split('::')[0]);
		}
		const metaFiles = fact.meta?.['files'];
		if (Array.isArray(metaFiles)) {
			for (const f of metaFiles) {
				if (typeof f === 'string' && pathLike(f)) { anchors.add(f.split('::')[0]); }
			}
		}
		return [...anchors].slice(0, 4);
	}

	// Assembles a token-budgeted memory snapshot for injection into a chat turn.
	// With a folder open, ONLY that workspace store is eligible. This is intentionally
	// stricter than explicit scope=global recall: ambient memory must never pull facts,
	// symbol notes, or embeddings from another project.
	async buildSnapshot(sessionId: string, role: AgentRole, budgetTokens: number, activeContext?: { files?: string[]; symbols?: string[] }): Promise<MemorySnapshot | null> {
		const workspaceIdentity = this._workspaceIdentity();
		const ws = await this.ensureWorkspaceScope();
		if (!ws || workspaceIdentity !== this._workspaceIdentity()) return null;
		const snapshot = await this.channel.call('buildSnapshot', {
			dbPath: ws.dbPath, workspaceId: ws.workspaceId, sessionId, role, budgetTokens, activeContext,
		}) as MemorySnapshot;
		if (workspaceIdentity !== this._workspaceIdentity()) return null;
		if (!snapshot?.symbolFacts?.length && !snapshot?.activeQuirks?.length && !snapshot?.openDecisions?.length && !snapshot?.recentEvents?.length) {
			return null;
		}

		// Beast graph-pull (Phase C2, the Letta-style local path): notes anchored to
		// the dependency-graph NEIGHBORHOOD of the active files — not just the files
		// themselves — scored by confidence/(1+hops) in the sidecar. Store-based
		// matching above only finds facts on the exact file; this reaches the
		// blast radius. Best-effort and bounded: 2 seeds, k=4 each, deduped.
		if (activeContext?.files?.length) {
			try {
				// Distinct FILES, not distinct strings: activeContext.files holds
				// both a path and its basename for the same file, which burned
				// both seed slots on one file (audit). beastService normalizes
				// each seed to the sidecar's workspace-relative path universe.
				const seeds: string[] = [];
				const seenBase = new Set<string>();
				for (const f of activeContext.files) {
					const base = f.replace(/\\/g, '/').split('/').pop() ?? f;
					if (seenBase.has(base)) { continue; }
					seenBase.add(base);
					seeds.push(f);
					if (seeds.length === 2) { break; }
				}
				// Soft budget: the pull rides the PROMPT path — a slow sidecar
				// must cost at most ~1.2s, never the spawn timeout.
				const softBudget = new Promise<null>(r => setTimeout(() => r(null), 1_200));
				const pulls = await Promise.race([
					Promise.all(seeds.map(f => this.beastService.recall({ near: f, k: 4 }))),
					softBudget,
				]);
				if (pulls) {
					// Dedupe against BOTH mirror text forms: facts mirror to beast
					// as `subject — body`, so hit.why embeds that composite while
					// the store fact carries the bare body (audit: the old
					// body-only set could never match).
					const seen = new Set<string>();
					for (const f of snapshot.symbolFacts) {
						seen.add(f.body);
						if (f.subject) { seen.add(`${f.subject} — ${f.body}`); }
					}
					for (let i = 0; i < seeds.length; i++) {
						for (const hit of pulls[i]) {
							const noteText = hit.why.replace(/^.*conf [0-9.]+: /, '');
							if (seen.has(hit.why) || seen.has(noteText) || [...seen].some(t => noteText.length > 8 && t.endsWith(noteText))) { continue; }
							seen.add(hit.why);
							snapshot.symbolFacts.push({ subject: `graph-pull near ${seeds[i]}`, body: hit.why });
						}
					}
				}
			} catch { /* sidecar dark — snapshot stands as-is */ }
		}
		return workspaceIdentity === this._workspaceIdentity() ? snapshot : null;
	}

	async rollup(): Promise<void> {
		const s = await this.ensureWorkspaceScope();
		if (!s) return;
		const projectName = this.workspaceService.getWorkspace().folders[0]?.name?.trim() || undefined;
		await this.channel.call('rollup', { dbPath: s.dbPath, workspaceId: s.workspaceId, projectName });
		// Rollup mints new facts in the main process (they don't pass through embed-on-upsert),
		// so chew through a batch of the pending backlog here -- the "idle drain" trigger.
		if (this._embeddingsOn()) void this.drainEmbeddings().catch(() => { /* best-effort */ });
	}

	// Drains the embed_pending backlog across both global and workspace stores in
	// batches. Called after rollup (which mints new facts outside the embed-on-upsert
	// path) and as a best-effort idle trigger. Embeds each pending fact's text, caches
	// the vector, and stores it via the shared embedder. Returns total facts processed.
	async drainEmbeddings(limit = 32): Promise<number> {
		if (!this._embeddingsOn()) return 0;
		let total = 0;
		const g = await this.ensureGlobalScope();
		total += await this._drainScope(g.dbPath, limit);
		const ws = await this.ensureWorkspaceScope();
		if (ws) total += await this._drainScope(ws.dbPath, limit);
		return total;
	}

	/** Drain one batch of embed_pending facts from a single store. */
	private async _drainScope(dbPath: string, limit: number): Promise<number> {
		const pending = await this.channel.call('getEmbedPending', { dbPath, limit }) as { id: string; text: string }[];
		if (!pending.length) return 0;
		await this._embedAndStore(dbPath, pending);
		return pending.length;
	}

	/** Embed a set of {id,text} facts and store their vectors. Reuses the single shared
	 *  embedder via ISemanticEmbedService; the content cache short-circuits repeats so
	 *  identical text is never re-embedded. Vectors cross IPC as plain number[]. */
	// Embeds a batch of {id, text} facts and stores their vectors in the memory DB.
	// Checks the content cache first so identical text is never re-embedded. Reuses
	// the single shared ISemanticEmbedService instance. Vectors cross the IPC boundary
	// as plain number[] arrays. If the embedder isn't ready, leaves facts as
	// embed_pending=1 for a later drain to retry.
	private async _embedAndStore(dbPath: string, items: { id: string; text: string }[]): Promise<void> {
		if (!items.length) return;
		await this.embedService.init();
		const model = await this.embedService.getModelInfo();
		if (!model.modelId) return; // embedder not ready; leave pending for a later drain
		// Cache lookup first (concurrent) so cached texts skip the embed call entirely.
		const cached = await Promise.all(items.map(it =>
			this.channel.call('getCachedVector', { dbPath, text: it.text, modelId: model.modelId }) as Promise<number[] | null>
		));
		const missIdx: number[] = [];
		for (let i = 0; i < items.length; i++) { if (!cached[i]) missIdx.push(i); }
		const missVecs = missIdx.length ? await this.embedService.embed(missIdx.map(i => items[i].text)) : [];
		let mi = 0;
		for (let i = 0; i < items.length; i++) {
			const vec = cached[i] ?? Array.from(missVecs[mi++] ?? []);
			if (!vec.length) continue;
			await this.channel.call('storeFactEmbedding', {
				dbPath, factId: items[i].id, text: items[i].text, modelId: model.modelId, dim: vec.length, vec,
			});
		}
	}

	async pin(factId: string): Promise<void> {
		const s = await this.ensureWorkspaceScope();
		if (!s) return;
		return this.channel.call('pin', { dbPath: s.dbPath, factId });
	}

	async correct(factId: string, body: string): Promise<void> {
		const s = await this.ensureWorkspaceScope();
		if (!s) return;
		return this.channel.call('correct', { dbPath: s.dbPath, factId, body });
	}

	// Deletes a fact from the memory store by id. Targets workspace or global store.
	// Irreversible — the fact is gone from the curated layer (the shadow archive
	// retains a raw copy if v2 was on when it was recorded).
	async forget(factId: string, target: MemoryFactTarget = 'workspace'): Promise<void> {
		const s = await this.scopeFor(target);
		if (!s) return;
		return this.channel.call('forget', { dbPath: s.dbPath, factId });
	}

	async recordEscalation(entry: Omit<EscalationLogEntry, 'id' | 'workspaceId'>): Promise<string | null> {
		const s = await this.ensureWorkspaceScope();
		if (!s) return null;
		return this.channel.call('recordEscalation', { dbPath: s.dbPath, entry: { ...entry, workspaceId: s.workspaceId } });
	}

	async getProjectReadme(): Promise<string> {
		return this._workspaceRead('', s => this.channel.call('getProjectReadme', { dbPath: s.dbPath, workspaceId: s.workspaceId }));
	}

	async getEditorialOverview(): Promise<{
		projectId: string | null;
		projectName: string;
		readme: string;
		branches: EditorialBranch[];
	}> {
		const empty = { projectId: null, projectName: '', readme: '', branches: [] };
		return this._workspaceRead(empty, s => this.channel.call('getEditorialOverview', { dbPath: s.dbPath, workspaceId: s.workspaceId }));
	}

	async getBranches(projectId: string): Promise<EditorialBranch[]> {
		return this._workspaceRead([], s => this.channel.call('getBranches', { dbPath: s.dbPath, projectId }));
	}

	async searchEditorial(query: string, crossProject?: boolean): Promise<EditorialBranch[]> {
		return this._workspaceRead([], s => this.channel.call('searchEditorial', { dbPath: s.dbPath, query, crossProject: !!crossProject }));
	}

	async writeEditorialBranch(opts: {
		topic: string; worked?: string; didntWork?: string; buildNotes?: string; miniReadme?: string;
		mode?: 'append' | 'replace';
	}): Promise<{ branchId: string; created: boolean; mode: 'append' | 'replace' }> {
		const s = await this.ensureWorkspaceScope();
		if (!s) { throw new Error('workspace memory is not available'); }
		return this.channel.call('writeEditorialBranch', { dbPath: s.dbPath, workspaceId: s.workspaceId, ...opts });
	}

	async deleteEditorialBranch(opts: { topic: string; section?: 'worked' | 'didnt_work' | 'build_notes' | 'mini_readme' }): Promise<{ deleted: boolean }> {
		const s = await this.ensureWorkspaceScope();
		if (!s) { throw new Error('workspace memory is not available'); }
		return this.channel.call('deleteEditorialBranch', { dbPath: s.dbPath, workspaceId: s.workspaceId, ...opts });
	}

	async migrateSymbolNotes(
		notes: { filePath: string; symbolName: string; note: string; ts: number }[],
		target?: MemoryFactTarget,
	): Promise<number> {
		const s = await this.scopeFor(target ?? automaticMemoryTarget(this.hasWorkspace));
		if (!s || !notes.length) return 0;
		return this.channel.call('migrateSymbolNotes', { dbPath: s.dbPath, workspaceId: s.workspaceId, notes });
	}

	async saveProcedure(p: { triggerPattern: string; steps: string[]; verifiedByTest?: boolean; provenance?: string; target?: ProcedureTarget }): Promise<LearnedProcedure | null> {
		const target = p.target ?? 'workspace';
		const s = await this.scopeFor(target);
		if (!s) return null;
		return this.channel.call('saveProcedure', { dbPath: s.dbPath, procedure: { ...p, target, workspaceId: s.workspaceId } });
	}

	async retrieveProcedures(query: string, limit = 5): Promise<LearnedProcedure[]> {
		return this._workspaceRead([], ws => this.channel.call('retrieveProcedures', { dbPath: ws.dbPath, workspaceId: ws.workspaceId, query, limit }));
	}

	async markProcedureUsed(id: string, target: ProcedureTarget = 'workspace'): Promise<void> {
		const s = await this.scopeFor(target);
		if (!s) return;
		return this.channel.call('markProcedureUsed', { dbPath: s.dbPath, id });
	}

	async getTimeline(limit = 100): Promise<TimelineEntry[]> {
		return this._workspaceRead([], s => this.channel.call('getTimeline', { dbPath: s.dbPath, workspaceId: s.workspaceId, limit }));
	}

	async hydrateTimeline(id: string): Promise<TimelineHydration | null> {
		return this._workspaceRead(null, s => this.channel.call('hydrateTimeline', { dbPath: s.dbPath, id }));
	}

	// Break-glass deep search over the raw shadow archive — reaches records the
	// curated memory layer decayed or filtered out. Only active when memoryLibraryV2
	// is on. Searches the shadow JSONL directory for events matching the query,
	// returning a tight ranked set. Use when normal search/rankedSearch didn't find
	// what the agent needs.
	async deepRecall(query: string, limit = 8): Promise<ShadowHit[]> {
		if (!this.voidSettingsService.state.globalSettings.memoryLibraryV2) return [];
		return this._workspaceRead([], s => {
			if (!s.wsId) return Promise.resolve([]);
			const shadowDir = resolveShadowDir(this.environmentService.userRoamingDataHome, s.wsId);
			return this.channel.call('deepRecall', { dbPath: s.dbPath, shadowDir, query, limit });
		});
	}

	async getShadowRecord(id: string): Promise<ShadowRecord | null> {
		if (!this.voidSettingsService.state.globalSettings.memoryLibraryV2) return null;
		return this._workspaceRead(null, s => {
			if (!s.wsId) return Promise.resolve(null);
			const shadowDir = resolveShadowDir(this.environmentService.userRoamingDataHome, s.wsId);
			return this.channel.call('getShadowRecord', { dbPath: s.dbPath, shadowDir, id });
		});
	}
}

registerSingleton(IMemoryService, MemoryService, InstantiationType.Delayed);
