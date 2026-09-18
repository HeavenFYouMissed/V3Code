/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Shared contract for the 3-layer memory system (Build Packet 1).
 *
 * These types are the ONLY thing crossing the IPC boundary between the renderer
 * (browser MemoryService proxy) and the main process (memoryChannel + the
 * @vscode/sqlite3 store). They carry no Node dependencies so the renderer can
 * import them freely.
 *
 * Three layers, three lifetimes:
 *   - CHAT memory  (chat_events) : verbatim, per-session, append-only, complete.
 *   - WORKSPACE memory (ws_facts): deduped, cross-session, rolled up from chat.
 *   - EDITORIAL memory (editorial_*): the librarian; cross-project, filed at end.
 */

export type MemoryKind =
	| 'prompt' | 'reply' | 'tool_call' | 'tool_result'
	| 'diff' | 'decision' | 'phase' | 'escalation' | 'note';

export type AgentRole = 'lead' | 'sprinter' | 'scout' | 'debugger' | 'user';

/** One verbatim event in the chat layer. Append-only; never edited after write. */
export interface ChatEvent {
	id: string;            // ulid (sortable by time)
	sessionId: string;
	workspaceId: string;
	ts: number;            // epoch ms
	kind: MemoryKind;
	role?: AgentRole;
	parentId?: string;     // threading: reply -> prompt, tool_result -> tool_call
	title: string;         // <= 80 chars, the Ledger rung text (packet 2)
	body: string;          // full verbatim content
	files?: string[];      // file paths this event touched
	meta?: Record<string, unknown>; // tool name, args, diff hash, token counts, model id, etc.
}

/** Input shape for recording a chat event — id + ts are assigned by the store. */
export type ChatEventInput = Omit<ChatEvent, 'id' | 'ts'> & { ts?: number };

export type WsFactKind =
	| 'file_state' | 'symbol' | 'decision' | 'pattern' | 'quirk' | 'dependency' | 'cochange'
	| 'roadmap' // editor build-state spine: goal/done/next/blocked lines from active plans
	| 'session_digest'; // bounded-chat step 5: rolling per-session condensed-history digest (durable layer copy)

/** One deduped, durable fact in the workspace layer (distilled from chat). */
export interface WsFact {
	id: string;
	workspaceId: string;
	tsFirst: number;
	tsLast: number;
	kind: WsFactKind;
	subject: string;       // file path, symbol, or decision title
	body: string;
	confidence: number;    // 0..1 — decays unused, bumps on reinforce
	priority: number;      // 1..10
	source: string[];      // chat_event ids this was distilled from (provenance)
	meta?: Record<string, unknown>;
}

export interface CodeRef {
	file: string;
	symbol: string;
	range: [number, number];
	blurb: string;
}

/** A sub-topic of a project in the editorial layer (auth, payments, build, ...). */
export interface EditorialBranch {
	id: string;
	projectId: string;
	name: string;
	miniReadme: string;
	worked: string;
	didntWork: string;
	buildNotes: string;
	codeRefs: CodeRef[];
	confidence: number;
	tsUpdated: number;
	originWorkspaceId?: string;
	originRoot?: string;
}

export interface EditorialProject {
	id: string;
	workspaceId: string;
	name: string;
	readme: string;
	stack: string[];
	status: 'active' | 'shipped' | 'paused';
	tsCreated: number;
	tsFiled?: number;
}

export interface EscalationLogEntry {
	id: string;
	workspaceId: string;
	ts: number;
	triggerRule: string;
	evidenceHash?: string;
	fixApplied?: string;
	verifyPassed?: boolean;
	meta?: Record<string, unknown>;
}

/** MemLegend rung kinds — the timeline's coarse vocabulary (mapped from MemoryKind). */
export type TimelineKind = 'prompt' | 'diff' | 'decision' | 'read' | 'escalation' | 'phase' | 'digest';

/**
 * One row on the time+file rail (catalog C2). REFERENCES ONLY: it carries ids
 * pointing at the chat event / fact / escalation it represents plus small derived
 * scalars in `meta` (diff counts, model, tokens) -- NEVER a payload copy. The
 * payload is fetched on demand via hydrateTimeline; a row whose target is gone
 * still renders from its scalars. This rail IS the Phase 3 MemLegend ledger.
 */
