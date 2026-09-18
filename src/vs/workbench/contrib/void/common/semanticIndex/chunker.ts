/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Tree-sitter–driven code chunker with a sliding-window fallback.
 *
 * Two paths:
 *   - Grammar available  → parse with `web-tree-sitter`, walk to the configured
 *     node types, emit one chunk per semantic unit.
 *   - Grammar missing    → split into 80-line windows with 10-line overlap.
 *
 * Grammar files are expected at `{appRoot}/extensions/v3code-semantic-index/
 * grammars/{name}.wasm`. The chunker tolerates missing wasms quietly — the
 * fallback still yields useful FTS/embeddable chunks. We never throw on
 * grammar-not-found because the indexer must keep moving.
 *
 * The chunker does NOT touch the disk for content — callers pass file text in
 * directly. This keeps the chunker free of FS plumbing and trivially testable.
 */

type TSLanguageCls = any;
type SyntaxNode = { type: string; text: string; startPosition: { row: number; column: number }; endPosition: { row: number; column: number }; namedChildren: SyntaxNode[]; childForFieldName(name: string): SyntaxNode | null };
import { Chunk } from './semanticIndexTypes.js';
import { chunkId, contentHash, toPosix } from './hashing.js';
import { LanguageProfile, profileFor } from './chunkerLanguages.js';

export interface ChunkerOptions {
	/** Absolute filesystem path used to load grammar `.wasm` assets. */
	grammarsDir: string;
	/** Max bytes of source we accept before falling back to skip. */
	maxFileBytes?: number;
	/** Fallback window size in lines. */
	windowLines?: number;
	/** Fallback window overlap in lines. */
	windowOverlap?: number;
}

const DEFAULT_WINDOW = 80;
const DEFAULT_OVERLAP = 10;

export class Chunker {
	private parserCtor: any = null;
	private languageCtor: any = null;
	private parserInitDone = false;
	private parserInitPromise: Promise<void> | null = null;
	private grammarCache = new Map<string, TSLanguageCls | null>();
	// Single reusable parser instance. Tree-sitter parsers are reusable across
	// languages via setLanguage() and parsing is synchronous on the main thread
	// (runWithConcurrency interleaves async file I/O, not parse calls), so one
	// instance is safe and avoids per-file GC churn.
	private sharedParser: any = null;
	private sharedParserLang: string | null = null;

	constructor(private readonly opts: ChunkerOptions) {}

	private async ensureParser(): Promise<boolean> {
		if (this.parserInitDone) return this.parserCtor !== null;
		if (!this.parserInitPromise) {
			this.parserInitPromise = (async () => {
				try {
					const mod = await import('web-tree-sitter' as any);
					this.parserCtor = mod.Parser;
					this.languageCtor = mod.Language;
					await this.parserCtor!.init({
						// web-tree-sitter loads its own `.wasm` runtime; resolve it next
						// to the grammar dir so packaging stays self-contained.
						locateFile: (file: string) => `${this.opts.grammarsDir}/${file}`,
					});
				} catch {
					this.parserCtor = null;
					this.languageCtor = null;
				}
			})();
		}
		await this.parserInitPromise;
		this.parserInitDone = true;
		return this.parserCtor !== null;
	}

	private async loadGrammar(profile: LanguageProfile): Promise<TSLanguageCls | null> {
		if (this.grammarCache.has(profile.grammar)) return this.grammarCache.get(profile.grammar)!;
		if (!await this.ensureParser() || !this.languageCtor) {
			this.grammarCache.set(profile.grammar, null);
			return null;
		}
		try {
			const wasmPath = `${this.opts.grammarsDir}/${profile.grammar}.wasm`;
			const lang = await this.languageCtor.load(wasmPath);
			this.grammarCache.set(profile.grammar, lang);
			return lang;
		} catch {
			this.grammarCache.set(profile.grammar, null);
			return null;
		}
	}

	async chunkFile(filePosix: string, source: string, languageId: string): Promise<Chunk[]> {
		const file = toPosix(filePosix);
		const maxBytes = this.opts.maxFileBytes ?? 512 * 1024;
		if (Buffer.byteLength(source, 'utf8') > maxBytes) return [];

		const profile = profileFor(languageId);
		if (profile) {
			const lang = await this.loadGrammar(profile);
			if (lang && this.parserCtor) {
				try {
					return this.chunkWithTreeSitter(file, source, languageId, profile, lang);
				} catch {
					// Fall through to window chunking — tree-sitter failures must never
					// stop indexing of a single file.
				}
			}
		}
		return this.chunkWithWindow(file, source, languageId);
	}

