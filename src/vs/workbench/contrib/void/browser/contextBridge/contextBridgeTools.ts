/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// LSP-backed Context Bridge tool implementations (Phase B.2 of vselite).
// Each tool is a pure async function so toolsService.ts can call them
// directly. State lives in the singletons we accept (ILspBridgeAdapter,
// IContextBridgeService, IFileService, IWorkspaceContextService).

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IContextBridgeService } from '../../common/contextBridge/contextBridgeService.js';
import {
	CallerEntry,
	CallerWithSnippet,
	CallGraphNode,
	CallGraphOutput,
	FileContextOutput,
	FileDependenciesOutput,
	ImportEntry,
	PackContextOutput,
	PackContextTask,
	ProjectBriefingOutput,
	ReferenceWithSnippet,
	ResolvedImportEntry,
	SymbolContextOutput,
	SymbolEntry,
	SymbolNote,
	TypeHierarchyEntry,
} from '../../common/contextBridge/contextBridgeTypes.js';
import { ILspBridgeAdapter } from './lspBridgeAdapter.js';

// ---- Import parsing (ported verbatim from cb-core/get-file-context.ts) ----

const IMPORT_RE =
	/^\s*import\s+(?:(type)\s+)?(?:(\*\s+as\s+\w+|\{[^}]*\}|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?["']([^"']+)["']/;

export function parseImportsFromText(text: string): ImportEntry[] {
	const lines = text.split(/\r?\n/);
	const imports: ImportEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match = IMPORT_RE.exec(lines[i]);
		if (!match) { continue; }
		const [, typeKeyword, importClause, module] = match;
		const names: string[] = [];
		if (importClause) {
			const braceMatch = /\{([^}]*)\}/.exec(importClause);
			if (braceMatch) {
				for (const n of braceMatch[1].split(',')) {
					const cleaned = n.trim().replace(/\s+as\s+\w+$/, '').replace(/^type\s+/, '').trim();
					if (cleaned) { names.push(cleaned); }
				}
			}
			const defaultMatch = /^(\w+)(?:\s*,|$)/.exec(importClause);
			if (defaultMatch) { names.unshift(defaultMatch[1]); }
			const starMatch = /\*\s+as\s+(\w+)/.exec(importClause);
			if (starMatch) { names.push(`* as ${starMatch[1]}`); }
		}
		imports.push({ module, line: i, importedNames: names, isTypeOnly: Boolean(typeKeyword) });
	}
	return imports;
}

// ---- Syntactic symbol fallback (used when the LSP outline is cold/empty) ----
//
// A deliberately small top-level-declaration scan, mirroring parseImportsFromText:
// no type info, just the visible top-level declarations (column 0 -- nested members
// are out of reach for a regex) so a non-empty code file is never reported as
// symbol-less while the TS server is still warming. Real LSP symbols always win;
// this only runs when getDocumentSymbols returns nothing.
const TOP_LEVEL_DECL_RE =
	/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|enum|type|function|const|let|var)\s+([A-Za-z_$][\w$]*)/;

const DECL_KEYWORD_TO_KIND: Record<string, SymbolEntry['kind']> = {
	class: 'class', interface: 'interface', enum: 'enum', type: 'type',
	function: 'function', const: 'variable', let: 'variable', var: 'variable',
};

export function parseTopLevelSymbolsFromText(text: string, filePath: string): SymbolEntry[] {
	const lines = text.split(/\r?\n/);
	const symbols: SymbolEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match = TOP_LEVEL_DECL_RE.exec(lines[i]);
		if (!match) { continue; }
		const [, keyword, name] = match;
		const character = lines[i].indexOf(name);
		symbols.push({
			name,
			kind: DECL_KEYWORD_TO_KIND[keyword] ?? 'unknown',
			filePath,
			line: i,
			character: character < 0 ? 0 : character,
		});
	}
	return symbols;
}

// ---- File helpers ----

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const SKIP_DIRS = new Set([
	'node_modules', 'dist', 'build', 'out', '.git', '.cache', 'coverage',
	'target', '__pycache__', '.turbo', '.vite', '.next', '.vscode-test',
]);
/** How many references get printed in symbol/pack context before the list is elided. */
const MAX_RENDERED_REFERENCES = 20;
const MAX_DEP_FILES = 2000;
const MAX_TREE_DEPTH = 3;
const MAX_TREE_ENTRIES = 200;

function normalizePath(p: string): string {
	return p.split('\\').join('/');
}

function joinPosix(...parts: string[]): string {
	const joined = parts.filter(Boolean).join('/');
	return normalizePath(joined).replace(/\/+/g, '/');
}

function dirnamePosix(p: string): string {
	const norm = normalizePath(p);
	const i = norm.lastIndexOf('/');
	return i <= 0 ? '' : norm.slice(0, i);
}



function resolvePosix(base: string, rel: string): string {
	const parts = (base ? base.split('/') : []).concat(rel.split('/'));
	const out: string[] = [];
	for (const p of parts) {
		if (!p || p === '.') { continue; }
		if (p === '..') { out.pop(); continue; }
		out.push(p);
	}
	return out.join('/');
}

