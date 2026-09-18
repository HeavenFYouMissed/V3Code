/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Async wrapper around `@vscode/sqlite3` for the semantic index DB.
 *
 * The DB lives at `{workspaceRoot}/.v3code/index.db`. We use native FS paths
 * (not VS Code URIs) because the sqlite3 native module needs OS-level access.
 * This is safe inside V3Code's renderer because Electron 34 ships node
 * integration for the workbench window (same pattern as `mcpService.ts`'s
 * stdio MCP transport).
 *
 * Concurrency model: single-writer. The service owns one Database instance per
 * workspace folder. `serialize()` is used to wrap multi-statement upserts so
 * `last_insert_rowid()` and friends remain well-defined.
 *
 * sqlite-vec is OPTIONAL — we probe at open time. If the extension fails to
 * load, the database still indexes structural + FTS data and the retriever
 * falls back to FTS-only ranking. This degrades gracefully on platforms where
 * `--enable-load-extension` is not compiled in.
 */

import type { Database } from '@vscode/sqlite3';
import { STRUCTURAL_SCHEMA, vecTableDDL, DROP_VEC_TABLE, META_KEYS, SCHEMA_VERSION } from './schema.js';
import { Chunk } from './semanticIndexTypes.js';
import { contentHash as hashContent } from './hashing.js';

export interface ManifestEntry {
	file: string;
	mtime: number;
	chunk_count: number;
	last_indexed: number;
}

export interface VectorHit {
	id: string;
	distance: number;
}

export interface FtsHit {
	id: string;
	rank: number; // bm25 score; lower = better
}

export interface OpenOptions {
	dbPath: string;
	embeddingDim: number;
	modelId: string;
}

export class SemanticIndexDatabase {
	private db: Database | null = null;
	private vecLoaded = false;
	private embeddingDim = 0;
	private modelId = '';

	get hasVec(): boolean { return this.vecLoaded; }
	get dim(): number { return this.embeddingDim; }
	get model(): string { return this.modelId; }

	async open(opts: OpenOptions): Promise<void> {
		// Dynamic import — `@vscode/sqlite3` is bundled but resolving its native
		// addon at compile time would force every workbench bundle to pay the
		// load cost even when indexing is disabled.
		const mod = await import('@vscode/sqlite3' as any);
		const sqlite3 = mod.default ?? mod;
		const SqliteDatabase = sqlite3.Database;
		if (!SqliteDatabase) throw new Error('@vscode/sqlite3: Database export missing');
		this.db = await new Promise<Database>((resolve, reject) => {
			const handle: Database = new SqliteDatabase(opts.dbPath, (err: Error | null) => {
				if (err) reject(err); else resolve(handle);
			});
		});
		this.embeddingDim = opts.embeddingDim;
		this.modelId = opts.modelId;

		await this.exec('PRAGMA journal_mode = WAL');
		await this.exec('PRAGMA synchronous = NORMAL');
		await this.exec('PRAGMA foreign_keys = ON');

		// Probe sqlite-vec extension. Soft-fail: if loading throws, we run in
		// FTS-only mode and the retriever automatically drops the vector channel.
		// A non-positive dim (embedder unavailable — lexical-only caller) also
		// forces FTS-only: vecTableDDL would reject FLOAT[0] anyway.
		this.vecLoaded = opts.embeddingDim > 0 && await this.tryLoadVec();

		await this.exec(STRUCTURAL_SCHEMA);
		if (this.vecLoaded) {
			await this.applyVecTable(opts.embeddingDim, opts.modelId);
		}
		await this.writeMeta();
	}

	private async tryLoadVec(): Promise<boolean> {
		if (!this.db) return false;
		try {
			const vec = await import('sqlite-vec' as any);
			vec.load(this.db);
			// Probe with a no-op query — confirms vec0 is reachable.
			await this.allRaw<{ vec_version: string }>('SELECT vec_version() AS vec_version');
			return true;
		} catch {
			return false;
		}
	}

