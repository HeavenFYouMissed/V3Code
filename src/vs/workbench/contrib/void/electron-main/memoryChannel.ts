/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Main-process IPC channel for the 3-layer memory store (Build Packet 1).
 *
 * Registered in app.ts as `void-channel-memory`; the renderer talks to it via
 * the MemoryService proxy (browser/memoryService.ts). Mirrors SemanticEmbedChannel.
 *
 * The renderer cannot run @vscode/sqlite3, so all DB work happens here. One
 * MemoryDatabase per physical db file (one per workspace), lazily opened and
 * cached by path. Every command carries `dbPath` so the channel routes to the
 * right workspace DB without holding renderer state.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../base/common/event.js';
import { MemoryDatabase } from './memory/memoryDatabase.js';
import {
	ChatEventInput, WsFactKind, AgentRole, EscalationLogEntry, LearnedProcedureInput,
} from '../common/memory/memoryTypes.js';

interface DbParam { dbPath: string }

export class MemoryChannel implements IServerChannel {

	private readonly dbs = new Map<string, Promise<MemoryDatabase>>();

	listen(_: unknown, event: string): Event<any> {
		throw new Error(`MemoryChannel has no events. Requested: ${event}`);
	}

	private async getDb(dbPath: string): Promise<MemoryDatabase> {
		let p = this.dbs.get(dbPath);
		if (!p) {
			p = (async () => {
				await fs.mkdir(dirname(dbPath), { recursive: true });
				const db = new MemoryDatabase();
				await db.open(dbPath);
				return db;
			})();
			this.dbs.set(dbPath, p);
			// On open failure, drop the cached promise so a later call can retry.
			p.catch(() => this.dbs.delete(dbPath));
		}
		return p;
	}

	async call(_: unknown, command: string, params?: any): Promise<any> {
		try {
			return await this._dispatch(command, params);
		} catch (e) {
			console.error(`[MemoryChannel] "${command}" error:`, e);
			throw e;
		}
	}

