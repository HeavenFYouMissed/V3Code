/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * `ISemanticIndexService` implementation.
 *
 * Coordinates: workspace walk → chunker → embedder → database (upsert) and
 * exposes a `retrieve(prompt)` entry point that runs the four-channel RRF
 * pipeline. All heavy work happens on the renderer's main thread for V0;
 * profiling can promote it to a `worker_threads.Worker` later without changing
 * the service surface.
 *
 * Lifecycle:
 *   workspace open       → service constructed (lazy, no I/O)
 *   first retrieve/      → openDatabase() + embedder.init() (lazy)
 *   first rebuild()
 *   model setting change → close + delete vec table + reopen
 *   workspace folder add → rebuild restricted to the new folder
 *
 * Configuration is read from `IConfigurationService` under `v3code.semanticIndex.*`
 * — see `semanticIndexConfiguration.ts`.
 *
 * NOTE (node backend): this service's ENGINE pieces — database.ts (SQLite
 * FTS5 + sqlite-vec), retriever.ts (4-channel RRF) and queryExpander.ts — now
 * also run in the electron-main process behind `void-channel-semanticIndexNode`
 * (electron-main/semanticIndexNodeChannel.ts), which the renderer opts into via
 * the `v3code.semanticIndex.nodeBackend` feature flag while keeping
 * orchestration in semanticIndexBrowserImpl.ts. This file remains as the
 * legacy all-in-one variant; it is never imported by void.contribution.ts, so
 * its registerSingleton below never takes effect.
 */

import { join, relative } from 'node:path';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService, FileChangeType } from '../../../../../platform/files/common/files.js';

import { Chunker } from './chunker.js';
import { Embedder, EmbedModelHint } from './embedder.js';
import { Retriever } from './retriever.js';
import { SemanticIndexDatabase } from './database.js';
import { createQueryExpander, expansionCacheKey, QueryExpanderApi } from './queryExpander.js';
import { Hit, IndexStatus, ISemanticIndexService, LocalScopeUnit } from './semanticIndexTypes.js';
import { languageFromExtension } from './chunkerLanguages.js';
import { DEFAULT_EMBEDDING_DIM } from './schema.js';
import { toPosix } from './hashing.js';
import { IgnoreLayer, loadGitignoreLayer, isIgnored } from './gitignore.js';

const CONFIG_PREFIX = 'v3code.semanticIndex';

const DEFAULT_EXCLUDES = [
	'node_modules', '.git', 'out', 'dist', 'build', '.next', '.cache', '.tmp',
	'.venv', 'venv', '__pycache__', '.pytest_cache', 'target', '.gradle',
	'bin', 'obj', '.idea', '.vscode-test', '.v3code',
];

