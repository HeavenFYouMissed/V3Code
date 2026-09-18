/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// Renderer-native replacement for @context-bridge/mcp-server's LspBridge.
// Drives VS Code's in-process language feature providers (definition, references,
// document/workspace symbols, call hierarchy, type hierarchy) instead of
// spawning typescript-language-server. Diagnostics come from IMarkerService.
//
// File paths flowing through this service are workspace-relative POSIX strings.
// Positions are 0-indexed (LSP convention); VS Code's IPosition is 1-indexed
// and we translate at the boundary.

import { URI } from '../../../../../base/common/uri.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IReference, Disposable } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { IRange } from '../../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { DocumentSymbol, SymbolKind as VsSymbolKind, LocationLink, Location } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService, IResolvedTextEditorModel } from '../../../../../editor/common/services/resolverService.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { OutlineModel } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { getDefinitionsAtPosition, getReferencesAtPosition } from '../../../../../editor/contrib/gotoSymbol/browser/goToSymbol.js';
import { CallHierarchyModel, CallHierarchyItem, CallHierarchyProviderRegistry } from '../../../callHierarchy/common/callHierarchy.js';
import { TypeHierarchyModel, TypeHierarchyItem, TypeHierarchyProviderRegistry } from '../../../typeHierarchy/common/typeHierarchy.js';
import { getWorkspaceSymbols } from '../../../search/common/search.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMarkerService, IMarker, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { extractHoverSignature } from '../../common/turboDraftCompilerTruth.js';
import { MULTI_ROOT_INDEX_PREFIX, workspaceIndexPath, workspaceIndexUri } from '../../common/semanticIndex/workspaceIndexPath.js';
import {
	CallerEntry,
	DiagnosticEntry,
	ProjectBriefingOutput,
	ReferenceEntry,
	SymbolEntry,
	SymbolKind,
	TypeHierarchyEntry,
} from '../../common/contextBridge/contextBridgeTypes.js';

// ---- Public service contract ----

export interface SymbolLocation {
	filePath: string;
	line: number;
	character: number;
}

export interface ILspBridgeAdapter {
	readonly _serviceBrand: undefined;

	/** Returns workspace root as POSIX fs path, or null when no folder is open. */
	getWorkspaceRoot(): string | null;

	/** Resolve a workspace-relative path to a URI. Null when no workspace. */
	resolveFile(filePath: string): URI | null;

	/** Inverse: turn a URI into a workspace-relative POSIX path. Falls back to fsPath. */
	relativize(uri: URI): string;

	// CB-core LspBridge mirror methods.
	getDocumentSymbols(filePath: string): Promise<SymbolEntry[]>;
	getWorkspaceSymbols(query: string): Promise<SymbolEntry[]>;
	resolveSymbolLocation(filePath: string, symbolName: string): Promise<SymbolLocation | null>;
	getDefinition(filePath: string, line: number, character: number): Promise<SymbolEntry | null>;
	/**
	 * Compiler-truth signature at a position: the code fences of the hover, joined and
	 * capped. Empty when no provider answers. Prose paragraphs of the hover are dropped -
	 * callers want the type, not the docs.
	 */
	getHoverSignature(filePath: string, line: number, character: number): Promise<string>;
	getReferences(filePath: string, line: number, character: number): Promise<ReferenceEntry[]>;
	getIncomingCalls(filePath: string, line: number, character: number): Promise<CallerEntry[]>;
	getOutgoingCalls(filePath: string, line: number, character: number): Promise<CallerEntry[]>;
	getSupertypes(filePath: string, line: number, character: number): Promise<TypeHierarchyEntry[]>;
	getSubtypes(filePath: string, line: number, character: number): Promise<TypeHierarchyEntry[]>;
	readSnippet(filePath: string, line: number, contextLines?: number, endLine?: number): Promise<{ startLine: number; lines: string[] }>;
	getDiagnostics(filePath: string): Promise<DiagnosticEntry[]>;

