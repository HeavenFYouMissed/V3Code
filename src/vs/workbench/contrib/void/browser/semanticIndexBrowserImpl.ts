/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Renderer-side semantic index — orchestrator.
 *
 * This is the ACTIVE ISemanticIndexService (registered below; imported from
 * void.contribution.ts). The Node-only common/semanticIndex/semanticIndexService.ts
 * stays dormant because its static `node:fs`/`@vscode/sqlite3` imports don't
 * resolve in the renderer's ESM loader.
 *
 * Responsibilities kept here (the orchestration layer):
 *   • Workspace walk (IFileService) honouring .gitignore + skip dirs + the
 *     hard security denylist (securityIgnore.ts — .env/keys/certs never indexed).
 *   • Merkle-incremental rebuild + background reconcile, with thread-yield guards.
 *   • Paged IndexedDB persistence (chunks bucketed by file-hash; int8 vectors),
 *     plus a content-addressed cross-branch cache (casStore.ts): a branch switch
 *     back to previously-seen content re-chunks and re-embeds NOTHING.
 *   • Embedding via the main-process MiniLM IPC proxy + dynamic-range int8 quant.
 *   • Public retrieve()/rebuild() + graph query APIs (related files / local scope
 *     / neighbors) that power proactive prefetch and the autocomplete engines.
 *
 * Delegated to focused modules (see ./semanticIndex/*):
 *   • treeSitterChunker  — structural parent/child extraction + window fallback.
 *   • quantizer          — dynamic-range int8 quantization + dequant cosine.
 *   • dependencyGraph    — defines/refs symbol graph + neighbor queries.
 *   • hybridRetriever    — RRF fusion (+ recent-edits boost), child→parent
 *                          collapse, neighbor injection.
 *   • casStore           — content-addressed chunk+vector cache with branch tags
 *                          (Continue's tag_catalog/global_cache design on IDB).
 */

import { localize } from '../../../../nls.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { importAMDNodeModule, canASAR } from '../../../../amdX.js';
import { AppResourcePath, FileAccess, nodeModulesAsarUnpackedPath, nodeModulesPath, Schemas } from '../../../../base/common/network.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ChunkKind, Hit, IndexStatus, ISemanticIndexService, LocalScopeUnit } from '../common/semanticIndex/semanticIndexTypes.js';
import { ISemanticEmbedService } from './semanticEmbedProxy.js';
import { IBeastService } from './beastService.js';
import { ISemanticIndexNodeService } from './semanticIndexNodeProxy.js';
import { mapNodeHits, toBatches, NodeIndexChunkInput, NODE_MIRROR_BATCH } from '../common/semanticIndex/semanticIndexNodeIpc.js';
import { IndexedChunk } from './semanticIndex/browserIndexTypes.js';
import { quantizeDynamic, QuantizedVector } from './semanticIndex/quantizer.js';
import { DependencyGraph } from './semanticIndex/dependencyGraph.js';
import { ChunkerHost, TreeSitterChunker } from './semanticIndex/treeSitterChunker.js';
import { hybridSearch } from './semanticIndex/hybridRetriever.js';
import { EMPTY_TOKENS, internTokens, tokenStringsOf } from './semanticIndex/tokenDict.js';
import { applyRerankOrder, buildRerankDoc, RERANK_MAX_CANDIDATES } from '../common/semanticIndex/llamaRerankerPure.js';
import { isSecurityConcernPath, isSecurityIgnoredDirName } from '../common/semanticIndex/securityIgnore.js';
import { CasStore, CasEntry, CasChunkRecord } from './semanticIndex/casStore.js';
import { embedTextFor } from './semanticIndex/embedText.js';
import { effectiveEmbedIdentity } from '../common/semanticIndex/embedIdentity.js';
import { isStaticCodeModel, STATIC_CODE_REPO } from '../common/semanticIndex/staticEmbedModels.js';
import { addedGrammars, ChunkerCapability, chunkerCapabilityKey, mergeChunkerCapability, readChunkerCapability, shouldRechunkForCapability } from '../common/semanticIndex/chunkerCapability.js';
import { IRecentEditsService } from './recentEditsService.js';
import { ILspBridgeAdapter } from './contextBridge/lspBridgeAdapter.js';
import { LspEdgeEnricher, LspEdgeHost } from './semanticIndex/lspEdgeEnricher.js';
import { IUserActivityService } from '../../../services/userActivity/common/userActivityService.js';
import { contentHash64 } from '../common/semanticIndex/hashing.js';
import { coveredByFailedWalk, walkHealthRetryDelay } from './semanticIndex/walkHealth.js';
import { isWorkspaceIndexPathSchemeCompatible, workspaceIndexPath, workspaceIndexPathScheme } from '../common/semanticIndex/workspaceIndexPath.js';
import { canServeSemanticWorkspace, shouldResetSemanticCorpus } from '../common/semanticIndex/semanticWorkspacePolicy.js';

interface GitignoreRule {
	re: RegExp;
	negate: boolean;
	dirOnly: boolean;
}

interface GitignoreLayer {
	dir: string;
	rules: GitignoreRule[];
}

/** On-disk chunk record (one element of a page). */
interface PersistedChunk {
	id: string;
	file: string;
	startLine: number;
	endLine: number;
	kind: ChunkKind;
	name: string;
	language: string;
	contentHash: string;
	parentId?: string;
	scored: boolean;
	defines?: string[];
	refs?: string[];
	/** LSP-verified defines/refs (lspEdgeEnricher.ts). Additive — older records
	 *  simply lack them; no PERSIST_VERSION bump needed. */
	lspDefines?: string[];
	lspRefs?: string[];
	/** Present only for display chunks (parents + window blocks). */
	content?: string;
	/** Present only for scored chunks. */
	tokens?: string[];
	vec?: Int8Array | null;
	vecScale?: number;
	/** PREVIOUS-model vector (dual-space retrieval during a model-swap backfill).
	 *  Additive — records from before the swap simply lack these. */
	prevVec?: Int8Array | null;
	prevVecScale?: number;
}

interface PersistedPage {
	chunks: PersistedChunk[];
}

interface PersistedManifest {
	version: number;
	/** File-key identity. Missing is compatible only with legacy single-root
	 * workspaces; old multi-root caches contained path collisions. */
	pathScheme?: string;
	modelId: string;
	embeddingDim: number;
	numPages: number;
	filesIndexed: number;
	chunksTotal: number;
	lastIndexedAt?: number;
	fileHashes: [string, string][];
	fileToChunks: [string, string[]][];
	/** Identity of the space `prevVec` vectors live in (set only while a
	 *  model-swap backfill is incomplete). Additive — older manifests lack it. */
	prevModelId?: string;
	/** Chunker capability (grammar set + algorithm version) the persisted CHUNKS
	 *  were produced under — see chunkerCapability.ts. Additive: a manifest
	 *  without it predates capability tracking, which is exactly the population
	 *  that upgraded into grammars its chunks never saw. */
	chunker?: ChunkerCapability;
}

const SKIP_DIRS = new Set([
	'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build',
	'.next', '.turbo', '.cache', '.parcel-cache', 'coverage',
	'.v3code', '.vscode-test', '__pycache__', 'venv', '.venv', 'target',
	'.gradle', '.idea', '.vs', 'bin', 'obj', '.terraform'
]);

const BINARY_EXTS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'pdf',
	'zip', 'gz', 'tar', 'rar', '7z', 'jar', 'war', 'class', 'exe', 'dll',
	'so', 'dylib', 'wasm', 'bin', 'iso', 'dmg', 'msi', 'pyc', 'pyo',
	'mp3', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'ogg', 'wav', 'flac',
	'woff', 'woff2', 'ttf', 'otf', 'eot', 'lock', 'sqlite', 'db'
]);

const MAX_FILE_BYTES = 1_000_000;
const STATUS_EMIT_MS = 250;
const INCREMENTAL_DEBOUNCE_MS = 2_000;
/** Max files any single event may push into the LSP edge enricher. Bulk events
 *  (branch switch → hundreds of watcher changes) must NOT drain fully into the
 *  enricher queue: each unopened file costs a createModelReference plus ~2×5
 *  LSP calls, exactly while the language server is re-analyzing the checkout. */
const LSP_FEED_MAX_FILES = 20;
const CONFIG_PREFIX = 'v3code.semanticIndex';
/** Beast answers in ~ms; past this budget retrieval fuses without it. */
const BEAST_FUSION_BUDGET_MS = 150;

// -- Embedding policy --
const EMBED_MAX_CHARS = 8_000;
/** Texts per embed IPC call. Large because the default static embedder is cheap
 *  per item, so the IPC round-trip dominates — big batches mean far fewer trips.
 *  The transformer fallback sub-batches internally, so this is safe for it too. */
const EMBED_BATCH = 512;
/** Batch size when the live embedder is a SLOW model (Qwen3 on GPU): at
 *  ~10-20 chunks/s a 512-batch means the progress counter only moves every
 *  ~45s (looks frozen). Small batches keep it moving every few seconds; the
 *  IPC round-trip is noise next to the GPU time. */
const SLOW_EMBED_BATCH = 32;
/** Minimum pending-chunk count before the potion first-pass (dual-space
 *  bootstrap) is worth running ahead of a slow-model backfill. Below this the
 *  slow backfill finishes in ~a minute anyway. */
const PREPASS_MIN_CHUNKS = 1_000;
/** Persist progress every N embedded chunks so a long backfill survives a
 *  restart. Periodic saves write only the dirty pages, in small per-page
 *  transactions with UI yields — but they still cost IDB churn, so stay coarse. */
const SAVE_EVERY_CHUNKS = 100_000;
/** …but ALSO persist on a wall-clock cadence: a slow GPU backfill (Qwen3) moves
 *  ~thousands of chunks per minute, so the chunk-count trigger alone could go
 *  hours between saves — quitting mid-backfill would lose all of it. */
const SAVE_EVERY_MS = 3 * 60 * 1000;
/** Hard cap on chunks emitted per file — bounds pathological minified/vendored
 *  files that would otherwise explode into hundreds of windows. */
const MAX_CHUNKS_PER_FILE = 120;
/** Config/markup languages indexed for LEXICAL search but NOT embedded — vector
 *  search over package-lock.json / generated config is low value and dominates
 *  embed cost/time. They stay fully keyword-searchable. */
const NON_EMBED_LANGS = new Set(['json', 'yaml', 'toml', 'xml', 'css', 'scss', 'html', 'ini']);
/** Dual-space retrieval supports exactly one "previous" space: the potion static
 *  model (the default before a Qwen3 upgrade). Old vectors from any other model
 *  are wiped as before — we can't embed queries in an arbitrary retired space. */
// -- Persistence (paged IndexedDB) --
const IDB_NAME = 'v3code-index';
/** 4: added the content-addressed 'cas' object store (cross-branch chunk+vector cache). */
const IDB_VERSION = 4;
const IDB_STORE = 'sessions';
const IDB_CAS_STORE = 'cas';
/** Bumped to 5: chunk ids + content hashes switched from async SHA-256 to fast FNV-64. */
const PERSIST_VERSION = 5;
const NUM_PAGES = 128;

// -- Content-addressed cache (Continue's cross-branch design; see casStore.ts) --
/** Entry-count floor before LRU eviction kicks in; actual budget is
 *  max(this, 2× current file count) so the cache can hold ~one extra branch. */
const CAS_MIN_ENTRIES = 10_000;
/** GC is O(all meta records) — run it at most this often. */
const CAS_GC_INTERVAL_MS = 10 * 60_000;

// -- Yield cadence --
const YIELD_EVERY_FILES = 5;
/** A single file at/above this size forces a UI yield right after it is
 *  processed — one large synchronous tree-sitter parse alone can blow through
 *  several frames, so it must not share a task with 4 more files. */
const LARGE_FILE_YIELD_CHARS = 64 * 1024;
/** Files above this skip the structural (tree-sitter) parse and go straight to
 *  the line-window fallback: the parse is synchronous on the renderer thread and
 *  a ~1MB file costs hundreds of ms in ONE task, while files that big are
 *  near-always generated/vendored where windows lose little retrieval quality.
 *  (readText itself admits files up to MAX_FILE_BYTES = 1MB.) */
const STRUCTURAL_PARSE_MAX_CHARS = 256 * 1024;
const RECONCILE_DELAY_MS = 4_000;
/** Chunks serialized per slice between UI yields while building page payloads
 *  for IndexedDB — the whole-index serialization used to run as one task. */
const SAVE_SERIALIZE_SLICE = 4_096;
/** Extra spacing between slow-model (Qwen3) GPU batches while the user is
 *  actively typing/clicking (IUserActivityService, 10s idle debounce). The slow
 *  backfill is a background QUALITY upgrade — search is already live on interim
 *  vectors — so it must lose every contended cycle to input latency. The potion
 *  paths are availability and stay full speed. */
const BACKFILL_ACTIVE_BATCH_DELAY_MS = 250;
/** Backfill scans that touch every chunk (pending scan, prev-vector retirement)
 *  yield every this-many chunks. */
const SCAN_YIELD_EVERY = 50_000;

// -- Node backend mirror --
/** Backstop on the renderer-side mirror queue. Mirroring is best-effort: a
 *  backend that can't drain (e.g. an open stuck in flight) must not pin
 *  unbounded chunk text in renderer memory. Oldest entries drop first; the
 *  next rebuild (or cold-open full mirror) re-syncs anything lost. */
const NODE_MIRROR_QUEUE_MAX = 50_000;

function compileGitignorePattern(raw: string): GitignoreRule | null {
	const trimmed = raw.trim();
	if (!trimmed || trimmed.startsWith('#')) return null;
	let pat = trimmed;
	const negate = pat.startsWith('!');
	if (negate) pat = pat.slice(1);
	const dirOnly = pat.endsWith('/');
	if (dirOnly) pat = pat.slice(0, -1);
	const rooted = pat.startsWith('/');
	if (rooted) pat = pat.slice(1);
	if (!pat) return null;
	let re = '';
	for (let i = 0; i < pat.length; i++) {
		const c = pat[i];
		if (c === '*') {
			if (pat[i + 1] === '*') { re += '.*'; i++; }
			else re += '[^/]*';
		} else if (c === '?') {
			re += '[^/]';
		} else if ('.+^$()|{}[]\\'.includes(c)) {
			re += '\\' + c;
		} else {
			re += c;
		}
	}
	const prefix = rooted ? '^' : '(^|/)';
	return { re: new RegExp(prefix + re + '($|/)'), negate, dirOnly };
}

function isIgnoredByLayer(relPath: string, isDir: boolean, layers: readonly GitignoreLayer[]): boolean {
	let ignored = false;
	for (const layer of layers) {
		for (const rule of layer.rules) {
			if (rule.dirOnly && !isDir) continue;
			if (rule.re.test(relPath)) ignored = !rule.negate;
		}
	}
	return ignored;
}

function langFromExt(ext: string): string {
	const map: Record<string, string> = {
		ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
		mjs: 'javascript', cjs: 'javascript', py: 'python', rs: 'rust', go: 'go',
		java: 'java', cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c',
		hpp: 'cpp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala',
		md: 'markdown', mdx: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml',
		toml: 'toml', xml: 'xml', html: 'html', css: 'css', scss: 'scss', sh: 'shellscript',
		bash: 'shellscript', zsh: 'shellscript', ps1: 'powershell', sql: 'sql'
	};
	return map[ext.toLowerCase()] ?? 'plaintext';
}

function isDocumentationPath(path: string): boolean {
	return /\.(?:md|mdx|rst|adoc|txt)$/i.test(path);
}

/**
 * Cooperative yield that bypasses Chromium's 4 ms nested-setTimeout clamp using a
 * MessageChannel macrotask (the React-scheduler trick). Lets the renderer paint
 * between heavy loop turns without the forced ~4 ms-per-yield tax.
 */
const _scheduleMacrotask: (cb: () => void) => void = (() => {
	const channel = new MessageChannel();
	const queue: Array<() => void> = [];
	channel.port1.onmessage = () => { const cb = queue.shift(); if (cb) cb(); };
	return (cb: () => void) => { queue.push(cb); channel.port2.postMessage(0); };
})();
function yieldToUI(): Promise<void> {
	return new Promise<void>(resolve => _scheduleMacrotask(resolve));
}

/** FNV-1a — cheap, synchronous, stable hash used to bucket a file into a page. */
function fnv1a(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h >>> 0;
}

function pageIndexForFile(file: string): number {
	return fnv1a(file) % NUM_PAGES;
}

function firstLine(text: string): string {
	const nl = text.indexOf('\n');
	return nl < 0 ? text : text.slice(0, nl);
}

/** Coerce a persisted vector back to Int8Array — IndexedDB round-trips typed
 *  arrays, but legacy records / structured-clone edge cases may surface plain
 *  views or number arrays. */
function normalizeVec(v: unknown): Int8Array | undefined {
	if (v instanceof Int8Array) return v;
	if (v && (v as ArrayBufferView).buffer) return new Int8Array((v as ArrayBufferView).buffer);
	if (Array.isArray(v) && v.length) return Int8Array.from(v as number[]);
	return undefined;
}

function tokenize(text: string): string[] {
	const parts: string[] = [];
	const re = /[A-Z]?[a-z0-9]+|[A-Z]+(?=[A-Z][a-z]|\d|$)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const tok = m[0].toLowerCase();
		if (tok.length >= 2) parts.push(tok);
	}
	return parts;
}