/** True when any path segment matches an excluded directory name (e.g. …/react/out/…). */
function pathHasExcludedSegment(absPath: string, root: string, excludeSet: Set<string>): boolean {
	const rel = toPosix(absPath.slice(root.length)).replace(/^\//, '');
	for (const seg of rel.split('/')) {
		if (excludeSet.has(seg)) { return true; }
	}
	return false;
}

function isIndexExcludedFile(filePath: string): boolean {
	const posix = toPosix(filePath);
	for (const seg of DEFAULT_EXCLUDES) {
		if (posix.includes(`/${seg}/`) || posix.startsWith(`${seg}/`) || posix.endsWith(`/${seg}`)) {
			return true;
		}
	}
	return false;
}

const DEFAULT_MAX_FILE_KB = 1024;
const EXPANSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling on a single retrieve() call. Prevents an agent turn from
 *  hanging forever if the DB is locked by a checkpoint or a runaway rebuild. */
const RETRIEVE_TIMEOUT_MS = 15_000;
/** Debounce window for the incremental re-index after file changes. Coalesces
 *  bursts (save-all, branch switch, rebase) into a single update. */
const INCREMENTAL_DEBOUNCE_MS = 2_000;

interface ResolvedConfig {
	enabled: boolean;
	autoRebuildOnStartup: boolean;
	embedModel: EmbedModelHint;
	queryExpanderMode: 'local-llama' | 'chat-model' | 'heuristic';
	excludes: string[];
	maxFileSizeKB: number;
	concurrency: number;
	modelDownloadHost: string;
}

export class SemanticIndexService extends Disposable implements ISemanticIndexService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<IndexStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private _status: IndexStatus = {
		state: 'uninitialized',
		filesTotal: 0,
		filesIndexed: 0,
		chunksTotal: 0,
	};

	private db: SemanticIndexDatabase | null = null;
	private embedder: Embedder | null = null;
	private chunker: Chunker | null = null;
	private retriever: Retriever | null = null;
	private expander: QueryExpanderApi | null = null;
	/** Path used for the DB + index dir. Always the first workspace folder. */
	private workspaceRoot: string | null = null;
	/** Every open workspace folder. Index walks all of these and stores chunk
	 *  paths as `relative(workspaceRoot, abs)`, which yields `../folderN/...`
	 *  for sibling roots — unique without a custom prefix scheme. */
	private workspaceFolders: string[] = [];
	private rebuildPromise: Promise<void> | null = null;
	private initPromise: Promise<void> | null = null;
	/** Files awaiting an incremental re-index. Keyed by absolute fs path. */
	private _pendingChanges = new Set<string>();
	private _incrementalTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		@IConfigurationService private readonly configService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._register(this.configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_PREFIX)) {
				// Model / expander swaps require a re-init — easiest is to tear down
				// and let the next retrieve()/rebuild() reopen with new settings.
				void this.dispose(/*keepStatus*/ true);
			}
		}));

		// Eager warm-up: kick off init in the background so the first retrieve()
		// doesn't pay the 5-10s model-load + DB-open cost on the user's hot path.
		// All failure modes are non-fatal here — the on-demand retry will surface
		// the real error.
		queueMicrotask(() => {
			void this.ensureInitialized().catch(err => {
				this.logService.debug('[semantic-index] background warm-up skipped:', err?.message ?? err);
			});
		});

		// File-watcher integration: keep the index live instead of stale-on-first-build.
		this._register(this.fileService.onDidFilesChange(e => {
			if (this._status.state === 'uninitialized' || this._status.state === 'error') return;
			let touched = false;
			const visit = (resources: readonly { fsPath: string }[], type: FileChangeType) => {
				for (const r of resources) {
					const path = r.fsPath;
					if (!path) continue;
					if (!this._isUnderWorkspace(path)) continue;
					if (type !== FileChangeType.DELETED && !languageFromExtension(path)) continue;
					this._pendingChanges.add(path);
					touched = true;
				}
			};
			visit(e.rawAdded, FileChangeType.ADDED);
			visit(e.rawUpdated, FileChangeType.UPDATED);
			visit(e.rawDeleted, FileChangeType.DELETED);
			if (touched) this._scheduleIncrementalUpdate();
		}));
	}

	get status(): IndexStatus { return this._status; }
	getStatus(): IndexStatus { return this._status; }

	// This Node-only variant is superseded by SemanticIndexBrowserImpl (the impl
	// actually registered in the browser). These satisfy ISemanticIndexService;
	// the symbol-skeleton enrichment is provided by the browser impl.
	getLocalScope(_file: string): LocalScopeUnit[] { return []; }
	getRelatedFiles(_file: string, _max?: number): string[] { return []; }

	private resolveConfig(): ResolvedConfig {
		const get = <T>(key: string, fallback: T): T => {
			const v = this.configService.getValue<T>(`${CONFIG_PREFIX}.${key}`);
			return v === undefined ? fallback : v;
		};
		return {
			enabled: get('enabled', true),
			autoRebuildOnStartup: get('autoRebuildOnStartup', false),
			embedModel: get<EmbedModelHint>('embedModel', 'auto'),
			queryExpanderMode: get<'local-llama' | 'chat-model' | 'heuristic'>('queryExpander', 'heuristic'),
			excludes: get<string[]>('exclude', DEFAULT_EXCLUDES),
			maxFileSizeKB: get('maxFileSizeKB', DEFAULT_MAX_FILE_KB),
			concurrency: get('concurrency', 4),
			modelDownloadHost: get('modelDownloadHost', ''),
		};
	}

	private async ensureInitialized(): Promise<void> {
		if (this.db && this.embedder && this.chunker && this.retriever) return;
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.doInit();
		try {
			await this.initPromise;
		} finally {
			this.initPromise = null;
		}
	}

	private async doInit(): Promise<void> {
		const cfg = this.resolveConfig();
		if (!cfg.enabled) throw new Error('semantic index disabled by configuration');

		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length === 0) throw new Error('no workspace folder open');
		this.workspaceRoot = folders[0].uri.fsPath;
		this.workspaceFolders = folders.map(f => f.uri.fsPath);

		const indexDir = join(this.workspaceRoot, '.v3code');
		await fs.mkdir(indexDir, { recursive: true });
		const dbPath = join(indexDir, 'index.db');

		this.embedder = new Embedder({
			modelHint: cfg.embedModel,
			cacheDir: join(homedir(), '.v3code', 'models'),
			mirrorHost: cfg.modelDownloadHost || undefined,
		});
		// Init embedder first so we know the actual dimension before opening DB.
		await this.embedder.init();

		const dim = this.embedder.dim || DEFAULT_EMBEDDING_DIM;
		const modelId = this.embedder.modelId || 'unknown';

		this.db = new SemanticIndexDatabase();
		await this.db.open({ dbPath, embeddingDim: dim, modelId });

		this.chunker = new Chunker({
			// Tree-sitter grammars are cached globally (not per-workspace) — they're
			// pure language wasm blobs with no workspace-specific state.
			grammarsDir: join(homedir(), '.v3code', 'grammars'),
			maxFileBytes: cfg.maxFileSizeKB * 1024,
		});

		this.expander = createQueryExpander({
			mode: cfg.queryExpanderMode === 'local-llama' ? 'local-llama'
				: cfg.queryExpanderMode === 'chat-model' ? 'chat-model'
				: 'heuristic', // explicit heuristic — no model needed
			llama: cfg.queryExpanderMode === 'local-llama'
				? { modelPath: join(homedir(), '.v3code', 'models', 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf') }
				: undefined,
		});

		this.retriever = new Retriever(this.db, this.embedder);

		// One-shot cache prune — cheap, runs once per init, prevents query_cache
		// from growing without bound under sustained retrieval traffic.
		try { await this.db.pruneExpiredExpansions(EXPANSION_CACHE_TTL_MS); }
		catch (err) { this.logService.debug('[semantic-index] cache prune failed:', err); }

		this.updateStatus({
			state: 'idle',
			filesTotal: await this.db.countFiles(),
			chunksTotal: await this.db.countChunks(),
			filesIndexed: await this.db.countFiles(),
			modelId,
			embeddingDim: dim,
		});

		if (cfg.autoRebuildOnStartup) {
			void this.rebuild().catch(err => this.logService.error('[semantic-index] auto rebuild failed', err));
		}
	}

	private updateStatus(patch: Partial<IndexStatus>): void {
		this._status = { ...this._status, ...patch };
		this._onDidChangeStatus.fire(this._status);
	}

	async rebuild(): Promise<void> {
		if (this.rebuildPromise) return this.rebuildPromise;
		this.rebuildPromise = this.doRebuild().finally(() => {
			this.rebuildPromise = null;
		});
		return this.rebuildPromise;
	}

	private async doRebuild(): Promise<void> {
		try {
			await this.ensureInitialized();
			if (!this.db || !this.chunker || !this.embedder || !this.workspaceRoot) return;
			const cfg = this.resolveConfig();

			this.updateStatus({ state: 'walking', filesIndexed: 0, chunksTotal: await this.db.countChunks(), lastError: undefined });

			// Walk every workspace folder — monorepos / multi-root workspaces would
			// otherwise lose all but the primary folder.
			const allFiles: string[] = [];
			for (const folder of this.workspaceFolders) {
				const files = await walkWorkspace(folder, cfg.excludes, cfg.maxFileSizeKB * 1024);
				allFiles.push(...files);
			}
			this.updateStatus({ state: 'chunking', filesTotal: allFiles.length });

			let filesDone = 0;
			let chunksTotal = 0;
			const concurrency = Math.max(1, Math.min(8, cfg.concurrency));
			await runWithConcurrency(allFiles, concurrency, async (absPath) => {
				try {
					const rel = toPosix(relative(this.workspaceRoot!, absPath));
					const stat = await fs.stat(absPath);
					const existing = await this.db!.getManifestEntry(rel);
					if (existing && existing.mtime === stat.mtimeMs) {
						filesDone++;
						this.updateStatus({ filesIndexed: filesDone });
						return;
					}
					const lang = languageFromExtension(absPath);
					if (!lang) {
						filesDone++;
						this.updateStatus({ filesIndexed: filesDone });
						return;
					}
					const source = await fs.readFile(absPath, 'utf8');
					const chunks = await this.chunker!.chunkFile(rel, source, lang);
					if (chunks.length === 0) {
						await this.db!.deleteByFile(rel);
						filesDone++;
						this.updateStatus({ filesIndexed: filesDone });
						return;
					}

					// Replace any chunks that no longer exist for this file.
					await this.db!.deleteByFile(rel);

					const texts = chunks.map(c => source.split('\n').slice(c.startLine - 1, c.endLine).join('\n'));
					this.updateStatus({ state: 'embedding' });
					const vecs = this.db!.hasVec ? await this.embedder!.embed(texts) : new Array(chunks.length).fill(null);

					for (let i = 0; i < chunks.length; i++) {
						await this.db!.upsertChunk(chunks[i], texts[i], (vecs[i] as Float32Array | null) ?? null);
					}
					await this.db!.setManifestEntry({
						file: rel, mtime: stat.mtimeMs, chunk_count: chunks.length, last_indexed: Date.now(),
					});
					chunksTotal += chunks.length;
					filesDone++;
					this.updateStatus({ state: 'chunking', filesIndexed: filesDone, chunksTotal });
				} catch (err: any) {
					this.logService.warn(`[semantic-index] skip ${absPath}: ${err?.message ?? err}`);
					filesDone++;
					this.updateStatus({ filesIndexed: filesDone });
				}
			});

			this.updateStatus({
				state: 'ready',
				filesTotal: allFiles.length,
				filesIndexed: filesDone,
				chunksTotal: await this.db.countChunks(),
				lastIndexedAt: Date.now(),
			});
		} catch (err: any) {
			this.updateStatus({ state: 'error', lastError: err?.message ?? String(err) });
			throw err;
		}
	}

	async retrieve(prompt: string, opts?: { topK?: number; files?: string[]; quickPath?: boolean }): Promise<Hit[]> {
		await this.ensureInitialized();
		if (!this.retriever || !this.expander || !this.db) return [];

		const cacheKey = expansionCacheKey(prompt);
		let expansionJson = await this.db.getCachedExpansion(cacheKey, EXPANSION_CACHE_TTL_MS);
		let expansion;
		if (expansionJson) {
			try { expansion = JSON.parse(expansionJson); } catch { expansion = undefined; }
		}
		if (!expansion) {
			expansion = await this.expander.expand(prompt);
			await this.db.putCachedExpansion(cacheKey, JSON.stringify(expansion));
		}

		// Hard timeout — if the DB is locked (WAL checkpoint, runaway rebuild),
		// the agent gets a clean error instead of a hung turn.
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const retrievePromise = this.retriever.retrieve(expansion, { topK: opts?.topK ?? 30 });
		const timeoutPromise = new Promise<Hit[]>((_, reject) => {
			timeoutHandle = setTimeout(
				() => reject(new Error(`[semantic-index] retrieve timed out after ${RETRIEVE_TIMEOUT_MS}ms`)),
				RETRIEVE_TIMEOUT_MS
			);
		});
		let hits: Hit[];
		try {
			hits = await Promise.race([retrievePromise, timeoutPromise]);
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
		}
		if (opts?.files && opts.files.length) {
			const allow = new Set(opts.files.map(toPosix));
			hits = hits.filter(h => allow.has(h.chunk.file));
		}
		hits = hits.filter(h => !isIndexExcludedFile(h.chunk.file));
		return hits;
	}

	override dispose(): void;
	override dispose(keepStatus: boolean): Promise<void>;
	override dispose(keepStatus?: boolean): void | Promise<void> {
		if (keepStatus) {
			// "Soft" teardown: tear down heavy state (db/embedder/etc) but KEEP the
			// platform Disposable store alive so the config listener and status
			// emitter survive — the singleton instance is meant to re-init on the
			// next retrieve()/rebuild(). Hard-disposing here would unregister the
			// very listener that called us.
			return this._disposeInternals();
		}
		// Hard teardown (singleton shutdown). Flush the Disposable store FIRST so
		// the config listener can't fire on a partially-torn-down service.
		super.dispose();
		// Fire-and-forget the async cleanup.
		void this._disposeInternals().catch(() => { /* noop */ });
	}

	private async _disposeInternals(): Promise<void> {
		if (this._incrementalTimer) {
			clearTimeout(this._incrementalTimer);
			this._incrementalTimer = null;
		}
		this._pendingChanges.clear();
		if (this.expander?.dispose) this.expander.dispose();
		this.embedder?.dispose();
		if (this.db) {
			try { await this.db.close(); } catch { /* noop */ }
		}
		this.db = null;
		this.embedder = null;
		this.chunker = null;
		this.retriever = null;
		this.expander = null;
		this.workspaceRoot = null;
		this.workspaceFolders = [];
	}

	// -----------------------------------------------------------------------
	// Incremental updates — file watcher pipeline
	// -----------------------------------------------------------------------

	private _isUnderWorkspace(absPath: string): boolean {
		for (const folder of this.workspaceFolders) {
			if (absPath === folder || absPath.startsWith(folder + '/') || absPath.startsWith(folder + '\\')) {
				return true;
			}
		}
		return false;
	}

	private _scheduleIncrementalUpdate(): void {
		if (this._incrementalTimer) clearTimeout(this._incrementalTimer);
		this._incrementalTimer = setTimeout(() => {
			this._incrementalTimer = null;
			void this._processIncremental().catch(err =>
				this.logService.warn('[semantic-index] incremental update failed:', err?.message ?? err));
		}, INCREMENTAL_DEBOUNCE_MS);
	}

	private async _processIncremental(): Promise<void> {
		if (!this.db || !this.chunker || !this.embedder || !this.workspaceRoot) return;
		if (this.rebuildPromise) return; // full rebuild is running — let it cover everything
		if (this._pendingChanges.size === 0) return;

		const cfg = this.resolveConfig();
		const batch = Array.from(this._pendingChanges);
		this._pendingChanges.clear();
		const maxBytes = cfg.maxFileSizeKB * 1024;

		for (const absPath of batch) {
			const rel = toPosix(relative(this.workspaceRoot, absPath));
			try {
				let stat;
				try { stat = await fs.stat(absPath); }
				catch { stat = null; }
				if (!stat) {
					// File deleted — drop its chunks. The manifest entry is harmless
					// to leave behind (next walker pass won't list a gone file, so
					// the stale mtime check is never consulted).
					await this.db.deleteByFile(rel);
					continue;
				}
				if (stat.size > maxBytes) continue;
				const lang = languageFromExtension(absPath);
				if (!lang) continue;
				const existing = await this.db.getManifestEntry(rel);
				if (existing && existing.mtime === stat.mtimeMs) continue;
				const source = await fs.readFile(absPath, 'utf8');
				const chunks = await this.chunker.chunkFile(rel, source, lang);
				await this.db.deleteByFile(rel);
				if (chunks.length === 0) continue;
				const texts = chunks.map(c => source.split('\n').slice(c.startLine - 1, c.endLine).join('\n'));
				const vecs = this.db.hasVec ? await this.embedder.embed(texts) : new Array(chunks.length).fill(null);
				for (let i = 0; i < chunks.length; i++) {
					await this.db.upsertChunk(chunks[i], texts[i], (vecs[i] as Float32Array | null) ?? null);
				}
				await this.db.setManifestEntry({
					file: rel, mtime: stat.mtimeMs, chunk_count: chunks.length, last_indexed: Date.now(),
				});
			} catch (err: any) {
				this.logService.warn(`[semantic-index] incremental skip ${absPath}: ${err?.message ?? err}`);
			}
		}

		// Refresh the public counters so the status bar reflects new totals.
		this.updateStatus({
			filesTotal: await this.db.countFiles(),
			filesIndexed: await this.db.countFiles(),
			chunksTotal: await this.db.countChunks(),
			lastIndexedAt: Date.now(),
		});
	}
}