	// Briefing cache — runGetProjectBriefing fans out to 6+ IO ops on every call.
	// First-call latency happens at session start when the agent most wants context.
	// Cache TTL is 30s; invalidated on changes to journal files or `.git/logs/HEAD`.
	// Single entrypoint by design: caller passes a `compute` thunk and the adapter
	// owns the cache+miss flow internally — prevents accidental writes of stale or
	// bogus data through a separate setter.
	getOrComputeBriefing(key: string, compute: () => Promise<ProjectBriefingOutput>): Promise<ProjectBriefingOutput>;
	invalidateBriefingCache(): void;
}

export const ILspBridgeAdapter = createDecorator<ILspBridgeAdapter>('lspBridgeAdapter');

// ---- Helpers ----

function vsSymbolKindToCb(kind: VsSymbolKind): SymbolKind {
	switch (kind) {
		case VsSymbolKind.Function: return 'function';
		case VsSymbolKind.Method: return 'method';
		case VsSymbolKind.Constructor: return 'method';
		case VsSymbolKind.Class: return 'class';
		case VsSymbolKind.Interface: return 'interface';
		case VsSymbolKind.Enum: return 'enum';
		case VsSymbolKind.Variable: return 'variable';
		case VsSymbolKind.Constant: return 'variable';
		case VsSymbolKind.Property: return 'property';
		case VsSymbolKind.Field: return 'property';
		case VsSymbolKind.Module: return 'module';
		case VsSymbolKind.Namespace: return 'module';
		case VsSymbolKind.Package: return 'module';
		case VsSymbolKind.Struct: return 'type';
		case VsSymbolKind.TypeParameter: return 'type';
		default: return 'unknown';
	}
}

function markerSeverityToCb(s: MarkerSeverity): DiagnosticEntry['severity'] {
	switch (s) {
		case MarkerSeverity.Error: return 'error';
		case MarkerSeverity.Warning: return 'warning';
		case MarkerSeverity.Info: return 'info';
		case MarkerSeverity.Hint: return 'hint';
		default: return 'info';
	}
}

function normalizePath(p: string): string {
	return p.split('\\').join('/');
}

/** Count trailing path segments two paths share (case-insensitive). Higher means
 *  the two files sit closer together in the tree. Used to disambiguate multiple
 *  same-named workspace symbols so we resolve to the one nearest the requested
 *  file instead of an arbitrary first match. */
function trailingSegmentOverlap(a: string, b: string): number {
	const as = normalizePath(a).toLowerCase().split('/').filter(Boolean);
	const bs = normalizePath(b).toLowerCase().split('/').filter(Boolean);
	const min = Math.min(as.length, bs.length);
	let n = 0;
	while (n < min && as[as.length - 1 - n] === bs[bs.length - 1 - n]) { n++; }
	return n;
}

/** VS Code ranges are 1-indexed inclusive on column/line; LSP/CB are 0-indexed. */
function rangeToLsp(range: IRange): { line: number; character: number; endLine: number; endCharacter: number } {
	return {
		line: range.startLineNumber - 1,
		character: range.startColumn - 1,
		endLine: range.endLineNumber - 1,
		endCharacter: range.endColumn - 1,
	};
}

// ---- Implementation ----

export class LspBridgeAdapter extends Disposable implements ILspBridgeAdapter {
	declare readonly _serviceBrand: undefined;

	// Outline cache: nested `pack_context` calls often re-walk the same file 3-5x per turn.
	// Key: uri.toString(); value tagged with model.versionId so any edit invalidates.
	// Capped (insertion-order eviction) to keep memory bounded for huge workspaces.
	private static readonly OUTLINE_CACHE_MAX = 64;
	private readonly outlineCache = new Map<string, { versionId: number; entries: SymbolEntry[] }>();

	// Briefing cache — TTL + file-watch invalidation. Tiny by design (<= 4 entries:
	// includeNotes in {true,false} x maybe future param shapes).
	private static readonly BRIEFING_TTL_MS = 30_000;
	private readonly briefingCache = new Map<string, { value: ProjectBriefingOutput; expiresAt: number }>();
	private static readonly BRIEFING_INVALIDATE_SUFFIXES = [
		'/AGENTS.md',
		'/.github/AGENTS.md',
		'/.github/copilot-instructions.md',
		'/.git/logs/HEAD',
	];

