/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// allow-any-unicode-comment-file

/**
 * Content-addressed chunk cache — Continue's two-table cross-branch design
 * (tag_catalog + global_cache in core/indexing/refreshIndex.ts) adapted to
 * IndexedDB.
 *
 * The insight: chunking + embedding depend only on file CONTENT, so key the
 * results by content hash and a branch switch becomes a tag flip — when a file
 * flips back to a hash we've seen (on any branch, or any workspace sharing the
 * DB), its chunks AND vectors are restored without re-parsing or re-embedding.
 *
 * Three key families inside one object store:
 *   e::v{N}::{contentHash}                  → CasEntry (chunk records + vectors)
 *   m::v{N}::{contentHash}                  → { lastUsed } — tiny meta record so
 *     LRU bookkeeping (touch / GC scans) never loads the heavy entries
 *   t::v{N}::{workspaceKey}::{branch}       → { hashes, updatedAt } — the branch
 *     tag catalog: which hashes each known branch needs. GC never evicts a hash
 *     referenced by a live tag, so switching back to a week-old branch is still
 *     instant. Stale tags (30 days unindexed) expire with their protection.
 *
 * Everything here is a CACHE: callers treat every method as fallible and fall
 * back to the normal chunk+embed path. Eviction is LRU over unprotected
 * entries once the entry count exceeds the caller's budget.
 */

import { ChunkKind } from '../../common/semanticIndex/semanticIndexTypes.js';

/** Path-independent persisted chunk: no id / file / parentId — the hydrator
 *  recomputes ids from the destination path and re-links parents via `parentIdx`
 *  (index into the same array). This is what makes an entry reusable when the
 *  same content appears at a different path (renames, monorepo copies). */
export interface CasChunkRecord {
	startLine: number;
	endLine: number;
	kind: ChunkKind;
	name: string;
	language: string;
	contentHash: string;
	scored: boolean;
	/** Index of the display parent within this same array (children only). */
	parentIdx?: number;
	defines?: string[];
	refs?: string[];
	/** LSP-verified defines/refs (lspEdgeEnricher.ts). Additive — records
	 *  written before the enricher existed simply lack them. */
	lspDefines?: string[];
	lspRefs?: string[];
	content?: string;
	tokens?: string[];
	vec?: Int8Array | null;
	vecScale?: number;
}

export interface CasEntry {
	chunks: CasChunkRecord[];
	/** Embedder that produced the vectors. Absent ⇒ entry has no usable vectors. */
	modelId?: string;
	dim?: number;
	/** Chunker capability key (chunkerCapability.ts) the CHUNKS were produced
	 *  under. The cache is content-addressed, but chunk BOUNDARIES also depend on
	 *  which tree-sitter grammars were packaged — so an entry written when a
	 *  language fell back to line windows must not be replayed over a chunker
	 *  that now has that grammar. Absent ⇒ written before capability tracking. */
	chunker?: string;
}

interface CasMeta { lastUsed: number; }
interface BranchTag { hashes: string[]; updatedAt: number; }

/** Branch tags older than this stop protecting their hashes from eviction. */
const TAG_TTL_MS = 30 * 24 * 3600 * 1000;

export class CasStore {
	private _dbPromise: Promise<IDBDatabase> | null = null;
	private _db: IDBDatabase | null = null;

	constructor(
		private readonly openDb: () => Promise<IDBDatabase>,
		private readonly storeName: string,
		/** Persist-format version — a bump orphans (and GC deletes) old entries. */
		private readonly version: number,
	) { }

	private _entryKey(hash: string): string { return `e::v${this.version}::${hash}`; }
	private _metaKey(hash: string): string { return `m::v${this.version}::${hash}`; }
	private _tagKey(ws: string, branch: string): string { return `t::v${this.version}::${ws}::${branch}`; }
	private _range(kind: 'e' | 'm' | 't'): IDBKeyRange {
		const p = `${kind}::v${this.version}::`;
		// allow-any-unicode-next-line
		return IDBKeyRange.bound(p, p + '￿');
	}

	/** One cached connection — CAS lookups sit on the rebuild hot loop, and an
	 *  open/close per get would dominate the hit's cost. */
	private _database(): Promise<IDBDatabase> {
		if (this._db) return Promise.resolve(this._db);
		if (!this._dbPromise) {
			this._dbPromise = this.openDb().then(db => {
				this._db = db;
				db.onclose = () => { this._db = null; this._dbPromise = null; };
				return db;
			}, err => { this._dbPromise = null; throw err; });
		}
		return this._dbPromise;
	}

	dispose(): void {
		this._db?.close();
		this._db = null;
		this._dbPromise = null;
	}