async function readTextFile(fileService: IFileService, uri: URI): Promise<string | null> {
	try {
		const content = await fileService.readFile(uri);
		return content.value.toString();
	} catch {
		return null;
	}
}

// ---- 1. get_file_context ----

/**
 * Stdlib/dependency call-graph noise: callees/callers resolving into node_modules or a
 * lib.*.d.ts (Promise.all, Array.filter, Math.abs, localize from a vendored copy, …) are never
 * actionable and eat the token budget real edges need. Module-scope so BOTH get_symbol_context
 * and get_call_graph can filter with it (it was previously a local const the graph walker
 * couldn't reach — R-2).
 */
export function isStdlibOrDepPath(p: string | undefined): boolean {
	return !!p && (/(^|\/)node_modules\//.test(p) || /(^|\/)lib\.[^/]*\.d\.ts$/.test(p));
}

export async function runGetFileContext(
	adapter: ILspBridgeAdapter,
	fileService: IFileService,
	params: { filePath: string },
): Promise<FileContextOutput> {
	const { filePath } = params;
	const uri = adapter.resolveFile(filePath);
	if (!uri) {
		return { filePath, symbols: [], imports: [], diagnostics: [] };
	}
	const [lspSymbols, diagnostics, text] = await Promise.all([
		adapter.getDocumentSymbols(filePath),
		adapter.getDiagnostics(filePath),
		readTextFile(fileService, uri),
	]);
	const imports = text ? parseImportsFromText(text) : [];
	// The LSP outline is empty when the TS server has not analyzed this file yet
	// (e.g. it is not open in the editor). Imports are always text-parsed, so an
	// empty symbol list would silently look symbol-less. Fall back to a syntactic
	// top-level scan so a non-empty code file always returns a usable map; the
	// caller is told via symbolsFromFallback to retry once the server is warm.
	let symbols = lspSymbols;
	let symbolsFromFallback = false;
	if (symbols.length === 0 && text) {
		const fallback = parseTopLevelSymbolsFromText(text, filePath);
		if (fallback.length > 0) {
			symbols = fallback;
			symbolsFromFallback = true;
		}
	}
	// Drop function-local variables so the file MAP isn't drowned (and truncated) by every
	// `.i`, `.braceMatch`, `.cleaned` inside a function body. Class fields map to 'property',
	// and top-level consts/vars have no container, so this removes only in-function locals —
	// leaving the actual top-level + member skeleton the caller wants.
	symbols = symbols.filter(s => !(s.kind === 'variable' && !!s.containerName));
	return { filePath, symbols, imports, diagnostics, symbolsFromFallback };
}

// ---- 2. get_file_dependencies ----

async function listWorkspaceSourceFiles(
	fileService: IFileService,
	rootUri: URI,
	limit: number,
): Promise<URI[]> {
	const out: URI[] = [];
	const queue: URI[] = [rootUri];
	while (queue.length > 0 && out.length < limit) {
		const dir = queue.shift()!;
		let stat;
		try {
			stat = await fileService.resolve(dir);
		} catch {
			continue;
		}
		if (!stat.children) { continue; }
		for (const child of stat.children) {
			if (out.length >= limit) { break; }
			const name = child.name;
			if (child.isDirectory) {
				if (SKIP_DIRS.has(name)) { continue; }
				if (name.startsWith('.') && name !== '.github') { continue; }
				queue.push(child.resource);
			} else {
				const lower = name.toLowerCase();
				if (SOURCE_EXTS.some(e => lower.endsWith(e))) {
					out.push(child.resource);
				}
			}
		}
	}
	return out;
}

function resolveRelativeImport(
	fromFilePath: string,
	moduleSpecifier: string,
	allFiles: Set<string>,
): string | null {
	if (!moduleSpecifier.startsWith('.')) { return null; }
	const fromDir = dirnamePosix(fromFilePath);
	const base = resolvePosix(fromDir, moduleSpecifier);
	const candidates: string[] = [];
	if (SOURCE_EXTS.some(e => base.toLowerCase().endsWith(e))) {
		candidates.push(base);
	} else {
		for (const ext of SOURCE_EXTS) { candidates.push(base + ext); }
		for (const ext of SOURCE_EXTS) { candidates.push(joinPosix(base, 'index' + ext)); }
		// Also try .js → .ts swap (common in ESM-style relative imports inside TS projects).
		if (base.toLowerCase().endsWith('.js')) {
			candidates.push(base.slice(0, -3) + '.ts');
			candidates.push(base.slice(0, -3) + '.tsx');
		}
	}
	for (const c of candidates) {
		if (allFiles.has(c)) { return c; }
	}
	return null;
}

export async function runGetFileDependencies(
	adapter: ILspBridgeAdapter,
	fileService: IFileService,
	workspace: IWorkspaceContextService,
	params: { filePath: string },
): Promise<FileDependenciesOutput> {
	const { filePath } = params;
	const folders = workspace.getWorkspace().folders;
	if (folders.length === 0) {
		throw new Error('No workspace is open. Select a project before reading file dependencies.');
	}
	const rootUri = folders[0].uri;
	const subjectUri = adapter.resolveFile(filePath);
	if (!subjectUri || !(await fileService.exists(subjectUri))) {
		throw new Error(`File not found in the selected workspace: ${filePath}`);
	}

	const allFileUris = await listWorkspaceSourceFiles(fileService, rootUri, MAX_DEP_FILES);
	const relPaths = allFileUris.map(u => adapter.relativize(u));
	const fileSet = new Set(relPaths);

	// Parse subject file's own imports.
	const subjectText = await readTextFile(fileService, subjectUri);
	const subjectImports = subjectText ? parseImportsFromText(subjectText) : [];
	const directImports: ResolvedImportEntry[] = subjectImports.map(imp => ({
		...imp,
		resolvedFilePath: resolveRelativeImport(filePath, imp.module, fileSet),
	}));

	const externalCounts = new Map<string, number>();
	for (const imp of subjectImports) {
		if (!imp.module.startsWith('.')) {
			externalCounts.set(imp.module, (externalCounts.get(imp.module) ?? 0) + 1);
		}
	}
	const externalImports = Array.from(externalCounts.entries())
		.map(([module, count]) => ({ module, count }))
		.sort((a, b) => b.count - a.count);

	// Scan every other source file for imports pointing at this one.
	const importedBy: FileDependenciesOutput['importedBy'] = [];
	for (let i = 0; i < allFileUris.length; i++) {
		const otherPath = relPaths[i];
		if (otherPath === filePath) { continue; }
		const otherText = await readTextFile(fileService, allFileUris[i]);
		if (!otherText) { continue; }
		const otherImports = parseImportsFromText(otherText);
		for (const imp of otherImports) {
			if (!imp.module.startsWith('.')) { continue; }
			const resolved = resolveRelativeImport(otherPath, imp.module, fileSet);
			if (resolved === filePath) {
				importedBy.push({
					filePath: otherPath,
					line: imp.line,
					importedNames: imp.importedNames,
					isTypeOnly: imp.isTypeOnly,
				});
			}
		}
	}

	return {
		filePath,
		directImports,
		externalImports,
		importedBy,
		scannedFiles: allFileUris.length,
	};
}

// ---- 3. get_symbol_context ----

export async function runGetSymbolContext(
	adapter: ILspBridgeAdapter,
	notes: IContextBridgeService,
	params: { filePath: string; symbolName: string },
): Promise<SymbolContextOutput> {
	const { filePath, symbolName } = params;
	const location = await adapter.resolveSymbolLocation(filePath, symbolName);
	const savedNotes = await notes.getNotesForSymbol(filePath, symbolName);

	if (!location) {
		return {
			symbol: null,
			definition: null,
			callers: [],
			callees: [],
			references: [],
			diagnostics: [],
			supertypes: [],
			subtypes: [],
			notes: savedNotes,
			via: 'text',
		};
	}

	// Independent provider calls must not each add another round-trip to context packing.
	const [def, outlineSyms] = await Promise.all([
		adapter.getDefinition(location.filePath, location.line, location.character),
		adapter.getDocumentSymbols(location.filePath).catch(() => [] as SymbolEntry[]),
	]);
	const outlineHit = outlineSyms.find(s => s.name === symbolName && Math.abs(s.line - location.line) <= 2)
		?? outlineSyms.find(s => s.name === symbolName);
	const symbol: SymbolEntry = {
		...(def ?? {
			name: symbolName,
			kind: outlineHit?.kind ?? 'unknown',
			filePath: location.filePath,
			line: location.line,
			character: location.character,
		}),
		endLine: outlineHit?.endLine ?? def?.endLine,
		kind: (def && def.kind !== 'unknown' ? def.kind : undefined) ?? outlineHit?.kind ?? def?.kind ?? 'unknown',
	};

	const [callersRaw, calleesRaw, references, diagnostics] = await Promise.all([
		adapter.getIncomingCalls(location.filePath, location.line, location.character),
		adapter.getOutgoingCalls(location.filePath, location.line, location.character),
		adapter.getReferences(location.filePath, location.line, location.character),
		adapter.getDiagnostics(location.filePath),
	]);

	// Drop stdlib/dependency noise (module-scope isStdlibOrDepPath — see R-2).
	const callers = callersRaw.filter(c => !isStdlibOrDepPath(c.filePath));
	const callees = calleesRaw.filter(c => !isStdlibOrDepPath(c.filePath));

	// Type hierarchy only meaningful for class/interface/enum/type-like kinds.
	let supertypes: TypeHierarchyEntry[] = [];
	let subtypes: TypeHierarchyEntry[] = [];
	if (symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'enum' || symbol.kind === 'type') {
		[supertypes, subtypes] = await Promise.all([
			adapter.getSupertypes(location.filePath, location.line, location.character),
			adapter.getSubtypes(location.filePath, location.line, location.character),
		]);
	}

	// Inline diagnostics filter — limit to ones touching the symbol's line +/- a small window.
	const symbolDiagnostics = diagnostics.filter(d => Math.abs(d.line - location.line) <= 30);

	// Prefer full symbol body when outline gave us endLine; fall back to a wider +/- window
	// so large functions aren't reduced to a signature + a few lines.
	const endLine = symbol.endLine;
	const snippet = await adapter.readSnippet(
		location.filePath,
		location.line,
		typeof endLine === 'number' ? 2 : 40,
		endLine,
	);
	const definition = snippet.lines.length > 0
		? snippet.lines.map((l, i) => `${snippet.startLine + i + 1} | ${l}`).join('\n')
		: null;

	return {
		symbol,
		definition,
		callers,
		callees,
		references,
		diagnostics: symbolDiagnostics,
		supertypes,
		subtypes,
		notes: savedNotes,
		via: 'lsp',
	};
}

// ---- 4. get_call_graph ----

export async function runGetCallGraph(
	adapter: ILspBridgeAdapter,
	params: { filePath: string; symbolName: string; direction: 'incoming' | 'outgoing'; depth: number },
): Promise<CallGraphOutput> {
	const depth = Math.min(Math.max(1, params.depth || 2), 4);
	const direction = params.direction || 'incoming';
	const root = await adapter.resolveSymbolLocation(params.filePath, params.symbolName);
	if (!root) {
		return {
			symbol: { name: params.symbolName, filePath: params.filePath, line: 0, character: 0 },
			direction, depth, totalNodes: 0, tree: [],
		};
	}

	const seen = new Set<string>();
	const keyOf = (filePath: string, line: number, name: string) => `${filePath}:${line}:${name}`;
	seen.add(keyOf(root.filePath, root.line, params.symbolName));

	let totalNodes = 1;
	const fetch = direction === 'incoming'
		? adapter.getIncomingCalls.bind(adapter)
		: adapter.getOutgoingCalls.bind(adapter);

	const walk = async (filePath: string, line: number, character: number, levelsLeft: number): Promise<CallGraphNode[]> => {
		if (levelsLeft <= 0) { return []; }
		const callers = await fetch(filePath, line, character);
		const nodes: CallGraphNode[] = [];
		for (const caller of callers) {
			// Skip stdlib/dependency nodes (R-2) — same filter get_symbol_context uses.
			if (isStdlibOrDepPath(caller.filePath)) { continue; }
			const key = keyOf(caller.filePath, caller.line, caller.name);
			if (seen.has(key)) { continue; }
			seen.add(key);
			totalNodes++;
			const children = await walk(caller.filePath, caller.line, caller.character, levelsLeft - 1);
			nodes.push({
				name: caller.name,
				kind: caller.kind,
				filePath: caller.filePath,
				line: caller.line,
				character: caller.character,
				children,
			});
		}
		return nodes;
	};

	const tree = await walk(root.filePath, root.line, root.character, depth);

	return {
		symbol: { name: params.symbolName, filePath: root.filePath, line: root.line, character: root.character },
		direction, depth, totalNodes, tree,
	};
}

// ---- 5. pack_context ----

interface PackCaps { callers: number; references: number; callerCtx: number }
const CAPS: Record<PackContextTask, PackCaps> = {
	// understand was too thin (1 ref) for "how is this used"; keep compact but usable.
	understand: { callers: 3, references: 4, callerCtx: 8 },
	refactor: { callers: 10, references: 8, callerCtx: 4 },
	debug: { callers: 6, references: 4, callerCtx: 6 },
	extend: { callers: 4, references: 2, callerCtx: 4 },
};

function estimateTokens(o: unknown): number {
	try { return Math.ceil(JSON.stringify(o).length / 4); } catch { return 0; }
}

export async function runPackContext(
	adapter: ILspBridgeAdapter,
	notes: IContextBridgeService,
	params: { filePath: string; symbolName: string; task: PackContextTask; maxTokens: number },
): Promise<PackContextOutput> {
	const task = params.task || 'understand';
	const maxTokens = Math.max(500, params.maxTokens || 3000);
	const caps = CAPS[task];

	const ctx = await runGetSymbolContext(adapter, notes, { filePath: params.filePath, symbolName: params.symbolName });

	// Apply per-task caps.
	const cappedCallers = ctx.callers.slice(0, caps.callers);
	const cappedReferences = ctx.references.slice(0, caps.references);

	// Hydrate caller + reference snippets.
	const callerSnippets: CallerWithSnippet[] = await Promise.all(
		cappedCallers.map(async (c): Promise<CallerWithSnippet> => ({
			...c,
			snippet: await adapter.readSnippet(c.filePath, c.line, caps.callerCtx),
		})),
	);
	const refSnippets: ReferenceWithSnippet[] = await Promise.all(
		cappedReferences.map(async (r): Promise<ReferenceWithSnippet> => ({
			...r,
			snippet: await adapter.readSnippet(r.filePath, r.line, 2),
		})),
	);

	let referencesDropped = ctx.references.length - cappedReferences.length;
	let callerSnippetsDropped = ctx.callers.length - cappedCallers.length;
	let working: PackContextOutput = {
		task,
		symbol: ctx.symbol,
		definition: ctx.definition,
		notes: [...ctx.notes],
		diagnostics: ctx.diagnostics,
		callers: callerSnippets,
		callees: ctx.callees,
		references: refSnippets,
		supertypes: ctx.supertypes,
		subtypes: ctx.subtypes,
		meta: {
			estimated_tokens: 0,
			truncated: { references_dropped: referencesDropped, caller_snippets_dropped: callerSnippetsDropped, hit_budget: false },
		},
	};

	// A large class body must not consume the entire pack before caller evidence fits.
	if (working.definition && working.definition.length > maxTokens * 2) {
		working.definition = working.definition.slice(0, maxTokens * 2) + '\n[Definition truncated; request a narrower symbol or source range.]';
	}
	// Budget trim: drop references first, then strip caller snippets in-place,
	// then drop callers entirely (old loop popped then only cleared snippet on the
	// detached entry — callers list never actually shrank after the first strip).
	let tokens = estimateTokens(working);
	while (tokens > maxTokens && working.references.length > 0) {
		working.references.pop();
		referencesDropped++;
		tokens = estimateTokens(working);
	}
	for (let i = working.callers.length - 1; tokens > maxTokens && i >= 0; i--) {
		const c = working.callers[i];
		if (c.snippet.lines.length === 0) { continue; }
		c.snippet = { startLine: 0, lines: [] };
		callerSnippetsDropped++;
		tokens = estimateTokens(working);
	}
	while (tokens > maxTokens && working.callers.length > 0) {
		working.callers.pop();
		callerSnippetsDropped++;
		tokens = estimateTokens(working);
	}

	working.meta.estimated_tokens = tokens;
	working.meta.truncated.references_dropped = referencesDropped;
	working.meta.truncated.caller_snippets_dropped = callerSnippetsDropped;
	working.meta.truncated.hit_budget = tokens > maxTokens;
	return working;
}

// ---- 6. get_project_briefing ----

const AGENTS_CANDIDATES = [
	'AGENTS.md',
	'.github/AGENTS.md',
	'.github/copilot-instructions.md',
];

function sliceSection(md: string, heading: string): string | null {
	const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
	const start = md.search(re);
	if (start === -1) { return null; }
	const after = md.slice(start);
	const nextHeading = after.slice(1).search(/^##\s+/m);
	const body = nextHeading === -1 ? after : after.slice(0, nextHeading + 1);
	const trimmed = body.trim();
	return trimmed.length > 0 ? trimmed : null;
}

// Cap a journal section at a LINE boundary, never mid-word (PP-1). The old code
// hard-sliced the raw journal at 24000 chars before extracting sections, so a
// section living past that byte was silently cut mid-word ("…DEEPSEEK-HAND") or
// lost entirely — the agent flew half-blind on the roadmap with no signal that
// anything was missing. Cap each section instead, on a newline, with an explicit
// marker so the agent knows to read the file directly for the rest.
const MAX_SECTION_CHARS = 8000;
function capSectionAtLineBoundary(s: string | null, max: number = MAX_SECTION_CHARS): string | null {
	if (s === null || s.length <= max) { return s; }
	const cut = s.lastIndexOf('\n', max);
	const body = s.slice(0, cut > 0 ? cut : max);
	const omitted = s.length - body.length;
	return `${body}\n\n[... section truncated: ${omitted} more chars in this section — open the journal file (AGENTS.md) directly for the full text ...]`;
}

// Guard against a pathologically huge journal file. Only the EXTRACTED sections
// reach the model, so returning the full text here is safe and correct — we cut
// only enormous files, and only on a newline so section extraction below still
// sees whole lines.
const MAX_JOURNAL_CHARS = 200000;
async function readJournal(
	fileService: IFileService,
	rootUri: URI,
): Promise<{ raw: string | null; path: string | null }> {
	for (const candidate of AGENTS_CANDIDATES) {
		const uri = URI.joinPath(rootUri, candidate);
		const text = await readTextFile(fileService, uri);
		if (text !== null) {
			let raw = text;
			if (text.length > MAX_JOURNAL_CHARS) {
				const cut = text.lastIndexOf('\n', MAX_JOURNAL_CHARS);
				raw = text.slice(0, cut > 0 ? cut : MAX_JOURNAL_CHARS);
			}
			return { raw, path: candidate };
		}
	}
	return { raw: null, path: null };
}

async function curatedFileTree(
	fileService: IFileService,
	rootUri: URI,
	rootPath: string,
): Promise<string> {
	const lines: string[] = [];
	const walk = async (dirUri: URI, dirRel: string, depth: number): Promise<void> => {
		if (lines.length >= MAX_TREE_ENTRIES || depth > MAX_TREE_DEPTH) { return; }
		let stat;
		try { stat = await fileService.resolve(dirUri); } catch { return; }
		if (!stat.children) { return; }
		const sorted = [...stat.children].sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
			return a.name.localeCompare(b.name);
		});
		for (const child of sorted) {
			if (lines.length >= MAX_TREE_ENTRIES) { return; }
			if (child.name.startsWith('.') && child.name !== '.github') { continue; }
			if (SKIP_DIRS.has(child.name)) { continue; }
			const rel = dirRel ? `${dirRel}/${child.name}` : child.name;
			if (child.isDirectory) {
				lines.push('  '.repeat(depth) + child.name + '/');
				await walk(child.resource, rel, depth + 1);
			} else {
				lines.push('  '.repeat(depth) + child.name);
			}
		}
	};
	await walk(rootUri, '', 0);
	void rootPath;
	return lines.join('\n');
}