	constructor(
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		// Invalidate briefing cache when journal or git HEAD log files change. Global
		// onDidFilesChange listener is fine — the suffix check is cheap (path.endsWith × 4
		// per changed file, and these events fire infrequently in normal use).
		this._register(this.fileService.onDidFilesChange(e => {
			const changed = e.rawAdded.concat(e.rawUpdated, e.rawDeleted);
			for (const uri of changed) {
				for (const suffix of LspBridgeAdapter.BRIEFING_INVALIDATE_SUFFIXES) {
					if (uri.path.endsWith(suffix)) {
						this.briefingCache.clear();
						return;
					}
				}
			}
		}));
	}

	getWorkspaceRoot(): string | null {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return null;
		}
		// Try each folder — skip any that look like an IDE install directory
		for (const folder of folders) {
			const root = normalizePath(folder.uri.fsPath);
			const lower = root.toLowerCase();
			const isIdeInstall =
				(lower.includes('/cursor') && (lower.includes('programs') || lower.includes('app-') || lower.includes('resources')))
				|| lower.includes('/appdata/local/programs/')
				|| lower.endsWith('/cursor')
				|| lower.includes('.vscode/')
				|| lower.includes('/visual studio code/');
			if (!isIdeInstall) {
				return root;
			}
		}
		// All folders look like IDE dirs — return first one anyway as last resort
		return normalizePath(folders[0].uri.fsPath);
	}

	resolveFile(filePath: string): URI | null {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return null;
		}
		// Allow absolute paths to pass through; treat plain strings as relative.
		const normalized = normalizePath(filePath);
		if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) {
			return URI.file(normalized);
		}
		if (normalized.startsWith(`${MULTI_ROOT_INDEX_PREFIX}/`)) {
			return workspaceIndexUri(folders, normalized) ?? null;
		}
		return URI.joinPath(folders[0].uri, normalized);
	}

	relativize(uri: URI): string {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return normalizePath(uri.fsPath);
		}
		return workspaceIndexPath(folders, uri) ?? normalizePath(uri.fsPath);
	}

	/** Open + resolve a text model; auto-dispose the reference after `fn` resolves. */
	private async withModel<T>(uri: URI, fn: (model: ITextModel) => Promise<T>): Promise<T | null> {
		// Fast path: already-loaded model.
		const existing = this.modelService.getModel(uri);
		if (existing) {
			return fn(existing);
		}
		let ref: IReference<IResolvedTextEditorModel> | null = null;
		try {
			ref = await this.textModelService.createModelReference(uri);
			const model = ref.object.textEditorModel;
			if (!model) {
				return null;
			}
			return await fn(model);
		} catch (err) {
			this.logService.warn(`[LspBridgeAdapter] withModel failed for ${uri.toString()}:`, err);
			return null;
		} finally {
			ref?.dispose();
		}
	}

	// ---- Document & workspace symbols ----

	async getDocumentSymbols(filePath: string): Promise<SymbolEntry[]> {
		const uri = this.resolveFile(filePath);
		if (!uri) {
			return [];
		}
		const relPath = this.relativize(uri);
		const cacheKey = uri.toString();
		const result = await this.withModel(uri, async (model) => {
			const versionId = model.getVersionId();
			const cached = this.outlineCache.get(cacheKey);
			if (cached && cached.versionId === versionId) {
				// Refresh LRU-ish ordering so hot files survive eviction.
				this.outlineCache.delete(cacheKey);
				this.outlineCache.set(cacheKey, cached);
				return cached.entries;
			}
			const outline = await OutlineModel.create(this.languageFeaturesService.documentSymbolProvider, model, CancellationToken.None);
			const flat: SymbolEntry[] = [];
			const visit = (symbol: DocumentSymbol, container?: string) => {
				flat.push({
					name: symbol.name,
					kind: vsSymbolKindToCb(symbol.kind),
					filePath: relPath,
					line: symbol.selectionRange.startLineNumber - 1,
					character: symbol.selectionRange.startColumn - 1,
					endLine: symbol.range.endLineNumber - 1,
					containerName: container,
				});
				if (symbol.children) {
					for (const child of symbol.children) {
						visit(child, symbol.name);
					}
				}
			};
			for (const root of outline.getTopLevelSymbols()) {
				visit(root);
			}
			// Do NOT cache an empty outline. A cold TS server (file not yet open /
			// analyzed) returns no symbols; caching that would pin an empty result to
			// this file version until it is edited, so retries could never self-heal.
			// Skipping the cache lets the next call re-run the provider once it is warm.
			if (flat.length > 0) {
				this.outlineCache.set(cacheKey, { versionId, entries: flat });
				if (this.outlineCache.size > LspBridgeAdapter.OUTLINE_CACHE_MAX) {
					// Map iteration is insertion order; evict the oldest.
					const oldestKey = this.outlineCache.keys().next().value;
					if (oldestKey !== undefined) {
						this.outlineCache.delete(oldestKey);
					}
				}
			}
			return flat;
		});
		return result ?? [];
	}

	async getWorkspaceSymbols(query: string): Promise<SymbolEntry[]> {
		if (!query) {
			return [];
		}
		const items = await getWorkspaceSymbols(query, CancellationToken.None);
		const out: SymbolEntry[] = [];
		for (const item of items) {
			const sym = item.symbol;
			out.push({
				name: sym.name,
				kind: vsSymbolKindToCb(sym.kind),
				filePath: this.relativize(sym.location.uri),
				line: sym.location.range.startLineNumber - 1,
				character: sym.location.range.startColumn - 1,
				containerName: sym.containerName,
			});
		}
		return out;
	}

	async resolveSymbolLocation(filePath: string, symbolName: string): Promise<SymbolLocation | null> {
		// First try: scan document symbols of the input file.
		// Prefer callable kinds when several same-named symbols exist (e.g. a
		// toolsService `pack_context` param-validator property vs the real runner /
		// callTool implementation). First-match used to pick the validator stub.
		const docSyms = await this.getDocumentSymbols(filePath);
		const inFileMatches = docSyms.filter(s => s.name === symbolName);
		const KIND_RANK: Record<string, number> = {
			function: 0, method: 1, class: 2, interface: 3, enum: 4, type: 5,
			module: 6, property: 7, variable: 8, unknown: 9,
		};
		const pickBest = (pool: typeof inFileMatches) => {
			if (pool.length === 0) { return undefined; }
			return pool.slice().sort((a, b) => {
				const ka = KIND_RANK[a.kind] ?? 9;
				const kb = KIND_RANK[b.kind] ?? 9;
				if (ka !== kb) { return ka - kb; }
				// Prefer the longer body when endLine is known (implementation over stub).
				const la = (a.endLine ?? a.line) - a.line;
				const lb = (b.endLine ?? b.line) - b.line;
				if (la !== lb) { return lb - la; }
				return a.line - b.line;
			})[0];
		};
		const inFile = pickBest(inFileMatches);
		if (inFile) {
			return { filePath: inFile.filePath, line: inFile.line, character: inFile.character };
		}
		// Fallback: workspace symbol search. Prefer exact-name matches, then
		// disambiguate by file proximity so we don't silently resolve to an
		// unrelated same-named symbol (e.g. 'save', 'constructor', 'App') in
		// another file when the caller named a specific path.
		const wsSyms = await this.getWorkspaceSymbols(symbolName);
		if (wsSyms.length === 0) {
			return null;
		}
		const exactMatches = wsSyms.filter(s => s.name === symbolName);
		const pool = exactMatches.length > 0 ? exactMatches : wsSyms;
		let best = pool[0];
		let bestScore = trailingSegmentOverlap(best.filePath, filePath);
		for (const s of pool) {
			const score = trailingSegmentOverlap(s.filePath, filePath);
			if (score > bestScore) {
				best = s;
				bestScore = score;
			}
		}
		if (pool.length > 1 && bestScore === 0) {
			this.logService.trace(`[LspBridgeAdapter] resolveSymbolLocation: ${pool.length} candidates for '${symbolName}', none under '${filePath}' — picked '${best.filePath}'`);
		}
		return { filePath: best.filePath, line: best.line, character: best.character };
	}

	// ---- Definition / references ----

	async getDefinition(filePath: string, line: number, character: number): Promise<SymbolEntry | null> {
		const uri = this.resolveFile(filePath);
		if (!uri) {
			return null;
		}
		const links = await this.withModel(uri, (model) =>
			getDefinitionsAtPosition(
				this.languageFeaturesService.definitionProvider,
				model,
				new Position(line + 1, character + 1),
				false,
				CancellationToken.None,
			),
		);
		if (!links || links.length === 0) {
			return null;
		}
		const link = links[0];
		const targetRange = link.targetSelectionRange ?? link.range;
		const relPath = this.relativize(link.uri);
		// Pull a name + kind from doc symbols at the definition site.
		const defSymbols = await this.getDocumentSymbols(relPath);
		const targetLine = targetRange.startLineNumber - 1;
		const hit = defSymbols.find(s => s.line === targetLine);
		return {
			name: hit?.name ?? '<anonymous>',
			kind: hit?.kind ?? 'unknown',
			filePath: relPath,
			line: targetLine,
			character: targetRange.startColumn - 1,
			containerName: hit?.containerName,
		};
	}

	async getHoverSignature(filePath: string, line: number, character: number): Promise<string> {
		const uri = this.resolveFile(filePath);
		if (!uri) {
			return '';
		}
		const position = new Position(line + 1, character + 1);
		const parts = await this.withModel(uri, async (model) => {
			const providers = this.languageFeaturesService.hoverProvider.ordered(model);
			const out: string[] = [];
			for (const provider of providers) {
				let hover;
				try {
					hover = await provider.provideHover(model, position, CancellationToken.None);
				} catch {
					continue; // one bad provider must not sink the whole lookup
				}
				for (const content of hover?.contents ?? []) {
					const value = typeof content === 'string' ? content : content.value;
					if (value?.trim()) { out.push(value); }
				}
				if (out.length) { break; } // highest-ranked provider that answered wins
			}
			return out;
		});
		return extractHoverSignature(parts ?? []);
	}

	async getReferences(filePath: string, line: number, character: number): Promise<ReferenceEntry[]> {
		const uri = this.resolveFile(filePath);
		if (!uri) {
			return [];
		}
		const links = await this.withModel(uri, (model) =>
			getReferencesAtPosition(
				this.languageFeaturesService.referenceProvider,
				model,
				new Position(line + 1, character + 1),
				false,
				false,
				CancellationToken.None,
			),
		);
		if (!links) {
			return [];
		}
		return links.map((link: LocationLink | Location) => {
			const range = (link as LocationLink).range;
			const uri2 = (link as LocationLink).uri ?? (link as Location).uri;
			return {
				filePath: this.relativize(uri2),
				...rangeToLsp(range),
			};
		});
	}

	// ---- Call hierarchy ----

	private async withCallHierarchy<T>(
		filePath: string, line: number, character: number,
		fn: (model: CallHierarchyModel, root: CallHierarchyItem) => Promise<T>,
	): Promise<T | null> {
		const uri = this.resolveFile(filePath);
		if (!uri) {
			return null;
		}
		return this.withModel(uri, async (model) => {
			if (!CallHierarchyProviderRegistry.has(model)) {
				return null as unknown as T;
			}
			const ch = await CallHierarchyModel.create(model, new Position(line + 1, character + 1), CancellationToken.None);
			if (!ch || !ch.root) {
				return null as unknown as T;
			}
			try {
				return await fn(ch, ch.root);
			} finally {
				ch.dispose();
			}
		});
	}

	async getIncomingCalls(filePath: string, line: number, character: number): Promise<CallerEntry[]> {
		const calls = await this.withCallHierarchy(filePath, line, character, async (model, root) =>
			model.resolveIncomingCalls(root, CancellationToken.None),
		);
		if (calls && calls.length > 0) {
			return calls.map(call => ({
				name: call.from.name,
				kind: vsSymbolKindToCb(call.from.kind),
				filePath: this.relativize(call.from.uri),
				line: call.from.selectionRange.startLineNumber - 1,
				character: call.from.selectionRange.startColumn - 1,
				fromRanges: call.fromRanges.map(rangeToLsp),
			}));
		}
		// Fallback: synthesize callers from references when call hierarchy is empty.
		// This handles cases where the TS language service hasn't fully indexed,
		// or when the call hierarchy provider isn't available.
		return this.synthCallersFallback(filePath, line, character);
	}

	private async synthCallersFallback(filePath: string, line: number, character: number): Promise<CallerEntry[]> {
		const refs = await this.getReferences(filePath, line, character);
		if (refs.length === 0) { return []; }

		const callers: CallerEntry[] = [];
		const seen = new Set<string>();
		for (const ref of refs) {
			if (ref.filePath === filePath && ref.line === line) { continue; }
			const key = `${ref.filePath}:${ref.line}`;
			if (seen.has(key)) { continue; }
			seen.add(key);

			const syms = await this.getDocumentSymbols(ref.filePath);
			let containingSymbol: SymbolEntry | undefined;
			for (const s of syms) {
				if (s.line <= ref.line) {
					if (!containingSymbol || s.line > containingSymbol.line) {
						containingSymbol = s;
					}
				}
			}
			if (containingSymbol) {
				callers.push({
					name: containingSymbol.name,
					kind: containingSymbol.kind,
					filePath: ref.filePath,
					line: containingSymbol.line,
					character: containingSymbol.character ?? 0,
					fromRanges: [{ line: ref.line, character: ref.character, endLine: ref.endLine, endCharacter: ref.endCharacter }],
				});
			} else {
				callers.push({
					name: `<${ref.filePath.split('/').pop()}>`,
					kind: 'unknown',
					filePath: ref.filePath,
					line: ref.line,
					character: ref.character,
					fromRanges: [{ line: ref.line, character: ref.character, endLine: ref.endLine, endCharacter: ref.endCharacter }],
				});
			}
			if (callers.length >= 20) { break; }
		}
		return callers;
	}

	async getOutgoingCalls(filePath: string, line: number, character: number): Promise<CallerEntry[]> {
		const calls = await this.withCallHierarchy(filePath, line, character, async (model, root) =>
			model.resolveOutgoingCalls(root, CancellationToken.None),
		);
		if (!calls) { return []; }
		return calls.map(call => ({
			name: call.to.name,
			kind: vsSymbolKindToCb(call.to.kind),
			filePath: this.relativize(call.to.uri),
			line: call.to.selectionRange.startLineNumber - 1,
			character: call.to.selectionRange.startColumn - 1,
			fromRanges: call.fromRanges.map(rangeToLsp),
		}));
	}

	// ---- Type hierarchy ----

	private async withTypeHierarchy<T>(
		filePath: string, line: number, character: number,
		fn: (model: TypeHierarchyModel, root: TypeHierarchyItem) => Promise<T>,
	): Promise<T | null> {
		const uri = this.resolveFile(filePath);
		if (!uri) {
			return null;
		}
		return this.withModel(uri, async (model) => {
			if (!TypeHierarchyProviderRegistry.has(model)) {
				return null as unknown as T;
			}
			const th = await TypeHierarchyModel.create(model, new Position(line + 1, character + 1), CancellationToken.None);
			if (!th || !th.root) {
				return null as unknown as T;
			}
			try {
				return await fn(th, th.root);
			} finally {
				th.dispose();
			}
		});
	}

	async getSupertypes(filePath: string, line: number, character: number): Promise<TypeHierarchyEntry[]> {
		const items = await this.withTypeHierarchy(filePath, line, character, async (model, root) =>
			model.provideSupertypes(root, CancellationToken.None),
		);
		return this.mapTypeHierarchyItems(items);
	}

	async getSubtypes(filePath: string, line: number, character: number): Promise<TypeHierarchyEntry[]> {
		const items = await this.withTypeHierarchy(filePath, line, character, async (model, root) =>
			model.provideSubtypes(root, CancellationToken.None),
		);
		return this.mapTypeHierarchyItems(items);
	}

	private mapTypeHierarchyItems(items: TypeHierarchyItem[] | null): TypeHierarchyEntry[] {
		if (!items) { return []; }
		const seen = new Set<string>();
		const out: TypeHierarchyEntry[] = [];
		for (const it of items) {
			const key = `${it.uri.toString()}:${it.selectionRange.startLineNumber}:${it.name}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			out.push({
				name: it.name,
				kind: vsSymbolKindToCb(it.kind),
				filePath: this.relativize(it.uri),
				line: it.selectionRange.startLineNumber - 1,
				character: it.selectionRange.startColumn - 1,
				detail: it.detail,
			});
		}
		return out;
	}

	// ---- Diagnostics ----

	async getDiagnostics(filePath: string): Promise<DiagnosticEntry[]> {
		const uri = this.resolveFile(filePath);
		if (!uri) {
			return [];
		}
		const relPath = this.relativize(uri);
		const markers = this.markerService.read({ resource: uri });
		return markers.map((m: IMarker) => ({
			filePath: relPath,
			line: m.startLineNumber - 1,
			severity: markerSeverityToCb(m.severity),
			message: m.message,
			source: m.source,
		}));
	}

	// ---- Snippet ----

	async readSnippet(filePath: string, line: number, contextLines: number = 3, endLine?: number): Promise<{ startLine: number; lines: string[] }> {
		const uri = this.resolveFile(filePath);
		if (!uri) {
			return { startLine: 0, lines: [] };
		}
		// Prefer in-memory model when loaded; falls back to disk read.
		const existing = this.modelService.getModel(uri);
		let allLines: string[];
		if (existing) {
			allLines = existing.getLinesContent();
		} else {
			try {
				const file = await this.fileService.readFile(uri);
				allLines = file.value.toString().split(/\r\n|\r|\n/);
			} catch {
				return { startLine: 0, lines: [] };
			}
		}
		// When endLine is known (full symbol range from outline), return the body
		// with a small pad instead of the old +/-contextLines window around the name.
		// Cap so pack_context can't dump multi-thousand-line classes into chat.
		const MAX_BODY_LINES = 220;
		let start: number;
		let end: number;
		if (typeof endLine === 'number' && Number.isFinite(endLine) && endLine >= line) {
			const pad = Math.min(2, Math.max(0, contextLines));
			start = Math.max(0, line - pad);
			end = Math.min(allLines.length, endLine + 1 + pad);
			if (end - start > MAX_BODY_LINES) {
				end = start + MAX_BODY_LINES;
			}
		} else {
			start = Math.max(0, line - contextLines);
			end = Math.min(allLines.length, line + contextLines + 1);
		}
		return { startLine: start, lines: allLines.slice(start, end) };
	}

	// ---- Briefing cache ----

	async getOrComputeBriefing(key: string, compute: () => Promise<ProjectBriefingOutput>): Promise<ProjectBriefingOutput> {
		const entry = this.briefingCache.get(key);
		if (entry && Date.now() < entry.expiresAt) {
			return entry.value;
		}
		if (entry) {
			this.briefingCache.delete(key);
		}
		const value = await compute();
		this.briefingCache.set(key, { value, expiresAt: Date.now() + LspBridgeAdapter.BRIEFING_TTL_MS });
		return value;
	}

	invalidateBriefingCache(): void {
		this.briefingCache.clear();
	}
}

registerSingleton(ILspBridgeAdapter, LspBridgeAdapter, InstantiationType.Delayed);
