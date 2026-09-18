/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — browser-layer host for the security scanner (the `security_scan` tool's backend).
 *
 * The engine in `common/security/` is deliberately pure: it takes its editor couplings as a
 * {@link ScanHost}. This service is that host — the ~5 callbacks that give the pure engine a
 * real workspace: file enumeration (gitignore-ish skip dirs + the hard security denylist),
 * file reads, tree-sitter parsing, and journal persistence.
 *
 * TREE LIFETIME (the load-bearing detail):
 * `wrapTsNode` wraps a tree-sitter node LAZILY — children and fields are materialized on
 * access, not up front. `CpgLifter.lift` therefore walks the CST AFTER `host.parse` has
 * already returned, so freeing the tree inside `parse` would hand the lifter freed wasm
 * memory. Instead we keep exactly ONE live tree: each `parse` frees the PREVIOUS file's
 * tree before parsing the next, and `dispose`/end-of-scan frees the last one. Memory stays
 * bounded at a single CST without ever reading through a deleted tree.
 *
 * Tree-sitter runtime wiring (runtime init + grammar wasm resolution) mirrors the semantic
 * index's chunker host exactly; it is duplicated rather than shared so a scan can never
 * disturb indexing state (grammar cache, parser language) mid-index.
 */

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { importAMDNodeModule, canASAR } from '../../../../amdX.js';
import { AppResourcePath, FileAccess, nodeModulesAsarUnpackedPath, nodeModulesPath } from '../../../../base/common/network.js';
import type { Language as TsLanguage, Parser as TsParser, Tree as TsTree } from '@vscode/tree-sitter-wasm';

import { profileFor } from '../common/semanticIndex/chunkerLanguages.js';
import { isSecurityConcernPath, isSecurityIgnoredDirName } from '../common/semanticIndex/securityIgnore.js';
import { AstNode } from '../common/security/astTypes.js';
import { languageIdFromPath } from '../common/security/languages.js';
import { runScan, ScanHost, ScanOptions, ScanResult } from '../common/security/scanner.js';
import { TsNodeLike, wrapTsNode } from '../common/security/treeSitterAdapter.js';

/** Directories never worth scanning (build output, vendored deps, VCS metadata). */
const SKIP_DIRS = new Set([
	'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build',
	'.next', '.turbo', '.cache', '.parcel-cache', 'coverage',
	'.v3code', '.vscode-test', '__pycache__', 'venv', '.venv', 'target',
	'.gradle', '.idea', '.vs', 'bin', 'obj', '.terraform',
]);

/** Hard ceiling on files enumerated, so a monorepo walk can't run unbounded. */
const MAX_WALK_FILES = 20000;

/** Where the cross-session journal lives (workspace-local, gitignorable). */
const JOURNAL_RELATIVE_PATH = '.v3code/security-journal.json';

export interface ISecurityScanService {
	readonly _serviceBrand: undefined;
	/** Run a workspace security scan. Rejects when no folder is open. */
	scan(options?: ScanOptions): Promise<ScanResult>;
}

export const ISecurityScanService = createDecorator<ISecurityScanService>('securityScanService');

export class SecurityScanService extends Disposable implements ISecurityScanService {
	declare readonly _serviceBrand: undefined;

	private _runtime: { Parser: typeof TsParser; Language: typeof TsLanguage } | null = null;
	private _runtimeTried = false;
	private _parser: TsParser | null = null;
	private _parserGrammar: string | null = null;
	private _grammars = new Map<string, TsLanguage | null>();
	/** The single live CST. Freed at the next parse and at scan end — see file header. */
	private _liveTree: TsTree | null = null;
	/** One scan at a time: the parser and the live-tree slot are single-instance state. */
	private _inFlight: Promise<ScanResult> | null = null;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super();
		this._register(toDisposable(() => this._freeLiveTree()));
	}

	scan(options: ScanOptions = {}): Promise<ScanResult> {
		if (this._inFlight) return this._inFlight;
		const run = this._scan(options).finally(() => {
			// Always release the last file's CST, success or failure.
			this._freeLiveTree();
			this._inFlight = null;
		});
		this._inFlight = run;
		return run;
	}

	private async _scan(options: ScanOptions): Promise<ScanResult> {
		const root = this._workspaceRoot();
		if (!root) {
			throw new Error('No workspace folder is open, so there is nothing to scan.');
		}
		const host = this._createScanHost(root);
		return runScan(host, root.fsPath, options);
	}

	private _workspaceRoot(): URI | null {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : null;
	}

	// -- ScanHost ------------------------------------------------------------

	private _createScanHost(root: URI): ScanHost {
		const journalUri = this._childUri(root, JOURNAL_RELATIVE_PATH);
		return {
			listFiles: () => this._listFiles(root),
			readFile: async (relPath: string) => {
				try {
					const file = await this.fileService.readFile(this._childUri(root, relPath));
					const text = file.value.toString();
					// Binary guard: a NUL byte early on means this isn't source we can parse.
					return text.slice(0, 4096).indexOf('\u0000') === -1 ? text : null;
				} catch {
					return null;
				}
			},
			parse: (source: string, languageId: string) => this._parse(source, languageId),
			loadJournal: async () => {
				try {
					const file = await this.fileService.readFile(journalUri);
					return file.value.toString();
				} catch {
					return undefined; // no journal yet — first scan
				}
			},
			saveJournal: async (json: string) => {
				try {
					await this.fileService.writeFile(journalUri, VSBuffer.fromString(json));
				} catch (e) {
					// A journal we can't persist costs the "since last scan" diff, never the findings.
					this.logService.warn(`[sentinel] could not save scan journal: ${e}`);
				}
			},
			log: (message: string) => this.logService.info(message),
		};
	}

	/** Join a workspace-relative POSIX path onto the workspace root. */
	private _childUri(root: URI, relPath: string): URI {
		return root.with({ path: `${root.path}/${relPath}` });
	}

	/**
	 * Enumerate scannable, workspace-relative source paths. Applies three filters:
	 * build/vendor skip dirs, the hard security denylist (never read .env/keys/certs),
	 * and the engine's own modeled-language check (skip what it cannot analyze).
	 */
	private async _listFiles(root: URI): Promise<readonly string[]> {
		const out: string[] = [];
		const walk = async (dir: URI, prefix: string): Promise<void> => {
			if (out.length >= MAX_WALK_FILES) return;
			let stat;
			try {
				stat = await this.fileService.resolve(dir);
			} catch {
				return; // unreadable directory — skip, never abort the scan
			}
			for (const child of stat.children ?? []) {
				if (out.length >= MAX_WALK_FILES) return;
				const name = child.name;
				const rel = prefix ? `${prefix}/${name}` : name;
				if (child.isDirectory) {
					if (SKIP_DIRS.has(name.toLowerCase())) continue;
					if (isSecurityIgnoredDirName(name)) continue;
					await walk(child.resource, rel);
					continue;
				}
				if (!languageIdFromPath(rel)) continue;      // engine can't analyze this extension
				if (isSecurityConcernPath(rel)) continue;    // secrets never get read
				out.push(rel);
			}
		};
		await walk(root, '');
		return out;
	}

	// -- Tree-sitter ---------------------------------------------------------

	/**
	 * Parse one file into a normalized AstNode root.
	 *
	 * Frees the PREVIOUS file's CST first (never the one being returned): the returned
	 * AstNode wraps this tree lazily and the caller walks it after we return.
	 */
	private async _parse(source: string, languageId: string): Promise<AstNode | null> {
		const profile = profileFor(languageId);
		if (!profile) return null;
		const rt = await this._ensureRuntime();
		if (!rt) return null;
		const language = await this._ensureGrammar(rt, profile.grammar);
		if (!language) return null;

		// The previous file's analysis is finished by the time we're asked for the next
		// file, so this is the safe point to release it — one live tree at a time.
		this._freeLiveTree();

		let tree: TsTree | null;
		try {
			if (!this._parser) this._parser = new rt.Parser();
			const parser = this._parser;
			if (this._parserGrammar !== profile.grammar) {
				parser.setLanguage(language);
				this._parserGrammar = profile.grammar;
			}
			tree = parser.parse(source);
		} catch {
			return null;
		}
		if (!tree) return null;
		this._liveTree = tree;
		return wrapTsNode(tree.rootNode as unknown as TsNodeLike);
	}

	private _freeLiveTree(): void {
		if (this._liveTree) {
			try { this._liveTree.delete(); } catch { /* already released */ }
			this._liveTree = null;
		}
	}

	private _tsModuleLocation(): AppResourcePath {
		const base = (canASAR && this.environmentService.isBuilt) ? nodeModulesAsarUnpackedPath : nodeModulesPath;
		return `${base}/@vscode/tree-sitter-wasm/wasm`;
	}

	private async _ensureRuntime(): Promise<{ Parser: typeof TsParser; Language: typeof TsLanguage } | null> {
		if (this._runtimeTried) return this._runtime;
		this._runtimeTried = true;
		try {
			const mod = await importAMDNodeModule<typeof import('@vscode/tree-sitter-wasm')>('@vscode/tree-sitter-wasm', 'wasm/tree-sitter.js');
			const location = this._tsModuleLocation();
			await mod.Parser.init({
				locateFile: (file: string) => FileAccess.asBrowserUri(`${location}/${file}` as AppResourcePath).toString(true),
			});
			this._runtime = { Parser: mod.Parser, Language: mod.Language };
		} catch (e) {
			this.logService.warn(`[sentinel] tree-sitter runtime unavailable — security scan cannot parse: ${e}`);
			this._runtime = null;
		}
		return this._runtime;
	}

	private async _ensureGrammar(rt: { Language: typeof TsLanguage }, grammar: string): Promise<TsLanguage | null> {
		if (this._grammars.has(grammar)) return this._grammars.get(grammar)!;
		try {
			const wasmPath = `${this._tsModuleLocation()}/${grammar}.wasm` as AppResourcePath;
			const file = await this.fileService.readFile(FileAccess.asFileUri(wasmPath));
			const lang = await rt.Language.load(file.value.buffer);
			this._grammars.set(grammar, lang);
			return lang;
		} catch {
			this._grammars.set(grammar, null);
			return null;
		}
	}
}

registerSingleton(ISecurityScanService, SecurityScanService, InstantiationType.Delayed);