/**
 * Resolve every reflog file that can hold recent commits for this workspace.
 *
 * A linked git worktree stores `.git` as a FILE containing `gitdir: <path>`, not a
 * directory — so joining `.git/logs/HEAD` always failed there and the briefing
 * silently lost its git history, which is precisely how every lane worktree runs.
 * A worktree has its own `<gitdir>/logs/HEAD` plus the shared `<commondir>/logs/HEAD`;
 * both are returned so recent commits surface no matter which side made them.
 * Ordinary repos get the classic single path.
 */
async function resolveHeadLogUris(
	fileService: IFileService,
	rootUri: URI,
): Promise<URI[]> {
	const dotGit = URI.joinPath(rootUri, '.git');
	const dotGitText = await readTextFile(fileService, dotGit);
	if (dotGitText === null) {
		// A real directory (ordinary repo) or unreadable — use the classic layout.
		return [URI.joinPath(dotGit, 'logs', 'HEAD')];
	}
	const gitDirMatch = /^\s*gitdir:\s*(.+?)\s*$/m.exec(dotGitText);
	if (!gitDirMatch) {
		return [URI.joinPath(dotGit, 'logs', 'HEAD')];
	}
	const target = gitDirMatch[1];
	const gitDir = /^([a-zA-Z]:[\\/]|[\\/])/.test(target) ? URI.file(target) : URI.joinPath(rootUri, target);
	// `commondir` is relative to the git dir in practice ('../..'), but the format
	// permits an absolute path, so accept both. URI.joinPath posix-joins, which
	// normalizes the travel segments.
	const resolveFromGitDir = (p: string): URI => /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
		? URI.file(p)
		: URI.joinPath(gitDir, ...p.split(/[\\/]+/).filter(Boolean));

	const uris = [URI.joinPath(gitDir, 'logs', 'HEAD')];
	const commonRaw = await readTextFile(fileService, URI.joinPath(gitDir, 'commondir'));
	const commonRel = commonRaw?.trim();
	if (commonRel) {
		const common = resolveFromGitDir(commonRel);
		if (common.toString() !== gitDir.toString()) {
			uris.push(URI.joinPath(common, 'logs', 'HEAD'));
		}
	}
	return uris;
}

