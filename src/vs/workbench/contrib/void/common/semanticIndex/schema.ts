/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * SQLite schema for the semantic index.
 *
 * Persisted at `.v3code/index.db` per workspace. Designed for single-writer
 * worker-thread access via `@vscode/sqlite3` (already bundled, see
 * vselite/package.json). The `chunk_vec` virtual table requires the `sqlite-vec`
 * extension to be loadable — verify `db.loadExtension('vec0')` succeeds before
 * applying CURRENT_SCHEMA, otherwise the migration must short-circuit and
 * surface a clear error to the user.
 *
 * Embedding dimension is model-dependent. The default `Xenova/jina-embeddings-
 * v2-base-code` is 768-dim. If `meta.model_id` mismatches the active model at
 * init, `chunk_vec` (and only `chunk_vec`) must be dropped + recreated with the
 * new dim. The text and structural tables are model-agnostic and survive.
 */

export const SCHEMA_VERSION = 1;

/**
 * Default embedding dimension for `Xenova/jina-embeddings-v2-base-code`.
 * Override via the recreate-vec-table flow when the user picks MiniLM (384) or
 * any other model.
 */
export const DEFAULT_EMBEDDING_DIM = 768;

/**
 * Structural tables — model-agnostic, never recreated by a model swap.
 * Safe to run repeatedly (`IF NOT EXISTS` everywhere).
 */
export const STRUCTURAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
	id           TEXT PRIMARY KEY,
	file         TEXT NOT NULL,
	start_line   INTEGER NOT NULL,
	end_line     INTEGER NOT NULL,
	kind         TEXT NOT NULL,
	name         TEXT NOT NULL,
	language     TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	indexed_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

CREATE TABLE IF NOT EXISTS chunk_text (
	id      TEXT PRIMARY KEY,
	content TEXT NOT NULL,
	FOREIGN KEY (id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
	id UNINDEXED,
	content,
	tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS manifest (
	file         TEXT PRIMARY KEY,
	mtime        INTEGER NOT NULL,
	chunk_count  INTEGER NOT NULL,
	last_indexed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS query_cache (
	prompt_hash TEXT PRIMARY KEY,
	expansion   TEXT NOT NULL,
	created_at  INTEGER NOT NULL
);
`;

/**
 * Build the model-specific vec table DDL. sqlite-vec parses the dim from the
 * column declaration, so this must be string-templated rather than parameterised.
 */
export function vecTableDDL(embeddingDim: number): string {
	if (!Number.isInteger(embeddingDim) || embeddingDim <= 0 || embeddingDim > 4096) {
		throw new Error(`vecTableDDL: invalid embeddingDim ${embeddingDim}`);
	}
	return `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
	id        TEXT PRIMARY KEY,
	embedding FLOAT[${embeddingDim}]
);`;
}

/** Drops only the vec table — used when the embedding model dim changes. */
export const DROP_VEC_TABLE = `DROP TABLE IF EXISTS chunk_vec;`;

/** Meta keys reserved for index bookkeeping. Treat as a closed enum. */
export const META_KEYS = {
	schemaVersion: 'schema_version',
	modelId: 'model_id',
	embeddingDim: 'embedding_dim',
	createdAt: 'created_at',
} as const;
export type MetaKey = typeof META_KEYS[keyof typeof META_KEYS];
