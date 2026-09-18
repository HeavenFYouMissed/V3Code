/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Async wrapper around `@vscode/sqlite3` for the 3-layer memory store.
 *
 * One instance per workspace folder, owned by the memoryChannel in the main
 * process. Single-writer. The renderer never touches this directly — it speaks
 * to the memoryChannel over IPC and gets back the plain types from
 * common/memory/memoryTypes.ts.
 *
 * Mirrors semanticIndex/database.ts: dynamic import of the native addon, WAL
 * mode, promise-wrapped run/get/all, and manual FTS sync (no triggers).
 */

import type { Database } from '@vscode/sqlite3';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadSqliteDatabaseConstructor } from '../sqliteLoader.js';
import { MEMORY_SCHEMA, MEMORY_META_KEYS, MEMORY_SCHEMA_VERSION, WS_FACTS_V2_COLUMNS, SHADOW_LINK_TABLES } from './memorySchema.js';
import {
		ChatEvent, ChatEventInput, WsFact, WsFactKind, MemoryKind, AgentRole,
		MemorySnapshot, EditorialBranch, EditorialProject, EscalationLogEntry,
		CodeRef, SearchChatOpts, TimelineEntry, TimelineKind, TimelineHydration,
		LearnedProcedure, LearnedProcedureInput, ProcedureTarget, ShadowRecord, ShadowHit,
		MemoryCheckpoint, CreateMemoryCheckpointInput, MemoryCheckpointEvidence,
		MemoryArchivePage, MemoryIndexDocument, MemoryIndexDocumentKind, MemoryIndexState, MemoryStats,
		MemorySearchHit, SearchMemoryOptions,
} from '../../common/memory/memoryTypes.js';
import { sha256 } from '../../common/semanticIndex/hashing.js';
import { cosineSim, normalizeScores } from '../../common/memory/vectorMath.js';
import { hybridMerge } from '../../common/memory/hybridMerge.js';
import { applyDecay, isEvergreen, DECAY_HALFLIVES } from '../../common/memory/temporalDecay.js';
import { mmrSelect, MMR_LAMBDA } from '../../common/memory/mmr.js';
import { salience, ActiveContext } from '../../common/memory/salience.js';
import { withBusyRetry } from '../../common/memory/withBusyRetry.js';
import { resolveContradiction } from '../../common/memory/contradiction.js';
import { PendingSessionTransition, SessionAnchor, SessionAnchorInput, SessionWorkspaceTransition } from '../../common/memory/sessionAnchors.js';

/** Time-sortable id: base36 ms timestamp + random suffix. Good enough as a ULID
 *  stand-in given every table also stores an explicit `ts`/`ts_*` we order by. */
function genId(): string {
	const t = Date.now().toString(36).padStart(9, '0');
	const r = Math.random().toString(36).slice(2, 10);
	return `${t}${r}`;
}

