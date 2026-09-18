/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/* eslint-disable local/code-no-unexternalized-strings */

/**
 * Live catalog harness (C8): exercises MemoryDatabase through native @vscode/sqlite3.
 * Run after transpile:
 *   $env:ELECTRON_RUN_AS_NODE=1; node_modules\electron\dist\electron.exe scripts\live-catalog-harness.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbMod = await import(pathToFileURL(path.join(repoRoot, 'out/vs/workbench/contrib/void/electron-main/memory/memoryDatabase.js')).href);
const sqliteMod = await import(pathToFileURL(path.join(repoRoot, 'out/vs/workbench/contrib/void/electron-main/sqliteLoader.js')).href);
const { MemoryDatabase } = dbMod;
const { loadSqliteDatabaseConstructor } = sqliteMod;

const WS = 'live-harness-ws';
let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
	if (cond) { passed++; console.log(`  PASS  ${name}`); }
	else { failed++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function f32(n) {
	const a = new Float32Array(n);
	for (let i = 0; i < n; i++) { a[i] = Math.sin(i); }
	return a;
}

const dbPath = path.join(os.tmpdir(), `v3code-live-catalog-${Date.now()}.db`);
const db = new MemoryDatabase();
await db.open(dbPath);

// C0/C1: schema + provenance columns + tables
const tableNames = (await rawAll(dbPath, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map(r => r.name);
ok("C0 tables: timeline, learned_procedures, ws_vectors, embed_cache", ['timeline', 'learned_procedures', 'ws_vectors', 'embed_cache'].every(t => tableNames.includes(t)));
const colNames = await rawAll(dbPath, 'PRAGMA table_info(ws_facts)');
ok("C0/C1 ws_facts has provenance columns", ['source', 'verified_by_test', 'last_used_at', 'use_count', 'superseded_by'].every(c => colNames.some(r => r.name === c)));

const humanFact = await db.upsertFact({
	workspaceId: WS, kind: 'symbol', subject: 'src/a.ts::Foo', body: 'human note v1',
	confidence: 1, provenance: 'human',
});
ok("C1 human fact stored", humanFact?.subject === 'src/a.ts::Foo');
const unknownCount = (await rawAll(dbPath, "SELECT COUNT(*) AS n FROM ws_facts WHERE source='unknown'"))[0]?.n;
ok("C1 no source=unknown after backfill", unknownCount === 0);

// C2 timeline: record -> hydrate -> delete payload -> gone
const ev = await db.record({ sessionId: 's1', workspaceId: WS, kind: 'prompt', title: 'hello', body: 'world body' });
const tlId = `tl:ev:${ev.id}`;
const hydrated = await db.hydrateTimeline(tlId);
ok("C2 timeline row + hydrate chat body", !!hydrated?.chatEvent?.body?.includes('world'));
await db.close();
await rawRun(dbPath, 'DELETE FROM chat_events WHERE id = ?', [ev.id]);
const db2 = new MemoryDatabase();
await db2.open(dbPath);
const gone = await db2.hydrateTimeline(tlId);
ok("C2 hydrate after delete -> gone sentinel", gone?.gone === true);

// C3 embeddings storage (native BLOB path; vectors from harness, not embedder)
const fact = await db2.upsertFact({
	workspaceId: WS, kind: 'decision', subject: 'build', body: 'use dev.ps1 -Transpile',
	confidence: 0.8, provenance: 'ai_inferred',
});
const vec = f32(8);
await db2.storeFactEmbedding(fact.id, `${fact.subject}\n${fact.body}`, 'test-model', 8, vec);
const vecCount = (await rawAll(dbPath, 'SELECT COUNT(*) AS n FROM ws_vectors'))[0]?.n;
const cacheCount = (await rawAll(dbPath, 'SELECT COUNT(*) AS n FROM embed_cache'))[0]?.n;
const pending = (await rawAll(dbPath, 'SELECT embed_pending FROM ws_facts WHERE id = ?', [fact.id]))[0]?.embed_pending;
ok("C3 ws_vectors + embed_cache + embed_pending cleared", vecCount >= 1 && cacheCount >= 1 && pending === 0);

// C4 ranked search: BM25-only + vector path
const bm25Only = await db2.rankedSearch(WS, 'transpile build', null, null, 5);
ok("C4 BM25-only rankedSearch returns hits", bm25Only.length >= 1);
const qvec = f32(8);
const hybrid = await db2.rankedSearch(WS, 'transpile', qvec, 'test-model', 5);
ok("C4 hybrid rankedSearch with vectors", hybrid.length >= 1);

// C5 buildSnapshot + active-task boost signal
await db2.upsertFact({ workspaceId: WS, kind: 'symbol', subject: 'src/active.ts::Bar', body: 'active file fact', confidence: 0.9, provenance: 'human' });
await db2.upsertFact({ workspaceId: WS, kind: 'symbol', subject: 'src/other.ts::Baz', body: 'other file fact', confidence: 0.9, provenance: 'human' });
const snap = await db2.buildSnapshot(WS, 's1', 'lead', 800, { files: ['src/active.ts'] });
const subjects = snap.symbolFacts.map(f => f.subject);
ok("C5 buildSnapshot returns facts under budget", snap.symbolFacts.length >= 1);
ok("C5 active-file fact ranks in snapshot", subjects.some(s => s.includes('active.ts')));
const used = await rawAll(dbPath, 'SELECT last_used_at, use_count FROM ws_facts WHERE subject LIKE ?', ['%active.ts%']);
ok("C5 bumps last_used_at/use_count on inclusion", used[0]?.use_count >= 1 && used[0]?.last_used_at > 0);

// C6 contradiction: AI cannot demote human
await db2.upsertFact({ workspaceId: WS, kind: 'quirk', subject: 'lint', body: 'human quirk truth', provenance: 'human', confidence: 1 });
const rejected = await db2.upsertFact({ workspaceId: WS, kind: 'quirk', subject: 'lint', body: 'ai wrong quirk', provenance: 'ai_inferred', confidence: 0.5 });
ok("C6 AI cannot demote human (body unchanged)", rejected.body === 'human quirk truth');
const conflicts = (await rawAll(dbPath, 'SELECT COUNT(*) AS n FROM editorial_conflicts WHERE resolved = 0'))[0]?.n;
ok("C6 flagged editorial_conflicts row", conflicts >= 1);
// reverse: human supersedes AI
await db2.upsertFact({ workspaceId: WS, kind: 'quirk', subject: 'rollup', body: 'ai guess', provenance: 'ai_inferred', confidence: 0.4 });
const won = await db2.upsertFact({ workspaceId: WS, kind: 'quirk', subject: 'rollup', body: 'human correction', provenance: 'human', confidence: 1 });
ok("C6 human supersedes AI", won.body === 'human correction');

// C7 procedural memory
const proc = await db2.saveProcedure({ workspaceId: WS, triggerPattern: 'transpile build failure', steps: ['run dev.ps1 -Transpile', 'check out/'], verifiedByTest: true, provenance: 'human', target: 'workspace' });
const found = await db2.retrieveProcedures(WS, 'transpile build failure', 3);
ok("C7 retrieveProcedures round-trip steps", found.some(p => p.id === proc.id && p.steps.length === 2));
const scBefore = proc.successCount;
await db2.markProcedureUsed(proc.id);
const foundAfter = await db2.retrieveProcedures(WS, 'transpile build failure', 3);
const procAfter = foundAfter.find(p => p.id === proc.id);
ok("C7 markProcedureUsed bumps success_count", !!procAfter && procAfter.successCount > scBefore);

// C8 memory timeline v3: exact checkpoint ranges, idempotency/revisions, redacted pages, and FTS fallback.
const cpSession = 'checkpoint-session';
const cpStart = await db2.record({ sessionId: cpSession, workspaceId: WS, kind: 'prompt', role: 'user', title: 'Initial architecture', body: 'Use immutable checkpoints for the memory timeline.' });
await db2.record({ sessionId: cpSession, workspaceId: WS, kind: 'tool_call', title: 'secret tool', body: '{"api_key":"sk-super-secret-value"}', meta: { tool: 'run_command' } });
await db2.record({ sessionId: cpSession, workspaceId: WS, kind: 'reply', title: 'Architecture accepted', body: 'The indexed memory design uses local hybrid retrieval.' });
const cpEnd = await db2.record({ sessionId: cpSession, workspaceId: WS, kind: 'note', title: 'Compaction', body: 'Immutable checkpoint timeline summary.' });
const checkpoint = await db2.createMemoryCheckpoint(WS, { sessionId: cpSession, trigger: 'explicit-compact', endEventId: cpEnd.id, summary: 'Immutable checkpoint timeline summary.' });
const checkpointAgain = await db2.createMemoryCheckpoint(WS, { sessionId: cpSession, trigger: 'explicit-compact', endEventId: cpEnd.id, summary: 'Revised immutable checkpoint timeline summary.' });
const checkpointCount = (await rawAll(dbPath, 'SELECT COUNT(*) AS n FROM memory_checkpoints WHERE session_id = ?', [cpSession]))[0]?.n;
const revisionCount = (await rawAll(dbPath, 'SELECT COUNT(*) AS n FROM memory_checkpoint_revisions WHERE checkpoint_id = ?', [checkpoint.id]))[0]?.n;
ok('C8 checkpoint exact range', checkpoint.startEventId === cpStart.id && checkpoint.endEventId === cpEnd.id && checkpoint.sourceEventCount === 4);
ok('C8 checkpoint idempotency + revision', checkpointAgain.id === checkpoint.id && checkpointCount === 1 && revisionCount === 1);
const evidence = await db2.getMemoryCheckpointEvidence(WS, checkpoint.id, 1, 2);
ok('C8 checkpoint evidence pagination', evidence?.events.length === 2 && evidence.totalPages === 2);
const pages = await db2.rebuildMemoryArchivePages(WS, cpSession, 100);
const pageDoc = (await rawAll(dbPath, "SELECT text FROM memory_index_documents WHERE kind = 'archive-page' AND session_id = ?", [cpSession]))[0]?.text ?? '';
ok('C8 archive page incremental build', pages.length === 1 && pages[0].startEventId === cpStart.id && pages[0].endEventId === cpEnd.id);
ok('C8 archive projection excludes tool secret', !pageDoc.includes('sk-super-secret-value') && pageDoc.includes('Tool: run_command'));
const checkpointHits = await db2.searchMemory(WS, 'immutable checkpoint timeline', null, null, { kinds: ['checkpoint'], limit: 5 });
ok('C8 BM25 checkpoint search', checkpointHits.some(hit => hit.id === checkpoint.id));
const pageIdBefore = pages[0].id;
const pagesAfterCursor = await db2.rebuildMemoryArchivePages(WS, cpSession, 100);
ok('C8 resumable cursor does not duplicate pages', pagesAfterCursor.length === 0 && (await rawAll(dbPath, 'SELECT COUNT(*) AS n FROM memory_archive_pages WHERE session_id = ?', [cpSession]))[0]?.n === 1 && pageIdBefore === pages[0].id);

// C9 the sanitizer itself. C8's secret lives in a tool_call, whose body is blanked wholesale, so
// it never exercises the redaction regexes. Non-tool events (prompt/reply) DO get indexed, so a
// credential pasted into a chat message is the real leak path -- cover it here.
const secSession = 'sanitizer-session';
const secStart = await db2.record({ sessionId: secSession, workspaceId: WS, kind: 'prompt', role: 'user', title: 'Auth debugging', body: 'The request sends Authorization: Bearer abc123xyz789supersecret and api_key: sk_live_LEAKYVALUE123456.' });
await db2.record({ sessionId: secSession, workspaceId: WS, kind: 'reply', title: 'Auth answer', body: 'Rotate it; the key was AIzaSyD1234567890abcdefghij in the config.' });
const secEnd = await db2.record({ sessionId: secSession, workspaceId: WS, kind: 'note', title: 'Wrap', body: 'Credential handling reviewed.' });
await db2.rebuildMemoryArchivePages(WS, secSession, 100);
const secDocs = (await rawAll(dbPath, "SELECT text FROM memory_index_documents WHERE kind = 'archive-page' AND session_id = ?", [secSession])).map(r => r.text).join('\n');
ok('C9 bearer credential redacted in index', !secDocs.includes('abc123xyz789supersecret'));
ok('C9 api key + provider token redacted in index', !secDocs.includes('sk_live_LEAKYVALUE123456') && !secDocs.includes('AIzaSyD1234567890abcdefghij'));
ok('C9 non-secret prose survives redaction', secDocs.includes('Rotate it') && secDocs.includes('Credential handling reviewed'));
ok('C9 sanitized page still spans exact range', (await rawAll(dbPath, 'SELECT start_event_id, end_event_id FROM memory_archive_pages WHERE session_id = ?', [secSession]))[0]?.start_event_id === secStart.id && (await rawAll(dbPath, 'SELECT start_event_id, end_event_id FROM memory_archive_pages WHERE session_id = ?', [secSession]))[0]?.end_event_id === secEnd.id);

// C10 getMemoryStats. Coverage is the load-bearing number (it decides whether search_memory can
// see an event at all), so assert it against an independently-derived count rather than itself.
const stats = await db2.getMemoryStats(WS);
const pagedEvents = (await rawAll(dbPath, 'SELECT COALESCE(SUM(event_count), 0) AS n FROM memory_archive_pages WHERE workspace_id = ?', [WS]))[0]?.n ?? 0;
const allEvents = (await rawAll(dbPath, 'SELECT COUNT(*) AS n FROM chat_events WHERE workspace_id = ?', [WS]))[0]?.n ?? 0;
ok('C10 stats totals match raw counts', stats.totalEvents === allEvents && stats.checkpoints === 1);
ok('C10 stats coverage matches paged events', stats.coveredEvents === pagedEvents && stats.coveredEvents > 0 && stats.coveredEvents <= stats.totalEvents);
ok('C10 stats document states sum to total', stats.indexed + stats.pending + stats.failed === stats.documents && stats.documents > 0);
ok('C10 stats byKind sums to documents', stats.byKind.reduce((sum, k) => sum + k.documents, 0) === stats.documents && stats.byKind.some(k => k.kind === 'archive-page'));
ok('C10 stats reports db bytes on disk', stats.dbBytes > 0 && typeof stats.walBytes === 'number');

await db2.close();
try { fs.unlinkSync(dbPath); } catch { /* ignore */ }

console.log(`\nLive catalog harness: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

// ---- tiny sqlite helpers (second connection for introspection / delete) ----

async function rawAll(dbFile, sql, params = []) {
	const Sqlite = await loadSqliteDatabaseConstructor();
	return new Promise((resolve, reject) => {
		const h = new Sqlite(dbFile, (err) => {
			if (err) { return reject(err); }
			h.all(sql, params, (e, rows) => {
				h.close(() => (e ? reject(e) : resolve(rows)));
			});
		});
	});
}

async function rawRun(dbFile, sql, params = []) {
	const Sqlite = await loadSqliteDatabaseConstructor();
	return new Promise((resolve, reject) => {
		const h = new Sqlite(dbFile, (err) => {
			if (err) { return reject(err); }
			h.run(sql, params, (e) => {
				h.close(() => (e ? reject(e) : resolve()));
			});
		});
	});
}