	private chunkWithTreeSitter(file: string, source: string, languageId: string, profile: LanguageProfile, language: TSLanguageCls): Chunk[] {
		if (!this.sharedParser) this.sharedParser = new this.parserCtor!();
		const parser = this.sharedParser!;
		if (this.sharedParserLang !== profile.grammar) {
			parser.setLanguage(language);
			this.sharedParserLang = profile.grammar;
		}
		const tree = parser.parse(source);
		const chunks: Chunk[] = [];
		const lines = source.split('\n');

		const walk = (node: SyntaxNode): void => {
			const kind = profile.nodeTypeMap[node.type];
			if (kind) {
				const startLine = node.startPosition.row + 1;
				const endLine = node.endPosition.row + 1;
				// Skip degenerate single-line "chunks" — they're rarely useful and
				// pollute retrieval results with noise.
				if (endLine - startLine >= 1) {
					const name = extractName(node, profile) ?? '<anonymous>';
					const text = lines.slice(startLine - 1, endLine).join('\n');
					chunks.push({
						id: chunkId(file, startLine, endLine),
						file,
						startLine,
						endLine,
						kind,
						name,
						language: languageId,
						contentHash: contentHash(text),
					});
				}
			}
			for (const child of node.namedChildren) walk(child);
		};
		walk(tree.rootNode);
		tree.delete();
		// NOTE: parser intentionally NOT deleted — it's shared across the whole
		// chunker lifetime to avoid per-file GC pressure.

		// Always include a file-level chunk so a query against the file itself can
		// surface it even when every semantic unit was filtered out.
		if (chunks.length === 0 || chunks[0].kind !== 'file') {
			const text = source;
			chunks.unshift({
				id: chunkId(file, 1, Math.max(1, lines.length)),
				file,
				startLine: 1,
				endLine: Math.max(1, lines.length),
				kind: 'file',
				name: file.split('/').pop() ?? file,
				language: languageId,
				contentHash: contentHash(text),
			});
		}
		return chunks;
	}

	private chunkWithWindow(file: string, source: string, languageId: string): Chunk[] {
		const lines = source.split('\n');
		const total = lines.length;
		if (total === 0) return [];
		const win = this.opts.windowLines ?? DEFAULT_WINDOW;
		const overlap = Math.min(this.opts.windowOverlap ?? DEFAULT_OVERLAP, Math.max(0, win - 1));
		const stride = Math.max(1, win - overlap);
		const chunks: Chunk[] = [];
		for (let start = 0; start < total; start += stride) {
			const end = Math.min(total, start + win);
			const text = lines.slice(start, end).join('\n');
			if (!text.trim()) continue;
			const startLine = start + 1;
			const endLine = end;
			chunks.push({
				id: chunkId(file, startLine, endLine),
				file,
				startLine,
				endLine,
				kind: 'block',
				name: `${file.split('/').pop()}:${startLine}`,
				language: languageId || 'plaintext',
				contentHash: contentHash(text),
			});
			if (end >= total) break;
		}
		return chunks;
	}
}

function extractName(node: SyntaxNode, profile: LanguageProfile): string | undefined {
	if (profile.nameField) {
		const named = node.childForFieldName(profile.nameField);
		if (named) {
			const t = named.text.trim();
			if (t) return t.split('\n')[0].slice(0, 120);
		}
	}
	if (profile.nameFromIdentifierChild) {
		for (const child of node.namedChildren) {
			if (child.type.endsWith('identifier') || child.type === 'identifier') {
				const t = child.text.trim();
				if (t) return t.split('\n')[0].slice(0, 120);
			}
		}
	}
	return undefined;
}

/**
 * Convenience: render a Chunk back to its text by re-slicing the original
 * source. Useful in tests and for the rebuild loop when we already have the
 * file content in memory.
 */
export function sliceChunk(source: string, chunk: Chunk): string {
	const lines = source.split('\n');
	return lines.slice(chunk.startLine - 1, chunk.endLine).join('\n');
}

/** Pure helper exported for tests. */
export function _windowRanges(totalLines: number, win: number, overlap: number): Array<[number, number]> {
	const stride = Math.max(1, win - overlap);
	const out: Array<[number, number]> = [];
	for (let s = 0; s < totalLines; s += stride) {
		const e = Math.min(totalLines, s + win);
		out.push([s + 1, e]);
		if (e >= totalLines) break;
	}
	return out;
}
