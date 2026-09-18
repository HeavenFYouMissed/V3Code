/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Tree-sitter structural chunker (renderer-safe) with parent-child splitting.
 *
 * Parent-child model:
 *   • PARENT units are structural blocks (function / class / method / interface
 *     / type / enum) per the language profile's `nodeTypeMap`.
 *   • CHILD units are small control-flow / error-handling sub-statements inside
 *     a parent (if / for / try / catch / switch / …). Children are what get
 *     embedded (precise vectors); a child hit resolves to its parent block for
 *     context injection. A parent with no descendants becomes its own scored
 *     leaf; a parent that contains nested units is display-only.
 *
 * Child detection uses LANGUAGE-SPECIFIC node-type sets for the supported
 * languages (TS/JS, Python, Go, Rust, Java, C#, C/C++, Ruby — whose grammars
 * use divergent names like `elif_clause`, `expression_case`, `if_modifier`)
 * and falls back to a generic `*_statement|*_clause` suffix match for anything
 * else. This is deliberate: the generic heuristic alone silently misses Python,
 * Go, and Ruby control flow.
 *
 * Runtime + grammar bytes are provided by the host (the orchestrator wires them
 * to `@vscode/tree-sitter-wasm` + IFileService). The chunker owns no I/O.
 */

import type { Language as TsLanguage, Node as TsNode, Parser as TsParser, Tree as TsTree } from '@vscode/tree-sitter-wasm';
import { LanguageProfile, profileFor } from '../../common/semanticIndex/chunkerLanguages.js';
import { ChunkerCapability, chunkerCapabilityOf, chunkerGrammarNames } from '../../common/semanticIndex/chunkerCapability.js';
import { ExtractedUnit } from './browserIndexTypes.js';

export interface TreeSitterRuntime {
	readonly Parser: typeof TsParser;
	readonly Language: typeof TsLanguage;
}

export interface ChunkerHost {
	/** Load + init the tree-sitter runtime once; null => unavailable (fallback). */
	loadRuntime(): Promise<TreeSitterRuntime | null>;
	/** Read a grammar's `.wasm` bytes by grammar name (e.g. 'tree-sitter-python'). */
	readGrammarBytes(grammarName: string): Promise<Uint8Array | null>;
	/** Whether a grammar's `.wasm` asset is present in this installation. Cheap
	 *  (a stat, not a read + compile) — it backs the capability probe. */
	grammarExists(grammarName: string): Promise<boolean>;
	log(message: string): void;
}

export interface ChunkerLimits {
	windowLines: number;
	windowOverlap: number;
	minChildLines: number;
	maxChildLines: number;
	maxChildrenPerParent: number;
	maxRefsPerParent: number;
}

const DEFAULT_LIMITS: ChunkerLimits = {
	windowLines: 80,
	windowOverlap: 10,
	minChildLines: 3,
	maxChildLines: 40,
	maxChildrenPerParent: 6,
	maxRefsPerParent: 24,
};