	private async applyVecTable(dim: number, modelId: string): Promise<void> {
		const storedDim = await this.getMetaNumber(META_KEYS.embeddingDim);
		const storedModel = await this.getMeta(META_KEYS.modelId);
		const mismatch = (storedDim !== undefined && storedDim !== dim) || (storedModel !== undefined && storedModel !== modelId);
		if (mismatch) {
			await this.exec(DROP_VEC_TABLE);
			// chunk_fts is a virtual table — FTS5 doesn't honour FK cascade, so we
			// must clear it explicitly before deleting chunks, or every model swap
			// leaves orphan FTS rows that bloat the index forever.
			await this.exec('DELETE FROM chunk_fts');
			await this.exec('DELETE FROM chunks');
			await this.exec('DELETE FROM manifest');
		}
		await this.exec(vecTableDDL(dim));
	}

	private async writeMeta(): Promise<void> {
		await this.setMeta(META_KEYS.schemaVersion, String(SCHEMA_VERSION));
		await this.setMeta(META_KEYS.embeddingDim, String(this.embeddingDim));
		await this.setMeta(META_KEYS.modelId, this.modelId);
		const existingCreatedAt = await this.getMeta(META_KEYS.createdAt);
		if (!existingCreatedAt) {
			await this.setMeta(META_KEYS.createdAt, String(Date.now()));
		}
	}

	// ---- raw promise helpers ----