const STOPWORDS = new Set([
	'the', 'is', 'are', 'was', 'were', 'a', 'an', 'and', 'or', 'but',
	'if', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'from', 'by',
	'as', 'be', 'it', 'its', 'this', 'that', 'these', 'those', 'not',
	'no', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
	'can', 'could', 'may', 'might', 'should', 'must', 'into', 'over',
	'under', 'about', 'such', 'like', 'just', 'also', 'then', 'than',
	'so', 'very', 'too', 'only', 'how', 'what', 'when', 'where', 'who',
	'which', 'why', 'we', 'you', 'they', 'he', 'she', 'me', 'my', 'our',
	'their', 'your', 'all', 'some', 'any', 'each', 'every', 'both',
]);

/** Whitelist of dot-prefixed filenames that should be indexed. */
const INDEXABLE_DOTFILES = new Set([
	'.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml',
	'.prettierrc', '.prettierrc.js', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml',
	'.babelrc', '.babelrc.js', '.babelrc.json',
	// .env* deliberately absent — every .env variant (including .local/.development/
	// .production, which used to be whitelisted here) is a security concern; see
	// securityIgnore.ts. Secrets must never reach the embedder or a context window.
	'.editorconfig', '.gitattributes', '.gitignore',
	'.nvmrc', '.npmrc', '.node-version',
	'.dockerignore',
	'.cursorrules', '.v3coderules', '.voidrules', '.claude', '.windsurfrules',
	'.cursorignore',
]);

/** Public shape returned by getNeighbors() — for context packing / FIM. */
export interface NeighborUnit {
	file: string;
	name: string;
	startLine: number;
	endLine: number;
	content: string;
}

