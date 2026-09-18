/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * SQLite schema for the 3-layer memory store (Build Packet 1).
 *
 * Runs in the MAIN process via `@vscode/sqlite3` (already bundled). The renderer
 * cannot load the native module (its ESM loader rejects Node builtins), so the
 * store lives behind the memoryChannel IPC boundary, mirroring the embedder.
 *
 * FTS5 strategy: we use STANDALONE contentless-ish FTS tables (`id UNINDEXED`)
 * kept in sync manually on each write, NOT external-content (content='...')
 * tables. This mirrors the proven pattern in semanticIndex/database.ts and
 * avoids the trigger machinery + orphan-row hazards external-content requires.
 *
 * No foreign keys between layers on purpose: memory must never block on
 * referential integrity. Provenance is by id arrays in source_json, not FKs.
 */

export const MEMORY_SCHEMA_VERSION = 5;

export const MEMORY_SCHEMA = `
-- ============ meta ============
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- ============ CHAT MEMORY (verbatim, per-session, complete) ============
CREATE TABLE IF NOT EXISTS chat_events (
	id            TEXT PRIMARY KEY,
	session_id    TEXT NOT NULL,
	workspace_id  TEXT NOT NULL,
	ts            INTEGER NOT NULL,
	kind          TEXT NOT NULL,
	role          TEXT,
	parent_id     TEXT,
	title         TEXT,
	body          TEXT,
	files_json    TEXT,
	meta_json     TEXT,
	shadow_id     TEXT             -- -> shadow archive record id (curated -> raw down-link). KEEP IN SYNC with SHADOW_LINK_TABLES.
);
CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_chat_ws ON chat_events(workspace_id, ts);
CREATE INDEX IF NOT EXISTS idx_chat_kind ON chat_events(workspace_id, kind, ts);
CREATE INDEX IF NOT EXISTS idx_chat_parent ON chat_events(parent_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
	id UNINDEXED,
	title,
	body,
	tokenize='unicode61 remove_diacritics 2'
);

-- Session-scoped runtime authority. This lives in V3Code app-data beside memory.db,
-- never in the user's repository. The compound key isolates parallel chats and lets
-- one native session retain different state when it moves A -> B -> A.
CREATE TABLE IF NOT EXISTS session_state (
	workspace_id TEXT NOT NULL,
	session_id   TEXT NOT NULL,
	state_key    TEXT NOT NULL,
	value_json   TEXT NOT NULL,
	revision     INTEGER NOT NULL DEFAULT 1,
	updated_at   INTEGER NOT NULL,
	PRIMARY KEY (workspace_id, session_id, state_key)
);
CREATE INDEX IF NOT EXISTS idx_session_state_session ON session_state(workspace_id, session_id, updated_at);

-- Canonical work-scoped anchors. This table is used only in the existing profile-global
-- memory.db. Keeping profile_id in the key is deliberate defense in depth: a misrouted IPC
-- call still cannot return another VS Code profile's private thread state.
CREATE TABLE IF NOT EXISTS session_anchors (
	profile_id          TEXT NOT NULL,
	anchor_id           TEXT NOT NULL,
	thread_id           TEXT NOT NULL,
	origin_workspace_id TEXT NOT NULL,
	origin_root         TEXT NOT NULL,
	kind                TEXT NOT NULL,
	relative_path       TEXT,
	symbol              TEXT,
	revision            INTEGER NOT NULL DEFAULT 1,
	update_identity     TEXT NOT NULL,
	payload_json        TEXT NOT NULL,
	updated_at          INTEGER NOT NULL,
	deleted_at          INTEGER,
	PRIMARY KEY (profile_id, anchor_id)
);
CREATE INDEX IF NOT EXISTS idx_session_anchors_thread ON session_anchors(profile_id, thread_id, kind, updated_at);
CREATE INDEX IF NOT EXISTS idx_session_anchors_origin ON session_anchors(profile_id, thread_id, origin_workspace_id);

-- Successful folder transitions for one native thread. Recovery may read an origin only
-- when it appears here, unless the user explicitly confirms an otherwise-unrecorded source.
CREATE TABLE IF NOT EXISTS session_anchor_transitions (
	id                TEXT PRIMARY KEY,
	profile_id        TEXT NOT NULL,
	thread_id         TEXT NOT NULL,
	kind              TEXT NOT NULL,
	from_workspace_id TEXT NOT NULL,
	from_root         TEXT NOT NULL,
	to_workspace_id   TEXT NOT NULL,
	to_root           TEXT NOT NULL,
	created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_anchor_transitions_thread ON session_anchor_transitions(profile_id, thread_id, created_at);

-- Write-ahead records for REQUESTED workspace swaps. The first swap of a session
-- reloads the window, killing the renderer's in-memory pending record before the
-- transition could be recorded — these rows survive the reload and are reconciled at
-- the next startup (completed when the live workspace matches, expired after 7 days).
CREATE TABLE IF NOT EXISTS pending_session_transitions (
	token             TEXT PRIMARY KEY,
	profile_id        TEXT NOT NULL,
	thread_id         TEXT NOT NULL,
	kind              TEXT NOT NULL,
	target_root       TEXT NOT NULL,
	from_workspace_id TEXT NOT NULL,
	from_root         TEXT NOT NULL,
	created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_session_transitions_profile ON pending_session_transitions(profile_id, created_at);

-- ============ WORKSPACE MEMORY (broad, cross-session, system-shaped) ============
CREATE TABLE IF NOT EXISTS ws_facts (
	id            TEXT PRIMARY KEY,
	workspace_id  TEXT NOT NULL,
	ts_first      INTEGER NOT NULL,
	ts_last       INTEGER NOT NULL,
	kind          TEXT NOT NULL,
	subject       TEXT NOT NULL,
	body          TEXT,
	confidence    REAL DEFAULT 0.5,
	priority      INTEGER DEFAULT 5,
	source_json   TEXT,
	meta_json     TEXT,
	-- catalog v2 (provenance / salience / embeddings). KEEP IN SYNC with WS_FACTS_V2_COLUMNS below.
	source           TEXT NOT NULL DEFAULT 'unknown',
	verified_by_test INTEGER NOT NULL DEFAULT 0,
	created_at       INTEGER NOT NULL DEFAULT 0,
	last_used_at     INTEGER NOT NULL DEFAULT 0,
	use_count        INTEGER NOT NULL DEFAULT 0,
	superseded_by    TEXT,
	embed_pending    INTEGER NOT NULL DEFAULT 1,
	shadow_id        TEXT             -- -> shadow archive record id (curated -> raw down-link). KEEP IN SYNC with SHADOW_LINK_TABLES.
);
CREATE INDEX IF NOT EXISTS idx_ws_subject ON ws_facts(workspace_id, subject);
CREATE INDEX IF NOT EXISTS idx_ws_kind ON ws_facts(workspace_id, kind, confidence);
CREATE VIRTUAL TABLE IF NOT EXISTS ws_fts USING fts5(
	id UNINDEXED,
	subject,
	body,
	tokenize='unicode61 remove_diacritics 2'
);

-- file co-change edges (hidden coupling the call graph misses)
CREATE TABLE IF NOT EXISTS ws_cochange (
	workspace_id  TEXT NOT NULL,
	file_a        TEXT NOT NULL,
	file_b        TEXT NOT NULL,
	count         INTEGER DEFAULT 1,
	ts_last       INTEGER NOT NULL,
	PRIMARY KEY (workspace_id, file_a, file_b)
);

-- ============ EDITORIAL MEMORY (the librarian, cross-project) ============
CREATE TABLE IF NOT EXISTS editorial_projects (
	id            TEXT PRIMARY KEY,
	workspace_id  TEXT NOT NULL,
	name          TEXT NOT NULL,
	readme        TEXT,
	stack_json    TEXT,
	status        TEXT,
	ts_created    INTEGER NOT NULL,
	ts_filed      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_editorial_projects_ws ON editorial_projects(workspace_id);

CREATE TABLE IF NOT EXISTS editorial_branches (
	id              TEXT PRIMARY KEY,
	project_id      TEXT NOT NULL,
	name            TEXT NOT NULL,
	mini_readme     TEXT,
	worked          TEXT,
	didnt_work      TEXT,
	build_notes     TEXT,
	code_refs_json  TEXT,
	links_json      TEXT,
	confidence      REAL DEFAULT 0.7,
	ts_updated      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_editorial_branches_project ON editorial_branches(project_id);

CREATE TABLE IF NOT EXISTS editorial_conflicts (
	id            TEXT PRIMARY KEY,
	new_id        TEXT NOT NULL,
	existing_id   TEXT NOT NULL,
	ts            INTEGER NOT NULL,
	resolved      INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS editorial_fts USING fts5(
	id UNINDEXED,
	name,
	mini_readme,
	worked,
	didnt_work,
	build_notes,
	tokenize='unicode61 remove_diacritics 2'
);

-- ============ ESCALATION LEDGER (tuning dataset for auto mode, packet 3) ============
CREATE TABLE IF NOT EXISTS escalation_log (
	id            TEXT PRIMARY KEY,
	workspace_id  TEXT NOT NULL,
	ts            INTEGER NOT NULL,
	trigger_rule  TEXT NOT NULL,
	evidence_hash TEXT,
	fix_applied   TEXT,
	verify_passed INTEGER,
	meta_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_escalation_ws ON escalation_log(workspace_id, ts);

-- ============ CATALOG v2 (timeline + procedural + vectors + embed cache) ============
-- All additive; no foreign keys (memory must never block on referential integrity).

-- TIMELINE: ties chat + facts + escalations together by time + file. REFERENCES ONLY
-- (logical id columns + small derived scalars in meta_json) -- never a payload copy.
-- A row hydrates on dig; a row whose target is gone renders from meta_json scalars.
CREATE TABLE IF NOT EXISTS timeline (
	id              TEXT PRIMARY KEY,
	workspace_id    TEXT NOT NULL,
	ts              INTEGER NOT NULL,
	kind            TEXT NOT NULL,   -- prompt|diff|decision|read|escalation|phase
	file            TEXT,            -- the file axis (nullable)
	session_id      TEXT,
	chat_event_id   TEXT,            -- -> chat_events.id (logical ref, no FK)
	fact_id         TEXT,            -- -> ws_facts.id
	plan_version_id TEXT,
	escalation_id   TEXT,            -- -> escalation_log.id
	meta_json       TEXT,            -- small derived scalars ONLY (add/del counts, model, tokens)
	shadow_id       TEXT             -- -> shadow archive record id (curated -> raw down-link). KEEP IN SYNC with SHADOW_LINK_TABLES.
);
CREATE INDEX IF NOT EXISTS idx_timeline_ws_ts ON timeline(workspace_id, ts);
CREATE INDEX IF NOT EXISTS idx_timeline_ws_file_ts ON timeline(workspace_id, file, ts);
CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline(session_id, ts);

-- PROCEDURAL MEMORY: how-to knowledge ("when I see this, these steps worked").
-- target seam ('workspace'|'global') so a procedure can later be promoted
-- cross-project; the promotion policy itself is a later phase.
CREATE TABLE IF NOT EXISTS learned_procedures (
	id               TEXT PRIMARY KEY,
	workspace_id     TEXT NOT NULL,
	trigger_pattern  TEXT NOT NULL,
	steps_json       TEXT NOT NULL,
	verified_by_test INTEGER NOT NULL DEFAULT 0,
	success_count    INTEGER NOT NULL DEFAULT 0,
	last_used        INTEGER NOT NULL DEFAULT 0,
	provenance       TEXT,
	target           TEXT NOT NULL DEFAULT 'workspace',
	ts_created       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_procedures_trigger ON learned_procedures(workspace_id, trigger_pattern);

-- EMBEDDINGS: per-fact vectors, model-aware (a host may resolve a different embed
-- model/dim; each row stores its own model_id + dim and re-embeds on drift). Ranked
-- by JS-cosine over the BLOB by default; sqlite-vec is an optional accelerator later.
CREATE TABLE IF NOT EXISTS ws_vectors (
	fact_id   TEXT NOT NULL,
	model_id  TEXT NOT NULL,
	dim       INTEGER NOT NULL,
	vec       BLOB NOT NULL,
	ts        INTEGER NOT NULL,
	PRIMARY KEY (fact_id, model_id)
);

-- EMBED CACHE: dedupes embedding work across restarts, keyed by content hash + model
-- so a cross-model vector is a cache miss (re-embed), never a wrong hit.
CREATE TABLE IF NOT EXISTS embed_cache (
	sha256    TEXT NOT NULL,
	model_id  TEXT NOT NULL,
	dim       INTEGER NOT NULL,
	vec       BLOB NOT NULL,
	PRIMARY KEY (sha256, model_id)
);

-- MEMORY TIMELINE v3: immutable checkpoints plus rebuildable pull-RAG documents.
CREATE TABLE IF NOT EXISTS memory_checkpoints (
	id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
	parent_checkpoint_id TEXT, trigger TEXT NOT NULL,
	start_event_id TEXT NOT NULL, end_event_id TEXT NOT NULL,
	started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
	summary TEXT NOT NULL, summary_hash TEXT NOT NULL,
	summary_format_version INTEGER NOT NULL DEFAULT 1,
	source_event_count INTEGER NOT NULL, source_bytes INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'complete', pinned INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL, meta_json TEXT,
	UNIQUE (workspace_id, session_id, trigger, end_event_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_checkpoints_session ON memory_checkpoints(workspace_id, session_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_memory_checkpoints_range ON memory_checkpoints(start_event_id, end_event_id);

CREATE TABLE IF NOT EXISTS memory_checkpoint_revisions (
	id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL,
	summary TEXT NOT NULL, summary_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL, meta_json TEXT,
	UNIQUE (checkpoint_id, summary_hash)
);
CREATE INDEX IF NOT EXISTS idx_memory_checkpoint_revisions ON memory_checkpoint_revisions(checkpoint_id, created_at);

CREATE TABLE IF NOT EXISTS memory_archive_pages (
	id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
	checkpoint_id TEXT, start_event_id TEXT NOT NULL, end_event_id TEXT NOT NULL,
	started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
	event_count INTEGER NOT NULL, token_estimate INTEGER NOT NULL,
	content_hash TEXT NOT NULL, index_state TEXT NOT NULL DEFAULT 'pending', indexed_at INTEGER,
	UNIQUE (workspace_id, session_id, start_event_id, end_event_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_archive_pages_session ON memory_archive_pages(workspace_id, session_id, ended_at);

CREATE TABLE IF NOT EXISTS memory_index_documents (
	id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
	source_id TEXT NOT NULL, session_id TEXT, title TEXT NOT NULL, text TEXT NOT NULL,
	content_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
	state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
	UNIQUE (workspace_id, kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_index_pending ON memory_index_documents(workspace_id, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_index_session ON memory_index_documents(workspace_id, session_id, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_index_fts USING fts5(
	id UNINDEXED, title, text, tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS memory_index_vectors (
	document_id TEXT NOT NULL, model_id TEXT NOT NULL, dim INTEGER NOT NULL,
	vec BLOB NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (document_id, model_id)
);
`;