// ---------------------------------------------------------------------------
// Helpers — workspace walker + bounded concurrency
// ---------------------------------------------------------------------------

async function walkWorkspace(root: string, excludes: string[], maxBytes: number): Promise<string[]> {
	const excludeSet = new Set(excludes);
	const out: string[] = [];
	const layerCache = new Map<string, IgnoreLayer | null>();

	const getLayer = async (dir: string): Promise<IgnoreLayer | null> => {
		if (layerCache.has(dir)) return layerCache.get(dir)!;
		const layer = await loadGitignoreLayer(dir);
		layerCache.set(dir, layer);
		return layer;
	};

	async function walk(dir: string, stack: IgnoreLayer[]): Promise<void> {
		const layer = await getLayer(dir);
		const layers = layer ? [...stack, layer] : stack;
		let entries: import('fs').Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (excludeSet.has(ent.name)) continue;
			const abs = join(dir, ent.name);
			if (pathHasExcludedSegment(abs, root, excludeSet)) continue;
			if (layers.length) {
				const topLayer = layers[layers.length - 1];
				const relFromLayer = toPosix(abs.slice(topLayer.dir.length + 1));
				if (isIgnored(relFromLayer, ent.isDirectory(), layers)) continue;
			}
			if (ent.isDirectory()) {
				await walk(abs, layers);
			} else if (ent.isFile()) {
				try {
					const st = await fs.stat(abs);
					if (st.size <= maxBytes) out.push(abs);
				} catch { /* skip */ }
			}
		}
	}
	await walk(root, []);
	return out;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
	let i = 0;
	const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
		while (i < items.length) {
			const idx = i++;
			await worker(items[idx]);
		}
	});
	await Promise.all(runners);
}

registerSingleton(ISemanticIndexService, SemanticIndexService, InstantiationType.Delayed);