export interface TimelineEntry {
	id: string;
	workspaceId: string;
	ts: number;
	kind: TimelineKind;
	file?: string;            // the file axis
	sessionId?: string;
	chatEventId?: string;     // -> ChatEvent.id (logical ref, no FK)
	factId?: string;          // -> WsFact.id
	planVersionId?: string;
	escalationId?: string;    // -> EscalationLogEntry.id
	meta?: Record<string, unknown>; // small derived scalars only
}

/** Result of hydrating a timeline row: the entry plus whichever payload it points
 *  at, or `gone: true` when that payload no longer exists (references-only proof). */
export interface TimelineHydration {
	entry: TimelineEntry;
	gone: boolean;
	chatEvent?: ChatEvent;
	fact?: WsFact;
	escalation?: EscalationLogEntry;
}

/**
 * What an agent gets injected every turn (packet 1 section 4). Top-of-tree only,
 * under a hard token budget; deeper detail is pulled on demand via tools. The
 * memory-derived parts are assembled by the store; `callGraphTop` is merged in
 * on the renderer side (the call graph lives in the browser semantic index).
 */
export interface MemorySnapshot {
	workspaceId: string;
	sessionId: string;
	generatedAt: number;
	recentEvents: { id: string; ts: number; kind: MemoryKind; role?: AgentRole; title: string }[];
	openDecisions: { subject: string; body: string }[];
	touchedFiles: { path: string; lastTs: number; lastKind: MemoryKind }[];
	activeQuirks: string[];          // build/terminal gotchas for this workspace
	symbolFacts: { subject: string; body: string }[]; // migrated / remember symbol notes (ws_facts kind=symbol)
	callGraphTop?: unknown;          // merged in by the renderer, not the store
	budgetTokens: number;            // hard cap on snapshot size
}

/**
 * SHADOW ARCHIVE (build packet "V3CODE SHADOW MEMORY"). The raw, append-only, never-deleted
 * floor. These cross the IPC boundary for the break-glass `deep_recall` path.
 */
/** One raw record in the shadow archive (one JSONL line). `text` is the full, untruncated body. */
export interface ShadowRecord {
	id: string;            // shd_<id>
	ts: number;
	wsId: string;
	sessionId: string;
	eventId?: string | null; // -> chat_events.id (shadow -> curated up-link)
	kind: string;            // PROMPT|REPLY|TOOL|DIFF|DECISION|NOTE|OTHER
	tool?: string | null;
	file?: string | null;
	text: string;
}

/** A ranked deep_recall hit: enough to decide + a bounded snippet, NOT the full record. */
export interface ShadowHit {
	id: string;
	ts: number;
	kind: string;
	file?: string | null;
	eventId?: string | null;
	snippet: string;
}

export type MemoryCheckpointTrigger = 'explicit-compact' | 'automatic-condensation' | 'manual-snapshot';
export type MemoryCheckpointStatus = 'complete' | 'source-pruned' | 'corrupt';

/** Immutable summary over an exact, closed range of persisted chat events. */
export interface MemoryCheckpoint {
	id: string;
	workspaceId: string;
	sessionId: string;
	parentCheckpointId?: string;
	trigger: MemoryCheckpointTrigger;
	startEventId: string;
	endEventId: string;
	startedAt: number;
	endedAt: number;
	summary: string;
	summaryHash: string;
	summaryFormatVersion: number;
	sourceEventCount: number;
	sourceBytes: number;
	status: MemoryCheckpointStatus;
	pinned: boolean;
	createdAt: number;
	meta?: Record<string, unknown>;
}

export interface CreateMemoryCheckpointInput {
	sessionId: string;
	trigger: MemoryCheckpointTrigger;
	endEventId: string;
	summary: string;
	summaryFormatVersion?: number;
	meta?: Record<string, unknown>;
}

export type MemoryIndexDocumentKind = 'fact' | 'checkpoint' | 'archive-page' | 'symbol-note';
export type MemoryIndexState = 'pending' | 'indexing' | 'indexed' | 'failed' | 'pruned';

/** Range metadata for a bounded searchable projection; raw transcript text stays in chat_events/shadow JSONL. */
export interface MemoryArchivePage {
	id: string;
	workspaceId: string;
	sessionId: string;
	checkpointId?: string;
	startEventId: string;
	endEventId: string;
	startedAt: number;
	endedAt: number;
	eventCount: number;
	tokenEstimate: number;
	contentHash: string;
	indexState: MemoryIndexState;
	indexedAt?: number;
}