	private exec(sql: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.db) return reject(new Error('database not open'));
			this.db.exec(sql, err => err ? reject(err) : resolve());
		});
	}

	private run(sql: string, params: unknown[] = []): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.db) return reject(new Error('database not open'));
			this.db.run(sql, params, err => err ? reject(err) : resolve());
		});
	}

	private allRaw<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
		return new Promise((resolve, reject) => {
			if (!this.db) return reject(new Error('database not open'));
			this.db.all(sql, params, (err: Error | null, rows: any[]) => err ? reject(err) : resolve(rows as T[]));
		});
	}

	private getRaw<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
		return new Promise((resolve, reject) => {
			if (!this.db) return reject(new Error('database not open'));
			this.db.get(sql, params, (err: Error | null, row: any) => err ? reject(err) : resolve(row as T | undefined));
		});
	}

	// ---- meta ----

	async getMeta(key: string): Promise<string | undefined> {
		const row = await this.getRaw<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
		return row?.value;
	}

	async getMetaNumber(key: string): Promise<number | undefined> {
		const v = await this.getMeta(key);
		if (v === undefined) return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	}

	async setMeta(key: string, value: string): Promise<void> {
		await this.run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [key, value]);
	}

	// ---- chunks / manifest ----

	/**
	 * Upsert a chunk + its content. If `embedding` is provided AND sqlite-vec is
	 * available, the vector is upserted too. Skips no-op writes when the
	 * existing row's content_hash matches.
	 */
	async upsertChunk(chunk: Chunk, content: string, embedding: Float32Array | null): Promise<{ inserted: boolean; skipped: boolean }> {
		if (!this.db) throw new Error('database not open');
		const ch = chunk.contentHash || hashContent(content);
		const existing = await this.getRaw<{ content_hash: string }>('SELECT content_hash FROM chunks WHERE id = ?', [chunk.id]);
		if (existing && existing.content_hash === ch) {
			return { inserted: false, skipped: true };
		}
		await this.run(
			`INSERT INTO chunks(id, file, start_line, end_line, kind, name, language, content_hash, indexed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   file=excluded.file,
			   start_line=excluded.start_line,
			   end_line=excluded.end_line,
			   kind=excluded.kind,
			   name=excluded.name,
			   language=excluded.language,
			   content_hash=excluded.content_hash,
			   indexed_at=excluded.indexed_at`,
			[chunk.id, chunk.file, chunk.startLine, chunk.endLine, chunk.kind, chunk.name ?? '', chunk.language ?? '', ch, Date.now()]
		);
		await this.run('INSERT OR REPLACE INTO chunk_text(id, content) VALUES (?, ?)', [chunk.id, content]);
		// FTS5 mirrors chunk_text via trigger-less direct write — keeps logic local.
		// Symbol name is concatenated into content so it's discoverable through the
		// same fts query without needing a separate column.
		await this.run('DELETE FROM chunk_fts WHERE id = ?', [chunk.id]);
		const ftsBody = chunk.name ? `${chunk.name}\n${content}` : content;
		await this.run('INSERT INTO chunk_fts(id, content) VALUES (?, ?)', [chunk.id, ftsBody]);
		if (embedding && this.vecLoaded) {
			if (embedding.length !== this.embeddingDim) {
				throw new Error(`embedding dim ${embedding.length} != expected ${this.embeddingDim}`);
			}
			await this.run('DELETE FROM chunk_vec WHERE id = ?', [chunk.id]);
			await this.run('INSERT INTO chunk_vec(id, embedding) VALUES (?, ?)', [chunk.id, Buffer.from(embedding.buffer)]);
		}
		return { inserted: !existing, skipped: false };
	}

	async deleteByFile(file: string): Promise<number> {
		const ids = await this.allRaw<{ id: string }>('SELECT id FROM chunks WHERE file = ?', [file]);
		if (ids.length === 0) return 0;
		// FK cascade handles chunk_text; chunk_vec & chunk_fts are virtual tables
		// so we delete them explicitly.
		const placeholders = ids.map(() => '?').join(',');
		const idList = ids.map(r => r.id);
		await this.run(`DELETE FROM chunk_fts WHERE id IN (${placeholders})`, idList);
		if (this.vecLoaded) {
			await this.run(`DELETE FROM chunk_vec WHERE id IN (${placeholders})`, idList);
		}
		await this.run('DELETE FROM chunks WHERE file = ?', [file]);
		await this.run('DELETE FROM manifest WHERE file = ?', [file]);
		return ids.length;
	}

	async getManifestEntry(file: string): Promise<ManifestEntry | undefined> {
		return this.getRaw<ManifestEntry>('SELECT file, mtime, chunk_count, last_indexed FROM manifest WHERE file = ?', [file]);
	}

	async setManifestEntry(entry: ManifestEntry): Promise<void> {
		await this.run(
			'INSERT OR REPLACE INTO manifest(file, mtime, chunk_count, last_indexed) VALUES (?, ?, ?, ?)',
			[entry.file, entry.mtime, entry.chunk_count, entry.last_indexed]
		);
	}

	async countChunks(): Promise<number> {
		const row = await this.getRaw<{ n: number }>('SELECT COUNT(*) AS n FROM chunks');
		return row?.n ?? 0;
	}

	async countFiles(): Promise<number> {
		const row = await this.getRaw<{ n: number }>('SELECT COUNT(*) AS n FROM manifest');
		return row?.n ?? 0;
	}

	// ---- retrieval ----

	async queryByVector(embedding: Float32Array, topK: number): Promise<VectorHit[]> {
		if (!this.vecLoaded) return [];
		const rows = await this.allRaw<{ id: string; distance: number }>(
			`SELECT id, distance FROM chunk_vec
			 WHERE embedding MATCH ? AND k = ?
			 ORDER BY distance ASC`,
			[Buffer.from(embedding.buffer), topK]
		);
		return rows;
	}

	async queryByFts(query: string, topK: number): Promise<FtsHit[]> {
		const cleaned = query.trim();
		if (!cleaned) return [];
		// Strip every FTS5 operator/punctuation character, keep letters/digits/_,
		// then double-quote each token and append `*` for prefix matching. The
		// quoting matters even after stripping punctuation: bare UPPERCASE tokens
		// like OR/AND/NOT/NEAR are still FTS5 keywords and a prompt containing a
		// standalone "OR" would otherwise be a syntax error. `"tok"*` is always a
		// literal prefix term, so the input can't invoke advanced syntax at all.
		const tokens = cleaned.split(/\s+/)
			.map(t => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
			.filter(t => t.length > 0)
			.map(t => `"${t}"*`)
			.join(' OR ');
		if (!tokens) return [];
		const rows = await this.allRaw<{ id: string; rank: number }>(
			`SELECT id, rank FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY rank LIMIT ?`,
			[tokens, topK]
		);
		return rows;
	}

	async getContent(id: string): Promise<string | undefined> {
		const row = await this.getRaw<{ content: string }>('SELECT content FROM chunk_text WHERE id = ?', [id]);
		return row?.content;
	}

	/** Batched variant of {@link getContent}. Returns a map keyed by chunk id;
	 *  missing ids simply absent. Two queries (chunks + content) per retrieve()
	 *  call instead of 2*N — ~10x speedup on topK=30 hydration. */
	async getContents(ids: readonly string[]): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		if (ids.length === 0) return out;
		const placeholders = ids.map(() => '?').join(',');
		const rows = await this.allRaw<{ id: string; content: string }>(
			`SELECT id, content FROM chunk_text WHERE id IN (${placeholders})`, [...ids]
		);
		for (const r of rows) out.set(r.id, r.content);
		return out;
	}

	async getChunk(id: string): Promise<Chunk | undefined> {
		const row = await this.getRaw<{
			id: string; file: string; start_line: number; end_line: number;
			kind: Chunk['kind']; name: string | null; language: string | null; content_hash: string;
		}>('SELECT id, file, start_line, end_line, kind, name, language, content_hash FROM chunks WHERE id = ?', [id]);
		if (!row) return undefined;
		return {
			id: row.id,
			file: row.file,
			startLine: row.start_line,
			endLine: row.end_line,
			kind: row.kind,
			name: row.name ?? '',
			language: row.language ?? '',
			contentHash: row.content_hash,
		};
	}

	/** Batched variant of {@link getChunk}. See {@link getContents} for rationale. */
	async getChunks(ids: readonly string[]): Promise<Map<string, Chunk>> {
		const out = new Map<string, Chunk>();
		if (ids.length === 0) return out;
		const placeholders = ids.map(() => '?').join(',');
		const rows = await this.allRaw<{
			id: string; file: string; start_line: number; end_line: number;
			kind: Chunk['kind']; name: string | null; language: string | null; content_hash: string;
		}>(
			`SELECT id, file, start_line, end_line, kind, name, language, content_hash FROM chunks WHERE id IN (${placeholders})`,
			[...ids]
		);
		for (const r of rows) {
			out.set(r.id, {
				id: r.id,
				file: r.file,
				startLine: r.start_line,
				endLine: r.end_line,
				kind: r.kind,
				name: r.name ?? '',
				language: r.language ?? '',
				contentHash: r.content_hash,
			});
		}
		return out;
	}

	// ---- cache ----

	async getCachedExpansion(promptHash: string, maxAgeMs: number): Promise<string | undefined> {
		const row = await this.getRaw<{ expansion: string; created_at: number }>(
			'SELECT expansion, created_at FROM query_cache WHERE prompt_hash = ?', [promptHash]
		);
		if (!row) return undefined;
		if (Date.now() - row.created_at > maxAgeMs) return undefined;
		return row.expansion;
	}

	async putCachedExpansion(promptHash: string, expansion: string): Promise<void> {
		await this.run(
			'INSERT OR REPLACE INTO query_cache(prompt_hash, expansion, created_at) VALUES (?, ?, ?)',
			[promptHash, expansion, Date.now()]
		);
	}

	/** Drop cache entries older than `maxAgeMs`. Cheap O(rows) scan; call once
	 *  per `doInit()` to prevent unbounded growth on heavy retrieval use. */
	async pruneExpiredExpansions(maxAgeMs: number): Promise<void> {
		await this.run('DELETE FROM query_cache WHERE created_at < ?', [Date.now() - maxAgeMs]);
	}

	// ---- lifecycle ----

	async close(): Promise<void> {
		if (!this.db) return;
		const db = this.db;
		this.db = null;
		// Truncate the WAL before closing so a subsequent crash can't leave
		// uncommitted pages dangling. SQLite auto-checkpoints on clean close,
		// but explicit is safer and costs one extra fsync.
		try {
			await new Promise<void>((resolve) => {
				db.exec('PRAGMA wal_checkpoint(TRUNCATE)', () => resolve());
			});
		} catch { /* noop */ }
		await new Promise<void>((resolve, reject) => {
			db.close(err => err ? reject(err) : resolve());
		});
	}
}