/**
 * Recent commits, newest first, read from the git reflog (never a subprocess — the
 * renderer cannot spawn one). Reads every reflog `resolveHeadLogUris` found and
 * merges them, so a linked worktree sees both its own commits and shared history.
 */
async function readRecentCommits(
	fileService: IFileService,
	rootUri: URI,
): Promise<string[]> {
	const parsed: { ts: number; hash: string; msg: string }[] = [];
	for (const uri of await resolveHeadLogUris(fileService, rootUri)) {
		const raw = await readTextFile(fileService, uri);
		if (!raw) { continue; }
		// Each line: <old> <new> <name> <email> <unix> <tz>\t<msg>
		// The timestamp must be matched from the END: the name may contain spaces and
		// the email is its own token, so a fixed index picks up "<user@host>" and
		// Number() yields NaN — which silently disabled the sort below.
		for (const line of raw.split(/\r?\n/)) {
			if (!line) { continue; }
			const tabIdx = line.indexOf('\t');
			const left = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
			const msg = tabIdx >= 0 ? line.slice(tabIdx + 1) : '';
			const toHash = left.split(/\s+/)[1] ?? '';
			if (!toHash) { continue; }
			const tsMatch = / (\d{9,}) ([+-]\d{4})$/.exec(left);
			parsed.push({ ts: tsMatch ? Number(tsMatch[1]) : 0, hash: toHash, msg });
		}
	}
	// Order by the reflog's own timestamp rather than file position: with two logs
	// merged there is no single "last 20 lines" anymore.
	parsed.sort((a, b) => b.ts - a.ts);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const e of parsed) {
		// One commit can be recorded by more than one reflog (worktree + shared) — list once.
		if (seen.has(e.hash)) { continue; }
		seen.add(e.hash);
		out.push(`${e.hash.slice(0, 8)} ${e.msg}`.trim());
		if (out.length >= 20) { break; }
	}
	return out;
}