/** ws_facts columns added in schema v2 (catalog provenance / salience / embeddings).
 *  The migration in `MemoryDatabase` ALTERs these onto a pre-v2 db; a fresh db already
 *  gets them from the ws_facts CREATE above. KEEP IN SYNC with that CREATE TABLE.
 *  Each `ddl` is a full column definition valid in `ALTER TABLE ws_facts ADD COLUMN`
 *  (every NOT NULL column carries a DEFAULT, as SQLite requires for ADD COLUMN). */
export const WS_FACTS_V2_COLUMNS: { name: string; ddl: string }[] = [
	{ name: 'source', ddl: `source TEXT NOT NULL DEFAULT 'unknown'` },
	{ name: 'verified_by_test', ddl: 'verified_by_test INTEGER NOT NULL DEFAULT 0' },
	{ name: 'created_at', ddl: 'created_at INTEGER NOT NULL DEFAULT 0' },
	{ name: 'last_used_at', ddl: 'last_used_at INTEGER NOT NULL DEFAULT 0' },
	{ name: 'use_count', ddl: 'use_count INTEGER NOT NULL DEFAULT 0' },
	{ name: 'superseded_by', ddl: 'superseded_by TEXT' },
	{ name: 'embed_pending', ddl: 'embed_pending INTEGER NOT NULL DEFAULT 1' },
];

/** Tables that carry the curated -> shadow `shadow_id` down-link. A fresh db gets the
 *  column from each CREATE above; a pre-existing db gets it ALTERed on in `migrateShadowLink`.
 *  KEEP IN SYNC with the three CREATE TABLEs (chat_events / ws_facts / timeline). */
export const SHADOW_LINK_TABLES = ['chat_events', 'ws_facts', 'timeline'] as const;

/** Meta keys reserved for memory bookkeeping. Treat as a closed enum. */
export const MEMORY_META_KEYS = {
	schemaVersion: 'schema_version',
	createdAt: 'created_at',
	lastRollupTs: 'last_rollup_ts',
	notesMigrated: 'notes_migrated_v1',
	provenanceBackfilled: 'provenance_backfilled_v2',
	timelineBackfilled: 'timeline_backfilled_v2',
	digestTimelineRepaired: 'digest_timeline_repaired_v1',
	editorialBranchesRepaired: 'editorial_branches_repaired_v1',
	planDecisionsRepaired: 'plan_decisions_repaired_v2',
	archivePageCursor: 'archive_page_cursor_v3',
	indexSchedulerLastRun: 'memory_index_scheduler_last_run_v3',
} as const;