	private _req<T>(req: IDBRequest<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	private _done(tx: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	}

	async get(contentHash: string): Promise<CasEntry | undefined> {
		const db = await this._database();
		const tx = db.transaction(this.storeName, 'readonly');
		return this._req<CasEntry | undefined>(tx.objectStore(this.storeName).get(this._entryKey(contentHash)));
	}

	/** Write entries + their LRU meta in a single transaction. */
	async putEntries(pairs: readonly [string, CasEntry][], now: number): Promise<void> {
		if (pairs.length === 0) return;
		const db = await this._database();
		const tx = db.transaction(this.storeName, 'readwrite');
		const store = tx.objectStore(this.storeName);
		for (const [hash, entry] of pairs) {
			store.put(entry, this._entryKey(hash));
			store.put({ lastUsed: now } satisfies CasMeta, this._metaKey(hash));
		}
		await this._done(tx);
	}

	/** Bump lastUsed on cache hits — meta records only, never the heavy entries. */
	async touch(hashes: readonly string[], now: number): Promise<void> {
		if (hashes.length === 0) return;
		const db = await this._database();
		const tx = db.transaction(this.storeName, 'readwrite');
		const store = tx.objectStore(this.storeName);
		for (const hash of hashes) {
			store.put({ lastUsed: now } satisfies CasMeta, this._metaKey(hash));
		}
		await this._done(tx);
	}

	/** Record which hashes `branch` needs — the tag layer that pins them across switches. */
	async writeBranchTag(workspaceKey: string, branch: string, hashes: readonly string[], now: number): Promise<void> {
		const db = await this._database();
		const tx = db.transaction(this.storeName, 'readwrite');
		tx.objectStore(this.storeName).put(
			{ hashes: [...hashes], updatedAt: now } satisfies BranchTag,
			this._tagKey(workspaceKey, branch),
		);
		await this._done(tx);
	}

	/**
	 * Garbage collection. Deletes, in order:
	 *   1. every record from a different persist-format version,
	 *   2. branch tags not refreshed within TAG_TTL_MS,
	 *   3. if more than `maxEntries` remain: LRU entries that no live branch tag
	 *      (and nothing in `protect`) references.
	 * Returns the number of evicted entries.
	 */
	async gc(opts: { maxEntries: number; protect: ReadonlySet<string>; now: number }): Promise<number> {
		const db = await this._database();

		// 1. Drop foreign-version records (format changed — unreadable by this code).
		{
			const tx = db.transaction(this.storeName, 'readwrite');
			const store = tx.objectStore(this.storeName);
			const keys = await this._req(store.getAllKeys());
			const vTag = `::v${this.version}::`;
			for (const key of keys) {
				if (typeof key === 'string' && !key.includes(vTag)) store.delete(key);
			}
			await this._done(tx);
		}

		// 2. Tags: expire stale ones; the survivors' hashes are protected.
		const protectedHashes = new Set(opts.protect);
		{
			const tx = db.transaction(this.storeName, 'readwrite');
			const store = tx.objectStore(this.storeName);
			const [tags, tagKeys] = await Promise.all([
				this._req(store.getAll(this._range('t')) as IDBRequest<BranchTag[]>),
				this._req(store.getAllKeys(this._range('t'))),
			]);
			for (let i = 0; i < tags.length; i++) {
				if (opts.now - (tags[i]?.updatedAt ?? 0) > TAG_TTL_MS) {
					store.delete(tagKeys[i]);
				} else {
					for (const h of tags[i]?.hashes ?? []) protectedHashes.add(h);
				}
			}
			await this._done(tx);
		}

		// 3. LRU-evict unprotected entries over budget (metas only — cheap scan).
		const metaPrefix = `m::v${this.version}::`;
		const tx = db.transaction(this.storeName, 'readwrite');
		const store = tx.objectStore(this.storeName);
		const [metas, metaKeys] = await Promise.all([
			this._req(store.getAll(this._range('m')) as IDBRequest<CasMeta[]>),
			this._req(store.getAllKeys(this._range('m'))),
		]);
		const over = metas.length - opts.maxEntries;
		let deleted = 0;
		if (over > 0) {
			const candidates: { hash: string; lastUsed: number }[] = [];
			for (let i = 0; i < metaKeys.length; i++) {
				const key = metaKeys[i];
				if (typeof key !== 'string') continue;
				const hash = key.slice(metaPrefix.length);
				if (protectedHashes.has(hash)) continue;
				candidates.push({ hash, lastUsed: metas[i]?.lastUsed ?? 0 });
			}
			candidates.sort((a, b) => a.lastUsed - b.lastUsed);
			for (const c of candidates.slice(0, over)) {
				store.delete(this._entryKey(c.hash));
				store.delete(this._metaKey(c.hash));
				deleted++;
			}
		}
		await this._done(tx);
		return deleted;
	}
}