/** Sanitize free text into a safe FTS5 prefix-OR query (mirrors database.ts). */
function toFtsQuery(query: string): string {
	const tokens = query.trim().split(/\s+/)
		.map(t => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
		.filter(t => t.length > 0)
		// Double-quote each term so FTS5 reserved words (OR/AND/NOT/NEAR, and uppercase
		// variants) are treated as string literals, not query operators. A bare `AND*`
		// token threw a "syntax error near AND" and failed the whole memory search.
		.map(t => `"${t}"*`)
		.join(' OR ');
	return tokens;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
	if (!s) return fallback;
	try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Map a verbatim chat MemoryKind to the SHADOW archive's coarse vocabulary. The
 *  archive keeps the full raw text regardless; this is just a render hint on the row. */
function toShadowKind(k: MemoryKind): string {
	switch (k) {
		case 'prompt': return 'PROMPT';
		case 'reply': return 'REPLY';
		case 'tool_call': case 'tool_result': return 'TOOL';
		case 'diff': return 'DIFF';
		case 'decision': return 'DECISION';
		case 'note': return 'NOTE';
		default: return 'OTHER'; // phase | escalation
	}
}

/** Local-time day key `YYYY-MM-DD` -> the shadow file an event lands in. One file per
 *  day keeps each file bounded and lets a future cold-storage step gzip/move old days. */
function shadowDayKey(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The single privacy projection every memory index document passes through before it is
 *  hashed, written to FTS, or embedded. Strips secret-shaped key/value pairs and known token
 *  prefixes, then caps length. Applied to facts, checkpoint summaries and archive-page bodies
 *  alike -- if you add a new indexed source, route its text through here too. The authorization
 *  case is matched first and consumes an optional Bearer/Basic/Token scheme word, otherwise the
 *  generic rule would redact only the scheme and leave the credential itself in the index. */
function sanitizeMemoryIndexText(text: string): string {
	return text
		.replace(/(authorization)\s*[:=]\s*(?:bearer|basic|token)?\s*[^\s,;]+/giu, '$1=[redacted]')
		.replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
		.replace(/\b(?:sk|ghp|github_pat|AIza)[A-Za-z0-9_\-]{12,}\b/g, '[redacted]')
		.slice(0, 16_000);
}

function shadowSnippet(text: string, tokens: string[]): string {
	const lower = text.toLowerCase();
	let at = -1;
	for (const t of tokens) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) { at = i; } }
	const W = 300;
	const start = at < 0 ? 0 : Math.max(0, at - 80);
	let snip = text.slice(start, start + W).replace(/\s+/g, ' ').trim();
	if (start > 0) { snip = '…' + snip; }
	if (start + W < text.length) { snip = snip + '…'; }
	return snip;
}

/** Map a verbatim chat MemoryKind to the coarse MemLegend rung vocabulary. */
function toTimelineKind(k: MemoryKind, meta?: Record<string, unknown>): TimelineKind {
	// A condensed-history digest is stored as a note (meta.digest); surface it as its own rung
	// so it stands out instead of vanishing into the "read" pile.
	if (k === 'note' && meta?.['digest'] === true) { return 'digest'; }
	switch (k) {
		case 'prompt': return 'prompt';
		case 'diff': return 'diff';
		case 'decision': return 'decision';
		case 'phase': return 'phase';
		case 'escalation': return 'escalation';
		default: return 'read'; // reply | tool_call | tool_result | note
	}
}

/** Pull ONLY small scalars out of an event/fact meta for a timeline row. This is the
 *  references-only guard made literal: the rail stores render hints (model, token /
 *  diff counts), never the payload -- the payload is hydrated on demand by id. */
function timelineMeta(meta?: Record<string, unknown>): Record<string, unknown> {
	if (!meta) return {};
	const out: Record<string, unknown> = {};
	for (const k of ['model', 'tokens', 'add', 'del', 'verifyPassed', 'tool']) {
		const v = meta[k];
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
	}
	return out;
}

/** Pack a Float32 embedding into a SQLite BLOB (little-endian float bytes). */
function f32ToBlob(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Read a BLOB back into a Float32Array. Copies into an aligned ArrayBuffer first --
 *  the driver's Buffer may sit at an unaligned offset in a shared pool. */
function blobToF32(buf: Buffer): Float32Array {
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	return new Float32Array(ab);
}

interface ChatEventRow {
	id: string; session_id: string; workspace_id: string; ts: number;
	kind: string; role: string | null; parent_id: string | null;
	title: string | null; body: string | null; files_json: string | null; meta_json: string | null;
}

interface WsFactRow {
	id: string; workspace_id: string; ts_first: number; ts_last: number;
	kind: string; subject: string; body: string | null; confidence: number;
	priority: number; source_json: string | null; meta_json: string | null;
	// catalog v2 provenance columns (schema v2; present after migrateToSchemaV2)
	source: string; verified_by_test: number; created_at: number;
	last_used_at: number; use_count: number; superseded_by: string | null; embed_pending: number;
}

interface TimelineRow {
	id: string; workspace_id: string; ts: number; kind: string;
	file: string | null; session_id: string | null; chat_event_id: string | null;
	fact_id: string | null; plan_version_id: string | null; escalation_id: string | null;
	meta_json: string | null;
}

interface EscalationRow {
	id: string; workspace_id: string; ts: number; trigger_rule: string;
	evidence_hash: string | null; fix_applied: string | null;
	verify_passed: number | null; meta_json: string | null;
}

interface LearnedProcedureRow {
	id: string; workspace_id: string; trigger_pattern: string; steps_json: string;
	verified_by_test: number; success_count: number; last_used: number;
	provenance: string | null; target: string; ts_created: number;
}

interface MemoryCheckpointRow {
	id: string; workspace_id: string; session_id: string; parent_checkpoint_id: string | null;
	trigger: string; start_event_id: string; end_event_id: string; started_at: number; ended_at: number;
	summary: string; summary_hash: string; summary_format_version: number; source_event_count: number;
	source_bytes: number; status: string; pinned: number; created_at: number; meta_json: string | null;
}

interface MemoryArchivePageRow {
	id: string; workspace_id: string; session_id: string; checkpoint_id: string | null;
	start_event_id: string; end_event_id: string; started_at: number; ended_at: number;
	event_count: number; token_estimate: number; content_hash: string; index_state: string; indexed_at: number | null;
}

interface MemoryIndexDocumentRow {
	id: string; workspace_id: string; kind: string; source_id: string; session_id: string | null;
	title: string; text: string; content_hash: string; version: number; state: string; attempts: number;
	last_error: string | null; created_at: number; updated_at: number;
}

interface SessionStateRow {
	workspace_id: string; session_id: string; state_key: string; value_json: string;
	revision: number; updated_at: number;
}

interface SessionAnchorRow {
	profile_id: string; anchor_id: string; thread_id: string;
	origin_workspace_id: string; origin_root: string; kind: string;
	relative_path: string | null; symbol: string | null; revision: number;
	update_identity: string; payload_json: string; updated_at: number; deleted_at: number | null;
}

interface SessionWorkspaceTransitionRow {
	id: string; profile_id: string; thread_id: string; kind: string;
	from_workspace_id: string; from_root: string; to_workspace_id: string;
	to_root: string; created_at: number;
}

export class MemoryDatabase {
	private db: Database | null = null;
	/** Retained so getMemoryStats can stat the file and its -wal/-shm sidecars. */
	private dbPath: string | null = null;

	async open(dbPath: string): Promise<void> {
		this.dbPath = dbPath;
		const SqliteDatabase = await loadSqliteDatabaseConstructor();
		this.db = await new Promise<Database>((resolve, reject) => {
			const handle: Database = new SqliteDatabase(dbPath, (err: Error | null) => {
				if (err) reject(err); else resolve(handle);
			});
		});
		await this.exec('PRAGMA journal_mode = WAL');
		await this.exec('PRAGMA synchronous = NORMAL');
		// Writer contention across connections (WAL = one writer at a time) surfaces as
		// SQLITE_BUSY; wait up to 2s inside SQLite before the busy-retry wrapper engages.
		await this.exec('PRAGMA busy_timeout = 2000');
			await this.exec(MEMORY_SCHEMA);
			await this.migrateToSchemaV2();
			await this.migrateShadowLink();
			await this.backfillProvenanceV2();
			await this.backfillTimelineV2();
			await this.repairDigestTimelineKinds();
			await this.repairDuplicateEditorialBranches();
			await this.repairPlanSnapshotDecisions();
			await this.migrateToSchemaV3();
		const created = await this.getMeta(MEMORY_META_KEYS.createdAt);
		if (!created) await this.setMeta(MEMORY_META_KEYS.createdAt, String(Date.now()));
	}

	/** Additive schema v2 (catalog) migration. ALTERs the provenance columns onto a
	 *  pre-v2 `ws_facts`; idempotent + crash-safe -- it only adds columns that are
	 *  missing, so a repeated or partially-applied run can never throw "duplicate
	 *  column". A fresh db already has the columns from the ws_facts CREATE in
	 *  MEMORY_SCHEMA, and the new v2 tables (timeline, learned_procedures, ws_vectors,
	 *  embed_cache) are created there too via CREATE TABLE IF NOT EXISTS -- so this
	 *  handles the one thing that CREATE cannot: adding columns to a table that already
	 *  exists. Runs for every db regardless of the memoryLibraryV2 flag, because the
	 *  columns are inert (nothing reads them until later catalog steps); it is a no-op
	 *  for behavior and simply lets an old db upgrade in place. */
	private async migrateToSchemaV2(): Promise<void> {
		const cols = await this.allRaw<{ name: string }>('PRAGMA table_info(ws_facts)');
		const existing = new Set(cols.map(c => c.name));
		for (const col of WS_FACTS_V2_COLUMNS) {
			if (!existing.has(col.name)) {
				await this.run(`ALTER TABLE ws_facts ADD COLUMN ${col.ddl}`);
			}
		}
	}

	/** Additive: ALTER the curated -> shadow `shadow_id` column onto a pre-existing
	 *  chat_events / ws_facts / timeline. Same discipline as migrateToSchemaV2 -- only adds
	 *  if missing (idempotent, crash-safe), and a fresh db already has it from the CREATEs.
	 *  Inert until the shadow layer reads it, so it is safe to run for every db. */
	/** Complete the v3 upgrade before writing its version stamp. The schema DDL is additive,
	 *  while this dispatcher keeps an interrupted v2→v3 upgrade retryable and never claims
	 *  v3 until all preceding repairs have succeeded. */
	private async migrateToSchemaV3(): Promise<void> {
		const current = Number(await this.getMeta(MEMORY_META_KEYS.schemaVersion) ?? '0');
		if (current > MEMORY_SCHEMA_VERSION) {
			throw new Error(`memory schema ${current} is newer than supported ${MEMORY_SCHEMA_VERSION}`);
		}
		if (current < MEMORY_SCHEMA_VERSION) {
			await this.exec('BEGIN IMMEDIATE');
			try {
				await this.setMeta(MEMORY_META_KEYS.schemaVersion, String(MEMORY_SCHEMA_VERSION));
				await this.exec('COMMIT');
			} catch (error) {
				try { await this.exec('ROLLBACK'); } catch { /* no active transaction */ }
				throw error;
			}
		}
	}

	async getSessionState(workspaceId: string, sessionId: string, stateKey: string): Promise<{ value: string; revision: number; updatedAt: number } | null> {
		const row = await this.getRaw<SessionStateRow>(
			'SELECT * FROM session_state WHERE workspace_id = ? AND session_id = ? AND state_key = ?',
			[workspaceId, sessionId, stateKey],
		);
		return row ? { value: row.value_json, revision: row.revision, updatedAt: row.updated_at } : null;
	}

	/** Compare-and-swap one session state row inside BEGIN IMMEDIATE. Concurrent windows can
	 *  never silently overwrite a newer task/plan revision. `expectedRevision=null` means the
	 *  caller observed no row and is creating it. */
	async putSessionState(
		workspaceId: string,
		sessionId: string,
		stateKey: string,
		value: string,
		expectedRevision: number | null,
	): Promise<{ saved: boolean; value: string; revision: number; updatedAt: number }> {
		return withBusyRetry(`session-state:${stateKey}`, async () => {
			await this.exec('BEGIN IMMEDIATE');
			try {
				const current = await this.getRaw<SessionStateRow>(
					'SELECT * FROM session_state WHERE workspace_id = ? AND session_id = ? AND state_key = ?',
					[workspaceId, sessionId, stateKey],
				);
				const currentRevision = current?.revision ?? null;
				if (currentRevision !== expectedRevision) {
					await this.exec('ROLLBACK');
					return current
						? { saved: false, value: current.value_json, revision: current.revision, updatedAt: current.updated_at }
						: { saved: false, value: '', revision: 0, updatedAt: 0 };
				}
				const revision = (current?.revision ?? 0) + 1;
				const updatedAt = Date.now();
				await this.run(
					`INSERT INTO session_state(workspace_id, session_id, state_key, value_json, revision, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(workspace_id, session_id, state_key) DO UPDATE SET
					 value_json = excluded.value_json, revision = excluded.revision, updated_at = excluded.updated_at`,
					[workspaceId, sessionId, stateKey, value, revision, updatedAt],
				);
				await this.exec('COMMIT');
				return { saved: true, value, revision, updatedAt };
			} catch (error) {
				try { await this.exec('ROLLBACK'); } catch { /* no active transaction */ }
				throw error;
			}
		});
	}

	async deleteSessionState(workspaceId: string, sessionId: string, stateKey: string): Promise<void> {
		await withBusyRetry(`session-state-delete:${stateKey}`, () => this.run(
			'DELETE FROM session_state WHERE workspace_id = ? AND session_id = ? AND state_key = ?',
			[workspaceId, sessionId, stateKey],
		));
	}

	private toSessionAnchor(row: SessionAnchorRow): SessionAnchor {
		return {
			anchorId: row.anchor_id,
			profileId: row.profile_id,
			threadId: row.thread_id,
			originWorkspaceId: row.origin_workspace_id,
			originRoot: row.origin_root,
			kind: row.kind as SessionAnchor['kind'],
			relativePath: row.relative_path ?? undefined,
			symbol: row.symbol ?? undefined,
			revision: row.revision,
			updateIdentity: row.update_identity,
			payload: parseJson<unknown>(row.payload_json, null),
			updatedAt: row.updated_at,
			deletedAt: row.deleted_at ?? undefined,
		};
	}

	/** Idempotent canonical anchor upsert. Replaying the same deterministic update
	 * identity is a read, not a new revision; a tombstone is an ordinary revision and
	 * therefore wins permanently over older workspace projections. */
	async upsertSessionAnchor(input: SessionAnchorInput): Promise<SessionAnchor> {
		return withBusyRetry(`session-anchor:${input.kind}`, async () => {
			await this.exec('BEGIN IMMEDIATE');
			try {
				const current = await this.getRaw<SessionAnchorRow>(
					'SELECT * FROM session_anchors WHERE profile_id = ? AND anchor_id = ?',
					[input.profileId, input.anchorId],
				);
				if (current && current.thread_id !== input.threadId) {
					throw new Error('session anchor id is already owned by another thread');
				}
				if (current?.update_identity === input.updateIdentity) {
					await this.exec('COMMIT');
					return this.toSessionAnchor(current);
				}
				const equalTimeExistingTombstoneWins = current?.updated_at === input.updatedAt
					&& current.deleted_at !== null && input.deletedAt === undefined;
				const equalTimeIdentityWins = current?.updated_at === input.updatedAt
					&& current.deleted_at === (input.deletedAt ?? null)
					&& current.update_identity > input.updateIdentity;
				if (current && (current.updated_at > input.updatedAt || equalTimeExistingTombstoneWins || equalTimeIdentityWins)) {
					await this.exec('COMMIT');
					return this.toSessionAnchor(current);
				}
				const revision = (current?.revision ?? 0) + 1;
				await this.run(
					`INSERT INTO session_anchors(profile_id, anchor_id, thread_id, origin_workspace_id, origin_root, kind, relative_path, symbol, revision, update_identity, payload_json, updated_at, deleted_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(profile_id, anchor_id) DO UPDATE SET
					 thread_id=excluded.thread_id, origin_workspace_id=excluded.origin_workspace_id,
					 origin_root=excluded.origin_root, kind=excluded.kind, relative_path=excluded.relative_path,
					 symbol=excluded.symbol, revision=excluded.revision, update_identity=excluded.update_identity,
					 payload_json=excluded.payload_json, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at`,
					[input.profileId, input.anchorId, input.threadId, input.originWorkspaceId, input.originRoot,
						input.kind, input.relativePath ?? null, input.symbol ?? null, revision, input.updateIdentity,
						JSON.stringify(input.payload ?? null), input.updatedAt, input.deletedAt ?? null],
				);
				const saved = await this.getRaw<SessionAnchorRow>(
					'SELECT * FROM session_anchors WHERE profile_id = ? AND anchor_id = ?',
					[input.profileId, input.anchorId],
				);
				if (!saved) { throw new Error('session anchor write did not produce a row'); }
				await this.exec('COMMIT');
				return this.toSessionAnchor(saved);
			} catch (error) {
				try { await this.exec('ROLLBACK'); } catch { /* no active transaction */ }
				throw error;
			}
		});
	}

	async listSessionAnchors(profileId: string, threadId: string, includeDeleted = false): Promise<SessionAnchor[]> {
		const rows = await this.allRaw<SessionAnchorRow>(
			`SELECT * FROM session_anchors
			 WHERE profile_id = ? AND thread_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}
			 ORDER BY updated_at DESC, anchor_id ASC`,
			[profileId, threadId],
		);
		return rows.map(row => this.toSessionAnchor(row));
	}

	async getSessionAnchor(profileId: string, threadId: string, anchorId: string, includeDeleted = false): Promise<SessionAnchor | null> {
		const row = await this.getRaw<SessionAnchorRow>(
			`SELECT * FROM session_anchors WHERE profile_id = ? AND thread_id = ? AND anchor_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
			[profileId, threadId, anchorId],
		);
		return row ? this.toSessionAnchor(row) : null;
	}

	async recordSessionTransition(input: SessionWorkspaceTransition): Promise<SessionWorkspaceTransition> {
		await this.run(
			`INSERT INTO session_anchor_transitions(id, profile_id, thread_id, kind, from_workspace_id, from_root, to_workspace_id, to_root, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
			[input.id, input.profileId, input.threadId, input.kind, input.fromWorkspaceId, input.fromRoot,
				input.toWorkspaceId, input.toRoot, input.createdAt],
		);
		return input;
	}

	async recordPendingSessionTransition(input: PendingSessionTransition): Promise<void> {
		await this.run(
			`INSERT INTO pending_session_transitions(token, profile_id, thread_id, kind, target_root, from_workspace_id, from_root, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(token) DO NOTHING`,
			[input.token, input.profileId, input.threadId, input.kind, input.targetRoot, input.fromWorkspaceId, input.fromRoot, input.createdAt],
		);
	}

	async listPendingSessionTransitions(profileId: string): Promise<PendingSessionTransition[]> {
		// Expire abandoned swaps (window never came back to the target workspace). 7 days
		// keeps a laptop closed mid-swap over a long weekend alive.
		await this.run('DELETE FROM pending_session_transitions WHERE created_at < ?', [Date.now() - 7 * 24 * 60 * 60 * 1000]);
		const rows = await this.allRaw<{ token: string; profile_id: string; thread_id: string; kind: string; target_root: string; from_workspace_id: string; from_root: string; created_at: number }>(
			'SELECT * FROM pending_session_transitions WHERE profile_id = ? ORDER BY created_at ASC',
			[profileId],
		);
		return rows.map(row => ({
			token: row.token,
			profileId: row.profile_id,
			threadId: row.thread_id,
			kind: row.kind as PendingSessionTransition['kind'],
			targetRoot: row.target_root,
			fromWorkspaceId: row.from_workspace_id,
			fromRoot: row.from_root,
			createdAt: row.created_at,
		}));
	}

	async deletePendingSessionTransition(token: string): Promise<void> {
		await this.run('DELETE FROM pending_session_transitions WHERE token = ?', [token]);
	}

	async listSessionTransitions(profileId: string, threadId: string): Promise<SessionWorkspaceTransition[]> {
		const rows = await this.allRaw<SessionWorkspaceTransitionRow>(
			'SELECT * FROM session_anchor_transitions WHERE profile_id = ? AND thread_id = ? ORDER BY created_at ASC',
			[profileId, threadId],
		);
		return rows.map(row => ({
			id: row.id,
			profileId: row.profile_id,
			threadId: row.thread_id,
			kind: row.kind as SessionWorkspaceTransition['kind'],
			fromWorkspaceId: row.from_workspace_id,
			fromRoot: row.from_root,
			toWorkspaceId: row.to_workspace_id,
			toRoot: row.to_root,
			createdAt: row.created_at,
		}));
	}

	private async migrateShadowLink(): Promise<void> {
		for (const table of SHADOW_LINK_TABLES) {
			const cols = await this.allRaw<{ name: string }>(`PRAGMA table_info(${table})`);
			if (!cols.some(c => c.name === 'shadow_id')) {
				await this.run(`ALTER TABLE ${table} ADD COLUMN shadow_id TEXT`);
			}
		}
	}

	/** One-time provenance backfill (catalog C1). Stamps the C0 sentinel rows
	 *  (source='unknown') with real provenance by heuristic, exactly once per db
	 *  (meta-guarded). Migrated notes (meta.migrated===true) came from the hand-written
	 *  notes.json -> source=human, confidence=1.0. Everything else is ai_inferred
	 *  (soft until verified), keeping its existing confidence, with verified_by_test
	 *  taken from meta.verifyPassed. created_at / last_used_at seed from the row's own
	 *  timestamps so salience (C5) has sane ages. Additive + inert until C5 reads these
	 *  columns; runs for every db regardless of the memoryLibraryV2 flag. */
	private async backfillProvenanceV2(): Promise<void> {
		if (await this.getMeta(MEMORY_META_KEYS.provenanceBackfilled) === '1') return;
		const rows = await this.allRaw<WsFactRow>("SELECT * FROM ws_facts WHERE source = 'unknown'");
		for (const r of rows) {
			const meta = parseJson<Record<string, unknown>>(r.meta_json, {});
			const migrated = meta['migrated'] === true;
			const source = migrated ? 'human' : 'ai_inferred';
			const confidence = migrated ? 1.0 : r.confidence;
			const verified = migrated ? 0 : (meta['verifyPassed'] === true ? 1 : 0);
			await this.run(
				`UPDATE ws_facts SET source = ?, confidence = ?, verified_by_test = ?, created_at = ?, last_used_at = ?, use_count = ? WHERE id = ?`,
				[source, confidence, verified, r.ts_first, r.ts_last, 1, r.id]
			);
		}
		await this.setMeta(MEMORY_META_KEYS.provenanceBackfilled, '1');
	}

	// ---- raw promise helpers (identical style to semanticIndex/database.ts) ----

	private exec(sql: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.db) return reject(new Error('memory db not open'));
			this.db.exec(sql, err => err ? reject(err) : resolve());
		});
	}
	private run(sql: string, params: unknown[] = []): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.db) return reject(new Error('memory db not open'));
			this.db.run(sql, params, err => err ? reject(err) : resolve());
		});
	}
	private allRaw<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
		return new Promise((resolve, reject) => {
			if (!this.db) return reject(new Error('memory db not open'));
			this.db.all(sql, params, (err: Error | null, rows: any[]) => err ? reject(err) : resolve(rows as T[]));
		});
	}
	private getRaw<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
		return new Promise((resolve, reject) => {
			if (!this.db) return reject(new Error('memory db not open'));
			this.db.get(sql, params, (err: Error | null, row: any) => err ? reject(err) : resolve(row as T | undefined));
		});
	}

	// ---- meta ----
	async getMeta(key: string): Promise<string | undefined> {
		const row = await this.getRaw<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
		return row?.value;
	}
	async setMeta(key: string, value: string): Promise<void> {
		await this.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [key, value]);
	}

	// ---- row mappers ----
	private toChatEvent(r: ChatEventRow): ChatEvent {
		return {
			id: r.id, sessionId: r.session_id, workspaceId: r.workspace_id, ts: r.ts,
			kind: r.kind as MemoryKind, role: (r.role as AgentRole) ?? undefined,
			parentId: r.parent_id ?? undefined, title: r.title ?? '', body: r.body ?? '',
			files: parseJson<string[]>(r.files_json, []),
			meta: parseJson<Record<string, unknown>>(r.meta_json, {}),
		};
	}
	private toWsFact(r: WsFactRow): WsFact {
		return {
			id: r.id, workspaceId: r.workspace_id, tsFirst: r.ts_first, tsLast: r.ts_last,
			kind: r.kind as WsFactKind, subject: r.subject, body: r.body ?? '',
			confidence: r.confidence, priority: r.priority,
			source: parseJson<string[]>(r.source_json, []),
			meta: parseJson<Record<string, unknown>>(r.meta_json, {}),
		};
	}

	// ---- CHAT LAYER (write + read) ----

	/**
	 * Append a raw record to the SHADOW archive: everything, judged by nothing, never
	 * decayed. Best-effort and isolated -- a failure here must never block the curated
	 * write (the archive is the floor, not a dependency). Returns the shadow id so the
	 * curated rows derived from this event can link DOWN to the raw original.
	 */
	private async appendShadow(shadowDir: string, shadowId: string, ev: ChatEvent): Promise<void> {
		const rec = {
			id: shadowId,
			ts: ev.ts,
			wsId: ev.workspaceId,
			sessionId: ev.sessionId,
			eventId: ev.id, // shadow -> curated up-link: a deep_recall hit can jump to normal memory
			kind: toShadowKind(ev.kind),
			tool: typeof ev.meta?.['tool'] === 'string' ? ev.meta['tool'] : null,
			file: ev.files?.[0] ?? null,
			text: ev.body ?? '', // RAW, full, untruncated -- the whole point of the shadow
		};
		await fs.mkdir(shadowDir, { recursive: true });
		await fs.appendFile(join(shadowDir, `${shadowDayKey(ev.ts)}.jsonl`), JSON.stringify(rec) + '\n', 'utf8');
	}

	/** Append a chat event (assigns id + ts) and mirror it into chat_fts. When `shadowDir`
	 *  is given (memoryLibraryV2), the raw event is captured to the shadow archive FIRST,
	 *  before any curation runs -- so an event curation would reject still hits the floor. */
	async record(input: ChatEventInput, chatJsonlPath?: string, shadowDir?: string): Promise<ChatEvent> {
		const ev: ChatEvent = {
			...input,
			id: genId(),
			ts: input.ts ?? Date.now(),
		};
		// SHADOW FIRST: unjudged raw capture before the curated pipeline forms any opinion.
		// The shadow id is stamped onto the curated rows below so they can dig DOWN to the raw.
		const shadowId = shadowDir ? `shd_${genId()}` : null;
		if (shadowDir && shadowId) {
			try { await this.appendShadow(shadowDir, shadowId, ev); }
			catch (e) { console.error('[memory] shadow append failed (curated write continues)', e); }
		}
		await this.run(
			`INSERT INTO chat_events(id, session_id, workspace_id, ts, kind, role, parent_id, title, body, files_json, meta_json, shadow_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[ev.id, ev.sessionId, ev.workspaceId, ev.ts, ev.kind, ev.role ?? null, ev.parentId ?? null,
			ev.title ?? '', ev.body ?? '', JSON.stringify(ev.files ?? []), JSON.stringify(ev.meta ?? {}), shadowId]
		);
		await this.run('INSERT INTO chat_fts(id, title, body) VALUES (?, ?, ?)', [ev.id, ev.title ?? '', ev.body ?? '']);
		await this.writeTimelineRow({
			id: `tl:ev:${ev.id}`, workspaceId: ev.workspaceId, ts: ev.ts,
			kind: toTimelineKind(ev.kind, ev.meta), file: ev.files?.[0] ?? null,
			sessionId: ev.sessionId, chatEventId: ev.id, meta: timelineMeta(ev.meta), shadowId,
		});
		if (chatJsonlPath) {
			await fs.mkdir(dirname(chatJsonlPath), { recursive: true });
			await fs.appendFile(chatJsonlPath, JSON.stringify(ev) + '\n', 'utf8');
		}
		return ev;
	}

	async getSession(sessionId: string): Promise<ChatEvent[]> {
		const rows = await this.allRaw<ChatEventRow>(
			'SELECT * FROM chat_events WHERE session_id = ? ORDER BY ts ASC', [sessionId]
		);
		return rows.map(r => this.toChatEvent(r));
	}

	async searchChat(workspaceId: string, query: string, opts?: SearchChatOpts): Promise<ChatEvent[]> {
		const limit = opts?.limit ?? 30;
		const fts = toFtsQuery(query);
		const filters: string[] = ['e.workspace_id = ?'];
		const params: unknown[] = [workspaceId];
		if (opts?.kind) { filters.push('e.kind = ?'); params.push(opts.kind); }
		if (opts?.role) { filters.push('e.role = ?'); params.push(opts.role); }
		if (opts?.sessionId) { filters.push('e.session_id = ?'); params.push(opts.sessionId); }
		let rows: ChatEventRow[];
		if (fts) {
			params.push(fts, limit);
			rows = await this.allRaw<ChatEventRow>(
				`SELECT e.* FROM chat_events e
				 JOIN chat_fts f ON f.id = e.id
				 WHERE ${filters.join(' AND ')} AND chat_fts MATCH ?
				 ORDER BY e.ts DESC LIMIT ?`,
				params
			);
		} else {
			params.push(limit);
			rows = await this.allRaw<ChatEventRow>(
				`SELECT e.* FROM chat_events e WHERE ${filters.join(' AND ')} ORDER BY e.ts DESC LIMIT ?`,
				params
			);
		}
		return rows.map(r => this.toChatEvent(r));
	}

	/** An event plus its direct children (reply under prompt, tool_result under tool_call). */
	async getThread(eventId: string): Promise<ChatEvent[]> {
		const root = await this.getRaw<ChatEventRow>('SELECT * FROM chat_events WHERE id = ?', [eventId]);
		if (!root) return [];
		const children = await this.allRaw<ChatEventRow>(
			'SELECT * FROM chat_events WHERE parent_id = ? ORDER BY ts ASC', [eventId]
		);
		return [this.toChatEvent(root), ...children.map(r => this.toChatEvent(r))];
	}

	// ---- WORKSPACE LAYER ----

	async searchWorkspace(workspaceId: string, query: string, limit = 20): Promise<WsFact[]> {
		const fts = toFtsQuery(query);
		// confidence > 0: forget() is a soft tombstone (confidence = 0) — a
		// forgotten fact must not resurface through search (audit finding).
		if (!fts) {
			const rows = await this.allRaw<WsFactRow>(
				'SELECT * FROM ws_facts WHERE workspace_id = ? AND confidence > 0 ORDER BY confidence DESC, ts_last DESC LIMIT ?',
				[workspaceId, limit]
			);
			return rows.map(r => this.toWsFact(r));
		}
		const rows = await this.allRaw<WsFactRow>(
			`SELECT ff.* FROM ws_facts ff
			 JOIN ws_fts f ON f.id = ff.id
			 WHERE ff.workspace_id = ? AND ff.confidence > 0 AND ws_fts MATCH ?
			 ORDER BY f.rank, ff.confidence DESC LIMIT ?`,
			[workspaceId, fts, limit]
		);
		return rows.map(r => this.toWsFact(r));
	}

	/** Ranked hybrid search (catalog C4): BM25 (ws_fts) + vector cosine over ws_vectors
	 *  -> hybridMerge (0.7/0.3) -> temporal decay (workspace half-life, human/verified
	 *  evergreen-exempt) -> MMR diversity. `queryVec` is embedded by the caller; when it
	 *  is null (or nothing is embedded yet) this degrades cleanly to a BM25-only ranking
	 *  so a fact is never invisible. Brute-force cosine over the BLOBs (small corpus);
	 *  sqlite-vec is an optional accelerator added later, behind the same contract. */
	async rankedSearch(workspaceId: string, queryText: string, queryVec: Float32Array | null, modelId: string | null, limit = 12): Promise<WsFact[]> {
		// 1. BM25 candidates. FTS5 rank is ascending-better, so negate -> higher = better.
		const bm25 = new Map<string, number>();
		const fts = toFtsQuery(queryText);
		if (fts) {
			const rows = await this.allRaw<{ id: string; rank: number }>(
				`SELECT ff.id AS id, f.rank AS rank FROM ws_facts ff
				 JOIN ws_fts f ON f.id = ff.id
				 WHERE ff.workspace_id = ? AND ws_fts MATCH ? AND ff.confidence > 0
				 ORDER BY f.rank LIMIT 50`,
				[workspaceId, fts]
			);
			for (const r of rows) { bm25.set(r.id, -r.rank); }
		}
		// 2. Vector cosine over stored fact vectors (brute force; small corpus).
		const vec = new Map<string, number>();
		const factVecs = new Map<string, Float32Array>();
		if (queryVec && modelId) {
			const vrows = await this.allRaw<{ id: string; vec: Buffer }>(
				`SELECT v.fact_id AS id, v.vec AS vec FROM ws_vectors v
				 JOIN ws_facts ff ON ff.id = v.fact_id
				 WHERE ff.workspace_id = ? AND v.model_id = ? AND ff.confidence > 0 LIMIT 2000`,
				[workspaceId, modelId]
			);
			for (const r of vrows) {
				const fv = blobToF32(r.vec);
				factVecs.set(r.id, fv);
				vec.set(r.id, cosineSim(queryVec, fv));
			}
		}
		// 3. Merge, or BM25-only fallback when nothing is embedded.
		const merged = vec.size > 0 ? hybridMerge(vec, bm25) : normalizeScores(bm25);
		if (merged.size === 0) { return []; }
		// 4. Take the top candidates, load their rows for decay + return.
		const topN = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
		const factRows = await this.getFactsByIds(workspaceId, topN.map(([id]) => id));
		// 5. Temporal decay (older fades; human/verified never do).
		const now = Date.now();
		const hl = DECAY_HALFLIVES.workspace;
		const items: { id: string; relevance: number; vec?: ArrayLike<number> }[] = [];
		for (const [id, score] of topN) {
			const fr = factRows.get(id);
			if (!fr) { continue; }
			const evergreen = isEvergreen({ source: fr.source, verifiedByTest: fr.verified_by_test === 1 });
			items.push({ id, relevance: applyDecay(score, now - fr.ts_last, hl, evergreen), vec: factVecs.get(id) });
		}
		// 6. MMR diversity -> ordered ids -> facts in that order.
		const out: WsFact[] = [];
		for (const id of mmrSelect(items, limit, MMR_LAMBDA)) {
			const fr = factRows.get(id);
			if (fr) { out.push(this.toWsFact(fr)); }
		}
		return out;
	}

	/** Load specific facts by id (order not preserved; caller re-orders). */
	private async getFactsByIds(workspaceId: string, ids: string[]): Promise<Map<string, WsFactRow>> {
		const map = new Map<string, WsFactRow>();
		if (!ids.length) { return map; }
		const placeholders = ids.map(() => '?').join(',');
		const rows = await this.allRaw<WsFactRow>(
			`SELECT * FROM ws_facts WHERE workspace_id = ? AND id IN (${placeholders})`,
			[workspaceId, ...ids]
		);
		for (const r of rows) { map.set(r.id, r); }
		return map;
	}

	async getFactsForFile(workspaceId: string, path: string): Promise<WsFact[]> {
		// confidence > 0 keeps tombstoned facts out; the forget flow re-tombstoning
		// an already-forgotten fact would be a harmless no-op anyway.
		const rows = await this.allRaw<WsFactRow>(
			'SELECT * FROM ws_facts WHERE workspace_id = ? AND subject = ? AND confidence > 0 ORDER BY confidence DESC',
			[workspaceId, path]
		);
		return rows.map(r => this.toWsFact(r));
	}

	async getCochange(workspaceId: string, path: string): Promise<{ file: string; count: number }[]> {
		const rows = await this.allRaw<{ file_a: string; file_b: string; count: number }>(
			'SELECT file_a, file_b, count FROM ws_cochange WHERE workspace_id = ? AND (file_a = ? OR file_b = ?) ORDER BY count DESC',
			[workspaceId, path, path]
		);
		return rows.map(r => ({ file: r.file_a === path ? r.file_b : r.file_a, count: r.count }));
	}

	/** Upsert a workspace fact keyed by (workspace, kind, subject). Merges source ids,
	 *  bumps confidence/ts_last on reinforce, keeps the highest priority seen. */
	async upsertFact(f: {
		workspaceId: string; kind: WsFactKind; subject: string; body: string;
		confidence?: number; priority?: number; source?: string[]; meta?: Record<string, unknown>;
		provenance?: 'human' | 'ai_inferred' | 'tool'; verifiedByTest?: boolean;
	}): Promise<WsFact> {
		const now = Date.now();
		const existing = await this.getRaw<WsFactRow>(
			'SELECT * FROM ws_facts WHERE workspace_id = ? AND kind = ? AND subject = ? AND superseded_by IS NULL ORDER BY ts_last DESC',
			[f.workspaceId, f.kind, f.subject]
		);
		if (existing) {
			// CONTRADICTION (catalog C6): the same (workspace, kind, subject) with a DIFFERING
			// body is a clash, not a reinforce. resolveContradiction gates by provenance: a
			// human/verified fact wins, an AI guess can never silently demote a human fact,
			// and every clash is recorded in editorial_conflicts (resolved or flagged).
			const incomingBody = f.body ?? '';
			const existingBody = existing.body ?? '';
			// Rolling kinds deliberately overwrite their own body as state advances -- that is
			// an UPDATE, not a contradiction. Session digests grow; roadmap todos move from
			// pending -> in_progress -> completed/blocked.
			if (incomingBody && existingBody && incomingBody !== existingBody && f.kind !== 'session_digest' && f.kind !== 'roadmap') {
				const decision = resolveContradiction(
					{ source: existing.source, verifiedByTest: existing.verified_by_test === 1 },
					{ source: f.provenance, verifiedByTest: f.verifiedByTest }
				);
				if (decision.winner === 'existing') {
					// incoming rejected: keep the existing fact active; record the loser as a
					// born-superseded audit row + flag the conflict for human review.
					const loserId = await this._insertNewFact(f, now, { supersededBy: existing.id, demoted: true });
					await this._logConflict(loserId, existing.id, now, decision.resolved);
					const retained = this.toWsFact(existing);
					await this.indexFact(retained);
					return retained;
				}
				// incoming wins: insert it as the new active row, then supersede + demote the
				// old one out of retrieval (confidence 0, superseded_by set, removed from FTS).
				const winnerId = await this._insertNewFact(f, now);
				await this.run('UPDATE ws_facts SET superseded_by = ?, confidence = 0 WHERE id = ?', [winnerId, existing.id]);
				await this.run('DELETE FROM ws_fts WHERE id = ?', [existing.id]);
				await this._logConflict(winnerId, existing.id, now, decision.resolved);
				const winner = this.toWsFact((await this.getRaw<WsFactRow>('SELECT * FROM ws_facts WHERE id = ?', [winnerId]))!);
				await this.indexFact(winner);
				return winner;
			}
			const mergedSource = Array.from(new Set([...parseJson<string[]>(existing.source_json, []), ...(f.source ?? [])]));
			const confidence = Math.min(1, Math.max(existing.confidence, f.confidence ?? existing.confidence) + 0.05);
			const priority = Math.max(existing.priority, f.priority ?? existing.priority);
			// Provenance on reinforce: human always wins (an AI re-observation can never
			// demote a human fact); otherwise take the incoming provenance, else keep the
			// existing one (never leave the 'unknown' sentinel). verified_by_test is sticky
			// once true. Full contradiction handling for differing bodies is C6.
			const newProvenance = f.provenance === 'human' || existing.source === 'human'
				? 'human'
				: (f.provenance ?? (existing.source !== 'unknown' ? existing.source : 'ai_inferred'));
			const newVerified = existing.verified_by_test === 1 || f.verifiedByTest === true ? 1 : 0;
			await this.run(
				`UPDATE ws_facts SET ts_last = ?, body = ?, confidence = ?, priority = ?, source_json = ?, meta_json = ?, source = ?, verified_by_test = ? WHERE id = ?`,
				[now, f.body, confidence, priority, JSON.stringify(mergedSource), JSON.stringify(f.meta ?? parseJson(existing.meta_json, {})), newProvenance, newVerified, existing.id]
			);
			await this.run('DELETE FROM ws_fts WHERE id = ?', [existing.id]);
			await this.run('INSERT INTO ws_fts(id, subject, body) VALUES (?, ?, ?)', [existing.id, f.subject, f.body]);
			const updated = this.toWsFact((await this.getRaw<WsFactRow>('SELECT * FROM ws_facts WHERE id = ?', [existing.id]))!);
			await this.indexFact(updated);
			return updated;
		}
		const id = await this._insertNewFact(f, now);
		const saved = this.toWsFact((await this.getRaw<WsFactRow>('SELECT * FROM ws_facts WHERE id = ?', [id]))!);
		await this.indexFact(saved);
		return saved;
	}

	/** Mirror each active curated fact into the generic pull index; SQLite remains authoritative. */
	private async indexFact(fact: WsFact): Promise<void> {
		await this.upsertMemoryIndexDocument({
			id: `mid:${sha256(`fact:${fact.id}`).slice(0, 40)}`,
			workspaceId: fact.workspaceId,
			kind: fact.kind === 'symbol' ? 'symbol-note' : 'fact',
			sourceId: fact.id,
			title: fact.subject,
				text: [fact.subject, fact.body].filter(Boolean).join('\n'),
				sourceTs: fact.tsLast,
		});
	}

	/** Insert a brand-new ws_facts row (+ FTS entry, unless born superseded). Returns its id.
	 *  Default provenance ai_inferred (C1, soft until verified); created_at/last_used_at = now;
	 *  embed_pending=1 queues embedding (C3). A demoted / born-superseded row (the audit row
	 *  from a rejected contradiction) gets confidence 0, no FTS entry, and no embedding. */
	private async _insertNewFact(
		f: {
			workspaceId: string; kind: WsFactKind; subject: string; body: string;
			confidence?: number; priority?: number; source?: string[]; meta?: Record<string, unknown>;
			provenance?: 'human' | 'ai_inferred' | 'tool'; verifiedByTest?: boolean;
		},
		now: number,
		opts?: { supersededBy?: string; demoted?: boolean },
	): Promise<string> {
		const id = genId();
		const provenance = f.provenance ?? 'ai_inferred';
		const verified = f.verifiedByTest === true ? 1 : 0;
		const confidence = opts?.demoted ? 0 : (f.confidence ?? 0.5);
		await this.run(
			`INSERT INTO ws_facts(id, workspace_id, ts_first, ts_last, kind, subject, body, confidence, priority, source_json, meta_json, source, verified_by_test, created_at, last_used_at, use_count, embed_pending, superseded_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, f.workspaceId, now, now, f.kind, f.subject, f.body, confidence, f.priority ?? 5,
			JSON.stringify(f.source ?? []), JSON.stringify(f.meta ?? {}), provenance, verified, now, now, 0,
			opts?.demoted ? 0 : 1, opts?.supersededBy ?? null]
		);
		if (!opts?.demoted) {
			await this.run('INSERT INTO ws_fts(id, subject, body) VALUES (?, ?, ?)', [id, f.subject, f.body]);
		}
		return id;
	}

	/** Record a contradiction in editorial_conflicts (resolved=1 clean win, 0 = needs review). */
	private async _logConflict(newId: string, existingId: string, now: number, resolved: boolean): Promise<void> {
		await this.run(
			'INSERT INTO editorial_conflicts(id, new_id, existing_id, ts, resolved) VALUES (?, ?, ?, ?, ?)',
			[genId(), newId, existingId, now, resolved ? 1 : 0]
		);
	}

	async bumpCochange(workspaceId: string, fileA: string, fileB: string): Promise<void> {
		const [a, b] = fileA < fileB ? [fileA, fileB] : [fileB, fileA];
		if (a === b) return;
		await this.run(
			`INSERT INTO ws_cochange(workspace_id, file_a, file_b, count, ts_last) VALUES (?, ?, ?, 1, ?)
			 ON CONFLICT(workspace_id, file_a, file_b) DO UPDATE SET count = count + 1, ts_last = excluded.ts_last`,
			[workspaceId, a, b, Date.now()]
		);
	}

	// ---- CURATION (packet 2 Ledger writes back through here) ----
	async pin(factId: string): Promise<void> {
		await this.run('UPDATE ws_facts SET confidence = MIN(1.0, confidence + 0.3), priority = MAX(priority, 8) WHERE id = ?', [factId]);
	}
	async correct(factId: string, body: string): Promise<void> {
		await this.run('UPDATE ws_facts SET body = ?, ts_last = ? WHERE id = ?', [body, Date.now(), factId]);
		await this.run('DELETE FROM ws_fts WHERE id = ?', [factId]);
		const row = await this.getRaw<WsFactRow>('SELECT subject FROM ws_facts WHERE id = ?', [factId]);
		if (row) await this.run('INSERT INTO ws_fts(id, subject, body) VALUES (?, ?, ?)', [factId, row.subject, body]);
	}

	/** When code changes, symbol-attached notes for that file become hypotheses until verified. */
	private async markSymbolFactsStaleForFile(workspaceId: string, filePath: string): Promise<void> {
		const rows = await this.allRaw<{ id: string; subject: string; body: string | null }>(
			`SELECT id, subject, body FROM ws_facts
			 WHERE workspace_id = ? AND kind = 'symbol'
			   AND confidence > 0 AND superseded_by IS NULL
			   AND (subject = ? OR subject LIKE ?)`,
			[workspaceId, filePath, `${filePath}::%`]
		);
		for (const r of rows) {
			const current = r.body ?? '';
			const body = current.startsWith('[verify after edit]')
				? current
				: `[verify after edit] ${current}`;
			await this.run(
				'UPDATE ws_facts SET body = ?, confidence = MIN(confidence, 0.35), priority = MIN(priority, 4), verified_by_test = 0 WHERE id = ?',
				[body, r.id]
			);
			await this.run('DELETE FROM ws_fts WHERE id = ?', [r.id]);
			await this.run('INSERT INTO ws_fts(id, subject, body) VALUES (?, ?, ?)', [r.id, r.subject, body]);
		}
	}

	/** Remove a fact from retrieval (set confidence/priority to floor). The verbatim
	 *  chat event survives for audit — only the rolled fact stops being surfaced. */
	async forget(factId: string): Promise<void> {
		await this.run('UPDATE ws_facts SET confidence = 0, priority = 0 WHERE id = ?', [factId]);
	}

	// ---- EDITORIAL LAYER ----
	async upsertProject(p: Omit<EditorialProject, 'id'> & { id?: string }): Promise<EditorialProject> {
		const existing = await this.getRaw<{ id: string }>('SELECT id FROM editorial_projects WHERE workspace_id = ?', [p.workspaceId]);
		const id = existing?.id ?? p.id ?? genId();
		await this.run(
			`INSERT INTO editorial_projects(id, workspace_id, name, readme, stack_json, status, ts_created, ts_filed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET name=excluded.name, readme=excluded.readme, stack_json=excluded.stack_json, status=excluded.status, ts_filed=excluded.ts_filed`,
			[id, p.workspaceId, p.name, p.readme, JSON.stringify(p.stack ?? []), p.status, p.tsCreated, p.tsFiled ?? null]
		);
		return { ...p, id };
	}

	async getProjectReadme(workspaceId: string): Promise<string> {
		const row = await this.getRaw<{ readme: string }>('SELECT readme FROM editorial_projects WHERE workspace_id = ?', [workspaceId]);
		return row?.readme ?? '';
	}

	/** Editorial layer overview for a workspace (readme + all branches). */
	async getEditorialOverview(workspaceId: string): Promise<{
		projectId: string | null;
		projectName: string;
		readme: string;
		branches: EditorialBranch[];
	}> {
		const row = await this.getRaw<{ id: string; name: string; readme: string }>(
			'SELECT id, name, readme FROM editorial_projects WHERE workspace_id = ?', [workspaceId]
		);
		if (!row) {
			return { projectId: null, projectName: '', readme: '', branches: [] };
		}
		return {
			projectId: row.id,
			projectName: row.name ?? '',
			readme: row.readme ?? '',
			branches: await this.getBranches(row.id),
		};
	}

	async upsertBranch(b: Omit<EditorialBranch, 'id'> & { id?: string }): Promise<EditorialBranch> {
		// One branch per (project, name) — rollup calls this every debounce; without lookup
		// we mint a new UUID each time and duplicate "decisions"/"quirks"/etc. rows forever.
		let id = b.id;
		if (!id) {
			const existing = await this.getRaw<{ id: string }>(
				'SELECT id FROM editorial_branches WHERE project_id = ? AND name = ?',
				[b.projectId, b.name]
			);
			id = existing?.id ?? genId();
		}
		await this.run(
			`INSERT INTO editorial_branches(id, project_id, name, mini_readme, worked, didnt_work, build_notes, code_refs_json, links_json, confidence, ts_updated)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET mini_readme=excluded.mini_readme, worked=excluded.worked, didnt_work=excluded.didnt_work, build_notes=excluded.build_notes, code_refs_json=excluded.code_refs_json, confidence=excluded.confidence, ts_updated=excluded.ts_updated`,
			[id, b.projectId, b.name, b.miniReadme, b.worked, b.didntWork, b.buildNotes, JSON.stringify(b.codeRefs ?? []), '[]', b.confidence, b.tsUpdated]
		);
		await this.run('DELETE FROM editorial_fts WHERE id = ?', [id]);
		await this.run('INSERT INTO editorial_fts(id, name, mini_readme, worked, didnt_work, build_notes) VALUES (?, ?, ?, ?, ?, ?)',
			[id, b.name, b.miniReadme, b.worked, b.didntWork, b.buildNotes]);
		return { ...b, id };
	}

	/**
	 * Branch names the automatic rollup owns and rewrites on every pass.
	 *
	 * A deliberate agent write to one of these would be silently overwritten minutes later, which
	 * reads as "my note vanished" rather than as a rejection. Refuse them at the door instead.
	 */
	static readonly RESERVED_EDITORIAL_TOPICS: readonly string[] = ['roadmap', 'decisions', 'quirks', 'symbols', 'hot-files'];

	/**
	 * Project row for a workspace, created only if absent.
	 *
	 * Deliberately NOT upsertProject: that carries `ON CONFLICT DO UPDATE SET readme=excluded.readme`,
	 * so calling it with an empty readme wipes whatever rollup had filed. Needed because
	 * fileToEditorial early-returns on a workspace with no facts yet, so a fresh workspace has no
	 * project row for a branch to hang off.
	 */
	private async ensureEditorialProject(workspaceId: string, name: string): Promise<string> {
		const existing = await this.getRaw<{ id: string }>('SELECT id FROM editorial_projects WHERE workspace_id = ?', [workspaceId]);
		if (existing?.id) { return existing.id; }
		const id = genId();
		const now = Date.now();
		await this.run(
			`INSERT INTO editorial_projects(id, workspace_id, name, readme, stack_json, status, ts_created, ts_filed)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, workspaceId, name, '', '[]', 'active', now, null]
		);
		return id;
	}

	/**
	 * Deliberate agent write to editorial memory.
	 *
	 * Distinct from upsertBranch, which takes a whole row and therefore blanks every field the caller
	 * did not supply — fine for rollup, which rebuilds a branch wholesale, wrong for an agent adding
	 * one line to `worked` without touching `didnt_work`.
	 *
	 * Appends by default. Each supplied field is merged line-wise with dedupe, so the same insight
	 * recorded twice does not accumulate, and each field is capped so a runaway loop cannot grow a row
	 * without bound.
	 */
	async writeEditorialBranch(opts: {
		workspaceId: string;
		topic: string;
		worked?: string;
		didntWork?: string;
		buildNotes?: string;
		miniReadme?: string;
		mode?: 'append' | 'replace';
	}): Promise<{ branchId: string; created: boolean; mode: 'append' | 'replace' }> {
		const topic = opts.topic.trim().toLowerCase().replace(/\s+/g, '-');
		if (!topic) { throw new Error('editorial topic is required'); }
		if (MemoryDatabase.RESERVED_EDITORIAL_TOPICS.includes(topic)) {
			throw new Error(`"${topic}" is maintained automatically and would be overwritten on the next rollup. Use a topic of your own, e.g. "${topic}-notes".`);
		}
		const mode = opts.mode ?? 'append';
		const projectId = await this.ensureEditorialProject(opts.workspaceId, topic);
		const existing = await this.getRaw<any>(
			'SELECT * FROM editorial_branches WHERE project_id = ? AND name = ?', [projectId, topic]
		);
		const FIELD_CAP = 8000;
		const merge = (prev: string | undefined, next: string | undefined): string => {
			if (next === undefined) { return prev ?? ''; }
			if (mode === 'replace') { return next.trim(); }
			const seen = new Set<string>();
			const keep: string[] = [];
			for (const line of `${prev ?? ''}\n${next}`.split('\n')) {
				const t = line.trimEnd();
				if (!t.trim()) { continue; }
				const key = t.replace(/\s+/g, ' ').toLowerCase();
				if (seen.has(key)) { continue; }
				seen.add(key);
				keep.push(t);
			}
			// Drop from the FRONT when over cap: the newest note is the one worth keeping.
			let out = keep.join('\n');
			while (out.length > FIELD_CAP && keep.length > 1) { keep.shift(); out = keep.join('\n'); }
			return out;
		};
		const id = existing?.id ?? genId();
		const row = {
			miniReadme: merge(existing?.mini_readme, opts.miniReadme),
			worked: merge(existing?.worked, opts.worked),
			didntWork: merge(existing?.didnt_work, opts.didntWork),
			buildNotes: merge(existing?.build_notes, opts.buildNotes),
		};
		await this.run(
			`INSERT INTO editorial_branches(id, project_id, name, mini_readme, worked, didnt_work, build_notes, code_refs_json, links_json, confidence, ts_updated)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET mini_readme=excluded.mini_readme, worked=excluded.worked, didnt_work=excluded.didnt_work, build_notes=excluded.build_notes, ts_updated=excluded.ts_updated`,
			[id, projectId, topic, row.miniReadme, row.worked, row.didntWork, row.buildNotes,
				existing?.code_refs_json ?? '[]', '[]', existing?.confidence ?? 0.9, Date.now()]
		);
		await this.run('DELETE FROM editorial_fts WHERE id = ?', [id]);
		await this.run('INSERT INTO editorial_fts(id, name, mini_readme, worked, didnt_work, build_notes) VALUES (?, ?, ?, ?, ?, ?)',
			[id, topic, row.miniReadme, row.worked, row.didntWork, row.buildNotes]);
		return { branchId: id, created: !existing, mode };
	}

	/**
	 * Delete an editorial topic, or blank one section of it.
	 *
	 * Hard delete rather than a confidence tombstone: nothing filters editorial reads by confidence,
	 * so a soft-deleted row keeps showing up and the agent concludes delete is broken.
	 */
	async deleteEditorialBranch(opts: { workspaceId: string; topic: string; section?: 'worked' | 'didnt_work' | 'build_notes' | 'mini_readme' }): Promise<{ deleted: boolean }> {
		const topic = opts.topic.trim().toLowerCase().replace(/\s+/g, '-');
		const project = await this.getRaw<{ id: string }>('SELECT id FROM editorial_projects WHERE workspace_id = ?', [opts.workspaceId]);
		if (!project?.id) { return { deleted: false }; }
		const existing = await this.getRaw<any>('SELECT * FROM editorial_branches WHERE project_id = ? AND name = ?', [project.id, topic]);
		if (!existing?.id) { return { deleted: false }; }
		if (!opts.section) {
			await this.run('DELETE FROM editorial_branches WHERE id = ?', [existing.id]);
			await this.run('DELETE FROM editorial_fts WHERE id = ?', [existing.id]);
			return { deleted: true };
		}
		const col = opts.section === 'didnt_work' ? 'didnt_work' : opts.section === 'build_notes' ? 'build_notes' : opts.section === 'mini_readme' ? 'mini_readme' : 'worked';
		await this.run(`UPDATE editorial_branches SET ${col} = '', ts_updated = ? WHERE id = ?`, [Date.now(), existing.id]);
		const after = await this.getRaw<any>('SELECT * FROM editorial_branches WHERE id = ?', [existing.id]);
		await this.run('DELETE FROM editorial_fts WHERE id = ?', [existing.id]);
		await this.run('INSERT INTO editorial_fts(id, name, mini_readme, worked, didnt_work, build_notes) VALUES (?, ?, ?, ?, ?, ?)',
			[existing.id, topic, after?.mini_readme ?? '', after?.worked ?? '', after?.didnt_work ?? '', after?.build_notes ?? '']);
		return { deleted: true };
	}

	async getBranches(projectId: string): Promise<EditorialBranch[]> {
		const rows = await this.allRaw<any>('SELECT * FROM editorial_branches WHERE project_id = ? ORDER BY ts_updated DESC', [projectId]);
		return rows.map(r => ({
			id: r.id, projectId: r.project_id, name: r.name, miniReadme: r.mini_readme ?? '',
			worked: r.worked ?? '', didntWork: r.didnt_work ?? '', buildNotes: r.build_notes ?? '',
			codeRefs: parseJson<CodeRef[]>(r.code_refs_json, []), confidence: r.confidence, tsUpdated: r.ts_updated,
		}));
	}

	async searchEditorial(query: string, crossProject = false): Promise<EditorialBranch[]> {
		const fts = toFtsQuery(query);
		if (!fts) return [];
		const rows = await this.allRaw<any>(
			`SELECT b.* FROM editorial_branches b JOIN editorial_fts f ON f.id = b.id WHERE editorial_fts MATCH ? ORDER BY f.rank LIMIT 30`,
			[fts]
		);
		// crossProject is implicit here (FTS spans all projects); a non-cross caller
		// filters by project on its side once it knows the active projectId.
		void crossProject;
		return rows.map(r => ({
			id: r.id, projectId: r.project_id, name: r.name, miniReadme: r.mini_readme ?? '',
			worked: r.worked ?? '', didntWork: r.didnt_work ?? '', buildNotes: r.build_notes ?? '',
			codeRefs: parseJson<CodeRef[]>(r.code_refs_json, []), confidence: r.confidence, tsUpdated: r.ts_updated,
		}));
	}

	// ---- ESCALATION LEDGER (packet 3 tuning dataset) ----
	async recordEscalation(e: Omit<EscalationLogEntry, 'id'>): Promise<string> {
		const id = genId();
		await this.run(
			`INSERT INTO escalation_log(id, workspace_id, ts, trigger_rule, evidence_hash, fix_applied, verify_passed, meta_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, e.workspaceId, e.ts, e.triggerRule, e.evidenceHash ?? null, e.fixApplied ?? null,
			e.verifyPassed === undefined ? null : (e.verifyPassed ? 1 : 0), JSON.stringify(e.meta ?? {})]
		);
		await this.writeTimelineRow({
			id: `tl:esc:${id}`, workspaceId: e.workspaceId, ts: e.ts, kind: 'escalation',
			escalationId: id, meta: { triggerRule: e.triggerRule, verifyPassed: e.verifyPassed ?? null },
		});
		return id;
	}

	// ---- TIMELINE LAYER (catalog C2): time+file rail, references only ----

	/** Insert a timeline row. id is deterministic (tl:ev:<id> / tl:fact:<id> /
	 *  tl:esc:<id>) and the insert is OR IGNORE, so live writes and the backfill can
	 *  never double-insert the same source and re-running the backfill is free. */
	private async writeTimelineRow(r: {
		id: string; workspaceId: string; ts: number; kind: TimelineKind;
		file?: string | null; sessionId?: string | null; chatEventId?: string | null;
		factId?: string | null; planVersionId?: string | null; escalationId?: string | null;
		meta?: Record<string, unknown>; shadowId?: string | null;
	}): Promise<void> {
		await this.run(
			`INSERT OR IGNORE INTO timeline(id, workspace_id, ts, kind, file, session_id, chat_event_id, fact_id, plan_version_id, escalation_id, meta_json, shadow_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[r.id, r.workspaceId, r.ts, r.kind, r.file ?? null, r.sessionId ?? null, r.chatEventId ?? null,
			r.factId ?? null, r.planVersionId ?? null, r.escalationId ?? null, JSON.stringify(r.meta ?? {}), r.shadowId ?? null]
		);
	}

	/** One-time backfill of the rail from existing chat_events (meta-guarded). Safe to
	 *  re-run: OR IGNORE + deterministic ids dedup against rows the live hook wrote. */
	private async backfillTimelineV2(): Promise<void> {
		if (await this.getMeta(MEMORY_META_KEYS.timelineBackfilled) === '1') return;
		const rows = await this.allRaw<ChatEventRow>('SELECT * FROM chat_events ORDER BY ts ASC');
		for (const r of rows) {
			const ev = this.toChatEvent(r);
			await this.writeTimelineRow({
				id: `tl:ev:${ev.id}`, workspaceId: ev.workspaceId, ts: ev.ts,
				kind: toTimelineKind(ev.kind, ev.meta), file: ev.files?.[0] ?? null,
				sessionId: ev.sessionId, chatEventId: ev.id, meta: timelineMeta(ev.meta),
			});
		}
		await this.setMeta(MEMORY_META_KEYS.timelineBackfilled, '1');
	}

	/** One-time repair: digest events were written to chat_events but timeline rows used
	 *  toTimelineKind(kind) without meta, so they showed as gray "read" in MemLegend. */
	private async repairDigestTimelineKinds(): Promise<void> {
		if (await this.getMeta(MEMORY_META_KEYS.digestTimelineRepaired) === '1') { return; }
		await this.run(
			`UPDATE timeline SET kind = 'digest'
			 WHERE chat_event_id IN (
			   SELECT id FROM chat_events WHERE meta_json LIKE '%"digest":true%'
			 ) AND kind != 'digest'`
		);
		await this.setMeta(MEMORY_META_KEYS.digestTimelineRepaired, '1');
	}

	/** One-time repair: fileToEditorial used to genId() every rollup → duplicate branch rows. */
	private async repairDuplicateEditorialBranches(): Promise<void> {
		if (await this.getMeta(MEMORY_META_KEYS.editorialBranchesRepaired) === '1') { return; }
		const dupes = await this.allRaw<{ project_id: string; name: string }>(
			`SELECT project_id, name FROM editorial_branches GROUP BY project_id, name HAVING COUNT(*) > 1`
		);
		for (const d of dupes) {
			const rows = await this.allRaw<{ id: string }>(
				'SELECT id FROM editorial_branches WHERE project_id = ? AND name = ? ORDER BY ts_updated DESC',
				[d.project_id, d.name]
			);
			for (let i = 1; i < rows.length; i++) {
				await this.run('DELETE FROM editorial_branches WHERE id = ?', [rows[i].id]);
				await this.run('DELETE FROM editorial_fts WHERE id = ?', [rows[i].id]);
			}
		}
		await this.setMeta(MEMORY_META_KEYS.editorialBranchesRepaired, '1');
	}

	/** One-time repair: plan snapshots used to file as generic decisions and spam editorial. */
	private async repairPlanSnapshotDecisions(): Promise<void> {
		if (await this.getMeta(MEMORY_META_KEYS.planDecisionsRepaired) === '1') { return; }
		const rows = await this.allRaw<{ id: string; workspace_id: string }>(
			`SELECT id, workspace_id FROM ws_facts
			 WHERE (
			   kind = 'decision'
			   AND (subject LIKE 'Plan (%' OR subject LIKE 'Plan:%')
			   AND body LIKE '- [%] %'
			 ) OR (
			   kind = 'roadmap'
			   AND subject NOT LIKE 'plan:%'
			   AND body LIKE '[%] %'
			 )`
		);
		const workspaces = new Set<string>();
		for (const r of rows) {
			workspaces.add(r.workspace_id);
			await this.run('UPDATE ws_facts SET confidence = 0, superseded_by = id WHERE id = ?', [r.id]);
			await this.run('DELETE FROM ws_fts WHERE id = ?', [r.id]);
		}
		for (const workspaceId of workspaces) {
			await this.fileToEditorial(workspaceId);
			const activeDecision = await this.getRaw<{ n: number }>(
				`SELECT COUNT(*) AS n FROM ws_facts
				 WHERE workspace_id = ? AND kind = 'decision' AND confidence > 0 AND superseded_by IS NULL`,
				[workspaceId]
			);
			if ((activeDecision?.n ?? 0) === 0) {
				const project = await this.getRaw<{ id: string }>('SELECT id FROM editorial_projects WHERE workspace_id = ?', [workspaceId]);
				if (project) {
					const branch = await this.getRaw<{ id: string }>('SELECT id FROM editorial_branches WHERE project_id = ? AND name = ?', [project.id, 'decisions']);
					if (branch) {
						await this.run('DELETE FROM editorial_branches WHERE id = ?', [branch.id]);
						await this.run('DELETE FROM editorial_fts WHERE id = ?', [branch.id]);
					}
				}
			}
		}
		await this.setMeta(MEMORY_META_KEYS.planDecisionsRepaired, '1');
	}

	private toTimelineEntry(r: TimelineRow): TimelineEntry {
		return {
			id: r.id, workspaceId: r.workspace_id, ts: r.ts, kind: r.kind as TimelineKind,
			file: r.file ?? undefined, sessionId: r.session_id ?? undefined,
			chatEventId: r.chat_event_id ?? undefined, factId: r.fact_id ?? undefined,
			planVersionId: r.plan_version_id ?? undefined, escalationId: r.escalation_id ?? undefined,
			meta: parseJson<Record<string, unknown>>(r.meta_json, {}),
		};
	}

	private toEscalation(r: EscalationRow): EscalationLogEntry {
		return {
			id: r.id, workspaceId: r.workspace_id, ts: r.ts, triggerRule: r.trigger_rule,
			evidenceHash: r.evidence_hash ?? undefined, fixApplied: r.fix_applied ?? undefined,
			verifyPassed: r.verify_passed === null ? undefined : r.verify_passed === 1,
			meta: parseJson<Record<string, unknown>>(r.meta_json, {}),
		};
	}

	/** Read the rail newest-first. */
	async getTimeline(workspaceId: string, limit = 100): Promise<TimelineEntry[]> {
		const rows = await this.allRaw<TimelineRow>(
			'SELECT * FROM timeline WHERE workspace_id = ? ORDER BY ts DESC LIMIT ?', [workspaceId, limit]
		);
		return rows.map(r => this.toTimelineEntry(r));
	}

	// ---- SHADOW ARCHIVE search (break-glass deep_recall) -------------------------------
	// Operates directly on the append-only shadow/<wsId>/<YYYY-MM-DD>.jsonl files (the jsonl
	// IS the source of truth; no separate index to keep in sync -- a scan is correct and
	// simple at this scale; an FTS5 accelerator is a later optimization). It reaches records
	// the curated layer decayed/filtered/never kept, and returns a tight ranked set.

	/** Lexical deep search across the entire raw shadow archive for a workspace. Returns a
	 *  RANKED, bounded set (default 8, hard cap 15) of snippets -- never the firehose. */
	async deepRecall(shadowDir: string, query: string, limit = 8): Promise<ShadowHit[]> {
		const cap = Math.max(1, Math.min(15, Math.floor(limit) || 8));
		const tokens = query.toLowerCase().split(/\s+/)
			.map(t => t.replace(/[^\p{L}\p{N}_]+/gu, '')).filter(t => t.length > 0);
		if (!tokens.length) { return []; }
		let dayFiles: string[];
		try { dayFiles = (await fs.readdir(shadowDir)).filter(f => f.endsWith('.jsonl')).sort().reverse(); }
		catch { return []; } // archive not created yet
		const MAX_LINES = 100_000;
		let scanned = 0, truncated = false;
		const hits: Array<ShadowHit & { score: number }> = [];
		for (const fname of dayFiles) {
			if (scanned >= MAX_LINES) { truncated = true; break; }
			let content: string;
			try { content = await fs.readFile(join(shadowDir, fname), 'utf8'); } catch { continue; }
			for (const line of content.split('\n')) {
				if (!line) { continue; }
				if (++scanned > MAX_LINES) { truncated = true; break; }
				let rec: ShadowRecord;
				try { rec = JSON.parse(line) as ShadowRecord; } catch { continue; }
				const text = rec.text ?? '';
				const hay = `${text}\n${rec.file ?? ''} ${rec.tool ?? ''} ${rec.kind ?? ''}`.toLowerCase();
				let score = 0;
				for (const t of tokens) { if (hay.includes(t)) { score++; } }
				if (!score) { continue; }
				hits.push({
					id: rec.id, ts: rec.ts, kind: rec.kind, file: rec.file ?? null, eventId: rec.eventId ?? null,
					snippet: shadowSnippet(text, tokens), score,
				});
			}
		}
		hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
		if (truncated) { console.error(`[memory] deep_recall hit the ${MAX_LINES}-line scan cap; oldest shadow days not searched this call`); }
		return hits.slice(0, cap).map(({ score, ...h }) => h);
	}

	/** Fetch ONE shadow record's full raw text by id (when a snippet isn't enough). */
	async getShadowRecord(shadowDir: string, id: string): Promise<ShadowRecord | null> {
		let dayFiles: string[];
		try { dayFiles = (await fs.readdir(shadowDir)).filter(f => f.endsWith('.jsonl')).sort().reverse(); }
		catch { return null; }
		for (const fname of dayFiles) {
			let content: string;
			try { content = await fs.readFile(join(shadowDir, fname), 'utf8'); } catch { continue; }
			for (const line of content.split('\n')) {
				if (!line || !line.includes(id)) { continue; }
				try { const rec = JSON.parse(line) as ShadowRecord; if (rec.id === id) { return rec; } } catch { /* skip */ }
			}
		}
		return null;
	}

	/** Hydrate a rung on demand: fetch whatever payload its id columns point at, or
	 *  flag `gone` when that payload no longer exists (the references-only proof). */
	async hydrateTimeline(id: string): Promise<TimelineHydration | null> {
		const row = await this.getRaw<TimelineRow>('SELECT * FROM timeline WHERE id = ?', [id]);
		if (!row) return null;
		const out: TimelineHydration = { entry: this.toTimelineEntry(row), gone: false };
		// Resolve EVERY reference the rung carries (a fact rung links both its fact and
		// the originating chat event). `gone` means the rung had references but NONE of
		// them survive on disk -- it then still renders from the entry's scalar meta.
		let refs = 0, resolved = 0;
		if (row.chat_event_id) {
			refs++;
			const er = await this.getRaw<ChatEventRow>('SELECT * FROM chat_events WHERE id = ?', [row.chat_event_id]);
			if (er) { out.chatEvent = this.toChatEvent(er); resolved++; }
		}
		if (row.fact_id) {
			refs++;
			const fr = await this.getRaw<WsFactRow>('SELECT * FROM ws_facts WHERE id = ?', [row.fact_id]);
			if (fr) { out.fact = this.toWsFact(fr); resolved++; }
		}
		if (row.escalation_id) {
			refs++;
			const sr = await this.getRaw<EscalationRow>('SELECT * FROM escalation_log WHERE id = ?', [row.escalation_id]);
			if (sr) { out.escalation = this.toEscalation(sr); resolved++; }
		}
		out.gone = refs > 0 && resolved === 0;
		return out;
	}

	// ---- EMBEDDING STORE (catalog C3): vectors + content cache + pending queue ----
	// Pure storage. The actual text->vector embedding is driven by the orchestrator
	// (browser MemoryService via ISemanticEmbedService) which calls storeFactEmbedding;
	// this layer holds the bytes, dedupes by content hash, and tracks what still needs
	// embedding. Ranking over these vectors (JS-cosine / sqlite-vec) is C4.

	/** Store (or replace) a fact's embedding. Model-aware: a host that resolves a
	 *  different embed model stores its own (fact_id, model_id) row and re-embeds on drift. */
	async putFactVector(factId: string, modelId: string, dim: number, vec: Float32Array): Promise<void> {
		await this.run(
			`INSERT INTO ws_vectors(fact_id, model_id, dim, vec, ts) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(fact_id, model_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, ts = excluded.ts`,
			[factId, modelId, dim, f32ToBlob(vec), Date.now()]
		);
	}

	async getFactVector(factId: string, modelId: string): Promise<Float32Array | null> {
		const row = await this.getRaw<{ vec: Buffer }>(
			'SELECT vec FROM ws_vectors WHERE fact_id = ? AND model_id = ?', [factId, modelId]
		);
		return row ? blobToF32(row.vec) : null;
	}

	/** Content-addressed embedding cache: dedupes embed work across restarts + identical
	 *  texts. Keyed by sha256(text)+model so a cross-model lookup is a clean miss. */
	async getCachedVector(text: string, modelId: string): Promise<Float32Array | null> {
		const row = await this.getRaw<{ vec: Buffer }>(
			'SELECT vec FROM embed_cache WHERE sha256 = ? AND model_id = ?', [sha256(text), modelId]
		);
		return row ? blobToF32(row.vec) : null;
	}

	async putCachedVector(text: string, modelId: string, dim: number, vec: Float32Array): Promise<void> {
		await this.run(
			'INSERT OR IGNORE INTO embed_cache(sha256, model_id, dim, vec) VALUES (?, ?, ?, ?)',
			[sha256(text), modelId, dim, f32ToBlob(vec)]
		);
	}

	/** Facts still needing an embedding (embed_pending=1), oldest-touched first. The text
	 *  to embed is subject + body. Skips tombstoned facts (confidence 0). */
	async getEmbedPending(limit = 32): Promise<{ id: string; text: string }[]> {
		const rows = await this.allRaw<{ id: string; subject: string; body: string | null }>(
			'SELECT id, subject, body FROM ws_facts WHERE embed_pending = 1 AND confidence > 0 ORDER BY ts_last ASC LIMIT ?',
			[limit]
		);
		return rows.map(r => ({ id: r.id, text: [r.subject, r.body ?? ''].filter(Boolean).join('\n') }));
	}

	async markFactEmbedded(factId: string): Promise<void> {
		await this.run('UPDATE ws_facts SET embed_pending = 0 WHERE id = ?', [factId]);
	}

	/** One-shot used by the orchestrator after it embeds (or gets a cache hit): cache the
	 *  vector by content, attach it to the fact, and clear the fact's pending flag. */
	async storeFactEmbedding(factId: string, text: string, modelId: string, dim: number, vec: Float32Array): Promise<void> {
		await this.putCachedVector(text, modelId, dim, vec);
		await this.putFactVector(factId, modelId, dim, vec);
		await this.markFactEmbedded(factId);
	}

	// ---- PROCEDURAL MEMORY (catalog C7): learned how-to, retrievable by trigger ----

	private toLearnedProcedure(r: LearnedProcedureRow): LearnedProcedure {
		return {
			id: r.id, workspaceId: r.workspace_id, triggerPattern: r.trigger_pattern,
			steps: parseJson<string[]>(r.steps_json, []),
			verifiedByTest: r.verified_by_test === 1, successCount: r.success_count, lastUsed: r.last_used,
			provenance: r.provenance ?? undefined, target: (r.target as ProcedureTarget) ?? 'workspace', tsCreated: r.ts_created,
		};
	}

	/** Save (or update) a learned procedure, keyed by (workspace, trigger_pattern, target).
	 *  Re-saving the same trigger refreshes its steps and bumps success_count -- a procedure
	 *  gets stronger each time it is confirmed to work. verified_by_test is sticky once true. */
	async saveProcedure(p: LearnedProcedureInput): Promise<LearnedProcedure> {
		const now = Date.now();
		const target = p.target ?? 'workspace';
		const verified = p.verifiedByTest === true ? 1 : 0;
		const existing = await this.getRaw<LearnedProcedureRow>(
			'SELECT * FROM learned_procedures WHERE workspace_id = ? AND trigger_pattern = ? AND target = ?',
			[p.workspaceId, p.triggerPattern, target]
		);
		if (existing) {
			await this.run(
				`UPDATE learned_procedures SET steps_json = ?, verified_by_test = ?, success_count = success_count + 1, last_used = ?, provenance = ? WHERE id = ?`,
				[JSON.stringify(p.steps), existing.verified_by_test === 1 || verified ? 1 : 0, now, p.provenance ?? existing.provenance, existing.id]
			);
			const r = await this.getRaw<LearnedProcedureRow>('SELECT * FROM learned_procedures WHERE id = ?', [existing.id]);
			return this.toLearnedProcedure(r!);
		}
		const id = genId();
		await this.run(
			`INSERT INTO learned_procedures(id, workspace_id, trigger_pattern, steps_json, verified_by_test, success_count, last_used, provenance, target, ts_created)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, p.workspaceId, p.triggerPattern, JSON.stringify(p.steps), verified, 1, now, p.provenance ?? null, target, now]
		);
		const r = await this.getRaw<LearnedProcedureRow>('SELECT * FROM learned_procedures WHERE id = ?', [id]);
		return this.toLearnedProcedure(r!);
	}

	/** Retrieve procedures whose trigger matches a task description -- exact, the trigger is
	 *  contained in the query, or the query is contained in the trigger. Verified + most-
	 *  successful + recently-used first. Read-only (call markProcedureUsed on a real replay). */
	async retrieveProcedures(workspaceId: string, query: string, limit = 5): Promise<LearnedProcedure[]> {
		const rows = await this.allRaw<LearnedProcedureRow>(
			`SELECT * FROM learned_procedures
			 WHERE workspace_id = ?
			   AND (trigger_pattern = ? OR ? LIKE '%' || trigger_pattern || '%' OR trigger_pattern LIKE '%' || ? || '%')
			 ORDER BY verified_by_test DESC, success_count DESC, last_used DESC LIMIT ?`,
			[workspaceId, query, query, query, limit]
		);
		return rows.map(r => this.toLearnedProcedure(r));
	}

	/** Bump a procedure's success + recency when it is replayed successfully. */
	async markProcedureUsed(id: string): Promise<void> {
		await this.run('UPDATE learned_procedures SET success_count = success_count + 1, last_used = ? WHERE id = ?', [Date.now(), id]);
	}

	// ---- PER-TURN SNAPSHOT (packet 1 section 4) ----
	async buildSnapshot(workspaceId: string, sessionId: string, role: AgentRole, budgetTokens: number, activeContext?: ActiveContext): Promise<MemorySnapshot> {
		const now = Date.now();
		// Cheap top-of-tree only. The DEBUGGER profile intentionally returns the
		// narrowest set (crime-scene assembly is packet 3's job, not here).
		const eventLimit = role === 'debugger' ? 8 : 16;
		const recentRows = await this.allRaw<ChatEventRow>(
			'SELECT id, ts, kind, role, title FROM chat_events WHERE workspace_id = ? ORDER BY ts DESC LIMIT ?',
			[workspaceId, eventLimit]
		);
		const recentEvents = recentRows.map(r => ({
			id: r.id, ts: r.ts, kind: r.kind as MemoryKind, role: (r.role as AgentRole) ?? undefined, title: r.title ?? '',
		}));

		// FACTS compete by salience for one token budget (catalog C5). symbol/decision/quirk
		// facts are ranked together, then greedily filled to budgetTokens. Inclusion bumps
		// last_used_at/use_count. Decay/staleness only drop a fact from the LIVE snapshot --
		// nothing is deleted from disk; a faded fact reappears if it becomes relevant again.
		const factRows = await this.allRaw<WsFactRow>(
			`SELECT * FROM ws_facts WHERE workspace_id = ? AND confidence > 0 AND superseded_by IS NULL
			 AND kind IN ('symbol','decision','quirk') ORDER BY ts_last DESC, id DESC LIMIT 300`,
			[workspaceId]
		);
		const scored = factRows
			.map(r => ({
				row: r,
				score: salience({
					subject: r.subject, tsLast: r.ts_last, confidence: r.confidence,
					source: r.source, verifiedByTest: r.verified_by_test === 1,
					lastUsedAt: r.last_used_at, useCount: r.use_count,
				}, activeContext, now),
			}))
			// Deterministic tie-break by id so equal-salience facts keep a stable order across
			// turns. Combined with placing memory in the per-turn tail (not the cached prefix),
			// this stops the memory block from needlessly reshuffling and working against caching.
			.sort((a, b) => (b.score - a.score) || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));

		const maxCount = role === 'debugger' ? 12 : 40;
		const included: WsFactRow[] = [];
		let usedTokens = 0;
		for (const s of scored) {
			if (included.length >= maxCount) { break; }
			const tok = Math.ceil((`${s.row.subject}\n${s.row.body ?? ''}`).length / 4);
			if (included.length > 0 && usedTokens + tok > budgetTokens) { break; } // always keep at least one
			included.push(s.row);
			usedTokens += tok;
		}
		// Bump usage for what was actually surfaced (ranking signal only; never deletes).
		if (included.length) {
			const ph = included.map(() => '?').join(',');
			await this.run(
				`UPDATE ws_facts SET last_used_at = ?, use_count = use_count + 1 WHERE id IN (${ph})`,
				[now, ...included.map(r => r.id)]
			);
		}
		const openDecisions = included.filter(r => r.kind === 'decision').map(r => ({ subject: r.subject, body: r.body ?? '' }));
		const activeQuirks = included.filter(r => r.kind === 'quirk').map(r => r.body ?? '').filter(Boolean);
		const symbolFacts = included.filter(r => r.kind === 'symbol').map(r => ({ subject: r.subject, body: r.body ?? '' }));

		// touchedFiles: aggregate the most recent file-touching events.
		const fileRows = await this.allRaw<{ ts: number; kind: string; files_json: string | null }>(
			"SELECT ts, kind, files_json FROM chat_events WHERE workspace_id = ? AND files_json IS NOT NULL AND files_json != '[]' ORDER BY ts DESC LIMIT 40",
			[workspaceId]
		);
		const touchedMap = new Map<string, { path: string; lastTs: number; lastKind: MemoryKind }>();
		for (const r of fileRows) {
			for (const p of parseJson<string[]>(r.files_json, [])) {
				if (!touchedMap.has(p)) touchedMap.set(p, { path: p, lastTs: r.ts, lastKind: r.kind as MemoryKind });
			}
			if (touchedMap.size >= 12) break;
		}

		return {
			workspaceId, sessionId, generatedAt: now,
			recentEvents, openDecisions,
			touchedFiles: [...touchedMap.values()],
			activeQuirks,
			symbolFacts,
			budgetTokens,
		};
	}

	// ---- ROLLUP: chat -> workspace (packet 1 section 3, write-path filtered) ----
	async rollupToWorkspace(workspaceId: string, projectName?: string): Promise<void> {
		const sinceStr = await this.getMeta(MEMORY_META_KEYS.lastRollupTs);
		const since = sinceStr ? Number(sinceStr) : 0;
		const rows = await this.allRaw<ChatEventRow>(
			'SELECT * FROM chat_events WHERE workspace_id = ? AND ts > ? ORDER BY ts ASC',
			[workspaceId, since]
		);
		let maxTs = since;
		for (const r of rows) {
			maxTs = Math.max(maxTs, r.ts);
			const ev = this.toChatEvent(r);
			const passed = (ev.meta?.['verifyPassed'] as boolean | undefined) ?? undefined;
			// Write-path filter (packet 6 sec 6): only signal events graduate to facts.
			if (ev.kind === 'diff' && ev.files && ev.files.length > 0) {
				// file_state per file; only bump confidence when tests/build passed.
				for (const f of ev.files) {
					const fileFact = await this.upsertFact({
						workspaceId, kind: 'file_state', subject: f,
						body: ev.title || `Changed ${f}`,
						confidence: passed ? 0.7 : 0.5, source: [ev.id],
						provenance: 'ai_inferred', verifiedByTest: passed === true,
					});
					await this.writeTimelineRow({
						id: `tl:fact:${fileFact.id}`, workspaceId, ts: ev.ts, kind: 'diff', file: f,
						sessionId: ev.sessionId, chatEventId: ev.id, factId: fileFact.id,
						meta: { rawFactKind: 'file_state', verifyPassed: passed ?? null },
					});
					await this.markSymbolFactsStaleForFile(workspaceId, f);
				}
				// cochange edges across all file pairs touched together.
				for (let i = 0; i < ev.files.length; i++) {
					for (let j = i + 1; j < ev.files.length; j++) {
						await this.bumpCochange(workspaceId, ev.files[i], ev.files[j]);
					}
				}
			} else if (ev.kind === 'decision') {
				const isPlanSnapshot = ev.meta?.['todoCount'] !== undefined || /^Plan[: ]/.test(ev.title ?? '') || /^Plan \(/.test(ev.title ?? '');
				if (!isPlanSnapshot) {
					const decisionFact = await this.upsertFact({
						workspaceId, kind: 'decision', subject: ev.title || ev.id,
						body: ev.body, confidence: 0.7, priority: 7, source: [ev.id],
						provenance: 'ai_inferred', verifiedByTest: passed === true,
					});
					await this.writeTimelineRow({
						id: `tl:fact:${decisionFact.id}`, workspaceId, ts: ev.ts, kind: 'decision',
						sessionId: ev.sessionId, chatEventId: ev.id, factId: decisionFact.id,
						meta: { rawFactKind: 'decision' },
					});
				}
				if (isPlanSnapshot) {
					const planKey = typeof ev.meta?.['planKey'] === 'string' && ev.meta['planKey']
						? ev.meta['planKey'] as string
						: ev.body.split('\n').map(line => line.replace(/^- \[[^\]]+\]\s*/, '').trim()).filter(Boolean).join('|').slice(0, 160);
					const statuses = ev.body.split('\n')
						.map(line => line.match(/^- \[([^\]]+)\]/)?.[1]?.trim())
						.filter((s): s is string => !!s);
					const priority = statuses.some(s => s === 'in_progress') ? 8
						: statuses.length && statuses.every(s => s === 'completed' || s === 'cancelled') ? 9
							: 6;
					const roadmapFact = await this.upsertFact({
						workspaceId,
						kind: 'roadmap',
						subject: `plan:${planKey || ev.title || ev.id}`,
						body: ev.body,
						confidence: 0.75,
						priority,
						source: [ev.id],
						provenance: 'ai_inferred',
						verifiedByTest: passed === true,
					});
					await this.writeTimelineRow({
						id: `tl:fact:${roadmapFact.id}`, workspaceId, ts: ev.ts, kind: 'decision',
						sessionId: ev.sessionId, chatEventId: ev.id, factId: roadmapFact.id,
						meta: { rawFactKind: 'roadmap', planKey, status: statuses.join(',') },
					});
				}
			} else if (ev.kind === 'note' && (ev.meta?.['quirk'] === true)) {
				const quirkFact = await this.upsertFact({
					workspaceId, kind: 'quirk', subject: ev.title || ev.id,
					body: ev.body, confidence: 0.8, priority: 8, source: [ev.id],
					provenance: 'ai_inferred', verifiedByTest: passed === true,
				});
				await this.writeTimelineRow({
					id: `tl:fact:${quirkFact.id}`, workspaceId, ts: ev.ts, kind: 'read',
					sessionId: ev.sessionId, chatEventId: ev.id, factId: quirkFact.id,
					meta: { rawFactKind: 'quirk' },
				});
			} else if (ev.kind === 'note' && (ev.meta?.['digest'] === true) && ev.sessionId) {
				// Bounded-chat step 5: promote the rolling session digest to a DURABLE workspace fact.
				// ONE row per session (subject keyed by sessionId); the body updates each rollup as the
				// digest grows (the contradiction path is exempted for 'session_digest' in upsertFact).
				// The chat-event note still drives the live <session_digest> injection + green ledger
				// rung; this fact is the durable layer copy (survives, queryable, for session reload).
				await this.upsertFact({
					workspaceId, kind: 'session_digest', subject: `session-digest:${ev.sessionId}`,
					body: ev.body, confidence: 0.6, priority: 6, source: [ev.id],
					provenance: 'ai_inferred',
				});
			}
		}
		if (maxTs > since) await this.setMeta(MEMORY_META_KEYS.lastRollupTs, String(maxTs));
		await this.fileToEditorial(workspaceId, projectName);
	}

	/** Distill workspace facts into editorial project readme + topic branches (Packet 1e). */
	async fileToEditorial(workspaceId: string, projectName?: string): Promise<void> {
		const decisions = await this.allRaw<WsFactRow>(
			`SELECT * FROM ws_facts
			 WHERE workspace_id = ? AND kind = ?
			   AND subject NOT LIKE 'Plan (%'
			   AND subject NOT LIKE 'Plan:%'
			 ORDER BY ts_last DESC LIMIT 30`,
			[workspaceId, 'decision']
		);
		const quirks = await this.allRaw<WsFactRow>(
			'SELECT * FROM ws_facts WHERE workspace_id = ? AND kind = ? ORDER BY ts_last DESC LIMIT 20',
			[workspaceId, 'quirk']
		);
		const symbols = await this.allRaw<WsFactRow>(
			'SELECT * FROM ws_facts WHERE workspace_id = ? AND kind = ? ORDER BY confidence DESC, ts_last DESC LIMIT 25',
			[workspaceId, 'symbol']
		);
		const files = await this.allRaw<WsFactRow>(
			'SELECT * FROM ws_facts WHERE workspace_id = ? AND kind = ? ORDER BY ts_last DESC LIMIT 20',
			[workspaceId, 'file_state']
		);
		const roadmap = await this.allRaw<WsFactRow>(
			'SELECT * FROM ws_facts WHERE workspace_id = ? AND kind = ? ORDER BY priority DESC, ts_last DESC LIMIT 40',
			[workspaceId, 'roadmap']
		);

		if (!decisions.length && !quirks.length && !symbols.length && !files.length && !roadmap.length) {
			return;
		}

		// Prefer the real workspace folder name passed from the renderer; the workspaceId is a wsId
		// UUID here, so the old split().pop() fallback produced "# <uuid>" titles and "Editorial
		// project: <uuid>" headers. Roadmap/plan facts are deliberately NOT packed into the editorial
		// readme — that is live task residue (completed/pending/in-progress plans), not the stable
		// orientation this readme is for. Plans live in update_plan/active_plan, not here.
		const resolvedName = (projectName && projectName.trim())
			? projectName.trim()
			: (workspaceId.split(/[/\\]/).filter(Boolean).pop() || workspaceId);
		const readmeLines: string[] = [`# ${resolvedName}`, ''];
		void roadmap;
		if (decisions.length) {
			readmeLines.push('## Recent decisions', '');
			for (const d of decisions.slice(0, 8)) {
				readmeLines.push(`- ${d.subject}: ${(d.body ?? '').slice(0, 200)}`);
			}
			readmeLines.push('');
		}
		if (quirks.length) {
			readmeLines.push('## Build / env quirks', '');
			for (const q of quirks.slice(0, 5)) {
				readmeLines.push(`- ${(q.body ?? '').slice(0, 200)}`);
			}
		}

		const project = await this.upsertProject({
			workspaceId,
			name: resolvedName,
			readme: readmeLines.join('\n').trim(),
			stack: [],
			status: 'active',
			tsCreated: Date.now(),
		});

		const now = Date.now();
		const bullets = (rows: WsFactRow[]) =>
			rows.map(r => `- ${r.subject}: ${(r.body ?? '').slice(0, 300)}`).join('\n');
		const roadmapBullets = (rows: WsFactRow[]) =>
			rows.map(r => {
				const title = r.subject.startsWith('plan:') ? 'Plan' : r.subject;
				const body = (r.body ?? '').split('\n').slice(0, 12).map(line => `  ${line}`).join('\n');
				return `- ${title}${body ? `\n${body}` : ''}`;
			}).join('\n');

		if (roadmap.length) {
			await this.upsertBranch({
				projectId: project.id,
				name: 'roadmap',
				miniReadme: 'Build-state spine: goal, done, next, and blocked work promoted from active plans.',
				worked: roadmapBullets(roadmap),
				didntWork: '',
				buildNotes: '',
				codeRefs: [],
				confidence: 0.8,
				tsUpdated: now,
			});
		}
		if (decisions.length) {
			await this.upsertBranch({
				projectId: project.id,
				name: 'decisions',
				miniReadme: 'Open decisions and plan items from chat rollup.',
				worked: bullets(decisions),
				didntWork: '',
				buildNotes: '',
				codeRefs: [],
				confidence: 0.7,
				tsUpdated: now,
			});
		}
		if (quirks.length) {
			await this.upsertBranch({
				projectId: project.id,
				name: 'quirks',
				miniReadme: 'Build, terminal, and environment gotchas.',
				worked: bullets(quirks),
				didntWork: '',
				buildNotes: '',
				codeRefs: [],
				confidence: 0.8,
				tsUpdated: now,
			});
		}
		if (symbols.length) {
			await this.upsertBranch({
				projectId: project.id,
				name: 'symbols',
				miniReadme: 'Symbol-attached notes (remember + migrated notes).',
				worked: bullets(symbols),
				didntWork: '',
				buildNotes: '',
				codeRefs: [],
				confidence: 0.75,
				tsUpdated: now,
			});
		}
		if (files.length) {
			await this.upsertBranch({
				projectId: project.id,
				name: 'hot-files',
				miniReadme: 'Files touched recently by agent edits.',
				worked: bullets(files),
				didntWork: '',
				buildNotes: '',
				codeRefs: [],
				confidence: 0.6,
				tsUpdated: now,
			});
		}
	}

		// ---- MEMORY TIMELINE v3: checkpoints, archive pages, and pull-index ----

		private toCheckpoint(r: MemoryCheckpointRow): MemoryCheckpoint {
			return {
				id: r.id, workspaceId: r.workspace_id, sessionId: r.session_id,
				parentCheckpointId: r.parent_checkpoint_id ?? undefined,
				trigger: r.trigger as MemoryCheckpoint['trigger'], startEventId: r.start_event_id,
				endEventId: r.end_event_id, startedAt: r.started_at, endedAt: r.ended_at,
				summary: r.summary, summaryHash: r.summary_hash, summaryFormatVersion: r.summary_format_version,
				sourceEventCount: r.source_event_count, sourceBytes: r.source_bytes,
				status: r.status as MemoryCheckpoint['status'], pinned: r.pinned === 1,
				createdAt: r.created_at, meta: parseJson<Record<string, unknown>>(r.meta_json, {}),
			};
		}

		private toArchivePage(r: MemoryArchivePageRow): MemoryArchivePage {
			return {
				id: r.id, workspaceId: r.workspace_id, sessionId: r.session_id, checkpointId: r.checkpoint_id ?? undefined,
				startEventId: r.start_event_id, endEventId: r.end_event_id, startedAt: r.started_at, endedAt: r.ended_at,
				eventCount: r.event_count, tokenEstimate: r.token_estimate, contentHash: r.content_hash,
				indexState: r.index_state as MemoryIndexState, indexedAt: r.indexed_at ?? undefined,
			};
		}

		private toIndexDocument(r: MemoryIndexDocumentRow): MemoryIndexDocument {
			return {
				id: r.id, workspaceId: r.workspace_id, kind: r.kind as MemoryIndexDocumentKind, sourceId: r.source_id,
				sessionId: r.session_id ?? undefined, title: r.title, text: r.text, contentHash: r.content_hash,
				version: r.version, state: r.state as MemoryIndexState, attempts: r.attempts,
				lastError: r.last_error ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
			};
		}

		/** Resolve an exact inclusive event range only when both boundary events belong to the
		 *  requested workspace/session. IDs are used as durable boundaries; timestamp order only
		 *  orders evidence and prevents foreign-session or reversed ranges from leaking through. */
		async getSessionEventRange(workspaceId: string, sessionId: string, startEventId: string, endEventId: string): Promise<ChatEvent[]> {
			const boundaries = await this.allRaw<ChatEventRow & { event_seq: number }>(
				'SELECT rowid AS event_seq, * FROM chat_events WHERE workspace_id = ? AND session_id = ? AND id IN (?, ?)',
				[workspaceId, sessionId, startEventId, endEventId]
			);
			const start = boundaries.find(row => row.id === startEventId);
			const end = boundaries.find(row => row.id === endEventId);
			if (!start || !end || start.event_seq > end.event_seq) {
				throw new Error('invalid memory checkpoint event range');
			}
			const rows = await this.allRaw<ChatEventRow>(
				'SELECT * FROM chat_events WHERE workspace_id = ? AND session_id = ? AND rowid BETWEEN ? AND ? ORDER BY rowid ASC',
				[workspaceId, sessionId, start.event_seq, end.event_seq]
			);
			return rows.map(row => this.toChatEvent(row));
		}

		/** Create or revise the one immutable checkpoint identified by workspace/session/trigger/end.
		 *  The parent checkpoint closes the previous source boundary, so callers cannot choose a
		 *  stale or overlapping start. A changed summary is recorded as a revision, not a duplicate. */
		async createMemoryCheckpoint(workspaceId: string, input: CreateMemoryCheckpointInput): Promise<MemoryCheckpoint> {
			const summary = input.summary.trim();
			if (!summary) throw new Error('memory checkpoint summary is required');
			const end = await this.getRaw<ChatEventRow>('SELECT * FROM chat_events WHERE id = ? AND workspace_id = ? AND session_id = ?', [input.endEventId, workspaceId, input.sessionId]);
			if (!end) throw new Error('memory checkpoint end event is not in this workspace session');
			const existing = await this.getRaw<MemoryCheckpointRow>(
				'SELECT * FROM memory_checkpoints WHERE workspace_id = ? AND session_id = ? AND trigger = ? AND end_event_id = ?',
				[workspaceId, input.sessionId, input.trigger, input.endEventId]
			);
			const summaryHash = sha256(summary);
			if (existing) {
				if (existing.summary_hash !== summaryHash) {
					await this.run('INSERT OR IGNORE INTO memory_checkpoint_revisions(id, checkpoint_id, summary, summary_hash, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?)',
						[`mcr:${sha256(`${existing.id}:${summaryHash}`).slice(0, 40)}`, existing.id, summary, summaryHash, Date.now(), JSON.stringify(input.meta ?? {})]);
					await this.run('UPDATE memory_checkpoints SET summary = ?, summary_hash = ?, summary_format_version = ?, meta_json = ? WHERE id = ?',
						[summary, summaryHash, input.summaryFormatVersion ?? 1, JSON.stringify(input.meta ?? {}), existing.id]);
				}
				const checkpoint = this.toCheckpoint((await this.getRaw<MemoryCheckpointRow>('SELECT * FROM memory_checkpoints WHERE id = ?', [existing.id]))!);
				await this.indexCheckpoint(checkpoint);
				return checkpoint;
			}
			const parent = await this.getRaw<MemoryCheckpointRow>(
				`SELECT c.* FROM memory_checkpoints c JOIN chat_events e ON e.id = c.end_event_id
				 WHERE c.workspace_id = ? AND c.session_id = ? AND e.rowid < (SELECT rowid FROM chat_events WHERE id = ?)
				 ORDER BY e.rowid DESC LIMIT 1`,
				[workspaceId, input.sessionId, end.id]
			);
			let start: ChatEventRow | undefined;
			if (parent) {
				start = await this.getRaw<ChatEventRow>(
					`SELECT * FROM chat_events WHERE workspace_id = ? AND session_id = ? AND rowid >
						 (SELECT rowid FROM chat_events WHERE id = ?) ORDER BY rowid ASC LIMIT 1`,
					[workspaceId, input.sessionId, parent.end_event_id]
				);
			} else {
				start = await this.getRaw<ChatEventRow>('SELECT * FROM chat_events WHERE workspace_id = ? AND session_id = ? ORDER BY rowid ASC LIMIT 1', [workspaceId, input.sessionId]);
			}
			if (!start) throw new Error('memory checkpoint has no source events after its parent boundary');
			const events = await this.getSessionEventRange(workspaceId, input.sessionId, start.id, end.id);
			if (!events.length) throw new Error('memory checkpoint source range is empty');
			const id = `mcp:${sha256(`${workspaceId}:${input.sessionId}:${input.trigger}:${end.id}`).slice(0, 40)}`;
			const now = Date.now();
			await this.run(
				`INSERT INTO memory_checkpoints(id, workspace_id, session_id, parent_checkpoint_id, trigger, start_event_id, end_event_id, started_at, ended_at, summary, summary_hash, summary_format_version, source_event_count, source_bytes, status, pinned, created_at, meta_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', 0, ?, ?)`,
				[id, workspaceId, input.sessionId, parent?.id ?? null, input.trigger, start.id, end.id, start.ts, end.ts, summary, summaryHash, input.summaryFormatVersion ?? 1, events.length, events.reduce((n, event) => n + Buffer.byteLength(event.body ?? '', 'utf8'), 0), now, JSON.stringify(input.meta ?? {})]
			);
			const checkpoint = this.toCheckpoint((await this.getRaw<MemoryCheckpointRow>('SELECT * FROM memory_checkpoints WHERE id = ?', [id]))!);
			await this.indexCheckpoint(checkpoint);
			return checkpoint;
		}

		/** Write a compaction/digest boundary note AND its checkpoint as ONE authoritative unit.
		 *  Both inserts land or neither does (single BEGIN IMMEDIATE transaction on this
		 *  connection) -- a checkpoint-less note can never exist, so it can never authorize a
		 *  later boundary restore or wire drop. The database transaction is the authoritative
		 *  record; the shadow/chat JSONL mirrors are best-effort appends OUTSIDE the
		 *  transaction, because a filesystem append cannot roll back and we do not claim it
		 *  can. Busy/locked databases are retried via withBusyRetry. */
		async recordCompactionBoundary(
			workspaceId: string,
			noteInput: ChatEventInput,
			checkpointInput: Omit<CreateMemoryCheckpointInput, 'endEventId'>,
			chatJsonlPath?: string,
			shadowDir?: string,
		): Promise<{ note: ChatEvent; checkpoint: MemoryCheckpoint }> {
			if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
				throw new Error('compaction boundary requires a workspaceId');
			}
			if (noteInput.workspaceId !== workspaceId) {
				throw new Error('compaction boundary workspaceId mismatch');
			}
			if (!noteInput.sessionId || checkpointInput.sessionId !== noteInput.sessionId) {
				throw new Error('compaction boundary sessionId mismatch');
			}
			return withBusyRetry('compaction-boundary', async () => {
				const ev: ChatEvent = {
					...noteInput,
					workspaceId,
					id: genId(),
					ts: noteInput.ts ?? Date.now(),
				};
				const shadowId = shadowDir ? `shd_${genId()}` : null;
				if (shadowDir && shadowId) {
					try { await this.appendShadow(shadowDir, shadowId, ev); }
					catch (e) { console.error('[memory] shadow append failed (boundary write continues)', e); }
				}
				await this.exec('BEGIN IMMEDIATE');
				try {
					await this.run(
						`INSERT INTO chat_events(id, session_id, workspace_id, ts, kind, role, parent_id, title, body, files_json, meta_json, shadow_id)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						[ev.id, ev.sessionId, ev.workspaceId, ev.ts, ev.kind, ev.role ?? null, ev.parentId ?? null,
						ev.title ?? '', ev.body ?? '', JSON.stringify(ev.files ?? []), JSON.stringify(ev.meta ?? {}), shadowId]
					);
					await this.run('INSERT INTO chat_fts(id, title, body) VALUES (?, ?, ?)', [ev.id, ev.title ?? '', ev.body ?? '']);
					await this.writeTimelineRow({
						id: `tl:ev:${ev.id}`, workspaceId: ev.workspaceId, ts: ev.ts,
						kind: toTimelineKind(ev.kind, ev.meta), file: ev.files?.[0] ?? null,
						sessionId: ev.sessionId, chatEventId: ev.id, meta: timelineMeta(ev.meta), shadowId,
					});
					// Runs inside the same transaction on this connection: the note row above is
					// visible as the checkpoint's end event, and a checkpoint failure rolls the
					// note back too -- exactly the "one authoritative operation" contract.
					const checkpoint = await this.createMemoryCheckpoint(workspaceId, { ...checkpointInput, endEventId: ev.id });
					await this.exec('COMMIT');
					if (chatJsonlPath) {
						try {
							await fs.mkdir(dirname(chatJsonlPath), { recursive: true });
							await fs.appendFile(chatJsonlPath, JSON.stringify(ev) + '\n', 'utf8');
						} catch (e) { console.error('[memory] chat jsonl mirror failed (db commit is already authoritative)', e); }
					}
					return { note: ev, checkpoint };
				} catch (error) {
					try { await this.exec('ROLLBACK'); } catch { /* no active transaction */ }
					throw error;
				}
			});
		}

		/** True when a COMPLETE checkpoint exists whose end event is the given one. Boundary
		 *  restores must check this before applying a note's boundary: a legacy note written
		 *  before atomic boundary writes (or any aborted write) has no checkpoint and must
		 *  never be applied. */
		async hasCompleteCheckpointForEndEvent(workspaceId: string, endEventId: string): Promise<boolean> {
			const row = await this.getRaw<{ n: number }>(
				`SELECT COUNT(*) AS n FROM memory_checkpoints WHERE workspace_id = ? AND end_event_id = ? AND status = 'complete'`,
				[workspaceId, endEventId]
			);
			return (row?.n ?? 0) > 0;
		}

		/** Keep checkpoint summaries in the generic pull index without exposing source events. */
		private async indexCheckpoint(checkpoint: MemoryCheckpoint): Promise<void> {
			await this.upsertMemoryIndexDocument({
				id: `mid:${sha256(`checkpoint:${checkpoint.id}`).slice(0, 40)}`,
				workspaceId: checkpoint.workspaceId,
				kind: 'checkpoint',
				sourceId: checkpoint.id,
				sessionId: checkpoint.sessionId,
				title: `Memory checkpoint ${new Date(checkpoint.endedAt).toISOString()}`,
				text: checkpoint.summary,
				contentHash: checkpoint.summaryHash,
				sourceTs: checkpoint.endedAt,
			});
		}

		async listMemoryCheckpoints(workspaceId: string, sessionId?: string, limit = 50): Promise<MemoryCheckpoint[]> {
			const rows = sessionId
				? await this.allRaw<MemoryCheckpointRow>('SELECT * FROM memory_checkpoints WHERE workspace_id = ? AND session_id = ? ORDER BY ended_at DESC, created_at DESC LIMIT ?', [workspaceId, sessionId, limit])
				: await this.allRaw<MemoryCheckpointRow>('SELECT * FROM memory_checkpoints WHERE workspace_id = ? ORDER BY ended_at DESC, created_at DESC LIMIT ?', [workspaceId, limit]);
			return rows.map(row => this.toCheckpoint(row));
		}

		async getMemoryCheckpoint(workspaceId: string, checkpointId: string): Promise<MemoryCheckpoint | null> {
			const row = await this.getRaw<MemoryCheckpointRow>('SELECT * FROM memory_checkpoints WHERE id = ? AND workspace_id = ?', [checkpointId, workspaceId]);
			return row ? this.toCheckpoint(row) : null;
		}

		async getMemoryCheckpointEvidence(workspaceId: string, checkpointId: string, page = 1, pageSize = 50): Promise<MemoryCheckpointEvidence | null> {
			const checkpoint = await this.getMemoryCheckpoint(workspaceId, checkpointId);
			if (!checkpoint) return null;
			const events = await this.getSessionEventRange(workspaceId, checkpoint.sessionId, checkpoint.startEventId, checkpoint.endEventId);
			const safePageSize = Math.max(1, Math.min(100, pageSize));
			const totalPages = Math.max(1, Math.ceil(events.length / safePageSize));
			const safePage = Math.max(1, Math.min(totalPages, page));
			const safeEvents = events.slice((safePage - 1) * safePageSize, safePage * safePageSize).map(event => ({
				...event,
				body: event.kind === 'tool_call' || event.kind === 'tool_result' ? '' : sanitizeMemoryIndexText(event.body),
			}));
			return { checkpoint, events: safeEvents, page: safePage, totalPages, rawAvailable: checkpoint.status === 'complete' };
		}

		/** Build bounded searchable text without copying raw tool payloads. Tool events contribute
		 *  only their name and file references; secret-shaped values are redacted before FTS/vector work. */
		private archiveProjection(events: ChatEvent[]): { title: string; text: string } {

			const lines: string[] = [];
			for (const event of events) {
				const label = event.kind === 'tool_call' || event.kind === 'tool_result'
					? `Tool: ${typeof event.meta?.['tool'] === 'string' ? event.meta['tool'] : event.title}`
					: `${event.kind}: ${event.title}`;
				const body = event.kind === 'tool_call' || event.kind === 'tool_result' ? '' : sanitizeMemoryIndexText(event.body ?? '').replace(/\s+/g, ' ').slice(0, 900);
				const files = (event.files ?? []).slice(0, 8).join(', ');
				lines.push([label.slice(0, 160), files && `Files: ${files}`, body].filter(Boolean).join('\n'));
				if (lines.join('\n').length >= 12000) break;
			}
			return { title: events.length ? `Archive ${events[0].title.slice(0, 80)}` : 'Archive page', text: lines.join('\n').slice(0, 12000) };
		}

		/** Incrementally rebuild archive documents from authoritative chat_events. Stable range IDs
		 *  and content hashes make restarts idempotent while allowing changed projections to requeue. */
		async backfillMemoryFacts(workspaceId: string, limit = 50): Promise<number> {
			const rows = await this.allRaw<WsFactRow>(
				`SELECT f.* FROM ws_facts f WHERE f.workspace_id = ? AND f.superseded_by IS NULL
				 AND NOT EXISTS (SELECT 1 FROM memory_index_documents d WHERE d.workspace_id = f.workspace_id AND d.kind IN ('fact', 'symbol-note') AND d.source_id = f.id)
				 ORDER BY f.ts_last DESC LIMIT ?`,
				[workspaceId, Math.max(1, Math.min(200, limit))]
			);
			for (const row of rows) await this.indexFact(this.toWsFact(row));
			return rows.length;
		}

		async listMemorySessionIds(workspaceId: string, limit = 100): Promise<string[]> {
			const rows = await this.allRaw<{ session_id: string }>('SELECT session_id FROM chat_events WHERE workspace_id = ? GROUP BY session_id ORDER BY MAX(ts) DESC LIMIT ?', [workspaceId, Math.max(1, Math.min(500, limit))]);
			return rows.map(row => row.session_id);
		}

		async rebuildMemoryArchivePages(workspaceId: string, sessionId: string, batchSize = 100): Promise<MemoryArchivePage[]> {
			const cursor = await this.getMeta(`${MEMORY_META_KEYS.archivePageCursor}:${workspaceId}:${sessionId}`);
			const cursorEvent = cursor ? await this.getRaw<{ event_seq: number }>('SELECT rowid AS event_seq FROM chat_events WHERE id = ? AND workspace_id = ? AND session_id = ?', [cursor, workspaceId, sessionId]) : undefined;
			const rows = await this.allRaw<ChatEventRow>(
				cursorEvent ? 'SELECT * FROM chat_events WHERE workspace_id = ? AND session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?' : 'SELECT * FROM chat_events WHERE workspace_id = ? AND session_id = ? ORDER BY rowid ASC LIMIT ?',
				cursorEvent ? [workspaceId, sessionId, cursorEvent.event_seq, Math.max(1, Math.min(500, batchSize))] : [workspaceId, sessionId, Math.max(1, Math.min(500, batchSize))]
			);
			if (!rows.length) return [];
			const events = rows.map(row => this.toChatEvent(row));
			const projection = this.archiveProjection(events);
			const contentHash = sha256(projection.text);
			const id = `map:${sha256(`${workspaceId}:${sessionId}:${events[0].id}:${events[events.length - 1].id}`).slice(0, 40)}`;
			await this.run(`INSERT INTO memory_archive_pages(id, workspace_id, session_id, checkpoint_id, start_event_id, end_event_id, started_at, ended_at, event_count, token_estimate, content_hash, index_state, indexed_at)
				VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
				ON CONFLICT(workspace_id, session_id, start_event_id, end_event_id) DO UPDATE SET content_hash = excluded.content_hash, index_state = CASE WHEN memory_archive_pages.content_hash <> excluded.content_hash THEN 'pending' ELSE memory_archive_pages.index_state END`,
				[id, workspaceId, sessionId, events[0].id, events[events.length - 1].id, events[0].ts, events[events.length - 1].ts, events.length, Math.ceil(projection.text.length / 4), contentHash]);
			await this.upsertMemoryIndexDocument({ id: `mid:${sha256(`archive-page:${id}`).slice(0, 40)}`, workspaceId, kind: 'archive-page', sourceId: id, sessionId, title: projection.title, text: projection.text, contentHash, sourceTs: events[events.length - 1].ts });
			await this.setMeta(`${MEMORY_META_KEYS.archivePageCursor}:${workspaceId}:${sessionId}`, events[events.length - 1].id);
			const page = await this.getRaw<MemoryArchivePageRow>('SELECT * FROM memory_archive_pages WHERE id = ?', [id]);
			return page ? [this.toArchivePage(page)] : [];
		}

		async upsertMemoryIndexDocument(input: { id: string; workspaceId: string; kind: MemoryIndexDocumentKind; sourceId: string; sessionId?: string; title: string; text: string; contentHash?: string; sourceTs?: number }): Promise<MemoryIndexDocument> {
			const now = input.sourceTs ?? Date.now();
			const title = sanitizeMemoryIndexText(input.title);
			const text = sanitizeMemoryIndexText(input.text);
			const hash = input.contentHash ?? sha256(`${title}\n${text}`);
			await this.run(`INSERT INTO memory_index_documents(id, workspace_id, kind, source_id, session_id, title, text, content_hash, version, state, attempts, last_error, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', 0, NULL, ?, ?)
					ON CONFLICT(workspace_id, kind, source_id) DO UPDATE SET title = excluded.title, text = excluded.text, content_hash = excluded.content_hash, version = CASE WHEN memory_index_documents.content_hash <> excluded.content_hash THEN memory_index_documents.version + 1 ELSE memory_index_documents.version END, state = CASE WHEN memory_index_documents.content_hash <> excluded.content_hash THEN 'pending' ELSE memory_index_documents.state END, updated_at = CASE WHEN memory_index_documents.content_hash <> excluded.content_hash THEN excluded.updated_at ELSE memory_index_documents.updated_at END`,
				[input.id, input.workspaceId, input.kind, input.sourceId, input.sessionId ?? null, title.slice(0, 500), text.slice(0, 12000), hash, now, now]);
			const row = await this.getRaw<MemoryIndexDocumentRow>('SELECT * FROM memory_index_documents WHERE workspace_id = ? AND kind = ? AND source_id = ?', [input.workspaceId, input.kind, input.sourceId]);
			if (!row) throw new Error('failed to store memory index document');
			await this.run('DELETE FROM memory_index_fts WHERE id = ?', [row.id]);
			await this.run('INSERT INTO memory_index_fts(id, title, text) VALUES (?, ?, ?)', [row.id, row.title, row.text]);
			return this.toIndexDocument(row);
		}

		async getMemoryIndexPending(workspaceId: string, limit = 32): Promise<MemoryIndexDocument[]> {
			const rows = await this.allRaw<MemoryIndexDocumentRow>('SELECT * FROM memory_index_documents WHERE workspace_id = ? AND state = \'pending\' ORDER BY updated_at ASC LIMIT ?', [workspaceId, Math.max(1, Math.min(100, limit))]);
			return rows.map(row => this.toIndexDocument(row));
		}

		async storeMemoryIndexEmbedding(documentId: string, text: string, modelId: string, dim: number, vec: Float32Array): Promise<void> {
			await this.putCachedVector(text, modelId, dim, vec);
			await this.run(`INSERT INTO memory_index_vectors(document_id, model_id, dim, vec, ts) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(document_id, model_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, ts = excluded.ts`, [documentId, modelId, dim, f32ToBlob(vec), Date.now()]);
			await this.run('UPDATE memory_index_documents SET state = \'indexed\', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?', [Date.now(), documentId]);
		}

		async searchMemory(workspaceId: string, query: string, queryVec: Float32Array | null, modelId: string | null, options: SearchMemoryOptions = {}): Promise<MemorySearchHit[]> {
			const fts = toFtsQuery(query);
			if (!fts) return [];
			const filters = ['d.workspace_id = ?'];
			const params: unknown[] = [workspaceId];
			if (options.scope === 'session' && options.sessionId) { filters.push('d.session_id = ?'); params.push(options.sessionId); }
			if (options.kinds?.length) { filters.push(`d.kind IN (${options.kinds.map(() => '?').join(',')})`); params.push(...options.kinds); }
			if (options.before !== undefined) { filters.push('d.updated_at <= ?'); params.push(options.before); }
			if (options.after !== undefined) { filters.push('d.updated_at >= ?'); params.push(options.after); }
			if (options.depth === 'recent' && options.after === undefined) { filters.push('d.updated_at >= ?'); params.push(Date.now() - 30 * 24 * 60 * 60 * 1000); }
			const candidateLimit = options.depth === 'deep' ? 500 : options.depth === 'recent' ? 50 : 150;
			const lexicalRows = await this.allRaw<MemoryIndexDocumentRow & { rank: number }>(`SELECT d.*, f.rank AS rank FROM memory_index_documents d JOIN memory_index_fts f ON f.id = d.id WHERE ${filters.join(' AND ')} AND memory_index_fts MATCH ? ORDER BY f.rank LIMIT ?`, [...params, fts, candidateLimit]);
			const lexical = new Map(lexicalRows.map(row => [row.id, -row.rank]));
			const semantic = new Map<string, number>();
			if (queryVec && modelId) {
				const vectors = await this.allRaw<{ document_id: string; vec: Buffer }>(`SELECT v.document_id, v.vec FROM memory_index_vectors v JOIN memory_index_documents d ON d.id = v.document_id WHERE ${filters.join(' AND ')} AND v.model_id = ? LIMIT ?`, [...params, modelId, options.depth === 'deep' ? 5000 : 2000]);
				for (const vector of vectors) semantic.set(vector.document_id, cosineSim(queryVec, blobToF32(vector.vec)));
			}
			const scores = semantic.size ? hybridMerge(semantic, lexical) : normalizeScores(lexical);
			const byId = new Map<string, MemoryIndexDocumentRow>(lexicalRows.map(row => [row.id, row]));
			if (semantic.size) {
				const ids = [...semantic.keys()].filter(id => !byId.has(id));
				if (ids.length) for (const row of await this.allRaw<MemoryIndexDocumentRow>(`SELECT * FROM memory_index_documents WHERE id IN (${ids.map(() => '?').join(',')})`, ids)) byId.set(row.id, row);
			}
			const limit = Math.max(1, Math.min(50, options.limit ?? 12));
			return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).flatMap(([id, score]) => {
				const row = byId.get(id); if (!row) return [];
				return [{ kind: row.kind as MemoryIndexDocumentKind, id: row.source_id, workspaceId: row.workspace_id, sessionId: row.session_id ?? undefined, summary: row.text.slice(0, 500), score, signals: { lexical: lexical.get(id), semantic: semantic.get(id) }, rawAvailable: row.kind !== 'fact' && row.kind !== 'symbol-note', sourcePruned: false }];
			});
		}

	/**
	 * Counts for the Ledger's Index Health / Storage panels.
	 *
	 * `coveredEvents` is the one that matters: it counts chat_events that fall inside some
	 * archive page's [start_event_id, end_event_id] range, resolved by rowid (append order)
	 * rather than ts, because same-millisecond events order by random id suffix. Events
	 * outside every page are unreachable by search_memory regardless of vector count, so
	 * coverage < total is the honest signal that the idle indexer still has work to do.
	 */
	async getMemoryStats(workspaceId: string): Promise<MemoryStats> {
		const one = async (sql: string, params: unknown[] = []) => (await this.getRaw<{ n: number }>(sql, params))?.n ?? 0;

		const [totalEvents, totalFacts, checkpoints, archivePages, vectors] = await Promise.all([
			one('SELECT COUNT(*) AS n FROM chat_events WHERE workspace_id = ?', [workspaceId]),
			one('SELECT COUNT(*) AS n FROM ws_facts WHERE workspace_id = ? AND superseded_by IS NULL', [workspaceId]),
			one('SELECT COUNT(*) AS n FROM memory_checkpoints WHERE workspace_id = ?', [workspaceId]),
			one('SELECT COUNT(*) AS n FROM memory_archive_pages WHERE workspace_id = ?', [workspaceId]),
			one('SELECT COUNT(*) AS n FROM memory_index_vectors v JOIN memory_index_documents d ON d.id = v.document_id WHERE d.workspace_id = ?', [workspaceId]),
		]);

		// Sum per page rather than one global MIN/MAX: pages are per-session, so a single
		// span across sessions would over-count interleaved events as covered.
		const coveredEvents = await one(
			`SELECT COALESCE(SUM(covered), 0) AS n FROM (
				SELECT (SELECT COUNT(*) FROM chat_events e
					WHERE e.workspace_id = p.workspace_id AND e.session_id = p.session_id
					  AND e.rowid >= (SELECT rowid FROM chat_events WHERE id = p.start_event_id)
					  AND e.rowid <= (SELECT rowid FROM chat_events WHERE id = p.end_event_id)) AS covered
				FROM memory_archive_pages p WHERE p.workspace_id = ?)`,
			[workspaceId]
		);

		const stateRows = await this.allRaw<{ state: string; n: number }>(
			'SELECT state, COUNT(*) AS n FROM memory_index_documents WHERE workspace_id = ? GROUP BY state', [workspaceId]);
		const byState = new Map(stateRows.map(r => [r.state, r.n]));

		const kindRows = await this.allRaw<{ kind: string; documents: number; indexed: number }>(
			`SELECT kind, COUNT(*) AS documents, SUM(CASE WHEN state = 'indexed' THEN 1 ELSE 0 END) AS indexed
			 FROM memory_index_documents WHERE workspace_id = ? GROUP BY kind ORDER BY documents DESC`, [workspaceId]);

		// oldest = how far the *memory* reaches, from the events themselves. Using
		// MIN(updated_at) on index documents would report when indexing last ran, so a
		// freshly-built index of five-year-old history would claim to reach back to today.
		// newest stays on updated_at: that one genuinely is "when did the indexer last write".
		const span = await this.getRaw<{ oldest: number | null; newest: number | null }>(
			`SELECT (SELECT MIN(ts) FROM chat_events WHERE workspace_id = ?) AS oldest,
			        (SELECT MAX(updated_at) FROM memory_index_documents WHERE workspace_id = ?) AS newest`,
			[workspaceId, workspaceId]);
		const failure = await this.getRaw<{ last_error: string | null }>(
			'SELECT last_error FROM memory_index_documents WHERE workspace_id = ? AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1', [workspaceId]);

		// Sidecars only exist between checkpoints; a missing -wal is normal, not an error.
		const bytesOf = async (p: string): Promise<number> => { try { return (await fs.stat(p)).size; } catch { return 0; } };
		const dbBytes = this.dbPath ? await bytesOf(this.dbPath) : 0;
		const walBytes = this.dbPath ? (await bytesOf(`${this.dbPath}-wal`)) + (await bytesOf(`${this.dbPath}-shm`)) : 0;

		return {
			totalEvents, coveredEvents, totalFacts, checkpoints, archivePages,
			documents: stateRows.reduce((sum, r) => sum + r.n, 0),
			indexed: byState.get('indexed') ?? 0,
			pending: (byState.get('pending') ?? 0) + (byState.get('indexing') ?? 0),
			failed: byState.get('failed') ?? 0,
			vectors,
			byKind: kindRows.map(r => ({ kind: r.kind as MemoryIndexDocumentKind, documents: r.documents, indexed: r.indexed ?? 0 })),
			oldestMemoryTs: span?.oldest ?? undefined,
			newestIndexedTs: span?.newest ?? undefined,
			dbBytes, walBytes,
			lastError: failure?.last_error ?? undefined,
		};
	}

		// ---- MIGRATION (packet 1f): import legacy symbol notes as facts ----
	async migrateSymbolNotes(workspaceId: string, notes: { filePath: string; symbolName: string; note: string; ts: number }[]): Promise<number> {
		if (!notes.length) return 0;
		const done = await this.getMeta(MEMORY_META_KEYS.notesMigrated);
		if (done === '1') {
			const row = await this.getRaw<{ n: number }>(
				"SELECT COUNT(*) as n FROM ws_facts WHERE workspace_id = ? AND kind = 'symbol'",
				[workspaceId]
			);
			if ((row?.n ?? 0) >= notes.length) return 0;
		}
		let n = 0;
		for (const note of notes) {
			await this.upsertFact({
				workspaceId, kind: 'symbol', subject: `${note.filePath}::${note.symbolName}`,
				body: note.note, confidence: 1.0, priority: 6, provenance: 'human',
				meta: { filePath: note.filePath, symbolName: note.symbolName, migrated: true },
			});
			n++;
		}
		await this.setMeta(MEMORY_META_KEYS.notesMigrated, '1');
		return n;
	}

	async close(): Promise<void> {
		if (!this.db) return;
		const db = this.db;
		this.db = null;
		try {
			await new Promise<void>((resolve) => { db.exec('PRAGMA wal_checkpoint(TRUNCATE)', () => resolve()); });
		} catch { /* noop */ }
		await new Promise<void>((resolve, reject) => { db.close(err => err ? reject(err) : resolve()); });
	}
}