export async function runGetProjectBriefing(
	adapter: ILspBridgeAdapter,
	fileService: IFileService,
	workspace: IWorkspaceContextService,
	notes: IContextBridgeService,
	params: { includeNotes: boolean },
): Promise<ProjectBriefingOutput> {
	const cacheKey = params.includeNotes ? 'with-notes' : 'no-notes';
	return adapter.getOrComputeBriefing(cacheKey, async () => {
		const workspaceRoot = adapter.getWorkspaceRoot();
		const folders = workspace.getWorkspace().folders;
		if (folders.length === 0 || !workspaceRoot) {
			return {
				workspaceRoot: null,
				hasJournal: false,
				journal: { recentChanges: null, sessionMemory: null },
				fileTree: '',
				recentCommits: [],
				notes: [],
				warnings: ['No workspace folder open.'],
			};
		}
		const rootUri = folders[0].uri;
		const warnings: string[] = [];

		const [{ raw: journalRaw, path: journalPath }, fileTree, recentCommits] = await Promise.all([
			readJournal(fileService, rootUri),
			curatedFileTree(fileService, rootUri, workspaceRoot),
			readRecentCommits(fileService, rootUri),
		]);

		if (!journalRaw) {
			warnings.push('No AGENTS.md (or .github/AGENTS.md, .github/copilot-instructions.md) at workspace root. Project state will not persist across sessions until one is created.');
		}
		if (recentCommits.length === 0) {
			warnings.push('Could not read .git/logs/HEAD — recent git history unavailable.');
		}

		const journal = {
			recentChanges: capSectionAtLineBoundary(journalRaw ? sliceSection(journalRaw, 'Recent Changes') : null),
			sessionMemory: capSectionAtLineBoundary(journalRaw ? sliceSection(journalRaw, 'Session Memory') : null),
		};

		const savedNotes = params.includeNotes ? await notes.listNotes() : [];
		void journalPath;

		const out: ProjectBriefingOutput = {
			workspaceRoot,
			hasJournal: journalRaw !== null,
			journal,
			fileTree,
			recentCommits,
			notes: savedNotes,
			warnings,
		};
		return out;
	});
}