/** Language-specific control-flow / error-handling node types → CHILD chunks. */
const CHILD_TYPES_BY_LANG: Record<string, ReadonlySet<string>> = {
	typescript: tsLike(), typescriptreact: tsLike(), javascript: tsLike(), javascriptreact: tsLike(),
	python: new Set(['if_statement', 'for_statement', 'while_statement', 'try_statement', 'with_statement', 'match_statement', 'elif_clause', 'else_clause', 'except_clause', 'except_group_clause', 'finally_clause', 'case_clause']),
	go: new Set(['if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement', 'expression_case', 'type_case', 'default_case', 'communication_case']),
	rust: new Set(['if_expression', 'match_expression', 'for_expression', 'while_expression', 'loop_expression', 'match_arm', 'if_let_expression', 'while_let_expression']),
	java: new Set(['if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'try_statement', 'catch_clause', 'finally_clause', 'switch_expression', 'switch_block_statement_group', 'switch_label']),
	csharp: new Set(['if_statement', 'for_statement', 'for_each_statement', 'foreach_statement', 'while_statement', 'do_statement', 'try_statement', 'catch_clause', 'finally_clause', 'switch_statement', 'switch_section', 'using_statement', 'lock_statement']),
	cpp: cLike(), c: cLike(),
	ruby: new Set(['if', 'unless', 'while', 'until', 'case', 'when', 'begin', 'rescue', 'ensure', 'for', 'if_modifier', 'unless_modifier', 'while_modifier', 'until_modifier']),
	php: new Set(['if_statement', 'for_statement', 'foreach_statement', 'while_statement', 'do_statement', 'try_statement', 'catch_clause', 'finally_clause', 'switch_statement', 'case_statement', 'default_statement']),
};

function tsLike(): ReadonlySet<string> {
	return new Set(['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'try_statement', 'catch_clause', 'finally_clause', 'switch_statement', 'switch_case', 'switch_default', 'else_clause']);
}
function cLike(): ReadonlySet<string> {
	return new Set(['if_statement', 'for_statement', 'for_range_loop', 'while_statement', 'do_statement', 'switch_statement', 'case_statement', 'try_statement', 'catch_clause']);
}

/** Generic fallback for languages without an explicit set. */
const GENERIC_CHILD_SUFFIX = /(_statement|_clause)$/;

const IDENTIFIER_TYPES = new Set(['identifier', 'property_identifier', 'field_identifier', 'type_identifier', 'constant', 'scoped_identifier']);

export class TreeSitterChunker {
	private _runtime: TreeSitterRuntime | null = null;
	private _runtimeTried = false;
	private _runtimePromise: Promise<TreeSitterRuntime | null> | null = null;
	private _parser: TsParser | null = null;
	private _parserLang: string | null = null;
	private _grammars = new Map<string, TsLanguage | null>();
	/** undefined => not probed yet, null => probed but indeterminate. */
	private _capability: ChunkerCapability | null | undefined = undefined;
	private _capabilityPromise: Promise<ChunkerCapability | undefined> | null = null;
	private readonly limits: ChunkerLimits;

	constructor(private readonly host: ChunkerHost, limits?: Partial<ChunkerLimits>) {
		this.limits = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
	}

	/** True once the runtime has been tried and is available. */
	get treeSitterReady(): boolean { return this._runtime !== null; }

	/**
	 * Which grammars this installation can actually give the chunker, probed once
	 * per session by asset presence. `undefined` means the probe could not answer
	 * (see below) — callers must treat that as "unchanged", never as a change.
	 *
	 * Presence, not a load: probing by `Language.load` would compile every
	 * grammar wasm at startup for an answer we only need to compare, and a
	 * transient compile failure would masquerade as a capability change and force
	 * a whole-workspace re-chunk.
	 */
	async capability(): Promise<ChunkerCapability | undefined> {
		if (this._capability !== undefined) return this._capability ?? undefined;
		if (!this._capabilityPromise) this._capabilityPromise = this._probeCapability();
		const capability = await this._capabilityPromise;
		this._capability = capability ?? null;
		return capability;
	}

	private async _probeCapability(): Promise<ChunkerCapability | undefined> {
		const present: string[] = [];
		for (const name of chunkerGrammarNames()) {
			try {
				if (await this.host.grammarExists(name)) present.push(name);
			} catch {
				// A probe that throws says nothing about the asset. Reporting a
				// shrunken set here would be an I/O failure impersonating a
				// capability change — the one thing this must never do.
				return undefined;
			}
		}
		// Every declared grammar missing is a broken install or an unavailable file
		// service, not a capability the index should be reconciled against.
		if (present.length === 0) {
			this.host.log('[v3code-index] chunker capability probe found no grammar assets — treating language support as unchanged');
			return undefined;
		}
		return chunkerCapabilityOf(present);
	}

	private async _ensureRuntime(): Promise<TreeSitterRuntime | null> {
		if (this._runtimeTried) return this._runtime;
		if (!this._runtimePromise) {
			this._runtimePromise = this.host.loadRuntime()
				.then(rt => { this._runtime = rt; return rt; })
				.catch(() => { this._runtime = null; return null; });
		}
		await this._runtimePromise;
		this._runtimeTried = true;
		return this._runtime;
	}

	private async _ensureGrammar(rt: TreeSitterRuntime, profile: LanguageProfile): Promise<TsLanguage | null> {
		if (this._grammars.has(profile.grammar)) return this._grammars.get(profile.grammar)!;
		try {
			const bytes = await this.host.readGrammarBytes(profile.grammar);
			if (!bytes) { this._grammars.set(profile.grammar, null); return null; }
			const lang = await rt.Language.load(bytes);
			this._grammars.set(profile.grammar, lang);
			return lang;
		} catch {
			// Grammar asset missing or load failed — fall back.
			this._grammars.set(profile.grammar, null);
			return null;
		}
	}

	/**
	 * Structurally chunk a file. Returns null when tree-sitter is unavailable,
	 * the language is unsupported, parsing fails, or no structure was found —
	 * the caller should then use {@link windowUnits}.
	 */
	async extract(file: string, content: string, languageId: string): Promise<ExtractedUnit[] | null> {
		const profile = profileFor(languageId);
		if (!profile) return null;
		const rt = await this._ensureRuntime();
		if (!rt) return null;
		const language = await this._ensureGrammar(rt, profile);
		if (!language) return null;

		let tree: TsTree | null;
		try {
			if (!this._parser) this._parser = new rt.Parser();
			const parser = this._parser;
			if (this._parserLang !== profile.grammar) {
				parser.setLanguage(language);
				this._parserLang = profile.grammar;
			}
			tree = parser.parse(content);
		} catch {
			return null;
		}
		if (!tree) return null;
		try {
			return this._walk(tree, content, languageId, profile);
		} catch {
			return null;
		} finally {
			// Free the CST immediately — never hold tree references across files.
			tree.delete();
		}
	}

	private _walk(tree: TsTree, content: string, languageId: string, profile: LanguageProfile): ExtractedUnit[] | null {
		const lines = content.split('\n');
		const units: ExtractedUnit[] = [];
		// A leading doc-comment run gets folded into its declaration's chunk below —
		// the comment's natural language is a strong retrieval signal. Comment node
		// types vary by grammar: `comment` (TS/JS/Py), `line_comment`/`block_comment`
		// (Rust/Go), etc. — so match any type containing "comment".
		const isCommentNode = (t: string) => t === 'comment' || t.includes('comment');
		const childSet = CHILD_TYPES_BY_LANG[languageId];
		const parentStack: number[] = [];      // indices into `units` of enclosing parents
		const childCount = new Map<number, number>();
		const hasDescendant = new Set<number>(); // parent idx -> has any nested unit (=> display-only)
		const limits = this.limits;

		const addRef = (sym: string | undefined) => {
			if (!sym || parentStack.length === 0) return;
			const p = units[parentStack[parentStack.length - 1]];
			if (p.refs.length < limits.maxRefsPerParent && !p.refs.includes(sym)) p.refs.push(sym);
		};

		const visit = (node: TsNode): void => {
			addRef(extractRef(node));
			const enclosing = parentStack.length ? parentStack[parentStack.length - 1] : undefined;
			const kind = profile.nodeTypeMap[node.type];
			let pushed = false;

			if (kind) {
				// Fold an immediately-preceding doc-comment run into this declaration's
				// chunk: walk back over contiguous comment siblings (a `/** */` block or
				// a stack of `//` lines directly above — a blank line breaks the run).
				let commentRow = node.startPosition.row;
				for (let prev = node.previousSibling; prev && isCommentNode(prev.type) && prev.endPosition.row === commentRow - 1; prev = prev.previousSibling) {
					commentRow = prev.startPosition.row;
				}
				const startLine = commentRow + 1;
				const endLine = node.endPosition.row + 1;
				if (endLine - startLine >= 1) {
					const name = extractName(node, profile) ?? '<anonymous>';
					const text = lines.slice(startLine - 1, endLine).join('\n');
					const idx = units.length;
					units.push({ startLine, endLine, kind, name, text, scored: false, parentLocalId: undefined, defines: [name], refs: [] });
					if (enclosing !== undefined) hasDescendant.add(enclosing);
					parentStack.push(idx);
					pushed = true;
				}
			} else if (enclosing !== undefined && this._isChild(node.type, childSet)) {
				const startLine = node.startPosition.row + 1;
				const endLine = node.endPosition.row + 1;
				const span = endLine - startLine + 1;
				if (span >= limits.minChildLines && span <= limits.maxChildLines) {
					const cnt = childCount.get(enclosing) ?? 0;
					if (cnt < limits.maxChildrenPerParent) {
						const text = lines.slice(startLine - 1, endLine).join('\n');
						units.push({ startLine, endLine, kind: 'block', name: `${units[enclosing].name} > ${node.type}`, text, scored: true, parentLocalId: enclosing, defines: [], refs: [] });
						childCount.set(enclosing, cnt + 1);
						hasDescendant.add(enclosing);
					}
				}
			}

			for (const child of node.namedChildren) {
				if (child) visit(child);
			}
			if (pushed) parentStack.pop();
		};

		visit(tree.rootNode);
		if (units.length === 0) return null;

		// A parent with no nested units is a scored leaf (embed it directly);
		// a parent that contains nested units is display-only (children carry search).
		for (let i = 0; i < units.length; i++) {
			if (units[i].kind !== 'block') units[i].scored = !hasDescendant.has(i);
		}
		return units;
	}

	private _isChild(type: string, langSet: ReadonlySet<string> | undefined): boolean {
		if (langSet) return langSet.has(type);
		return GENERIC_CHILD_SUFFIX.test(type);
	}

	/** Sliding line-window fallback for unsupported languages / parse failures. */
	windowUnits(file: string, content: string): ExtractedUnit[] {
		const base = file.split('/').pop() ?? file;
		const lines = content.split(/\r?\n/);
		const total = lines.length;
		if (total === 0) return [];
		const step = Math.max(1, this.limits.windowLines - this.limits.windowOverlap);
		const out: ExtractedUnit[] = [];
		for (let start = 0; start < total; start += step) {
			const end = Math.min(start + this.limits.windowLines, total);
			const text = lines.slice(start, end).join('\n');
			if (!text.trim()) {
				if (end >= total) break;
				continue;
			}
			out.push({ startLine: start + 1, endLine: end, kind: 'block', name: `${base}:${start + 1}`, text, scored: true, parentLocalId: undefined, defines: [], refs: [] });
			if (end >= total) break;
		}
		return out;
	}
}

/** Extract a symbol definition name from a parent node via the profile. */
function extractName(node: TsNode, profile: LanguageProfile): string | undefined {
	if (profile.nameField) {
		const named = node.childForFieldName(profile.nameField);
		if (named) {
			const t = named.text.trim();
			if (t) return t.split('\n')[0].slice(0, 120);
		}
	}
	if (profile.nameFromIdentifierChild) {
		for (const child of node.namedChildren) {
			if (!child) continue;
			if (child.type === 'identifier' || child.type.endsWith('identifier')) {
				const t = child.text.trim();
				if (t) return t.split('\n')[0].slice(0, 120);
			}
		}
	}
	return undefined;
}

/**
 * Heuristically extract a referenced symbol (callee or type) from a node.
 * Text-only — see dependencyGraph.ts for the recall-ceiling caveats.
 */
function extractRef(node: TsNode): string | undefined {
	const t = node.type;
	if (t === 'type_identifier') {
		const s = node.text.trim().split('\n')[0];
		return s && s.length <= 80 ? s : undefined;
	}
	if (t === 'new_expression' || t.includes('call') || t.includes('invocation')) {
		let callee: TsNode | null = null;
		try { callee = node.childForFieldName('function') ?? node.childForFieldName('name') ?? null; } catch { callee = null; }
		let id = callee ? lastIdentifier(callee) : undefined;
		if (!id) {
			for (const child of node.namedChildren) {
				if (!child) continue;
				const li = lastIdentifier(child);
				if (li) { id = li; break; }
			}
		}
		return id && id.length <= 80 ? id : undefined;
	}
	return undefined;
}

/** Rightmost identifier inside a (possibly member/scoped) expression. */
function lastIdentifier(node: TsNode): string | undefined {
	if (IDENTIFIER_TYPES.has(node.type) || node.type.endsWith('identifier')) {
		const s = node.text.trim().split('\n')[0];
		return s || undefined;
	}
	let found: string | undefined;
	for (const child of node.namedChildren) {
		if (!child) continue;
		const li = lastIdentifier(child);
		if (li) found = li;
	}
	return found;
}
