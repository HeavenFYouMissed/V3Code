/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  Minimal structural typings for the tree-sitter WASM runtime.
 *
 *  The chunker receives its runtime through ChunkerHost.loadRuntime() and only
 *  touches the members below, so V3Index types the SHAPE rather than binding to
 *  a specific package (@vscode/tree-sitter-wasm in the editor, web-tree-sitter
 *  here). Any runtime whose objects satisfy these interfaces works.
 *--------------------------------------------------------------------------------------*/

export interface TsPoint {
	readonly row: number;
	readonly column: number;
}

export interface TsNode {
	readonly type: string;
	readonly text: string;
	readonly startPosition: TsPoint;
	readonly endPosition: TsPoint;
	readonly namedChildren: Array<TsNode | null>;
	childForFieldName(name: string): TsNode | null;
}

export interface TsTree {
	readonly rootNode: TsNode;
	delete(): void;
}

export interface TsLanguage {
	/** Opaque — passed straight back into parser.setLanguage(). */
	readonly _v3indexBrand?: undefined;
}

export interface TsParser {
	setLanguage(language: TsLanguage): void;
	parse(input: string): TsTree | null;
}

/** Constructor/statics surface the chunker uses off the loaded runtime module. */
export interface TsParserCtor {
	new(): TsParser;
}

/** Grammar source: raw wasm bytes (Node/editor hosts) or a precompiled module
 *  (Cloudflare Workers forbid runtime WASM compilation — grammars are statically
 *  imported as WebAssembly.Module and passed through). */
export type TsGrammarSource = Uint8Array | WebAssembly.Module;

export interface TsLanguageStatics {
	load(source: TsGrammarSource): Promise<TsLanguage>;
}