	private async _dispatch(command: string, params: any): Promise<any> {
		// Commands that don't need a DB.
		if (command === 'dispose') return this._dispose();

		const { dbPath } = (params ?? {}) as DbParam;
		if (!dbPath) throw new Error(`MemoryChannel: "${command}" requires dbPath`);
		const db = await this.getDb(dbPath);

		switch (command) {
			case 'open':
				return; // getDb already opened it
			case 'record':
				return db.record(params.input as ChatEventInput, params.chatJsonlPath as string | undefined, params.shadowDir as string | undefined);
			case 'getSession':
				return db.getSession(params.sessionId);
			case 'searchChat':
				return db.searchChat(params.workspaceId, params.query, params.opts);
			case 'getThread':
				return db.getThread(params.eventId);
		case 'createMemoryCheckpoint':
			return db.createMemoryCheckpoint(params.workspaceId, params.input);
		case 'recordCompactionBoundary':
			return db.recordCompactionBoundary(params.workspaceId, params.noteInput as ChatEventInput, params.checkpointInput, params.chatJsonlPath as string | undefined, params.shadowDir as string | undefined);
		case 'hasCompleteCheckpointForEndEvent':
			return db.hasCompleteCheckpointForEndEvent(params.workspaceId, params.endEventId as string);
		case 'getSessionState':
			return db.getSessionState(params.workspaceId, params.sessionId as string, params.stateKey as string);
		case 'putSessionState':
			return db.putSessionState(params.workspaceId, params.sessionId as string, params.stateKey as string, params.value as string, params.expectedRevision as number | null);
		case 'deleteSessionState':
			return db.deleteSessionState(params.workspaceId, params.sessionId as string, params.stateKey as string);
		case 'upsertSessionAnchor':
			return db.upsertSessionAnchor(params.anchor);
		case 'listSessionAnchors':
			return db.listSessionAnchors(params.profileId as string, params.threadId as string, params.includeDeleted === true);
		case 'getSessionAnchor':
			return db.getSessionAnchor(params.profileId as string, params.threadId as string, params.anchorId as string, params.includeDeleted === true);
		case 'recordSessionTransition':
			return db.recordSessionTransition(params.transition);
		case 'listSessionTransitions':
			return db.listSessionTransitions(params.profileId as string, params.threadId as string);
		case 'recordPendingSessionTransition':
			return db.recordPendingSessionTransition(params.pending);
		case 'listPendingSessionTransitions':
			return db.listPendingSessionTransitions(params.profileId as string);
		case 'deletePendingSessionTransition':
			return db.deletePendingSessionTransition(params.token as string);
			case 'listMemoryCheckpoints':
				return db.listMemoryCheckpoints(params.workspaceId, params.sessionId, params.limit);
			case 'getMemoryCheckpoint':
				return db.getMemoryCheckpoint(params.workspaceId, params.checkpointId);
			case 'getMemoryCheckpointEvidence':
				return db.getMemoryCheckpointEvidence(params.workspaceId, params.checkpointId, params.page, params.pageSize);
			case 'getMemoryStats':
				return db.getMemoryStats(params.workspaceId);
			case 'backfillMemoryFacts':
				return db.backfillMemoryFacts(params.workspaceId, params.limit);
			case 'listMemorySessionIds':
				return db.listMemorySessionIds(params.workspaceId, params.limit);
			case 'rebuildMemoryArchivePages':
				return db.rebuildMemoryArchivePages(params.workspaceId, params.sessionId, params.batchSize);
			case 'getMemoryIndexPending':
				return db.getMemoryIndexPending(params.workspaceId, params.limit);
			case 'storeMemoryIndexEmbedding':
				return db.storeMemoryIndexEmbedding(params.documentId, params.text, params.modelId, params.dim, new Float32Array(params.vec));
			case 'searchMemory':
				return db.searchMemory(params.workspaceId, params.query, params.queryVec ? new Float32Array(params.queryVec) : null, params.modelId, params.options);
			case 'deepRecall':
				return db.deepRecall(params.shadowDir as string, params.query as string, params.limit as number | undefined);
			case 'getShadowRecord':
				return db.getShadowRecord(params.shadowDir as string, params.id as string);
			case 'searchWorkspace':
				return db.searchWorkspace(params.workspaceId, params.query, params.limit);
			case 'getFactsForFile':
				return db.getFactsForFile(params.workspaceId, params.path);
			case 'getCochange':
				return db.getCochange(params.workspaceId, params.path);
			case 'upsertFact':
				return db.upsertFact(params.fact as {
					workspaceId: string; kind: WsFactKind; subject: string; body: string;
					confidence?: number; priority?: number; source?: string[]; meta?: Record<string, unknown>;
				});
			case 'buildSnapshot':
				return db.buildSnapshot(params.workspaceId, params.sessionId, params.role as AgentRole, params.budgetTokens, params.activeContext);
			case 'rollup':
				return db.rollupToWorkspace(params.workspaceId, params.projectName);
			case 'pin':
				return db.pin(params.factId);
			case 'correct':
				return db.correct(params.factId, params.body);
			case 'forget':
				return db.forget(params.factId);
			case 'recordEscalation':
				return db.recordEscalation(params.entry as Omit<EscalationLogEntry, 'id'>);
			case 'getProjectReadme':
				return db.getProjectReadme(params.workspaceId);
			case 'getEditorialOverview':
				return db.getEditorialOverview(params.workspaceId);
			case 'getBranches':
				return db.getBranches(params.projectId);
			case 'searchEditorial':
				return db.searchEditorial(params.query, params.crossProject);
			case 'writeEditorialBranch':
				return db.writeEditorialBranch({
					workspaceId: params.workspaceId,
					topic: params.topic,
					worked: params.worked,
					didntWork: params.didntWork,
					buildNotes: params.buildNotes,
					miniReadme: params.miniReadme,
					mode: params.mode,
				});
			case 'deleteEditorialBranch':
				return db.deleteEditorialBranch({
					workspaceId: params.workspaceId,
					topic: params.topic,
					section: params.section,
				});
			case 'migrateSymbolNotes':
				return db.migrateSymbolNotes(params.workspaceId, params.notes as { filePath: string; symbolName: string; note: string; ts: number }[]);
			// ---- catalog C3: embedding store (vectors cross IPC as plain number[]) ----
			case 'getEmbedPending':
				return db.getEmbedPending(params.limit as number | undefined);
			case 'getCachedVector': {
				const v = await db.getCachedVector(params.text as string, params.modelId as string);
				return v ? Array.from(v) : null;
			}
			case 'storeFactEmbedding':
				return db.storeFactEmbedding(
					params.factId as string, params.text as string, params.modelId as string,
					params.dim as number, new Float32Array(params.vec as number[]),
				);
			case 'rankedSearch':
				return db.rankedSearch(
					params.workspaceId as string, params.queryText as string,
					params.queryVec ? new Float32Array(params.queryVec as number[]) : null,
					(params.modelId as string | null) ?? null, params.limit as number | undefined,
				);
			// ---- catalog C7: procedural memory ----
			case 'saveProcedure':
				return db.saveProcedure(params.procedure as LearnedProcedureInput);
			case 'retrieveProcedures':
				return db.retrieveProcedures(params.workspaceId as string, params.query as string, params.limit as number | undefined);
			case 'markProcedureUsed':
				return db.markProcedureUsed(params.id as string);
			// ---- Phase 3: MemLegend timeline reads ----
			case 'getTimeline':
				return db.getTimeline(params.workspaceId as string, params.limit as number | undefined);
			case 'hydrateTimeline':
				return db.hydrateTimeline(params.id as string);
			default:
				throw new Error(`MemoryChannel: command "${command}" not recognized.`);
		}
	}

	private async _dispose(): Promise<void> {
		const all = [...this.dbs.values()];
		this.dbs.clear();
		await Promise.all(all.map(async p => {
			try { (await p).close(); } catch { /* noop */ }
		}));
	}
}