export class SemanticIndexBrowserImpl extends Disposable implements ISemanticIndexService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<IndexStatus>());
	readonly onDidChangeStatus: Event<IndexStatus> = this._onDidChangeStatus.event;

	private _status: IndexStatus = {
		state: 'uninitialized',
		filesTotal: 0,
		filesIndexed: 0,
		chunksTotal: 0,
		modelId: 'loading...'
	};

	private chunks = new Map<string, IndexedChunk>();
	private fileToChunks = new Map<string, Set<string>>();
	private fileHashes = new Map<string, string>();
	private rebuildInFlight: Promise<void> | null = null;
	/** Identity of the workspace that produced the maps currently in memory. */
	private _indexedWorkspaceKey: string | null = null;
	private lastEmitAt = 0;
	private _pendingChanges = new Set<string>();
	private _dirtyPages = new Set<number>();
	/** Serializes page/manifest writes: saves now yield internally, so two
	 *  overlapping saves could otherwise interleave stale and fresh pages. */
	private _saveChain: Promise<void> = Promise.resolve();
	private _saveInFlight = false;
	private _incrementalTimer: ReturnType<typeof setTimeout> | null = null;
	private _initDone = false;
	private _reconcileScheduled = false;
	private _healthRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private _healthRetryAttempt = 0;
	private gitignoreCache = new Map<string, GitignoreLayer | null>();

	// Content-addressed cross-branch cache (see casStore.ts).
	private readonly _cas: CasStore;
	/** Files whose CAS entry is stale (freshly chunked or newly embedded). */
	private readonly _casDirty = new Set<string>();
	private _lastCasGcAt = 0;

	// Embeddings pipeline — proxied to main process via IPC.
	private _embeddingsAvailable = false;
	private _embeddingsLoading = false;
	private _modelDim = 0;
	private _backfillInFlight: Promise<void> | null = null;
	private _persistedDim = 0;
	private _persistedModelId = '';
	/** Raw id of the live embedder (e.g. 'minishlab/potion-code-16M-v2'), no display decoration. */
	private _modelId = '';
	/** Non-null while a model-swap backfill is incomplete: identity of the space
	 *  that chunks' `prevEmbedding` vectors live in (dual-space retrieval). */
	private _prevSpaceModelId: string | null = null;

	// Node backend (EXPERIMENTAL, flag 'v3code.semanticIndex.nodeBackend') —
	// SQLite FTS5 + sqlite-vec engine hosted in electron-main. The renderer
	// stays the orchestrator: it mirrors scored chunks over IPC and queries the
	// engine first in retrieve(), falling back to the in-memory index on any
	// error or empty result.
	private _nodeState: 'idle' | 'opening' | 'ready' | 'error' = 'idle';
	private _nodeDbPath: string | null = null;
	private _nodeWorkspaceKey: string | null = null;
	private _nodeMirrorQueue: NodeIndexChunkInput[] = [];
	private _nodeFlushing = false;

	private readonly _graph = new DependencyGraph();
	private readonly _chunker: TreeSitterChunker;

	// Chunker capability (chunkerCapability.ts) — grammar set + algorithm version.
	/** What the PERSISTED chunks were produced under. Promoted to the live
	 *  capability only once a whole-corpus re-chunk has completed: a periodic save
	 *  landing mid-rebuild must never claim capabilities the chunks on disk don't
	 *  have, or the heal is recorded as done while half the index is stale. */
	private _persistedChunker: ChunkerCapability | undefined;
	/** Set while a capability-forced re-chunk is in flight; the value to promote
	 *  when the walk that re-chunks every file finishes. */
	private _pendingChunkerPromotion: ChunkerCapability | undefined;
	/** Live capability key, cached for the CAS gate on the walk hot loop. Empty
	 *  until probed, and empty forever if the probe can't answer. */
	private _liveChunkerKey = '';

	// LSP edge enrichment (lspEdgeEnricher.ts) — lazily created on the first
	// candidate so workspaces with the kill-switch off never pay for it.
	private _lspEnricher: LspEdgeEnricher | null = null;

	private get _sessionKey(): string {
		const folders = this.workspace.getWorkspace().folders;
		if (folders.length === 0) return 'v3code-index:no-workspace';
		return 'v3code-index:' + folders.map(f => f.uri.toString()).sort().join('|');
	}

	private _manifestKeyFor(workspaceKey: string): string { return `${workspaceKey}::v${PERSIST_VERSION}::manifest`; }
	private _pageKeyFor(workspaceKey: string, i: number): string { return `${workspaceKey}::v${PERSIST_VERSION}::page::${i}`; }

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ISemanticEmbedService private readonly embedService: ISemanticEmbedService,
		@ISemanticIndexNodeService private readonly nodeIndexService: ISemanticIndexNodeService,
		@IRecentEditsService private readonly recentEditsService: IRecentEditsService,
		@IModelService private readonly modelService: IModelService,
		@ILspBridgeAdapter private readonly lspBridge: ILspBridgeAdapter,
		@IUserActivityService private readonly userActivityService: IUserActivityService,
		@IBeastService private readonly beastService: IBeastService,
	) {
		super();

		// Renderer long-task telemetry (measurement aid, trace-level): while the
		// index is doing background work, log main-thread tasks >=150ms so save /
		// parse / rebuild stalls are attributable from the log without a profiler.
		try {
			const obs = new PerformanceObserver(list => {
				const busy = this._backfillInFlight !== null || this._saveInFlight || this.rebuildInFlight !== null;
				if (!busy) return;
				for (const e of list.getEntries()) {
					if (e.duration < 150) continue;
					this.logService.trace(`[v3code-index] renderer long task ${Math.round(e.duration)}ms (state=${this._status.state}${this._backfillInFlight ? ' +backfill' : ''}${this._saveInFlight ? ' +save' : ''})`);
				}
			});
			obs.observe({ entryTypes: ['longtask'] });
			this._register(toDisposable(() => obs.disconnect()));
		} catch { /* longtask observer unavailable — instrumentation only */ }

		this._chunker = new TreeSitterChunker(this._createChunkerHost());
		this._cas = new CasStore(() => this._indexedDB(), IDB_CAS_STORE, PERSIST_VERSION);
		this._register(toDisposable(() => this._cas.dispose()));
		this._register(toDisposable(() => {
			if (this._healthRetryTimer) clearTimeout(this._healthRetryTimer);
			this._healthRetryTimer = null;
		}));

		this._register(this.fileService.onDidFilesChange(e => {
			if (!this._initDone || this._status.state === 'error') return;
			if (!this._readConfig().enabled) return;
			let touched = false;
			for (const r of e.rawAdded) { if (this._shouldWatch(r.fsPath)) { this._pendingChanges.add(r.fsPath); touched = true; } }
			for (const r of e.rawUpdated) { if (this._shouldWatch(r.fsPath)) { this._pendingChanges.add(r.fsPath); touched = true; } }
			let removed = false;
			for (const r of e.rawDeleted) {
				const rel = this._absToRel(r.fsPath);
				if (rel) {
					this._removeFileChunks(rel);
					this.fileHashes.delete(rel);
					this._dirtyPages.add(pageIndexForFile(rel));
					removed = true;
				}
			}
			if (touched || removed) this._scheduleIncremental();
		}));

		// Invalidate the old corpus synchronously. The folder-change contribution
		// starts the replacement rebuild, but calls arriving in that gap must never
		// see code or embeddings from the previous project.
		this._register(this.workspace.onDidChangeWorkspaceFolders(() => {
			this._indexedWorkspaceKey = null;
			this._backfillEpoch++;
			// A live project swap keeps the chat session, not the old project's
			// search corpus. Drop every workspace-owned in-memory structure now,
			// before the replacement walk starts, so background helpers that do not
			// serve retrieval cannot accidentally carry old metadata forward.
			this.chunks.clear();
			this.fileToChunks.clear();
			this.fileHashes.clear();
			this._graph.markDirty();
			this._dirtyPages.clear();
			this._casDirty.clear();
			this._persistedDim = 0;
			this._persistedModelId = '';
			this._prevSpaceModelId = null;
			this._persistedChunker = undefined;
			this._pendingChunkerPromotion = undefined;
			this._lspEnricher?.dispose();
			this._lspEnricher = null;
			this._pendingChanges.clear();
			if (this._incrementalTimer) clearTimeout(this._incrementalTimer);
			this._incrementalTimer = null;
			this._nodeState = 'idle';
			this._nodeDbPath = null;
			this._nodeWorkspaceKey = null;
			this._nodeMirrorQueue = [];
			const hasFolders = this.workspace.getWorkspace().folders.length > 0;
			this.setStatus({
				state: hasFolders ? 'walking' : 'idle',
				filesTotal: 0,
				filesIndexed: 0,
				chunksTotal: 0,
				currentFile: undefined,
				lastError: undefined,
			}, true);
		}));

		// A newly-opened text model means its language service is (about to be)
		// warm — the cheapest moment to resolve real LSP edges for that file.
		this._register(this.modelService.onModelAdded(model => {
			if (!this._initDone || model.uri.scheme !== Schemas.file) return;
			const rel = this._absToRel(model.uri.fsPath);
			if (rel && this.fileToChunks.has(rel)) this._feedLspEnricher([rel]);
		}));

		this._register(this.configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_PREFIX)) {
				if (this._readConfig().enabled && !this._initDone) {
					void this._initAndMaybeRebuild();
				}
				// Live engine swap: the channel rebuilds its Embedder when the hint
				// changes; _tryLoadEmbeddings then refreshes model info, drops
				// other-model vectors, and backfills.
				if (e.affectsConfiguration(`${CONFIG_PREFIX}.embedModel`)) {
					this._embeddingsAvailable = false;
					this._embeddingsLoading = false;
					void this._tryLoadEmbeddings().finally(() => {
						// The node backend keys its DB to the embedder identity —
						// re-open (and let it wipe/re-key) after a model swap.
						if (this._nodeState === 'ready' || this._nodeState === 'error') {
							this._nodeState = 'idle';
							this._nodeDbPath = null;
						}
						this._ensureNodeBackend();
					});
				}
				if (e.affectsConfiguration(`${CONFIG_PREFIX}.nodeBackend`)) {
					this._ensureNodeBackend();
				}
			}
		}));

		queueMicrotask(() => {
			void this._initAndMaybeRebuild();
			// Open the node backend only after the embedder identity settled — it
			// keys the SQLite schema to modelId/dim. No-op while the flag is off.
			void this._tryLoadEmbeddings().finally(() => this._ensureNodeBackend());
		});
	}

	private _readConfig() {
		const get = <T>(key: string, fallback: T): T => {
			const v = this.configService.getValue<T>(`${CONFIG_PREFIX}.${key}`);
			return v === undefined ? fallback : v;
		};
		return {
			enabled: get<boolean>('enabled', true),
			autoRebuildOnStartup: get<boolean>('autoRebuildOnStartup', true),
			excludes: get<string[]>('exclude', []),
			maxFileSizeKB: get<number>('maxFileSizeKB', 1024),
			concurrency: get<number>('concurrency', 4),
		};
	}

	private async _initAndMaybeRebuild(): Promise<void> {
		if (this._initDone) return;
		this._initDone = true;
		const cfg = this._readConfig();
		if (!cfg.enabled) {
			this.setStatus({ state: 'idle' }, true);
			return;
		}
		this._scheduleRerankerWarmup();

		const restored = await this._loadAll();
		const restoredFileCount = this.fileToChunks.size;
		const healthy = restored && restoredFileCount > 1 && this.chunks.size > 0;

		if (healthy) {
			this.logService.info(`[v3code-index] restored ${this.chunks.size} chunks (${restoredFileCount} files) from paged IndexedDB cache`);
			// Build the dependency graph NOW, cooperatively — not synchronously
			// inside the first retrieve (the autocomplete hot path).
			void this._graph.warmUp(this.chunks.values(), yieldToUI);
			this.setStatus({
				state: 'ready',
				filesIndexed: restoredFileCount,
				chunksTotal: this.chunks.size,
				documentationFiles: this._documentationFileCount(),
				embeddingDim: this._persistedDim || undefined,
				modelId: this._persistedModelId ? `${this._persistedModelId} (cached)` : this._status.modelId,
				lastIndexedAt: this._status.lastIndexedAt,
			}, true);
			if (cfg.autoRebuildOnStartup) {
				await this._healChunkerCapability();
				this._scheduleBackgroundReconcile();
			}
		} else {
			if (restored) {
				this.logService.warn(`[v3code-index] cache unusable (${restoredFileCount} files) — forcing full rebuild`);
			}
			await this.rebuild();
		}
	}

	/**
	 * Live chunker capability key, cached. Empty when the probe can't answer —
	 * every caller must then behave exactly as it did before capability tracking.
	 */
	private async _chunkerKey(): Promise<string> {
		if (!this._liveChunkerKey) {
			this._liveChunkerKey = chunkerCapabilityKey(await this._chunker.capability());
		}
		return this._liveChunkerKey;
	}

	/**
	 * Re-chunk the workspace when the chunker gained tree-sitter grammars the
	 * persisted index was built without.
	 *
	 * The index only re-chunks a file whose CONTENT hash moved, so shipping a
	 * grammar does nothing for an existing workspace: those files keep the blind
	 * line windows they got when the grammar was missing, until the user happens
	 * to edit every one of them. Clearing the hash map makes the ordinary
	 * reconcile treat every file as changed, which runs the full
	 * `_removeFileChunks` → `chunkFile` path — a real re-chunk, not the
	 * embedder-swap path, which only drops vectors and leaves boundaries alone.
	 */
	private async _healChunkerCapability(): Promise<void> {
		const live = await this._chunker.capability();
		if (!live) return; // probe indeterminate — say nothing, change nothing
		if (!shouldRechunkForCapability(this._persistedChunker, live)) return;
		const added = addedGrammars(this._persistedChunker, live);
		this.logService.info(
			`[v3code-index] chunker capability changed (algo ${this._persistedChunker?.algo ?? 'none'}→${live.algo}` +
			`${added.length ? `, gained ${added.join(', ')}` : ''}) — re-chunking ${this.fileToChunks.size} files so they get structural chunks instead of line windows`
		);
		// The promotion is deferred to the end of the walk: quitting mid-rebuild
		// must leave the OLD capability recorded so the heal simply runs again.
		this._pendingChunkerPromotion = mergeChunkerCapability(this._persistedChunker, live);
		this.fileHashes.clear();
		this.setStatus({
			rebuildReason: localize('v3code.semanticIndex.reason.languageSupport', "language support changed"),
		}, true);
	}

	/**
	 * Record the capability a just-completed whole-corpus re-chunk ran under.
	 * Called only from the walk paths that touched every file, so the value can
	 * never over-claim; writing it is what makes the heal happen exactly once.
	 */
	private async _promoteChunkerCapability(): Promise<void> {
		let promoted = this._pendingChunkerPromotion;
		this._pendingChunkerPromotion = undefined;
		if (!promoted) {
			const live = await this._chunker.capability();
			if (!live) return;
			promoted = mergeChunkerCapability(this._persistedChunker, live);
		}
		this._persistedChunker = promoted;
		if (this._status.rebuildReason) this.setStatus({ rebuildReason: undefined }, true);
	}

	private _shouldWatch(fsPath: string): boolean {
		if (!fsPath) return false;
		return this.workspace.getWorkspace().folders.some(f => fsPath.startsWith(f.uri.fsPath));
	}

	private _absToRel(fsPath: string): string | null {
		// File watcher events use native fsPath (backslashes on Windows). The old
		// string prefix check appended '/' to the workspace root, so paths like
		// `C:\proj\file.ts` never matched `C:\proj/` and incremental updates were
		// silently skipped — manual rebuild worked because the walk uses URI paths.
		const uri = URI.file(fsPath);
		if (!this.workspace.getWorkspaceFolder(uri)) return null;
		return this.relativePath(uri);
	}

	private _removeFileChunks(relPath: string): void {
		const ids = this.fileToChunks.get(relPath);
		if (ids) {
			for (const id of ids) this.chunks.delete(id);
			this.fileToChunks.delete(relPath);
			this._graph.removeChunks(ids);
			this.setStatus({ chunksTotal: this.chunks.size }, true);
			// Keep the node backend mirror in sync (flag-gated, fire-and-forget).
			if (this._nodeBackendEnabled() && this._nodeState === 'ready' && this._nodeDbPath) {
				this.nodeIndexService.removeFile(this._nodeDbPath, relPath).catch(err =>
					this.logService.trace(`[v3code-index] node-backend removeFile failed: ${err?.message ?? err}`));
			}
		}
	}

	/** Restore a file-level snapshot after any failed refresh. The in-memory
	 * chunks, graph, hash, and optional node mirror move back together. */
	private _restoreVerifiedFile(relPath: string, previousChunks: readonly IndexedChunk[], previousHash: string | undefined): void {
		this._removeFileChunks(relPath);
		if (previousChunks.length > 0) {
			const restoredIds = new Set<string>();
			for (const chunk of previousChunks) { this.chunks.set(chunk.id, chunk); restoredIds.add(chunk.id); }
			this.fileToChunks.set(relPath, restoredIds);
			this._graph.updateChunks(previousChunks);
			this._queueNodeMirror(previousChunks.filter(chunk => chunk.scored));
		}
		if (previousHash) this.fileHashes.set(relPath, previousHash);
		else this.fileHashes.delete(relPath);
	}

	private _scheduleIncremental(): void {
		if (this._incrementalTimer) clearTimeout(this._incrementalTimer);
		if (this._store.isDisposed) { return; } // disposed service must not schedule work
		this._incrementalTimer = setTimeout(() => {
			this._incrementalTimer = null;
			void this._doIncrementalUpdate();
		}, INCREMENTAL_DEBOUNCE_MS);
	}

	private async _doIncrementalUpdate(): Promise<void> {
		const workspaceKey = this._sessionKey;
		if (!canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) {
			this._pendingChanges.clear();
			void this.rebuild();
			return;
		}
		if (this.rebuildInFlight) {
			this._scheduleIncremental();
			return;
		}
		const paths = [...this._pendingChanges];
		this._pendingChanges.clear();
		const changedRels: string[] = [];
		const maxBytes = (this._readConfig().maxFileSizeKB || 1024) * 1024;
		let processed = 0;
		for (const absPath of paths) {
			if (workspaceKey !== this._sessionKey) return;
			const rel = this._absToRel(absPath);
			if (!rel) continue;
			this._dirtyPages.add(pageIndexForFile(rel));
			if (!this._shouldIndexPath(rel)) {
				this._removeFileChunks(rel);
				this.fileHashes.delete(rel);
				continue;
			}
			let bigFile = false;
			const previousIds = this.fileToChunks.get(rel);
			const previousChunks = previousIds
				? [...previousIds].map(id => this.chunks.get(id)).filter((chunk): chunk is IndexedChunk => !!chunk)
				: [];
			const previousHash = this.fileHashes.get(rel);
			let replacementStarted = false;
			try {
				const uri = URI.file(absPath);
				const content = await this.readText(uri, maxBytes);
				if (workspaceKey !== this._sessionKey) return;
				if (content === null) {
					this._removeFileChunks(rel);
					this.fileHashes.delete(rel);
					continue;
				}
				bigFile = content.length >= LARGE_FILE_YIELD_CHARS;
				replacementStarted = true;
				this._removeFileChunks(rel);
				const contentHash = contentHash64(content);
				this.fileHashes.set(rel, contentHash);
				// Cross-branch fast path (see doRebuild) — an edit that reverts a file
				// to previously-indexed content also lands here.
				if (await this._tryHydrateFromCas(rel, contentHash, workspaceKey)) {
					this._cas.touch([contentHash], Date.now()).catch(() => { });
				} else {
					await this.chunkFile(rel, content, workspaceKey);
					this._casDirty.add(rel);
				}
				if (workspaceKey !== this._sessionKey) return;
				changedRels.push(rel);
			} catch (err) {
				// A watcher update is not proof the file vanished (delete events have
				// their own path). Roll back the whole file refresh, including failures
				// after old chunks were removed, then retry via the health reconcile.
				if (replacementStarted) this._restoreVerifiedFile(rel, previousChunks, previousHash);
				this.logService.warn(`[v3code-index] changed file could not be safely refreshed; preserving its last verified chunks until retry: ${rel}: ${err instanceof Error ? err.message : err}`);
				this._scheduleHealthRetry();
			}
			// This loop had NO yields: a bulk external change (git checkout →
			// hundreds of watcher events) chunked every file in one renderer task.
			if (bigFile || ++processed % YIELD_EVERY_FILES === 0) await yieldToUI();
		}

		// Embed just the changed files' new chunks inline — a handful of vectors,
		// immediate, and only the touched pages are rewritten below. (The mass
		// background backfill is reserved for full rebuilds / first model load.)
		if (this._embeddingsAvailable && changedRels.length) {
			const toEmbed: IndexedChunk[] = [];
			for (const rel of changedRels) {
				const ids = this.fileToChunks.get(rel);
				if (!ids) continue;
				for (const id of ids) {
					const c = this.chunks.get(id);
					if (c && c.scored && !c.embedding && !NON_EMBED_LANGS.has(c.language)) toEmbed.push(c);
				}
			}
			// A bulk burst (branch switch, git checkout) on the slow transformer
			// would saturate the GPU doc lane for minutes and starve FIM — defer
			// big batches to the paced backfill instead (it prioritizes recent
			// files anyway), and use the slow-model batch size inline. Audit #7.
			const liveIsStatic = !this._modelId || isStaticCodeModel(this._modelId);
			const inlineEmbedMax = liveIsStatic ? Number.MAX_SAFE_INTEGER : 256;
			if (toEmbed.length > inlineEmbedMax) {
				this._maybeBackfillEmbeddings();
			} else {
				const incBatch = liveIsStatic ? EMBED_BATCH : SLOW_EMBED_BATCH;
				for (let i = 0; i < toEmbed.length; i += incBatch) {
					if (workspaceKey !== this._sessionKey) return;
					const slice = toEmbed.slice(i, i + incBatch);
					const vecs = await this._computeEmbeddings(slice.map(c => embedTextFor(c, this.chunks)));
					if (workspaceKey !== this._sessionKey) return;
					for (let j = 0; j < slice.length; j++) {
						const q = vecs[j];
						if (q) {
							slice[j].embedding = q.q;
							slice[j].vecScale = q.scale;
							this._casDirty.add(slice[j].file); // CAS entry gains vectors
						}
					}
					await yieldToUI();
				}
			}
		}

		this.setStatus({ chunksTotal: this.chunks.size, filesIndexed: this.fileToChunks.size, documentationFiles: this._documentationFileCount() }, true);
		const toSave = this._dirtyPages;
		this._dirtyPages = new Set();
		if (workspaceKey !== this._sessionKey) return;
		await this._savePages(toSave, undefined, workspaceKey);

		// Recently-edited files are enrichment candidates — their re-chunk just
		// dropped any previous lsp edges. Capped like _feedLspFromHits: this path
		// also fires for BULK external changes (a git checkout produces hundreds
		// of watcher events, and the language service is busy re-analyzing then,
		// not warm), so only a bounded slice may reach the enricher. Files that
		// hydrated from the CAS above already carry their lsp edges and are
		// skipped by the enricher's seed check, costing nothing.
		this._feedLspEnricher(changedRels.slice(0, LSP_FEED_MAX_FILES));
	}

	get status(): IndexStatus { return this._status; }
	getStatus(): IndexStatus { return this._status; }

	private _documentationFileCount(): number {
		let count = 0;
		for (const path of this.fileToChunks.keys()) if (isDocumentationPath(path)) count++;
		return count;
	}

	private setStatus(patch: Partial<IndexStatus>, force = false): void {
		this._status = { ...this._status, ...patch };
		// filesIndexed and filesTotal are written independently and drift apart, which is
		// what surfaced as impossible ratios like "4/0" and "10/2" on the index panel:
		//   - the cache/IndexedDB restore paths set filesIndexed but never filesTotal, so
		//     it keeps the constructor's 0 and the panel reads "restored N of nothing";
		//   - the debounced watcher update recomputes filesIndexed from the live file map,
		//     which grows with every new file, while filesTotal stays frozen at whatever
		//     the last full walk counted.
		// Both cases mean the same thing — we know about at least as many files as we have
		// indexed — so pin the invariant here, at the one place every write passes through,
		// rather than patching each writer and waiting for the next one to forget.
		if (this._status.filesIndexed > this._status.filesTotal) {
			this._status = { ...this._status, filesTotal: this._status.filesIndexed };
		}
		const now = Date.now();
		if (force || now - this.lastEmitAt >= STATUS_EMIT_MS) {
			this.lastEmitAt = now;
			this._onDidChangeStatus.fire(this._status);
		}
	}

	async rebuild(): Promise<void> {
		const requestedWorkspaceKey = this._sessionKey;
		if (this.workspace.getWorkspace().folders.length === 0) {
			this._indexedWorkspaceKey = null;
			this.setStatus({ state: 'idle', filesTotal: 0, filesIndexed: 0, chunksTotal: 0 }, true);
			return;
		}
		if (this.rebuildInFlight) {
			await this.rebuildInFlight;
			// A folder swap while the old walk was running must queue a fresh walk;
			// sharing the old promise alone leaves the new workspace unindexed.
			if (!canServeSemanticWorkspace(this._indexedWorkspaceKey, this._sessionKey)) {
				return this.rebuild();
			}
			return;
		}
		const cfg = this._readConfig();
		if (!cfg.enabled) {
			this.setStatus({ state: 'idle' }, true);
			return;
		}
		this.rebuildInFlight = this.doRebuild(cfg, /*fullReset*/ true, requestedWorkspaceKey).finally(() => {
			this.rebuildInFlight = null;
			// Close the race where embeddings became ready mid-rebuild: ensure a
			// backfill runs now that no rebuild is in flight (self-guarded + no-op
			// if everything is already embedded).
			if (canServeSemanticWorkspace(this._indexedWorkspaceKey, this._sessionKey)) {
				this._maybeBackfillEmbeddings();
			}
		});
		await this.rebuildInFlight;
		if (!canServeSemanticWorkspace(this._indexedWorkspaceKey, this._sessionKey)) {
			return this.rebuild();
		}
	}

	private _scheduleBackgroundReconcile(): void {
		if (this._reconcileScheduled) return;
		this._reconcileScheduled = true;
		setTimeout(() => {
			this._reconcileScheduled = false;
			void this._reconcile();
		}, RECONCILE_DELAY_MS);
	}

	private _scheduleHealthRetry(): void {
		if (this._healthRetryTimer || this._store.isDisposed || !this._readConfig().enabled) return;
		const delay = walkHealthRetryDelay(this._healthRetryAttempt++);
		this.logService.info(`[v3code-index] incomplete source read — scheduling a health reconcile in ${Math.round(delay / 1000)}s`);
		this._healthRetryTimer = setTimeout(() => {
			this._healthRetryTimer = null;
			void this._reconcile();
		}, delay);
	}

	private _clearHealthRetry(): void {
		this._healthRetryAttempt = 0;
		if (this._healthRetryTimer) clearTimeout(this._healthRetryTimer);
		this._healthRetryTimer = null;
	}

	private async _reconcile(): Promise<void> {
		if (!canServeSemanticWorkspace(this._indexedWorkspaceKey, this._sessionKey)) return this.rebuild();
		if (this.rebuildInFlight) return this.rebuildInFlight;
		const cfg = this._readConfig();
		if (!cfg.enabled) return;
		const workspaceKey = this._sessionKey;
		this.rebuildInFlight = this.doRebuild(cfg, /*fullReset*/ false, workspaceKey)
			.catch(err => {
				this.logService.warn('[v3code-index] background reconcile failed', err);
				this.setStatus({ lastError: `Index health reconcile failed: ${err instanceof Error ? err.message : err}. Search remains available from the last verified index.` }, true);
				this._scheduleHealthRetry();
			})
			.finally(() => {
				this.rebuildInFlight = null;
				this._maybeBackfillEmbeddings();
			});
		return this.rebuildInFlight;
	}

	private async doRebuild(cfg: ReturnType<SemanticIndexBrowserImpl['_readConfig']>, fullReset: boolean, workspaceKey: string): Promise<void> {
		if (workspaceKey !== this._sessionKey) return;
		const folders = this.workspace.getWorkspace().folders;
		if (folders.length === 0) {
			// Not an error — an empty window is a normal state, and it is what a brand-new user sees
			// before they open a folder. Reporting it as state:'error' put a red index status in front
			// of someone who has done nothing wrong. 'idle' is what the other nothing-to-do paths use.
			this.setStatus({ state: 'idle', lastError: undefined }, true);
			return;
		}

		// Beast sidecar (Phase A plumbing): index the same workspace in parallel.
		// Its db lives outside the repo, its failures never surface here, and the
		// service throttles watcher-driven re-runs (manual rebuilds force).
		void this.beastService.indexWorkspace({ force: fullReset });

		this.gitignoreCache.clear();
		this.setStatus({
			state: 'walking', filesTotal: 0, filesIndexed: 0, chunksTotal: this.chunks.size,
			lastError: undefined, currentFile: undefined, filesPerSecond: undefined,
			etaSeconds: undefined, bytesProcessed: 0, filesSkipped: 0
		}, true);

		const allSkipDirs = this._allSkipDirs();
		const maxBytes = (cfg.maxFileSizeKB || 1024) * 1024;

		let files: URI[] = [];
		try {
			files = await this.walkParallel(folders.map(f => f.uri), allSkipDirs, cfg.concurrency);
		} catch (err) {
			this.logService.warn('[v3code-index] walk failed', err);
			this._walkErrors.push('workspace walk');
			this._walkErrorPrefixes.push('');
		}
		if (workspaceKey !== this._sessionKey) {
			this.logService.info('[v3code-index] workspace changed during walk; discarding stale rebuild and queuing the active workspace');
			return;
		}
		const incompleteWalk = this._walkErrors.length > 0;
		// Preserving cached subtrees is valid only for a reconcile of the SAME
		// workspace. After a folder swap, even an incomplete walk must start from
		// empty maps or the old project's files become the new project's cache.
		const sameWorkspaceCorpus = canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey);
		const applyFullReset = shouldResetSemanticCorpus(fullReset, incompleteWalk, sameWorkspaceCorpus);
		const resetBackup = applyFullReset && sameWorkspaceCorpus ? {
			chunks: this.chunks,
			fileToChunks: this.fileToChunks,
			fileHashes: this.fileHashes,
		} : null;
		if (applyFullReset) {
			this._backfillEpoch++; // invalidate any in-flight backfill (it holds detached chunks)
			this.chunks = new Map();
			this.fileToChunks = new Map();
			this.fileHashes = new Map();
			this._graph.markDirty();
		} else if (fullReset && incompleteWalk) {
			this.logService.warn('[v3code-index] full rebuild walk was incomplete — converting to a preserving reconcile so verified cached subtrees stay searchable');
		}
		this.setStatus({ filesTotal: files.length, state: 'chunking' }, true);

		const startMs = Date.now();
		let bytesProcessed = 0;
		let filesSkipped = 0;
		let mutated = applyFullReset;
		let casHits = 0;
		const casTouched: string[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < files.length; i++) {
			if (workspaceKey !== this._sessionKey) return;
			const uri = files[i];
			const relPath = this.relativePath(uri);
			seen.add(relPath);
			let bigFile = false;
			const snapshotChunks = resetBackup?.chunks ?? this.chunks;
			const snapshotFiles = resetBackup?.fileToChunks ?? this.fileToChunks;
			const snapshotHashes = resetBackup?.fileHashes ?? this.fileHashes;
			const previousIds = snapshotFiles.get(relPath);
			const previousChunks = previousIds
				? [...previousIds].map(id => snapshotChunks.get(id)).filter((chunk): chunk is IndexedChunk => !!chunk)
				: [];
			const previousHash = snapshotHashes.get(relPath);
			let replacementStarted = applyFullReset;
			try {
				const content = await this.readText(uri, maxBytes);
				if (content === null) {
					if (this.fileToChunks.has(relPath)) mutated = true;
					this._removeFileChunks(relPath);
					this.fileHashes.delete(relPath);
				} else {
					bytesProcessed += content.length;
					bigFile = content.length >= LARGE_FILE_YIELD_CHARS;
					const prevHash = this.fileHashes.get(relPath);
					const hasExistingChunks = this.fileToChunks.has(relPath);
					const contentHash = contentHash64(content);

					if (prevHash && hasExistingChunks && contentHash === prevHash) {
						filesSkipped++;
						this.fileHashes.set(relPath, contentHash);
					} else {
						mutated = true;
						replacementStarted = true;
						this._removeFileChunks(relPath);
						this.fileHashes.set(relPath, contentHash);
						// Cross-branch fast path: content seen before (any branch, any
						// path) => restore chunks + vectors, skip tree-sitter AND embed.
						if (await this._tryHydrateFromCas(relPath, contentHash, workspaceKey)) {
							casHits++;
							casTouched.push(contentHash);
						} else {
							await this.chunkFile(relPath, content, workspaceKey);
							this._casDirty.add(relPath);
						}
					}
				}
			} catch (err) {
				this._fileRefreshErrors.push(uri.fsPath);
				this.logService.warn(`[v3code-index] file could not be safely refreshed; preserving its last verified chunks until retry: ${relPath}: ${err instanceof Error ? err.message : err}`);
				if (replacementStarted) this._restoreVerifiedFile(relPath, previousChunks, previousHash);
			}

			const elapsedSec = Math.max(0.001, (Date.now() - startMs) / 1000);
			const filesPerSecond = (i + 1) / elapsedSec;
			const remaining = files.length - (i + 1);
			const etaSeconds = filesPerSecond > 0 ? remaining / filesPerSecond : undefined;

			this.setStatus({
				filesIndexed: i + 1,
				chunksTotal: this.chunks.size,
				currentFile: relPath,
				filesPerSecond,
				etaSeconds,
				bytesProcessed,
				filesSkipped
			});

			// A big file gets its own yield immediately — its chunk/hash work alone
			// can eat a frame, so it must not ride in a 5-file batch.
			if (bigFile || (i > 0 && i % YIELD_EVERY_FILES === 0)) {
				await yieldToUI();
			}
		}

		for (const relPath of [...this.fileToChunks.keys()]) {
			if (!seen.has(relPath)) {
				// Explicit security/config exclusion still wins. Preservation covers
				// only uncertain I/O absence, never a path we now know must be denied.
				if (this._shouldIndexPath(relPath) && coveredByFailedWalk(relPath, this._walkErrorPrefixes)) continue;
				mutated = true;
				this._removeFileChunks(relPath);
				this.fileHashes.delete(relPath);
			}
		}
		for (const relPath of [...this.fileHashes.keys()]) {
			if (!this.fileToChunks.has(relPath)) this.fileHashes.delete(relPath);
		}

		if (casHits > 0) {
			this.logService.info(`[v3code-index] cas: restored ${casHits} changed files from the content-addressed cache (no re-chunk/re-embed)`);
			this._cas.touch(casTouched, Date.now()).catch(() => { });
		}

		// This walk re-chunked every file — either because the caller reset the
		// index, or because _healChunkerCapability cleared the hash map — so the
		// chunks now on disk were all produced by the live chunker. Record that
		// BEFORE the save below, and only here: an ordinary reconcile skips
		// unchanged files and has no right to claim their capability.
		if (fullReset || this._pendingChunkerPromotion) {
			await this._promoteChunkerCapability();
		}
		if (workspaceKey !== this._sessionKey) return;

		const staleSources = this._walkErrors.length + this._fileRefreshErrors.length;
		this._indexedWorkspaceKey = workspaceKey;
		this.setStatus({
			state: 'ready',
			currentFile: undefined,
			filesPerSecond: undefined,
			etaSeconds: undefined,
			lastIndexedAt: Date.now(),
			filesIndexed: this.fileToChunks.size,
			filesTotal: Math.max(files.length, this.fileToChunks.size),
			documentationFiles: this._documentationFileCount(),
			staleSources: staleSources || undefined,
			lastError: staleSources ? `${staleSources} source${staleSources === 1 ? '' : 's'} could not be refreshed; verified cached content was preserved and retry is scheduled.` : undefined,
		}, true);
		if (staleSources) this._scheduleHealthRetry();
		else this._clearHealthRetry();

		// A full-reset rebuild left the graph dirty — rebuild it here with yields
		// so neither the first retrieve nor the backfill's centrality pass pays
		// the O(all chunks) build synchronously. (Reconcile keeps the graph clean
		// incrementally, so this is a no-op there.)
		await this._graph.warmUp(this.chunks.values(), yieldToUI);
		if (workspaceKey !== this._sessionKey) return;

		// Embeddings are decoupled from the walk: persist the structural + lexical
		// index immediately (fast, search-ready), then backfill vectors in a paced
		// background phase. Blocking each file on an embed IPC call was the cause of
		// the ~5 files/s walk and the main-process CPU burst that starved the
		// extension-host language servers.
		if (mutated) await this._saveAll(workspaceKey);
		if (this._embeddingsAvailable) await this._backfillEmbeddings();
	}

	// -- IndexedDB persistence (paged, dynamic-quant int8 vectors) --

	private _indexedDB(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(IDB_NAME, IDB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
				if (!db.objectStoreNames.contains(IDB_CAS_STORE)) db.createObjectStore(IDB_CAS_STORE);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	private _txGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
		return new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, 'readonly');
			const req = tx.objectStore(IDB_STORE).get(key);
			req.onsuccess = () => resolve(req.result as T | undefined);
			req.onerror = () => reject(req.error);
		});
	}

	private _txDone(tx: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	}

	private _toPersisted(c: IndexedChunk): PersistedChunk {
		return {
			id: c.id, file: c.file, startLine: c.startLine, endLine: c.endLine,
			kind: c.kind, name: c.name, language: c.language, contentHash: c.contentHash,
			parentId: c.parentId, scored: c.scored, defines: c.defines, refs: c.refs,
			lspDefines: c.lspDefines, lspRefs: c.lspRefs,
			content: c.content ? c.content : undefined,
			tokens: c.scored ? tokenStringsOf(c.tokens) : undefined,
			vec: c.embedding ?? null,
			vecScale: c.vecScale,
			prevVec: c.prevEmbedding ?? undefined,
			prevVecScale: c.prevVecScale,
		};
	}

	private _buildManifest(): PersistedManifest {
		return {
			version: PERSIST_VERSION,
			pathScheme: workspaceIndexPathScheme(this.workspace.getWorkspace().folders),
			// Effective identity (model + embed-text scheme) — the manifest keys
			// VECTOR validity, so it must change when the embed text scheme does.
			// Only the LIVE id may be salted: in a lexical-only session (_modelId
			// empty) the persisted id is written back verbatim — salting a raw
			// pre-header id here would launder headerless vectors into the new
			// identity and permanently defeat the backfill reset.
			modelId: this._modelId ? effectiveEmbedIdentity(this._modelId) : this._persistedModelId,
			embeddingDim: this._modelDim || this._persistedDim || 0,
			numPages: NUM_PAGES,
			filesIndexed: this.fileToChunks.size,
			chunksTotal: this.chunks.size,
			lastIndexedAt: this._status.lastIndexedAt,
			fileHashes: [...this.fileHashes.entries()],
			fileToChunks: [...this.fileToChunks.entries()].map(([k, v]) => [k, [...v]] as [string, string[]]),
			prevModelId: this._prevSpaceModelId ?? undefined,
			// Same discipline as modelId: only a value a completed walk earned is
			// written. Until then the loaded value is echoed back verbatim.
			chunker: this._persistedChunker,
		};
	}

	/** Serialize save operations: page writes yield to the UI internally now, so
	 *  two concurrent saves could otherwise interleave stale buckets over fresh
	 *  ones. Every save (and its CAS sync) runs strictly after the previous one. */
	private _enqueueSave(fn: () => Promise<void>): Promise<void> {
		const run = this._saveChain.then(async () => {
			this._saveInFlight = true;
			try { await fn(); } finally { this._saveInFlight = false; }
		});
		this._saveChain = run.then(() => undefined, () => undefined);
		return run;
	}

	/**
	 * Write the given pages (null means every page) in SMALL per-page transactions
	 * with UI yields between serialization slices and between writes — the old
	 * single-transaction save structured-cloned the whole ~300k-chunk index in
	 * one renderer task (a multi-second stall every SAVE_EVERY_MS during a slow
	 * backfill). Pages not listed are skipped entirely.
	 *
	 * Per-page transactions give up all-or-nothing atomicity: a crash mid-save
	 * can leave new pages beside an old manifest (the manifest is written LAST,
	 * in its own transaction). _loadAll self-heals such torn snapshots by
	 * dropping files whose chunks are missing and orphaned chunks, which the
	 * startup reconcile then re-indexes.
	 */
	private async _writePages(pages: ReadonlySet<number> | null, writeManifest: boolean, workspaceKey: string): Promise<void> {
		const workspaceStillCurrent = () => this._sessionKey === workspaceKey && canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey);
		if (!workspaceStillCurrent()) return;
		const buckets = new Map<number, PersistedChunk[]>();
		if (pages) { for (const p of pages) buckets.set(p, []); }
		else { for (let i = 0; i < NUM_PAGES; i++) buckets.set(i, []); }
		let sinceYield = 0;
		for (const c of this.chunks.values()) {
			if (!workspaceStillCurrent()) return;
			const bucket = buckets.get(pageIndexForFile(c.file));
			if (!bucket) continue;
			bucket.push(this._toPersisted(c));
			if (++sinceYield >= SAVE_SERIALIZE_SLICE) {
				sinceYield = 0;
				await yieldToUI();
			}
		}
		const db = await this._indexedDB();
		try {
			for (const [p, arr] of buckets) {
				if (!workspaceStillCurrent()) return;
				const tx = db.transaction(IDB_STORE, 'readwrite');
				const store = tx.objectStore(IDB_STORE);
				if (arr.length) store.put({ chunks: arr } as PersistedPage, this._pageKeyFor(workspaceKey, p));
				else store.delete(this._pageKeyFor(workspaceKey, p));
				await this._txDone(tx);
				await yieldToUI(); // paint between pages — put()'s structured clone is sync
			}
			if (writeManifest) {
				if (!workspaceStillCurrent()) return;
				// The manifest alone serializes fileHashes + fileToChunks (O(files +
				// chunk ids)) — give it its own task and transaction.
				await yieldToUI();
				const tx = db.transaction(IDB_STORE, 'readwrite');
				tx.objectStore(IDB_STORE).put(this._buildManifest(), this._manifestKeyFor(workspaceKey));
				await this._txDone(tx);
			}
		} finally {
			db.close();
		}
	}

	private async _saveAll(workspaceKey: string | null = this._indexedWorkspaceKey): Promise<void> {
		if (!workspaceKey) return;
		return this._enqueueSave(async () => {
			if (this._sessionKey !== workspaceKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
			const t0 = Date.now();
			try {
				await this._writePages(null, true, workspaceKey);
				if (this._sessionKey !== workspaceKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
				this._dirtyPages.clear();
				this.logService.trace(`[v3code-index] full save (${NUM_PAGES} pages) in ${Date.now() - t0}ms`);
			} catch (e: any) {
				// IndexedDB can fail (private browsing, disk full, QUOTA) — non-fatal
				// for this session, but NEVER silent: a swallowed quota failure means
				// the index silently rebuilds from scratch every restart (audit #4).
				this.logService.warn(`[v3code-index] FULL SAVE FAILED — index will not survive restart: ${e?.message ?? e}`);
				this.setStatus({ lastError: `index save failed: ${e?.message ?? e}` }, true);
			}
			await this._syncCas(/*fullSave*/ true, workspaceKey);
		});
	}

	/**
	 * Persist only the given pages. `manifest: false` is for saves that change
	 * chunk FIELDS but no manifest-tracked state (the LSP enricher's per-file
	 * edge writes): it skips the O(files + chunk ids) manifest serialization on
	 * that interactive-adjacent path.
	 */
	private async _savePages(dirtyPages: Set<number>, opts?: { manifest?: boolean }, workspaceKey: string | null = this._indexedWorkspaceKey): Promise<void> {
		if (!workspaceKey) return;
		return this._enqueueSave(async () => {
			if (this._sessionKey !== workspaceKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
			if (dirtyPages.size > 0) {
				const t0 = Date.now();
				try {
					await this._writePages(dirtyPages, opts?.manifest !== false, workspaceKey);
					this.logService.trace(`[v3code-index] incremental save (${dirtyPages.size} pages) in ${Date.now() - t0}ms`);
				} catch (e: any) {
					this.logService.warn(`[v3code-index] incremental save failed (${dirtyPages.size} pages): ${e?.message ?? e}`);
				}
			}
			if (this._sessionKey !== workspaceKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
			await this._syncCas(/*fullSave*/ false, workspaceKey);
		});
	}

	private _hydrate(rec: PersistedChunk): IndexedChunk {
		const content = rec.content ?? '';
		let tokens: Uint32Array;
		if (rec.tokens) tokens = internTokens(rec.tokens);
		else if (rec.scored && content) tokens = internTokens(tokenize(`${rec.name}\n${content}`));
		else tokens = EMPTY_TOKENS;

		const embedding = normalizeVec(rec.vec);
		const vecScale = embedding ? (typeof rec.vecScale === 'number' ? rec.vecScale : 1) : undefined;
		const prevEmbedding = normalizeVec(rec.prevVec);
		const prevVecScale = prevEmbedding ? (typeof rec.prevVecScale === 'number' ? rec.prevVecScale : 1) : undefined;

		return {
			id: rec.id, file: rec.file, startLine: rec.startLine, endLine: rec.endLine,
			kind: rec.kind, name: rec.name, language: rec.language, contentHash: rec.contentHash,
			content, tokens, scored: !!rec.scored, parentId: rec.parentId,
			defines: rec.defines, refs: rec.refs,
			lspDefines: rec.lspDefines, lspRefs: rec.lspRefs,
			embedding, vecScale,
			prevEmbedding, prevVecScale,
		};
	}

	private async _loadAll(): Promise<boolean> {
		const workspaceKey = this._sessionKey;
		try {
			const db = await this._indexedDB();
			const manifest = await this._txGet<PersistedManifest>(db, this._manifestKeyFor(workspaceKey));
			const folders = this.workspace.getWorkspace().folders;
			const pathSchemeCompatible = isWorkspaceIndexPathSchemeCompatible(folders, manifest?.pathScheme);
			if (manifest && !pathSchemeCompatible) {
				this.logService.info('[v3code-index] persisted multi-root path identity is obsolete; rebuilding collision-free keys');
				db.close();
				return false;
			}
			if (manifest && manifest.version === PERSIST_VERSION && Array.isArray(manifest.fileToChunks)) {
				this.chunks.clear();
				this.fileToChunks.clear();
				this.fileHashes.clear();

				const numPages = manifest.numPages || NUM_PAGES;
				for (let i = 0; i < numPages; i++) {
					const page = await this._txGet<PersistedPage>(db, this._pageKeyFor(workspaceKey, i));
					if (page && Array.isArray(page.chunks)) {
						for (const rec of page.chunks) this.chunks.set(rec.id, this._hydrate(rec));
					}
					if (i > 0 && i % 16 === 0) {
						await yieldToUI();
					}
				}
				for (const [k, v] of manifest.fileHashes ?? []) this.fileHashes.set(k, v);
				for (const [k, v] of manifest.fileToChunks) this.fileToChunks.set(k, new Set(v));

				// Self-heal torn snapshots (saves are per-page transactions, not
				// atomic): a file whose chunks are missing is dropped so the startup
				// reconcile re-indexes it, and chunks no file references are purged
				// so stale content can't surface in retrieval.
				const referenced = new Set<string>();
				let torn = 0;
				for (const [file, ids] of [...this.fileToChunks]) {
					let ok = true;
					for (const id of ids) { if (!this.chunks.has(id)) { ok = false; break; } }
					if (!ok) {
						this.fileToChunks.delete(file);
						this.fileHashes.delete(file);
						torn++;
						continue;
					}
					for (const id of ids) referenced.add(id);
				}
				if (referenced.size !== this.chunks.size) {
					for (const id of [...this.chunks.keys()]) {
						if (!referenced.has(id)) this.chunks.delete(id);
					}
				}
				if (torn > 0) this.logService.info(`[v3code-index] dropped ${torn} torn-save files from cache — reconcile will re-index them`);

				if (workspaceKey !== this._sessionKey) {
					this.chunks.clear();
					this.fileToChunks.clear();
					this.fileHashes.clear();
					db.close();
					return false;
				}

				this._persistedDim = manifest.embeddingDim || 0;
				// Strip any display decoration so the label can't accumulate " (cached)".
				this._persistedModelId = (manifest.modelId || '').replace(/\s*\((?:cached|hybrid-ipc)\)/g, '').trim();
				// Resume dual-space retrieval when a model-swap backfill was cut short.
				this._prevSpaceModelId = manifest.prevModelId || null;
				this._persistedChunker = readChunkerCapability(manifest.chunker);
				this._graph.markDirty();
				this._indexedWorkspaceKey = workspaceKey;
				this.setStatus({
					state: 'ready',
					filesIndexed: manifest.filesIndexed ?? this.fileToChunks.size,
					chunksTotal: manifest.chunksTotal ?? this.chunks.size,
					lastIndexedAt: manifest.lastIndexedAt,
					embeddingDim: this._persistedDim || undefined,
				}, true);
				db.close();
				return true;
			}

			// An unversioned multi-root snapshot cannot prove which root owned a
			// folder-relative key, so never migrate it into the collision-free scheme.
			const legacy = folders.length <= 1 ? await this._txGet<unknown>(db, workspaceKey) : undefined;
			db.close();
			if (workspaceKey !== this._sessionKey) return false;
			if (legacy !== undefined && legacy !== null) {
				const loaded = this._loadLegacy(legacy);
				if (loaded) this._indexedWorkspaceKey = workspaceKey;
				return loaded;
			}
			return false;
		} catch {
			return false;
		}
	}

	private _loadLegacy(raw: unknown): boolean {
		try {
			let data: any;
			if (typeof raw === 'string') data = JSON.parse(raw);
			else data = raw;
			if (!data || !Array.isArray(data.chunks)) return false;
			this.chunks.clear();
			this.fileToChunks.clear();
			this.fileHashes.clear();
			if (Array.isArray(data.fileHashes)) {
				for (const [k, v] of data.fileHashes) this.fileHashes.set(k, v);
			}
			for (const entry of data.chunks) {
				const content: string = entry.content || '';
				this.chunks.set(entry.id, {
					id: entry.id, file: entry.file, startLine: entry.startLine,
					endLine: entry.endLine, kind: entry.kind, name: entry.name,
					language: entry.language, contentHash: entry.contentHash,
					content, tokens: internTokens(tokenize(`${entry.name ?? ''}\n${content}`)),
					scored: true, embedding: undefined,
				});
			}
			if (Array.isArray(data.fileToChunks)) {
				for (const [k, v] of data.fileToChunks) this.fileToChunks.set(k, new Set(v));
			}
			this._graph.markDirty();
			this.setStatus({
				state: 'ready',
				filesIndexed: data.filesIndexed ?? this.fileToChunks.size,
				chunksTotal: data.chunksTotal ?? this.chunks.size,
				lastIndexedAt: data.lastIndexedAt,
			}, true);
			this.logService.info('[v3code-index] migrated legacy cache (text only); vectors + graph will backfill');
			return true;
		} catch {
			return false;
		}
	}

	// -- gitignore + walk --

	private async _loadGitignore(dirUri: URI): Promise<GitignoreLayer | null> {
		const cacheKey = dirUri.path;
		if (this.gitignoreCache.has(cacheKey)) return this.gitignoreCache.get(cacheKey)!;
		try {
			const gitignoreUri = URI.joinPath(dirUri, '.gitignore');
			const content = await this.fileService.readFile(gitignoreUri);
			const text = content.value.toString();
			const rules: GitignoreRule[] = [];
			for (const line of text.split(/\r?\n/)) {
				const rule = compileGitignorePattern(line);
				if (rule) rules.push(rule);
			}
			const layer: GitignoreLayer | null = rules.length ? { dir: dirUri.path, rules } : null;
			this.gitignoreCache.set(cacheKey, layer);
			return layer;
		} catch {
			this.gitignoreCache.set(cacheKey, null);
			return null;
		}
	}

	/**
	 * Bounded-parallel BFS walk. Up to `concurrency` directories are resolved at
	 * once (each `fileService.resolve` is one IPC round-trip), which collapses the
	 * cold-enumeration time on large trees from one-RTT-per-dir-sequentially to
	 * roughly total-dirs / concurrency. A work-queue + semaphore caps in-flight
	 * resolves regardless of tree shape (a giant node_modules can't fan out).
	 * Gitignore layers inherit down the tree exactly as the recursive walk did.
	 */
	private async walkParallel(roots: URI[], skipDirs: Set<string>, concurrency: number): Promise<URI[]> {
		const out: URI[] = [];
		this._walkErrors = [];
		this._walkErrorPrefixes = [];
		this._fileRefreshErrors = [];
		const queue: { uri: URI; layers: GitignoreLayer[] }[] = roots.map(uri => ({ uri, layers: [] as GitignoreLayer[] }));
		const limit = Math.max(1, Math.min(8, concurrency || 4));
		let active = 0;
		await new Promise<void>((resolve) => {
			const pump = () => {
				if (queue.length === 0 && active === 0) { resolve(); return; }
				while (active < limit && queue.length > 0) {
					const task = queue.shift()!;
					active++;
					this._walkDir(task.uri, task.layers, out, skipDirs, queue)
						.catch(() => { /* per-dir failure is non-fatal */ })
						.finally(() => { active--; pump(); });
				}
			};
			pump();
		});
		if (this._walkErrors.length > 0) {
			// Loud on purpose: a silently-pruned subtree makes every later "no matches" a lie.
			this.logService.warn(`[v3code-index] ${this._walkErrors.length} director(ies) could not be read and are NOT in the index: ${this._walkErrors.slice(0, 10).join(', ')}${this._walkErrors.length > 10 ? ', ...' : ''}`);
		}
		return out;
	}

	/** Directories the last walk could not read. Their last verified chunks stay searchable. */
	private _walkErrors: string[] = [];
	/** Same failures mapped into workspace-relative index-key prefixes. */
	private _walkErrorPrefixes: string[] = [];
	/** Individual files listed by the walk but not safely refreshed. */
	private _fileRefreshErrors: string[] = [];

	private async _walkDir(dirUri: URI, parentLayers: GitignoreLayer[], out: URI[], skipDirs: Set<string>, queue: { uri: URI; layers: GitignoreLayer[] }[]): Promise<void> {
		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(dirUri, { resolveMetadata: false });
		} catch (e) {
			// Swallowing this dropped the ENTIRE subtree from the index with no trace. Worse, the
			// count from this walk becomes filesTotal, so numerator and denominator shrank together
			// and index_health looked perfectly consistent while being wrong. semantic_search over
			// the missing directory then returned a confident "no matches", and because the walk
			// runs up to 8 directories concurrently, a transient EMFILE is a realistic trigger --
			// which means it recurs on every rebuild, not once.
			this._walkErrors.push(dirUri.fsPath);
			const prefix = workspaceIndexPath(this.workspace.getWorkspace().folders, dirUri);
			if (prefix !== undefined) this._walkErrorPrefixes.push(prefix);
			this.logService.warn(`[v3code-index] could not refresh ${dirUri.fsPath}; last verified chunks are preserved when available: ${e instanceof Error ? e.message : e}`);
			return;
		}
		if (!stat.isDirectory) return;

		let layers = parentLayers;
		const layer = await this._loadGitignore(dirUri);
		if (layer) layers = [...parentLayers, layer];

		for (const child of stat.children ?? []) {
			const name = this.basename(child.resource);
			if (child.isDirectory) {
				const lname = name.toLowerCase();
				if (skipDirs.has(lname)) continue;
				// Security denylist beats everything below (incl. the dot-dir
				// gitignore-negation carve-out, which could otherwise walk .aws/).
				if (isSecurityIgnoredDirName(lname)) continue;
				if (child.isSymbolicLink) continue; // avoid symlink loops in monorepos
				if (name.startsWith('.') && name !== '.gitignore') {
					if (layers.length > 0 && !isIgnoredByLayer(name + '/', true, layers)) {
						queue.push({ uri: child.resource, layers });
					}
					continue;
				}
				if (layers.length > 0 && isIgnoredByLayer(name + '/', true, layers)) continue;
				queue.push({ uri: child.resource, layers });
			} else {
				if (layers.length > 0 && isIgnoredByLayer(name, false, layers)) continue;
				if (this._shouldIndexPath(this.relativePath(child.resource))) out.push(child.resource);
			}
		}
	}

	/** SKIP_DIRS + user excludes (lowercased), memoized on the raw config value —
	 *  ONE source of truth for both the walk's directory pruning and the per-path
	 *  check below. */
	private _skipDirsCache: { key: string; set: Set<string> } | null = null;
	private _allSkipDirs(): Set<string> {
		const excludes = this._readConfig().excludes;
		const key = excludes.join('\n');
		if (!this._skipDirsCache || this._skipDirsCache.key !== key) {
			this._skipDirsCache = { key, set: new Set([...SKIP_DIRS, ...excludes.map(s => s.toLowerCase())]) };
		}
		return this._skipDirsCache.set;
	}

	private _shouldIndexPath(relPath: string): boolean {
		// Hard security denylist first — checked on the full relative path so it
		// also covers incremental updates, which never pass through the walk's
		// directory skipping.
		if (isSecurityConcernPath(relPath)) return false;
		// Directory skipping for paths that arrive OUTSIDE the walk (incremental
		// watcher events carry full paths): without this, every compile burst
		// used to inject thousands of out/**.js duplicates into the persisted
		// index, crowding top-K until the next full rebuild. Gitignore layers
		// still apply only to the walk (they need the directory stack).
		const segs = relPath.split('/');
		const skipDirs = this._allSkipDirs();
		for (let i = 0; i < segs.length - 1; i++) {
			const seg = segs[i].toLowerCase();
			if (skipDirs.has(seg) || isSecurityIgnoredDirName(seg)) return false;
		}
		const name = segs[segs.length - 1] || relPath;
		if (name.startsWith('.') && !INDEXABLE_DOTFILES.has(name)) return false;
		const dot = name.lastIndexOf('.');
		const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
		if (BINARY_EXTS.has(ext)) return false;
		return true;
	}

	private basename(uri: URI): string {
		const p = uri.path;
		const i = p.lastIndexOf('/');
		return i >= 0 ? p.slice(i + 1) : p;
	}

	private relativePath(uri: URI): string {
		return workspaceIndexPath(this.workspace.getWorkspace().folders, uri) ?? uri.path;
	}

	private async readText(uri: URI, maxBytes = MAX_FILE_BYTES): Promise<string | null> {
		// Callers distinguish an intentional skip (oversize/binary => null) from
		// an I/O failure (throw). Conflating them used to delete verified cached
		// chunks whenever Windows file sharing or a network mount blinked.
		const content = await this.fileService.readFile(uri);
		if (content.size > maxBytes) return null;
		const text = content.value.toString();
		if (text.slice(0, 4096).indexOf('\u0000') !== -1) return null;
		return text;
	}

	// -- Tree-sitter host wiring (browser-safe via @vscode/tree-sitter-wasm) --

	private _tsModuleLocation(): AppResourcePath {
		const base = (canASAR && this.environmentService.isBuilt) ? nodeModulesAsarUnpackedPath : nodeModulesPath;
		return `${base}/@vscode/tree-sitter-wasm/wasm`;
	}

	private _createChunkerHost(): ChunkerHost {
		return {
			loadRuntime: async () => {
				const mod = await importAMDNodeModule<typeof import('@vscode/tree-sitter-wasm')>('@vscode/tree-sitter-wasm', 'wasm/tree-sitter.js');
				const location = this._tsModuleLocation();
				await mod.Parser.init({
					locateFile: (file: string) => FileAccess.asBrowserUri(`${location}/${file}` as AppResourcePath).toString(true),
				});
				this.logService.info('[v3code-index] tree-sitter runtime ready — structural parent/child chunking enabled');
				return { Parser: mod.Parser, Language: mod.Language };
			},
			readGrammarBytes: async (grammarName: string) => {
				const wasmPath = `${this._tsModuleLocation()}/${grammarName}.wasm` as AppResourcePath;
				const file = await this.fileService.readFile(FileAccess.asFileUri(wasmPath));
				return file.value.buffer;
			},
			grammarExists: async (grammarName: string) => {
				const wasmPath = `${this._tsModuleLocation()}/${grammarName}.wasm` as AppResourcePath;
				return this.fileService.exists(FileAccess.asFileUri(wasmPath));
			},
			log: (message: string) => this.logService.info(message),
		};
	}

	private async chunkFile(relPath: string, content: string, workspaceKey?: string): Promise<void> {
		const dot = relPath.lastIndexOf('.');
		const ext = dot >= 0 ? relPath.slice(dot + 1) : '';
		const language = langFromExt(ext);

		// Structural parent/child extraction first; line-window fallback otherwise.
		// Only changed files reach here (Merkle skip), so tree-sitter parses just
		// deltas — but the parse is synchronous on the renderer, so files beyond
		// STRUCTURAL_PARSE_MAX_CHARS skip straight to the cheap window fallback.
		let units = content.length > STRUCTURAL_PARSE_MAX_CHARS
			? null
			: await this._chunker.extract(relPath, content, language);
		if (workspaceKey && workspaceKey !== this._sessionKey) return;
		if (!units || units.length === 0) units = this._chunker.windowUnits(relPath, content);
		// Bound pathological files (minified / vendored) so one file can't explode the index.
		if (units.length > MAX_CHUNKS_PER_FILE) units = units.slice(0, MAX_CHUNKS_PER_FILE);

		const idByLocal: string[] = [];
		for (const u of units) idByLocal.push(contentHash64(`${relPath}:${u.startLine}:${u.endLine}`));

		const idSet = new Set<string>();
		const newChunks: IndexedChunk[] = [];
		for (let i = 0; i < units.length; i++) {
			const u = units[i];
			const id = idByLocal[i];
			const parentId = u.parentLocalId !== undefined ? idByLocal[u.parentLocalId] : undefined;
			// Every chunk keeps its own text: children need it to (re-)embed during
			// deferred backfill, and display injection resolves child→parent via
			// `parentId` (see hybridRetriever.resolveDisplay), not via empty content.
			// int8 vectors already removed the dominant memory cost; text at ~2x is
			// the accepted price of structural + graph indexing.
			const chunkContent = u.text;
			const contentHash = contentHash64(u.text);

			let tokens: Uint32Array;
			if (u.scored) {
				const parent = u.parentLocalId !== undefined ? units[u.parentLocalId] : undefined;
				const sig = parent ? `${parent.name}\n${firstLine(parent.text)}` : '';
				tokens = internTokens(tokenize(`${sig}\n${u.name}\n${u.text}`));
			} else {
				tokens = EMPTY_TOKENS;
			}

			const chunk: IndexedChunk = {
				id, file: relPath, startLine: u.startLine, endLine: u.endLine,
				kind: u.kind, name: u.name, language, contentHash,
				content: chunkContent, tokens, scored: u.scored, parentId,
				defines: u.defines.length ? u.defines : undefined,
				refs: u.refs.length ? u.refs : undefined,
			};
			this.chunks.set(id, chunk);
			idSet.add(id);
			newChunks.push(chunk);
		}
		this.fileToChunks.set(relPath, idSet);
		this._graph.updateChunks(newChunks);
		// NOTE: embedding is intentionally NOT done here. chunkFile only builds the
		// (fast) structural + lexical index. Vectors are filled by _backfillEmbeddings
		// (full rebuild / model-load) or inline in _doIncrementalUpdate (small edits).

		// Node backend mirror (flag-gated, fire-and-forget): scored chunks land in
		// the main-process SQLite engine too, where they are embedded + FTS-indexed.
		if (this._nodeBackendEnabled()) {
			const scored: IndexedChunk[] = [];
			for (const id of idSet) {
				const c = this.chunks.get(id);
				if (c && c.scored) scored.push(c);
			}
			this._queueNodeMirror(scored);
		}
	}

	// -- Content-addressed cross-branch cache (Continue's two-table design) --

	/**
	 * Current git branch of the first workspace folder, read from .git/HEAD.
	 * Only names the branch TAG record (retention grouping) — content addressing
	 * itself is branch-agnostic, so this failing soft to 'default' is harmless.
	 */
	private async _readGitBranch(workspaceKey: string): Promise<string> {
		if (workspaceKey !== this._sessionKey) return 'default';
		const folders = this.workspace.getWorkspace().folders;
		if (folders.length === 0) return 'default';
		const headUri = URI.joinPath(folders[0].uri, '.git', 'HEAD');
		try {
			const head = await this.fileService.readFile(headUri);
			if (workspaceKey !== this._sessionKey) return 'default';
			const text = head.value.toString().trim();
			const m = text.match(/^ref:\s*refs\/heads\/(.+)$/);
			if (m) return m[1];
			if (/^[0-9a-f]{40}/.test(text)) return 'detached:' + text.slice(0, 12);
		} catch { /* not a git repo */ }
		return 'default';
	}

	/**
	 * Try to restore a file's chunks (and, if the embedder matches, its vectors)
	 * from the content-addressed cache instead of re-chunking + re-embedding.
	 * This is the branch-switch fast path: file flipped to a hash we indexed
	 * before => tree-sitter parse and embed IPC are both skipped entirely.
	 */
	private async _tryHydrateFromCas(relPath: string, contentHash: string, workspaceKey?: string): Promise<boolean> {
		let entry: CasEntry | undefined;
		try {
			entry = await this._cas.get(contentHash);
		} catch {
			return false;
		}
		if (workspaceKey && workspaceKey !== this._sessionKey) return false;
		if (!entry || !Array.isArray(entry.chunks) || entry.chunks.length === 0) return false;

		// The CAS is content-addressed, but chunk BOUNDARIES also depend on which
		// grammars were packaged — so an entry written while a language fell back
		// to line windows would replay those windows straight over a chunker that
		// now has the grammar, silently defeating the re-chunk. Gate the whole
		// hydration (not just the vectors) on the chunker capability; a miss just
		// falls through to chunkFile, which rewrites the entry.
		const chunkerKey = await this._chunkerKey();
		if (workspaceKey && workspaceKey !== this._sessionKey) return false;
		if (chunkerKey && entry.chunker !== chunkerKey) return false;

		// Vector reuse is gated on the EFFECTIVE embedder identity (model id +
		// embed-text scheme, see embedIdentity.ts) — entries written before
		// contextual headers carry the raw model id and mismatch here, so their
		// chunks hydrate but their headerless vectors are dropped for backfill.
		const modelId = effectiveEmbedIdentity(this._modelId || this._persistedModelId);
		const dim = this._modelDim || this._persistedDim;
		const vecsUsable = !!entry.modelId && entry.modelId === modelId && (!dim || entry.dim === dim);

		// Recompute ids for the DESTINATION path — entries are path-independent,
		// so a hit also covers renames / identical files at new locations.
		const ids: string[] = [];
		for (const rc of entry.chunks) ids.push(contentHash64(`${relPath}:${rc.startLine}:${rc.endLine}`));

		const idSet = new Set<string>();
		const newChunks: IndexedChunk[] = [];
		for (let i = 0; i < entry.chunks.length; i++) {
			const rc = entry.chunks[i];
			const content = rc.content ?? '';
			let tokens: Uint32Array;
			if (rc.tokens) tokens = internTokens(rc.tokens);
			else if (rc.scored && content) tokens = internTokens(tokenize(`${rc.name}\n${content}`));
			else tokens = EMPTY_TOKENS;
			const embedding = vecsUsable ? normalizeVec(rc.vec) : undefined;
			const parentId = rc.parentIdx !== undefined ? ids[rc.parentIdx] : undefined;
			const chunk: IndexedChunk = {
				id: ids[i], file: relPath, startLine: rc.startLine, endLine: rc.endLine,
				kind: rc.kind, name: rc.name, language: rc.language, contentHash: rc.contentHash,
				content, tokens, scored: !!rc.scored, parentId,
				defines: rc.defines, refs: rc.refs,
				lspDefines: rc.lspDefines, lspRefs: rc.lspRefs,
				embedding, vecScale: embedding ? (typeof rc.vecScale === 'number' ? rc.vecScale : 1) : undefined,
			};
			this.chunks.set(ids[i], chunk);
			idSet.add(ids[i]);
			newChunks.push(chunk);
		}
		this.fileToChunks.set(relPath, idSet);
		this._graph.updateChunks(newChunks);
		return true;
	}

	/** Serialize dirty files into path-independent CAS entries (one per content
	 *  hash). Batched with UI yields — after a full rebuild every file is dirty,
	 *  and one giant transaction would stall the renderer on structured clones. */
	private async _flushCasEntries(workspaceKey: string): Promise<void> {
		if (workspaceKey !== this._sessionKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
		if (this._casDirty.size === 0) return;
		const rels = [...this._casDirty];
		this._casDirty.clear();
		// WRITE site — salt only the LIVE id (same rule as _buildManifest): a raw
		// persisted id must never be promoted to the salted identity, or headerless
		// vectors still in memory would be tagged as header-scheme vectors and
		// survive the migration reset forever.
		const modelId = (this._modelId ? effectiveEmbedIdentity(this._modelId) : this._persistedModelId) || undefined;
		const dim = this._modelDim || this._persistedDim || undefined;
		// Undefined when the capability probe couldn't answer — an entry that
		// claims nothing is rejected by a later session that CAN answer, which is
		// the safe direction (a re-chunk, never a stale replay).
		const chunker = (await this._chunkerKey()) || undefined;
		if (workspaceKey !== this._sessionKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
		const BATCH = 300;
		for (let i = 0; i < rels.length; i += BATCH) {
			if (workspaceKey !== this._sessionKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
			const pairs: [string, CasEntry][] = [];
			for (const rel of rels.slice(i, i + BATCH)) {
				const hash = this.fileHashes.get(rel);
				const chunkIds = this.fileToChunks.get(rel);
				if (!hash || !chunkIds || chunkIds.size === 0) continue;
				const arr: IndexedChunk[] = [];
				for (const id of chunkIds) {
					const c = this.chunks.get(id);
					if (c) arr.push(c);
				}
				if (arr.length === 0) continue;
				const idxOf = new Map<string, number>();
				arr.forEach((c, j) => idxOf.set(c.id, j));
				let hasVec = false;
				const records: CasChunkRecord[] = arr.map(c => {
					if (c.embedding) hasVec = true;
					return {
						startLine: c.startLine, endLine: c.endLine, kind: c.kind, name: c.name,
						language: c.language, contentHash: c.contentHash, scored: c.scored,
						parentIdx: c.parentId !== undefined ? idxOf.get(c.parentId) : undefined,
						defines: c.defines, refs: c.refs,
						lspDefines: c.lspDefines, lspRefs: c.lspRefs,
						content: c.content ? c.content : undefined,
						tokens: c.scored ? tokenStringsOf(c.tokens) : undefined,
						vec: c.embedding ?? null,
						vecScale: c.vecScale,
					};
				});
				pairs.push([hash, { chunks: records, modelId: hasVec ? modelId : undefined, dim: hasVec ? dim : undefined, chunker }]);
			}
			if (pairs.length) await this._cas.putEntries(pairs, Date.now());
			if (workspaceKey !== this._sessionKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
			if (i + BATCH < rels.length) await yieldToUI();
		}
	}

	/**
	 * Post-save CAS maintenance: flush dirty entries; on FULL saves also refresh
	 * this branch's tag record and (throttled) LRU-GC the store. Never fatal —
	 * the CAS is a cache; the paged store remains the source of truth.
	 */
	private async _syncCas(fullSave: boolean, workspaceKey: string): Promise<void> {
		try {
			if (workspaceKey !== this._sessionKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
			await this._flushCasEntries(workspaceKey);
			if (workspaceKey !== this._sessionKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
			if (!fullSave) return;
			const now = Date.now();
			const branch = await this._readGitBranch(workspaceKey);
			if (workspaceKey !== this._sessionKey || !canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey)) return;
			await this._cas.writeBranchTag(workspaceKey, branch, [...this.fileHashes.values()], now);
			if (now - this._lastCasGcAt >= CAS_GC_INTERVAL_MS) {
				this._lastCasGcAt = now;
				const deleted = await this._cas.gc({
					maxEntries: Math.max(CAS_MIN_ENTRIES, this.fileHashes.size * 2),
					protect: new Set(this.fileHashes.values()),
					now,
				});
				if (deleted > 0) this.logService.info(`[v3code-index] cas: evicted ${deleted} LRU entries`);
			}
		} catch {
			// cache maintenance must never break indexing
		}
	}

	// -- Embeddings (IPC -> MiniLM, dynamic int8 quant) --

	private async _tryLoadEmbeddings(): Promise<void> {
		if (this._embeddingsLoading || this._embeddingsAvailable) { return; }
		this._embeddingsLoading = true;

		const MAX_TRIES = 3;
		for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
			try {
				// Pass the user's engine choice through — this call used to send no
				// options, which made the embedModel setting silently dead (the main
				// process fell back to defaults forever).
				const modelHint = this.configService.getValue<string>(`${CONFIG_PREFIX}.embedModel`) || 'auto';
				const mirrorHost = this.configService.getValue<string>(`${CONFIG_PREFIX}.modelDownloadHost`) || undefined;
				await this.embedService.init({ modelHint, mirrorHost });
				const info = await this.embedService.getModelInfo();
				if (info.isReady) {
					const previousModelId = this._modelId;
					this._embeddingsAvailable = true;
					this._modelDim = info.dim;
					this._modelId = info.modelId;
					// Engine swap: vectors from another model are meaningless even at
					// equal dim. When the OLD model is the potion static space we KEEP
					// the vectors as `prevEmbedding` (dual-space retrieval — search
					// quality doesn't cliff for the whole backfill); anything else is
					// dropped as before. Backfill re-embeds with the new model either way.
					if (previousModelId && previousModelId !== info.modelId) {
						const keepAsPrev = isStaticCodeModel(previousModelId);
						for (const c of this.chunks.values()) {
							if (!c.embedding) continue;
							if (keepAsPrev) {
								c.prevEmbedding = c.embedding;
								c.prevVecScale = c.vecScale;
							}
							c.embedding = undefined; c.vecScale = undefined;
							this._dirtyPages.add(pageIndexForFile(c.file));
						}
						if (keepAsPrev) this._prevSpaceModelId = effectiveEmbedIdentity(previousModelId);
					}
					this.setStatus({ modelId: `${info.modelId} (hybrid-ipc)`, embeddingDim: info.dim, lastError: undefined }, true);
					this.logService.info(`[v3code-index] embeddings model loaded via IPC (${info.modelId}, dim=${info.dim})`);
					// The user explicitly chose the Qwen3 engine but something else is
					// live: the main process either refused it (RAM gate) or its load
					// failed and silently fell back to the static embedder. Both used
					// to be invisible — the UI showed the fallback as if chosen. Say so.
					if (modelHint === 'qwen3-embed' && !info.modelId.startsWith('Qwen/')) {
						this.setStatus({ lastError: `Qwen3 embeddings were requested but ${info.modelId} is active — the engine was refused (needs ~16GB RAM) or failed to load (see the main process log). Run "V3Code: Rebuild Codebase Index" to retry.` }, true);
						this.logService.warn(`[v3code-index] embedModel=qwen3-embed requested but the live model is ${info.modelId}`);
					}
					this._embeddingsLoading = false;
					this._maybeBackfillEmbeddings();
					return;
				}
				this._embeddingsAvailable = false;
				this.logService.info('[v3code-index] embeddings IPC init returned not-ready, using lexical-only mode');
				break;
			} catch (err: any) {
				const msg = err?.message ?? String(err);
				if (attempt < MAX_TRIES - 1) {
					const delay = Math.pow(2, attempt) * 1000;
					this.logService.warn(`[v3code-index] embeddings attempt ${attempt + 1}/${MAX_TRIES} failed, retrying in ${delay}ms: ${msg}`);
					await new Promise(resolve => setTimeout(resolve, delay));
				} else {
					this._embeddingsAvailable = false;
					this.setStatus({
						modelId: 'lexical-only',
						lastError: `Embeddings unavailable (retried ${MAX_TRIES}x): ${msg}`
					}, true);
					this.logService.warn(`[v3code-index] embeddings unavailable after ${MAX_TRIES} attempts: ${msg}`);
					this.logService.info('[v3code-index] semantic index running in lexical-only mode. To retry embeddings: run "V3Code: Rebuild Codebase Index"');
				}
			}
		}
		this._embeddingsLoading = false;
	}

	/** Embed a batch and dynamic-range quantize to int8. */
	private async _computeEmbeddings(texts: string[]): Promise<(QuantizedVector | null)[]> {
		if (!this._embeddingsAvailable || texts.length === 0) return texts.map(() => null);
		try {
			const capped = texts.map(t => t.length > EMBED_MAX_CHARS ? t.slice(0, EMBED_MAX_CHARS) : t);
			const results = await this.embedService.embed(capped);
			return texts.map((_, i) => results[i] ? quantizeDynamic(results[i]) : null);
		} catch {
			return texts.map(() => null);
		}
	}

	private async _computeQueryEmbedding(text: string): Promise<Float32Array | null> {
		if (!this._embeddingsAvailable) return null;
		try {
			const capped = text.length > EMBED_MAX_CHARS ? text.slice(0, EMBED_MAX_CHARS) : text;
			const results = await this.embedService.embed([capped], 'query');
			return results[0] ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Query embedded in the PREVIOUS model's space (potion static) — only while a
	 * model-swap backfill is incomplete. Failure just drops the dual-space
	 * channel for this query; retrieval proceeds on lexical + new-space vectors.
	 */
	private async _computePrevQueryEmbedding(text: string): Promise<Float32Array | null> {
		if (!this._prevSpaceModelId) return null;
		try {
			const capped = text.length > EMBED_MAX_CHARS ? text.slice(0, EMBED_MAX_CHARS) : text;
			const results = await this.embedService.embedStatic([capped], this._prevSpaceModelId);
			return results[0] ?? null;
		} catch {
			return null;
		}
	}

	private _maybeBackfillEmbeddings(): void {
		if (!this._embeddingsAvailable) return;
		if (this.rebuildInFlight) return; // a rebuild runs its own backfill at the end
		if (!canServeSemanticWorkspace(this._indexedWorkspaceKey, this._sessionKey)) return;
		void this._backfillEmbeddings();
	}

	/**
	 * Fast first-pass for a slow-model backfill: embed every vectorless chunk in
	 * the potion static space (hundreds of chunks/s on CPU) into `prevEmbedding`,
	 * so dual-space retrieval covers the WHOLE corpus within minutes. The slow
	 * model then overwrites chunk-by-chunk with real vectors for hours behind it.
	 * Best-effort: any failure leaves chunks bare and the slow pass proceeds.
	 */
	private async _potionPrepass(bare: IndexedChunk[], epoch: number): Promise<void> {
		try {
			const total = bare.length;
			this.logService.info(`[v3code-index] potion first-pass: ${total} chunks get interim vectors while the slow model backfills`);
			// Open the prev-space channel NOW: chunks become dual-space searchable
			// as their interim vector lands, not only when the pass completes.
			this._prevSpaceModelId = effectiveEmbedIdentity(STATIC_CODE_REPO);
			let done = 0;
			const startMs = Date.now();
			for (let i = 0; i < total; i += EMBED_BATCH) {
				if (epoch !== this._backfillEpoch) return;
				const slice = bare.slice(i, i + EMBED_BATCH);
				const texts: string[] = [];
				for (let j = 0; j < slice.length; j++) {
					const t = embedTextFor(slice[j], this.chunks);
					texts.push(t.length > EMBED_MAX_CHARS ? t.slice(0, EMBED_MAX_CHARS) : t);
					// Header building walks parents — for a 512-chunk batch that is
					// enough synchronous work to blow a frame; break it up.
					if ((j & 127) === 127) await yieldToUI();
				}
				const vecs = await this.embedService.embedStatic(texts, STATIC_CODE_REPO);
				if (epoch !== this._backfillEpoch) return;
				for (let j = 0; j < slice.length; j++) {
					const v = vecs[j];
					if (v && v.length > 0) {
						const q = quantizeDynamic(v);
						slice[j].prevEmbedding = q.q;
						slice[j].prevVecScale = q.scale;
						this._dirtyPages.add(pageIndexForFile(slice[j].file));
					}
				}
				done += slice.length;
				const elapsedSec = Math.max(0.001, (Date.now() - startMs) / 1000);
				const rate = done / elapsedSec;
				this.setStatus({
					state: 'embedding',
					embeddedChunks: done,
					chunksToEmbed: total,
					chunksTotal: this.chunks.size,
					currentFile: 'fast first-pass (potion)…',
					filesPerSecond: rate,
					etaSeconds: rate > 0 ? (total - done) / rate : undefined,
				});
				await yieldToUI();
			}
			// Persist so the interim vectors survive a restart (the manifest
			// records prevModelId, the pages carry prevVec). Only pages that
			// actually gained vectors are written.
			const toSave = this._dirtyPages;
			this._dirtyPages = new Set();
			if (epoch !== this._backfillEpoch) return;
			await this._savePages(toSave);
			this.logService.info(`[v3code-index] potion first-pass done (${done}/${total}) — dual-space retrieval active`);
		} catch (err: any) {
			this.logService.warn(`[v3code-index] potion first-pass failed (slow backfill continues): ${err?.message ?? err}`);
		}
	}

	/**
	 * Compute vectors for every scored chunk that lacks one (or whose dimension no
	 * longer matches the model). Runs as a paced background phase with a visible
	 * 'embedding' status so a big first index stays responsive.
	 */
	/** Bumped by every rebuild: a backfill captured its chunk list from a corpus
	 *  that no longer exists and must stop (it was embedding detached chunks over
	 *  the GPU for hours, and the fresh corpus never got a backfill — audit #2). */
	private _backfillEpoch = 0;
	private async _backfillEmbeddings(): Promise<void> {
		if (this._backfillInFlight) return this._backfillInFlight;
		if (!canServeSemanticWorkspace(this._indexedWorkspaceKey, this._sessionKey)) return;
		const epoch = this._backfillEpoch;
		this._backfillInFlight = (async () => {
			const pending: IndexedChunk[] = [];
			// Persisted vectors are stale when the EFFECTIVE embedder identity moved —
			// either a different model, or the same model with a different embed-text
			// scheme (contextual headers, embedIdentity.ts). Old manifests carry the
			// raw model id, so a scheme change mismatches here exactly once; the
			// re-key below keeps later backfills (and the rewritten manifest) stable.
			const liveIdentity = effectiveEmbedIdentity(this._modelId);
			const staleIdentity = !!liveIdentity && !!this._persistedModelId && this._persistedModelId !== liveIdentity;
			// Dual-space: when the RETIRED identity is the potion static space, old
			// vectors move to `prevEmbedding` instead of being wiped, so retrieval
			// keeps a real vector channel while the new-model backfill runs.
			const keepStaleAsPrev = staleIdentity && isStaticCodeModel(this._persistedModelId);
			let scanned = 0;
			for (const c of this.chunks.values()) {
				// The plain collect-pending scan may yield; a stale-identity WIPE may
				// not — a retrieve interleaved mid-wipe would score the new-space
				// query against not-yet-wiped old-space vectors.
				if (!staleIdentity && ++scanned % SCAN_YIELD_EVERY === 0) await yieldToUI();
				if (!c.scored) continue;
				if (NON_EMBED_LANGS.has(c.language)) continue; // config/markup → lexical only
				if (c.embedding && (staleIdentity || (this._modelDim && c.embedding.length !== this._modelDim))) {
					if (keepStaleAsPrev) {
						c.prevEmbedding = c.embedding;
						c.prevVecScale = c.vecScale;
					}
					c.embedding = undefined;
					c.vecScale = undefined;
					this._casDirty.add(c.file); // CAS entry must lose its stale vectors too
				}
				if (!c.embedding) pending.push(c);
			}
			if (keepStaleAsPrev) this._prevSpaceModelId = this._persistedModelId;
			if (staleIdentity) this._persistedModelId = liveIdentity;
			if (pending.length === 0) return;

			// Prioritize the queue: recently-edited files first (the code the user is
			// working in right now), then files whose definitions are referenced most
			// across the codebase (centrality), then everything else. On a slow GPU
			// backfill this puts quality vectors where they matter within minutes
			// instead of hours.
			try {
				const recentRank = new Map<string, number>();
				for (const e of this.recentEditsService.getRecentEdits()) {
					if (e.relativePath && !recentRank.has(e.relativePath)) recentRank.set(e.relativePath, recentRank.size);
				}
				this._graph.ensure(this.chunks.values());
				const fileCentrality = new Map<string, number>();
				for (const c of pending) {
					let score = fileCentrality.get(c.file) ?? 0;
					if (c.defines) for (const d of c.defines) score += this._graph.refCountOf(d);
					fileCentrality.set(c.file, score);
				}
				const prio = new Map<string, number>();
				for (const file of fileCentrality.keys()) {
					const r = recentRank.get(file);
					prio.set(file, r !== undefined ? -1_000_000 + r : -(fileCentrality.get(file) ?? 0));
				}
				pending.sort((a, b) => (prio.get(a.file)! - prio.get(b.file)!) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
			} catch {
				// Prioritization is best-effort — unsorted order embeds everything just the same.
			}

			const total = pending.length;

			// Slow-model handling (Qwen3 GPU / transformer): small batches so the
			// progress counter moves every few seconds instead of every ~45s, and a
			// potion first-pass so the WHOLE corpus is vector-searchable in minutes
			// while the slow upgrade runs for hours behind it.
			const liveIsStatic = !this._modelId || isStaticCodeModel(this._modelId);
			const batchSize = liveIsStatic ? EMBED_BATCH : SLOW_EMBED_BATCH;
			if (!liveIsStatic && total >= PREPASS_MIN_CHUNKS) {
				const bare = pending.filter(c => !c.prevEmbedding);
				if (bare.length > 0) await this._potionPrepass(bare, epoch);
			}
			if (epoch !== this._backfillEpoch) return;
			// Background-upgrade mode: the prev-space (potion) channel covers the
			// corpus, so SEARCH IS FULLY FUNCTIONAL right now — the slow model is a
			// quality upgrade, not availability. Report state 'ready' the whole way
			// so nothing looks blocked for hours; the counters ride along as an
			// "upgrading" annotation.
			const upgradeMode = !liveIsStatic && this._prevSpaceModelId !== null;
			if (upgradeMode) {
				this.setStatus({
					state: 'ready',
					backgroundUpgrade: true,
					embeddedChunks: 0,
					chunksToEmbed: total,
					chunksTotal: this.chunks.size,
					currentFile: undefined,
					filesPerSecond: undefined,
					etaSeconds: undefined,
				}, true);
			}

			this.logService.info(`[v3code-index] embedding ${total} chunks in the background${upgradeMode ? ' (upgrade mode — search already live on interim vectors)' : ''}`);
			let done = 0;
			let sinceSave = 0;
			const startMs = Date.now();
			let lastSaveMs = startMs;
			for (let i = 0; i < total; i += batchSize) {
				if (!this._embeddingsAvailable) break;
				// A rebuild replaced the corpus: these chunk objects are detached —
				// stop burning GPU on them; the finally() below re-kicks a fresh run.
				if (epoch !== this._backfillEpoch) break;
				const slice = pending.slice(i, i + batchSize);
				const texts: string[] = [];
				for (let j = 0; j < slice.length; j++) {
					texts.push(embedTextFor(slice[j], this.chunks));
					// Header building walks parents — for the fast path's 512-chunk
					// batches that is enough synchronous work to blow a frame.
					if ((j & 127) === 127) await yieldToUI();
				}
				const vecs = await this._computeEmbeddings(texts);
				if (epoch !== this._backfillEpoch) return;
				for (let j = 0; j < slice.length; j++) {
					const q = vecs[j];
					if (q) {
						slice[j].embedding = q.q;
						slice[j].vecScale = q.scale;
						// The new-space vector supersedes the dual-space fallback.
						slice[j].prevEmbedding = undefined;
						slice[j].prevVecScale = undefined;
						this._casDirty.add(slice[j].file); // CAS entry gains vectors
						this._dirtyPages.add(pageIndexForFile(slice[j].file));
					}
				}
				done += slice.length;
				sinceSave += slice.length;
				const elapsedSec = Math.max(0.001, (Date.now() - startMs) / 1000);
				const rate = done / elapsedSec;
				// Report embedding progress in DEDICATED chunk fields — never overwrite
				// the file counters (that's what made the meter say "268k files").
				this.setStatus({
					state: upgradeMode ? 'ready' : 'embedding',
					backgroundUpgrade: upgradeMode || undefined,
					embeddedChunks: done,
					chunksToEmbed: total,
					chunksTotal: this.chunks.size,
					currentFile: upgradeMode ? undefined : 'computing embeddings…',
					filesPerSecond: rate,
					etaSeconds: rate > 0 ? (total - done) / rate : undefined,
				});
				// Persist progress periodically so a long backfill survives a restart —
				// whichever fires first: the chunk-count trigger (fast static backfill)
				// or the wall-clock trigger (slow GPU backfill). Only pages whose
				// chunks actually gained vectors are written (a full _saveAll here
				// serialized all ~300k chunks on the renderer every 3 minutes).
				if (sinceSave >= SAVE_EVERY_CHUNKS || (sinceSave > 0 && Date.now() - lastSaveMs >= SAVE_EVERY_MS)) {
					const toSave = this._dirtyPages;
					this._dirtyPages = new Set();
					await this._savePages(toSave);
					sinceSave = 0;
					lastSaveMs = Date.now();
				}
				await yieldToUI();
				// Deprioritize the slow-model upgrade while the user is interacting:
				// search is already live on interim vectors, so this pass can afford
				// to keep GPU/IPC contention away from input handling. The fast
				// static path skips this — there it IS availability.
				if (!liveIsStatic && this.userActivityService.isActive) {
					await new Promise<void>(resolve => setTimeout(resolve, BACKFILL_ACTIVE_BATCH_DELAY_MS));
				}
			}
			if (epoch !== this._backfillEpoch) return;
			// Backfill complete → retire the dual-space fallback vectors (memory and
			// storage return to baseline). Chunks that STILL lack a new-model vector
			// (per-batch embed failures) keep their prev vector — better a stale
			// signal than none — and keep `_prevSpaceModelId` alive for them.
			if (this._prevSpaceModelId && this._embeddingsAvailable && done >= total) {
				let prevRemaining = 0;
				let retireScanned = 0;
				for (const c of this.chunks.values()) {
					if (++retireScanned % SCAN_YIELD_EVERY === 0) await yieldToUI();
					if (!c.prevEmbedding) continue;
					if (c.embedding || !c.scored || NON_EMBED_LANGS.has(c.language)) {
						c.prevEmbedding = undefined;
						c.prevVecScale = undefined;
						this._dirtyPages.add(pageIndexForFile(c.file));
					} else {
						prevRemaining++;
					}
				}
				if (prevRemaining === 0) {
					this._prevSpaceModelId = null;
					this.logService.info('[v3code-index] model-swap backfill complete — dual-space retrieval retired');
				}
			}
			await this._saveAll();
			this.setStatus({
				state: 'ready',
				backgroundUpgrade: undefined,
				embeddedChunks: undefined,
				chunksToEmbed: undefined,
				chunksTotal: this.chunks.size,
				currentFile: undefined,
				filesPerSecond: undefined,
				etaSeconds: undefined,
			}, true);
		})().finally(() => {
			this._backfillInFlight = null;
			// If the corpus was rebuilt mid-run, this run embedded (some) detached
			// chunks and the NEW corpus never got its pass — start one now.
			if (epoch !== this._backfillEpoch) { setTimeout(() => this._maybeBackfillEmbeddings(), 1_000); }
		});
		return this._backfillInFlight;
	}

	// -- Node backend (EXPERIMENTAL) — main-process SQLite FTS5 + sqlite-vec engine --

	private _nodeBackendEnabled(): boolean {
		return this.configService.getValue<boolean>(`${CONFIG_PREFIX}.nodeBackend`) === true;
	}

	/** Kick a (single) background open of the node engine. No-op when the flag
	 *  is off or an open already ran. Never throws. */
	private _ensureNodeBackend(): void {
		if (!this._nodeBackendEnabled()) return;
		if (this._nodeWorkspaceKey && this._nodeWorkspaceKey !== this._sessionKey) {
			this._nodeState = 'idle';
			this._nodeDbPath = null;
			this._nodeWorkspaceKey = null;
			this._nodeMirrorQueue = [];
		}
		if (this._nodeState !== 'idle') return;
		this._nodeState = 'opening';
		void this._openNodeBackend();
	}

	private async _openNodeBackend(): Promise<void> {
		const workspaceKey = this._sessionKey;
		try {
			const folders = this.workspace.getWorkspace().folders;
			if (folders.length === 0) {
				this._nodeState = 'error';
				this._nodeMirrorQueue = [];
				return;
			}
			// Same location the legacy Node service used: {workspaceRoot}/.v3code/index.db.
			const dbPath = `${folders[0].uri.fsPath}/.v3code/index.db`;
			const modelHint = this.configService.getValue<string>(`${CONFIG_PREFIX}.embedModel`) || 'auto';
			const mirrorHost = this.configService.getValue<string>(`${CONFIG_PREFIX}.modelDownloadHost`) || undefined;
			const res = await this.nodeIndexService.open({
				dbPath,
				// Effective identity (embedIdentity.ts): the node DB wipes its vector
				// table on model mismatch, which is exactly what a scheme change needs.
				modelId: effectiveEmbedIdentity(this._modelId || this._persistedModelId) || '',
				dim: this._modelDim || this._persistedDim || 0,
				modelHint,
				mirrorHost,
			});
			if (workspaceKey !== this._sessionKey) {
				this._nodeState = 'idle';
				this._nodeDbPath = null;
				this._nodeWorkspaceKey = null;
				queueMicrotask(() => this._ensureNodeBackend());
				return;
			}
			this._nodeDbPath = dbPath;
			this._nodeWorkspaceKey = workspaceKey;
			this._nodeState = 'ready';
			this.logService.info(`[v3code-index] node backend open (${res.modelId}, dim=${res.dim}, vec=${res.hasVec}, ${res.chunks} chunks on disk)`);
			if (res.chunks === 0 && this.chunks.size > 0) {
				// Cold backend, warm renderer (flag just enabled / model re-key wiped
				// the DB / session restored from IndexedDB): mirror the whole
				// in-memory index once so node retrieval works before the next rebuild.
				const scored: IndexedChunk[] = [];
				for (const c of this.chunks.values()) {
					if (c.scored) scored.push(c);
				}
				this._queueNodeMirror(scored);
			} else {
				void this._flushNodeMirror();
			}
		} catch (err: any) {
			if (workspaceKey !== this._sessionKey) {
				this._nodeState = 'idle';
				this._nodeDbPath = null;
				this._nodeWorkspaceKey = null;
				queueMicrotask(() => this._ensureNodeBackend());
				return;
			}
			this._nodeState = 'error';
			// Anything queued while 'opening' can never drain now — release it.
			this._nodeMirrorQueue = [];
			this.logService.warn(`[v3code-index] node backend unavailable, staying on in-memory index: ${err?.message ?? err}`);
		}
	}

	/** Enqueue scored chunks for the node mirror and kick a background flush.
	 *  Fire-and-forget: mirroring must never slow down or fail indexing. */
	private _queueNodeMirror(chunks: readonly IndexedChunk[]): void {
		if (!this._nodeBackendEnabled() || chunks.length === 0) return;
		// A failed open never drains the queue (_flushNodeMirror requires
		// 'ready'), so queueing while in 'error' would leak every scored
		// chunk's text for the rest of the session. Skip instead — if the
		// backend later recovers (flag toggle / model re-key resets to
		// 'idle'), the cold-open full mirror or the next rebuild re-syncs.
		if (this._nodeState === 'error') return;
		for (const c of chunks) {
			this._nodeMirrorQueue.push({
				id: c.id, file: c.file, name: c.name,
				startLine: c.startLine, endLine: c.endLine,
				text: c.content || c.name,
				// Embedding-only text with the contextual header (embedText.ts);
				// the channel keeps `text` raw for FTS + storage.
				embedText: embedTextFor(c, this.chunks),
			});
		}
		if (this._nodeMirrorQueue.length > NODE_MIRROR_QUEUE_MAX) {
			this._nodeMirrorQueue.splice(0, this._nodeMirrorQueue.length - NODE_MIRROR_QUEUE_MAX);
		}
		this._ensureNodeBackend();
		void this._flushNodeMirror();
	}

	/** Drain the mirror queue in batches. Single flight; new chunks queued while
	 *  a batch is in transit are picked up by the next loop turn. */
	private async _flushNodeMirror(): Promise<void> {
		if (this._nodeFlushing) return;
		const workspaceKey = this._nodeWorkspaceKey;
		const dbPath = this._nodeDbPath;
		if (!workspaceKey || !dbPath || workspaceKey !== this._sessionKey) return;
		this._nodeFlushing = true;
		try {
			while (
				this._nodeMirrorQueue.length > 0 &&
				this._nodeState === 'ready' && this._nodeDbPath !== null &&
				this._nodeWorkspaceKey === workspaceKey && this._sessionKey === workspaceKey &&
				this._nodeBackendEnabled()
			) {
				const snapshot = this._nodeMirrorQueue;
				this._nodeMirrorQueue = [];
				for (const batch of toBatches(snapshot, NODE_MIRROR_BATCH)) {
					if (this._sessionKey !== workspaceKey || this._nodeWorkspaceKey !== workspaceKey) return;
					await this.nodeIndexService.upsertChunks(dbPath, batch);
				}
			}
		} catch (err: any) {
			if (this._sessionKey === workspaceKey && this._nodeWorkspaceKey === workspaceKey) {
				// Best-effort mirror: drop this workspace's queue — the next rebuild
				// (or cold-open full mirror) re-syncs. A queue belonging to a newly
				// swapped workspace must survive an old backend's late failure.
				this._nodeMirrorQueue = [];
				this.logService.warn(`[v3code-index] node-backend mirror failed: ${err?.message ?? err}`);
			}
		} finally {
			this._nodeFlushing = false;
			// A replacement backend may have opened while the previous workspace's
			// final batch was still in flight. Its first flush intentionally yielded
			// to this single-flight; make sure the new queue is not stranded.
			if (this._nodeMirrorQueue.length > 0 && this._nodeWorkspaceKey === this._sessionKey && this._nodeState === 'ready') {
				queueMicrotask(() => void this._flushNodeMirror());
			}
		}
	}

	/** Query the node engine. Returns null (→ caller falls back to the in-memory
	 *  path) when the backend isn't ready, errors, or returns nothing. */
	private async _tryNodeRetrieve(prompt: string, topK: number, fileFilter: Set<string> | null): Promise<Hit[] | null> {
		const workspaceKey = this._sessionKey;
		try {
			if (this._nodeWorkspaceKey !== this._sessionKey) return null;
			if (this._nodeState === 'idle') {
				this._ensureNodeBackend(); // warm up for next time; use in-memory now
				return null;
			}
			if (this._nodeState !== 'ready' || !this._nodeDbPath) return null;
			const mode = (this.configService.getValue<string>(`${CONFIG_PREFIX}.queryExpander`) || 'heuristic') as 'heuristic' | 'local-llama' | 'chat-model';
			const raw = await this.nodeIndexService.retrieve(this._nodeDbPath, prompt, topK, mode);
			if (workspaceKey !== this._sessionKey || this._nodeWorkspaceKey !== workspaceKey) return null;
			let hits = mapNodeHits(raw, id => this.chunks.get(id));
			if (fileFilter) hits = hits.filter(h => fileFilter.has(h.chunk.file));
			return hits.length > 0 ? hits : null;
		} catch (err: any) {
			this.logService.warn(`[v3code-index] node-backend retrieve failed, using in-memory index: ${err?.message ?? err}`);
			return null;
		}
	}

	// -- LSP edge enrichment (real graph edges — see lspEdgeEnricher.ts) --

	private _lspEdgesEnabled(): boolean {
		// Kill-switch, default ON: the enricher's budgets (5 symbols/file,
		// 20 files/cycle, single-flight, 250ms inter-file yield, event-driven
		// candidates only) keep language-service load negligible.
		return this.configService.getValue<boolean>(`${CONFIG_PREFIX}.lspGraphEdges`) !== false;
	}

	/** Queue indexed files for background LSP edge enrichment. Cheap + sync. */
	private _feedLspEnricher(files: readonly string[]): void {
		if (files.length === 0 || !this._lspEdgesEnabled() || !this._readConfig().enabled) return;
		const indexed = files.filter(f => this.fileToChunks.has(f));
		if (indexed.length === 0) return;
		if (!this._lspEnricher) {
			const enricher = new LspEdgeEnricher(this._createLspEdgeHost());
			this._lspEnricher = enricher;
			this._register(toDisposable(() => enricher.dispose()));
		}
		this._lspEnricher.enqueue(indexed);
	}

	/** Fire-and-forget: files surfaced by a retrieve() are enrichment candidates. */
	private _feedLspFromHits(hits: readonly Hit[]): void {
		if (hits.length === 0) return;
		const files: string[] = [];
		const seen = new Set<string>();
		for (const h of hits) {
			const f = h.chunk.file;
			if (seen.has(f)) continue;
			seen.add(f);
			files.push(f);
			if (files.length >= LSP_FEED_MAX_FILES) break;
		}
		this._feedLspEnricher(files);
	}

	private _createLspEdgeHost(): LspEdgeHost {
		const workspaceKey = this._sessionKey;
		const workspaceStillCurrent = () => workspaceKey === this._sessionKey && canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey);
		return {
			isEnabled: () => workspaceStillCurrent() && this._lspEdgesEnabled() && this._readConfig().enabled,
			getDocumentSymbols: async (file) =>
				(workspaceStillCurrent() ? await this.lspBridge.getDocumentSymbols(file) : [])
					.map(s => ({ name: s.name, line: s.line, character: s.character, containerName: s.containerName })),
			getReferences: async (file, line, character) =>
				(workspaceStillCurrent() ? await this.lspBridge.getReferences(file, line, character) : [])
					.map(r => ({ filePath: r.filePath, line: r.line })),
			getDefinition: async (file, line, character) => {
				if (!workspaceStillCurrent()) return null;
				const d = await this.lspBridge.getDefinition(file, line, character);
				return workspaceStillCurrent() && d ? { name: d.name, filePath: d.filePath } : null;
			},
			chunksOf: (file) => {
				if (!workspaceStillCurrent()) return [];
				const ids = this.fileToChunks.get(file);
				if (!ids) return [];
				const out: IndexedChunk[] = [];
				for (const id of ids) {
					const c = this.chunks.get(id);
					if (c) out.push(c);
				}
				return out;
			},
			contentHashOf: (file) => workspaceStillCurrent() ? this.fileHashes.get(file) : undefined,
			// lspDefines only: it is written exclusively by the file's OWN pass
			// (lspRefs can be inbound writes from another file's enrichment).
			hasOwnLspEdges: (file) => {
				if (!workspaceStillCurrent()) return false;
				const ids = this.fileToChunks.get(file);
				if (!ids) return false;
				for (const id of ids) {
					const c = this.chunks.get(id);
					if (c?.lspDefines?.length) return true;
				}
				return false;
			},
			onEnriched: (touchedFiles) => {
				if (!workspaceStillCurrent()) return;
				// New edges: apply the touched files' chunks to the graph as a
				// per-file delta (a full markDirty here made every retrieve during
				// enrichment pay an O(all chunks) rebuild) and persist the touched
				// pages so the lspDefines/lspRefs survive restarts (and reach the
				// CAS for cross-branch reuse). manifest:false — edge writes change
				// chunk fields only, no manifest-tracked state.
				const touched: IndexedChunk[] = [];
				const pages = new Set<number>();
				for (const f of touchedFiles) {
					pages.add(pageIndexForFile(f));
					this._casDirty.add(f);
					const ids = this.fileToChunks.get(f);
					if (ids) {
						for (const id of ids) {
							const c = this.chunks.get(id);
							if (c) touched.push(c);
						}
					}
				}
				this._graph.updateChunks(touched);
				void this._savePages(pages, { manifest: false }, workspaceKey);
			},
			log: (m) => this.logService.trace(m),
		};
	}

	// -- Retrieval --

	async retrieve(prompt: string, opts?: { topK?: number; files?: string[]; quickPath?: boolean; rerank?: boolean | { budgetMs?: number } }): Promise<Hit[]> {
		const workspaceKey = this._sessionKey;
		const workspaceStillCurrent = () => workspaceKey === this._sessionKey && canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey);
		if (!workspaceStillCurrent()) return [];
		const topK = opts?.topK ?? 30;
		const fileFilter = opts?.files ? new Set(opts.files) : null;
		const queryTokens = Array.from(new Set(tokenize(prompt))).filter(t => !STOPWORDS.has(t));
		if (queryTokens.length === 0) return [];

		// Node backend first (experimental flag): SQLite FTS5 + ANN + query
		// expansion in the main process. ANY error or empty result falls through
		// to the in-memory hybrid path below. quickPath keeps its fast lexical
		// contract (autocomplete races a ~120ms timeout) and never goes over IPC.
		if (this._nodeBackendEnabled() && !opts?.quickPath) {
			const nodeHits = await this._tryNodeRetrieve(prompt, topK, fileFilter);
			if (nodeHits && workspaceStillCurrent()) {
				this._feedLspFromHits(nodeHits); // background LSP edge candidates
				if (opts?.rerank) {
					const budgetMs = typeof opts.rerank === 'object' ? (opts.rerank.budgetMs ?? 1500) : 1500;
					const reranked = await this._localRerank(prompt, nodeHits, budgetMs);
					return workspaceStillCurrent() ? reranked : [];
				}
				return nodeHits;
			}
		}

		const queryEmbedding = (!opts?.quickPath && this._embeddingsAvailable) ? await this._computeQueryEmbedding(prompt) : null;
		// Dual-space channel (model-swap backfill in flight): embed the query in the
		// retired potion space too, so not-yet-re-embedded chunks stay searchable.
		const queryEmbeddingPrev = (!opts?.quickPath && this._prevSpaceModelId) ? await this._computePrevQueryEmbedding(prompt) : null;
		if (!workspaceStillCurrent()) return [];

		// Recency channel input: distinct recently-edited files, most recent first
		// (Continue's recently-edited retrieval channel, fed by the edit journal).
		const recentFiles = new Map<string, number>();
		for (const e of this.recentEditsService.getRecentEdits()) {
			if (e.relativePath && !recentFiles.has(e.relativePath)) recentFiles.set(e.relativePath, recentFiles.size);
			if (recentFiles.size >= 12) break;
		}

		// Beast sidecar channel (eval-gated Phase B, off by default): pre-fetch
		// trigram hits under a strict budget; on timeout/failure fuse without
		// them. hybridSearch stays synchronous — the async work happens here.
		let beastHits: { file: string; line: number }[] | null = null;
		if (!opts?.quickPath && this.configService.getValue<boolean>(`${CONFIG_PREFIX}.beastFusion`) === true) {
			// k=30 matches the offline gate's ask (run-eval.mjs --beast) so the
			// measured configuration is the shipped configuration.
			beastHits = await Promise.race([
				this.beastService.search(prompt, 30),
				new Promise<null>(resolve => setTimeout(() => resolve(null), BEAST_FUSION_BUDGET_MS)),
			]);
		}
		if (!workspaceStillCurrent()) return [];
		const beastWeight = this.configService.getValue<number>(`${CONFIG_PREFIX}.beastWeight`);

		const fused = hybridSearch(
			{ chunks: this.chunks, graph: this._graph, embeddingsAvailable: this._embeddingsAvailable },
			{ queryTokens, queryText: prompt, queryEmbedding, queryEmbeddingPrev, recentFiles: recentFiles.size > 0 ? recentFiles : null, beastHits },
			{ topK, fileFilter, beastWeight: typeof beastWeight === 'number' ? beastWeight : undefined },
		);

		// Fire-and-forget: retrieval hits are prime candidates for background LSP
		// edge enrichment (the user is working in this neighborhood right now).
		this._feedLspFromHits(fused);

		if (opts?.rerank && !opts.quickPath) {
			const budgetMs = typeof opts.rerank === 'object' ? (opts.rerank.budgetMs ?? 1500) : 1500;
			const reranked = await this._localRerank(prompt, fused, budgetMs);
			return workspaceStillCurrent() ? reranked : [];
		}
		// No rerank-by-default here: semantic_search already opts in explicitly
		// (toolsService sets rerank=!quickPath), and the OTHER retrieve() callers
		// are latency-budgeted hot paths (autocomplete repo context, next-edit)
		// that must never pay cross-encoder inference. The session warm-up
		// (_scheduleRerankerWarmup) is what makes the tool's opt-in reliable
		// from its first call instead of silently timing out on the cold load.
		return workspaceStillCurrent() ? fused : [];
	}

	/**
	 * Warm the local cross-encoder shortly after init so the FIRST rerank of the
	 * session doesn't eat the ~5-10s model load inside its latency budget (which
	 * silently returned the un-reranked order every cold start). 10s delay keeps
	 * the load off the index-restore/backfill window. 'auto' warms only when the
	 * GGUF is already on disk; 'on' may download it. Best-effort.
	 */
	private _scheduleRerankerWarmup(): void {
		const timer = setTimeout(async () => {
			try {
				const mode = this.configService.getValue<string>(`${CONFIG_PREFIX}.localReranker`) ?? 'auto';
				if (mode === 'off') { return; }
				const info = await this.embedService.getRerankInfo();
				if (info.isReady || (!info.modelPresent && mode !== 'on')) { return; }
				await this.embedService.rerank('warm-up', ['warm-up'], mode === 'on');
				this.logService.info('[v3code-index] local reranker warmed — semantic_search rerank is live from its first call');
			} catch (e: any) {
				this.logService.trace(`[v3code-index] reranker warm-up skipped: ${e?.message ?? e}`);
			}
		}, 10_000);
		this._register(toDisposable(() => clearTimeout(timer)));
	}

	/**
	 * Local cross-encoder precision pass over the fused head. NEVER throws and
	 * never worsens latency past its budget: any failure, cold model, or timeout
	 * returns the fused order unchanged. Neighbors (appended after primaries by
	 * hybridSearch) are excluded from scoring and keep their tail position.
	 */
	private _rerankAvailability: { at: number; ok: boolean } | null = null;
	private async _localRerank(query: string, hits: Hit[], budgetMs: number): Promise<Hit[]> {
		try {
			const mode = this.configService.getValue<string>(`${CONFIG_PREFIX}.localReranker`) ?? 'auto';
			if (mode === 'off' || hits.length < 2) return hits;

			// 'auto' = only when the model is already on disk; 'on' also permits the
			// one-time download. Availability is cached 60s to avoid an IPC ping per query.
			if (mode === 'auto') {
				if (!this._rerankAvailability || Date.now() - this._rerankAvailability.at > 60_000) {
					const info = await this.embedService.getRerankInfo();
					this._rerankAvailability = { at: Date.now(), ok: info.modelPresent || info.isReady };
				}
				if (!this._rerankAvailability.ok) return hits;
			}

			let headCount = 0;
			while (headCount < hits.length && headCount < RERANK_MAX_CANDIDATES && hits[headCount].signals.neighbor !== 1) headCount++;
			if (headCount < 2) return hits;

			const docs = hits.slice(0, headCount).map(buildRerankDoc);
			const scores = await Promise.race([
				this.embedService.rerank(query, docs, mode === 'on'),
				new Promise<null>(resolve => setTimeout(() => resolve(null), budgetMs)),
			]);
			if (!scores || scores.length !== docs.length) return hits;
			return applyRerankOrder(hits, scores);
		} catch {
			return hits; // fused order always survives
		}
	}

	// -- Public graph APIs (prefetch + autocomplete foundations) --

	// ------------------------------------------------------------------
	// Cloud index sync (V3Index) — read-only snapshot for the pusher.
	// Duck-typed via CloudSyncSnapshotProvider; deliberately NOT on
	// ISemanticIndexService so this stays additive. See cloudIndexSyncer.ts.
	// ------------------------------------------------------------------

	getCloudSyncSnapshot(): import('../common/cloudIndex/cloudIndexProtocol.js').CloudSyncSnapshot {
		const workspaceKey = this._sessionKey;
		const workspaceStillCurrent = () => workspaceKey === this._sessionKey && canServeSemanticWorkspace(this._indexedWorkspaceKey, workspaceKey);
		if (!workspaceStillCurrent()) {
			return { files: {}, vectorCountForFile: () => 0, chunksForFile: () => [] };
		}
		const files: Record<string, string> = {};
		for (const [rel, hash] of this.fileHashes) { files[rel] = hash; }
		return {
			files,
			vectorCountForFile: (file: string) => {
				if (!workspaceStillCurrent()) return 0;
				const ids = this.fileToChunks.get(file);
				if (!ids) { return 0; }
				let count = 0;
				for (const id of ids) {
					const c = this.chunks.get(id);
					if (c?.scored && c.embedding && typeof c.vecScale === 'number') { count++; }
				}
				return count;
			},
			chunksForFile: (file: string, includeVectors = false) => {
				if (!workspaceStillCurrent()) return [];
				const ids = this.fileToChunks.get(file);
				if (!ids) { return []; }
				const out: import('../common/cloudIndex/cloudIndexProtocol.js').CloudWireChunk[] = [];
				for (const id of ids) {
					const c = this.chunks.get(id);
					if (!c) { continue; }
					out.push({
						id: c.id, casKey: c.contentHash, file: c.file,
						startLine: c.startLine, endLine: c.endLine,
						kind: c.kind, name: c.name, language: c.language,
						parentId: c.parentId, scored: c.scored,
						defines: c.defines, refs: c.refs,
						lspDefines: c.lspDefines, lspRefs: c.lspRefs,
						content: c.content,
						tokens: c.tokens && c.tokens.length > 0 ? tokenStringsOf(c.tokens) : undefined,
						vectorQ8: includeVectors && c.scored && c.embedding ? encodeBase64(VSBuffer.wrap(new Uint8Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength))) : undefined,
						vectorScale: includeVectors && c.scored && c.embedding ? c.vecScale : undefined,
						vectorSpace: includeVectors && c.scored && c.embedding && typeof c.vecScale === 'number' ? 'qwen3-embedding-0.6b+hdr2' : undefined,
					});
				}
				return out;
			},
		};
	}

	getRecentEditRanks(): Record<string, number> {
		const ranks: Record<string, number> = {};
		let rank = 0;
		for (const e of this.recentEditsService.getRecentEdits(20)) {
			if (e.relativePath && !(e.relativePath in ranks)) { ranks[e.relativePath] = rank++; }
		}
		return ranks;
	}

	/**
	 * Files connected to `file` via the dependency graph, ranked by edge count.
	 * Powers proactive prefetch: "you opened A → warm B which A depends on".
	 * NOTE: graph is text-derived (~60-70% recall) — see dependencyGraph.ts.
	 */
	getRelatedFiles(file: string, max = 8): string[] {
		if (!canServeSemanticWorkspace(this._indexedWorkspaceKey, this._sessionKey)) return [];
		this._graph.ensure(this.chunks.values());
		const ids = this.fileToChunks.get(file);
		if (!ids) return [];
		const fileChunks: IndexedChunk[] = [];
		for (const id of ids) {
			const c = this.chunks.get(id);
			if (c) fileChunks.push(c);
		}
		return this._graph.relatedFiles(fileChunks, id => this.chunks.get(id)?.file, max);
	}

	/**
	 * The file's structural units (functions/classes/methods/types), sorted by
	 * line. Powers autocomplete Engine 1 (instant local scope, no API call).
	 */
	getLocalScope(file: string): LocalScopeUnit[] {
		if (!canServeSemanticWorkspace(this._indexedWorkspaceKey, this._sessionKey)) return [];
		const ids = this.fileToChunks.get(file);
		if (!ids) return [];
		const out: LocalScopeUnit[] = [];
		for (const id of ids) {
			const c = this.chunks.get(id);
			if (!c || c.kind === 'block') continue;
			out.push({ name: c.name, kind: c.kind, startLine: c.startLine, endLine: c.endLine, content: c.content });
		}
		return out.sort((a, b) => a.startLine - b.startLine);
	}

	/**
	 * Cross-file neighbors (callers + referenced definitions) for the symbols in
	 * `file`. Powers context packing for FIM completion + chat. Returns full
	 * enclosing blocks (child → parent resolved).
	 */
	getNeighbors(file: string, max = 10): NeighborUnit[] {
		if (!canServeSemanticWorkspace(this._indexedWorkspaceKey, this._sessionKey)) return [];
		this._graph.ensure(this.chunks.values());
		const ids = this.fileToChunks.get(file);
		if (!ids) return [];
		const seen = new Set<string>();
		const out: NeighborUnit[] = [];
		for (const id of ids) {
			const c = this.chunks.get(id);
			if (!c) continue;
			for (const nid of this._graph.neighborsOf(c, max)) {
				if (seen.has(nid)) continue;
				seen.add(nid);
				const n = this.chunks.get(nid);
				if (!n || n.file === file) continue;
				// Resolve child → enclosing parent block for injection.
				const content = (n.parentId ? this.chunks.get(n.parentId)?.content : undefined) || n.content;
				if (!content) continue;
				out.push({ file: n.file, name: n.name, startLine: n.startLine, endLine: n.endLine, content });
				if (out.length >= max) return out;
			}
		}
		return out;
	}
}

// Registration: this browser-safe impl is the active ISemanticIndexService.
registerSingleton(ISemanticIndexService, SemanticIndexBrowserImpl, InstantiationType.Delayed);