// Helper: stringify the most common nested entries for human-readable tool output.
function formatSnippetBlock(snippet: { startLine: number; lines: string[] } | undefined, indent: string = '    '): string[] {
	if (!snippet || !snippet.lines || snippet.lines.length === 0) { return []; }
	return snippet.lines.map((l, i) => `${indent}${snippet.startLine + i + 1} | ${l}`);
}

export function stringifySymbolContext(out: SymbolContextOutput & {
	callers?: Array<CallerEntry & { snippet?: { startLine: number; lines: string[] } }>;
	references?: Array<{ filePath: string; line: number; snippet?: { startLine: number; lines: string[] } }>;
}): string {
	if (!out.symbol) {
		return `No symbol resolved.${out.notes.length > 0 ? `\n\nNotes:\n${formatNotes(out.notes)}` : ''}`;
	}
	const lines: string[] = [];
	lines.push(`${out.symbol.kind} ${out.symbol.name} @ ${out.symbol.filePath}:${out.symbol.line + 1}`);
	if (out.definition) { lines.push('', 'Definition:', out.definition); }
	if (out.notes.length > 0) { lines.push('', 'Notes:', formatNotes(out.notes)); }
	if (out.diagnostics.length > 0) { lines.push('', `Diagnostics (${out.diagnostics.length}):`, ...out.diagnostics.map(d => `  ${d.severity} ${d.filePath}:${d.line + 1} ${d.message}`)); }
	if (out.callers.length > 0) {
		lines.push('', `Callers (${out.callers.length}):`);
		for (const c of out.callers) {
			lines.push(`  ${c.name} @ ${c.filePath}:${c.line + 1}`);
			// pack_context hydrates caller.snippet — print it (was previously dropped).
			const snip = (c as { snippet?: { startLine: number; lines: string[] } }).snippet;
			lines.push(...formatSnippetBlock(snip));
		}
	}
	if (out.callees.length > 0) { lines.push('', `Callees (${out.callees.length}):`, ...out.callees.map(c => `  ${c.name} @ ${c.filePath}:${c.line + 1}`)); }
	if (out.references.length > 0) {
		lines.push('', `References (${out.references.length}):`);
		for (const r of out.references.slice(0, MAX_RENDERED_REFERENCES)) {
			lines.push(`  ${r.filePath}:${r.line + 1}`);
			const snip = (r as { snippet?: { startLine: number; lines: string[] } }).snippet;
			lines.push(...formatSnippetBlock(snip));
		}
		// The header states the TRUE count but the body stops at the cap. Without this line a
		// model reads "References (137)", sees 20, believes it has them all, and refactors
		// against a fifth of the call sites.
		if (out.references.length > MAX_RENDERED_REFERENCES) {
			lines.push(`  ... (+${out.references.length - MAX_RENDERED_REFERENCES} more not shown — narrow with find_text or list_code_usages before assuming this list is complete)`);
		}
	}
	if (out.supertypes.length > 0) { lines.push('', `Supertypes:`, ...out.supertypes.map(t => `  ${t.kind} ${t.name} @ ${t.filePath}:${t.line + 1}`)); }
	if (out.subtypes.length > 0) { lines.push('', `Subtypes:`, ...out.subtypes.map(t => `  ${t.kind} ${t.name} @ ${t.filePath}:${t.line + 1}`)); }
	return lines.join('\n');
}