export interface MemoryIndexDocument {
	id: string;
	workspaceId: string;
	kind: MemoryIndexDocumentKind;
	sourceId: string;
	sessionId?: string;
	title: string;
	text: string;
	contentHash: string;
	version: number;
	state: MemoryIndexState;
	attempts: number;
	lastError?: string;
	createdAt: number;
	updatedAt: number;
}

export interface MemorySearchHit {
	kind: MemoryIndexDocumentKind;
	id: string;
	workspaceId: string;
	sessionId?: string;
	summary: string;
	score: number;
	signals: { lexical?: number; semantic?: number; recency?: number; confidence?: number };
	sourceRange?: { startEventId: string; endEventId: string };
	rawAvailable: boolean;
	sourcePruned: boolean;
	ts?: number;
}

export interface SearchMemoryOptions {
	scope?: 'workspace' | 'session' | 'global';
	depth?: 'recent' | 'broad' | 'deep';
	sessionId?: string;
	before?: number;
	after?: number;
	kinds?: MemoryIndexDocumentKind[];
	limit?: number;
}

export interface MemoryCheckpointEvidence {
	checkpoint: MemoryCheckpoint;
	events: ChatEvent[];
	page: number;
	totalPages: number;
	rawAvailable: boolean;
}

/**
 * A point-in-time count of what the memory index actually contains, for the Ledger's
 * Index Health / Storage panels.
 *
 * Deliberately counts rather than samples: "297 of 297 documents embedded" is a fact a
 * user can act on, where "indexing is healthy" is not. `coveredEvents` vs `totalEvents`
 * is the number that answers "is my history actually reachable by search_memory?" —
 * an event outside every archive page is invisible to retrieval no matter how many
 * vectors exist.
 */
export interface MemoryStats {
	/** Raw source rows. `coveredEvents` counts events inside some archive page's range. */
	totalEvents: number;
	coveredEvents: number;
	totalFacts: number;
	checkpoints: number;
	archivePages: number;
	/** Index documents by state; `byKind` is the same population split by document kind. */
	documents: number;
	indexed: number;
	pending: number;
	failed: number;
	vectors: number;
	byKind: { kind: MemoryIndexDocumentKind; documents: number; indexed: number }[];
	/**
	 * How far back the memory itself reaches: the oldest chat event, NOT the oldest index
	 * row. Those differ whenever the index is rebuilt — a fresh index over old history
	 * would otherwise claim to reach back only to today. (ms epoch)
	 */
	oldestMemoryTs?: number;
	/** When the indexer last wrote a document — genuinely an index timestamp. (ms epoch) */
	newestIndexedTs?: number;
	/** Bytes on disk: the SQLite file plus its -wal/-shm sidecars. */
	dbBytes: number;
	walBytes: number;
	/** Most recent index failure, so a stuck backlog names itself instead of sitting silent. */
	lastError?: string;
}

export interface SearchChatOpts {
	kind?: MemoryKind;
	role?: AgentRole;
	/** Filter to one session INSIDE the SQL query (before LIMIT) — never fetch a blind
	 *  window and filter sessions in JS, or a busy workspace pushes the target session's
	 *  rows out of the limit and the caller silently loses them. */
	sessionId?: string;
	limit?: number;
}

/** Where a learned procedure lives: this workspace, or cross-project for the profile. */
export type ProcedureTarget = 'workspace' | 'global';

/**
 * Procedural ("how-to") memory (catalog C7): "when I see THIS kind of task, this verified
 * sequence of moves worked." The LEAD can retrieve + replay a procedure instead of
 * re-deriving it -- the in-editor analogue of a Skill. Seeded from successful runs (the
 * full seeding loop is Phase 9); this layer is just the durable store + retrieve-by-trigger.
 */
export interface LearnedProcedure {
	id: string;
	workspaceId: string;
	triggerPattern: string;     // the task shape this procedure applies to
	steps: string[];            // the verified sequence of moves to replay
	verifiedByTest: boolean;
	successCount: number;       // how many times it has worked
	lastUsed: number;
	provenance?: string;        // 'human' | 'ai_inferred' | ...
	target: ProcedureTarget;
	tsCreated: number;
}

export interface LearnedProcedureInput {
	workspaceId: string;
	triggerPattern: string;
	steps: string[];
	verifiedByTest?: boolean;
	provenance?: string;
	target?: ProcedureTarget;
}
