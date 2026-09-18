/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Repo-level FIM context. Autocomplete gathers a few related "neighbor" files and ships them
 * with the fill-in-the-middle request so the model understands code beyond the current file
 * (cross-file types, signatures, recently-edited code).
 *
 * The built-in local engine renders these in Qwen2.5-Coder's native repo-level layout using the
 * real `<|repo_name|>` / `<|file_sep|>` special tokens (see localInferenceService). FIM providers
 * that take a plain prefix/suffix (Codestral, Mistral, Ollama) instead fold them into a leading
 * comment block via `fimRepoContextToComment`.
 */

export interface FIMRepoContextFile {
	/** Workspace-relative path (used as the file label the model sees). */
	path: string;
	/** File (or chunk) source, already truncated to a budget by the gatherer. */
	content: string;
}

export interface FIMRepoContext {
	/** Workspace/repo label (Qwen's `<|repo_name|>`). */
	repoName?: string;
	/** Workspace-relative path of the file being edited. */
	currentPath?: string;
	/** Neighbor files shown before the current file, most relevant first. */
	files: FIMRepoContextFile[];
}

/**
 * Flatten neighbor files into a leading comment block, for FIM providers that only accept a
 * plain text prefix/suffix and can't consume special tokens. Returns '' when there's nothing to add.
 */
export function fimRepoContextToComment(ctx: FIMRepoContext | undefined): string {
	if (!ctx || ctx.files.length === 0) { return ''; }
	const blocks = ctx.files.map(f => `// ----- ${f.path} -----\n${f.content.trim()}`);
	return `/* Related files from this codebase (for reference, do not repeat):\n${blocks.join('\n\n')}\n*/\n`;
}