export function stringifyCallGraph(out: CallGraphOutput): string {
	const lines: string[] = [];
	lines.push(`Call graph (${out.direction}, depth ${out.depth}, ${out.totalNodes} nodes) — root: ${out.symbol.name} @ ${out.symbol.filePath}:${out.symbol.line + 1}`);
	const render = (nodes: CallGraphNode[], indent: number) => {
		for (const n of nodes) {
			lines.push('  '.repeat(indent + 1) + `${n.kind} ${n.name} @ ${n.filePath}:${n.line + 1}`);
			render(n.children, indent + 1);
		}
	};
	render(out.tree, 0);
	// An empty tree renders as nothing but the header, which reads as "nothing calls this" —
	// and a language server that has not finished indexing looks exactly the same as genuinely
	// dead code. This tool is what the prompt recommends before a risky change, so say it.
	if (out.totalNodes === 0) {
		lines.push('', `No ${out.direction} edges found. That can mean nothing references this symbol, OR the language server has not finished indexing it. Confirm with find_text on the symbol name before treating it as unused.`);
	}
	return lines.join('\n');
}

export function stringifyFileContext(out: FileContextOutput): string {
	const lines: string[] = [];
	lines.push(`File: ${out.filePath}`);
	if (out.symbols.length > 0) {
		const note = out.symbolsFromFallback
			? ' [syntactic fallback -- TS server still warming; retry shortly for full symbols incl. members]'
			: '';
		lines.push('', `Symbols (${out.symbols.length})${note}:`);
		for (const s of out.symbols.slice(0, 80)) {
			lines.push(`  ${s.kind} ${s.containerName ? `${s.containerName}.` : ''}${s.name} @ ${s.line + 1}`);
		}
		if (out.symbols.length > 80) { lines.push(`  ... (+${out.symbols.length - 80} more)`); }
	} else {
		lines.push('', 'Symbols (0): none returned -- the language server may still be warming for this file. Retry shortly.');
	}
	if (out.imports.length > 0) {
		lines.push('', `Imports (${out.imports.length}):`);
		for (const i of out.imports) {
			lines.push(`  line ${i.line + 1}: ${i.isTypeOnly ? 'type ' : ''}${i.importedNames.join(', ') || '*'} from "${i.module}"`);
		}
	}
	if (out.diagnostics.length > 0) {
		lines.push('', `Diagnostics (${out.diagnostics.length}):`);
		for (const d of out.diagnostics) {
			lines.push(`  ${d.severity} :${d.line + 1} ${d.message}`);
		}
	}
	return lines.join('\n');
}

export function stringifyFileDependencies(out: FileDependenciesOutput): string {
	const lines: string[] = [];
	lines.push(`Dependencies for ${out.filePath} (scanned ${out.scannedFiles} files)`);
	if (out.directImports.length > 0) {
		lines.push('', `Direct imports (${out.directImports.length}):`);
		for (const d of out.directImports) {
			lines.push(`  ${d.module}${d.resolvedFilePath ? ` → ${d.resolvedFilePath}` : ''}`);
		}
	}
	if (out.externalImports.length > 0) {
		lines.push('', `External packages (${out.externalImports.length}):`);
		for (const e of out.externalImports) { lines.push(`  ${e.module} (${e.count})`); }
	}
	if (out.importedBy.length > 0) {
		lines.push('', `Imported by (${out.importedBy.length}):`);
		for (const i of out.importedBy) {
			lines.push(`  ${i.filePath}:${i.line + 1}  [${i.importedNames.join(', ') || '*'}]`);
		}
	}
	return lines.join('\n');
}

export function stringifyPackContext(out: PackContextOutput): string {
	const head = stringifySymbolContext({
		symbol: out.symbol,
		definition: out.definition,
		callers: out.callers,
		callees: out.callees,
		references: out.references,
		diagnostics: out.diagnostics,
		supertypes: out.supertypes,
		subtypes: out.subtypes,
		notes: out.notes,
		via: 'lsp',
	});
	const footer = `\n\n[pack_context task=${out.task} estimated_tokens=${out.meta.estimated_tokens} dropped_refs=${out.meta.truncated.references_dropped} dropped_caller_snippets=${out.meta.truncated.caller_snippets_dropped}${out.meta.truncated.hit_budget ? ' (budget exceeded)' : ''}]`;
	return head + footer;
}

export function stringifyProjectBriefing(out: ProjectBriefingOutput): string {
	const lines: string[] = [];
	if (out.sessionContinuity) {
		lines.push(out.sessionContinuity, '');
	}
	lines.push(`Workspace: ${out.workspaceRoot ?? '<none>'}`);
	if (out.warnings.length > 0) {
		lines.push('', 'Warnings:', ...out.warnings.map(w => `  - ${w}`));
	}
	if (out.journal.recentChanges) {
		lines.push('', '## Recent Changes', out.journal.recentChanges);
	}
	if (out.journal.sessionMemory) {
		lines.push('', '## Session Memory', out.journal.sessionMemory);
	}
	if (out.recentCommits.length > 0) {
		lines.push('', 'Recent commits:', ...out.recentCommits.map(c => `  ${c}`));
	}
	if (out.fileTree) {
		lines.push('', 'File tree (depth 3):', out.fileTree);
	}
	if (out.notes.length > 0) {
		lines.push('', `Persistent notes (${out.notes.length}):`, formatNotes(out.notes));
	}
	return lines.join('\n');
}

function formatNotes(notes: SymbolNote[]): string {
	return notes.map(n => {
		const origin = n.originRoot ? ` [carried from ${n.originRoot}; ${n.resolution ?? 'unresolved'}]` : '';
		return `  [${n.id}] ${n.filePath} :: ${n.symbolName}${origin}\n    ${n.note}`;
	}).join('\n');
}

// Touched to silence unused-imports while keeping the symbol available for ad-hoc tooling.
void VSBuffer;
