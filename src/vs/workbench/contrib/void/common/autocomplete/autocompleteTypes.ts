/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/*
 * Shared types for the FIM autocomplete pipeline. Snippet/template shapes adapted from
 * Continue (https://github.com/continuedev/continue), Apache-2.0,
 * Copyright 2023-2026 Continue Dev, Inc.
 */
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** A piece of cross-file context shipped with a FIM request. */
export enum AutocompleteSnippetType {
	Code = 'code',
	Clipboard = 'clipboard',
	Diff = 'diff',
}

export interface AutocompleteCodeSnippet {
	type: AutocompleteSnippetType.Code;
	/** Workspace-relative path — the label the model sees. */
	filepath: string;
	content: string;
}

export interface AutocompleteClipboardSnippet {
	type: AutocompleteSnippetType.Clipboard;
	content: string;
	copiedAt: number;
}

export interface AutocompleteDiffSnippet {
	type: AutocompleteSnippetType.Diff;
	content: string;
}

export type AutocompleteSnippet = AutocompleteCodeSnippet | AutocompleteClipboardSnippet | AutocompleteDiffSnippet;

/** Everything a per-model template needs to render a full FIM prompt. */
export interface FimTemplateContext {
	prefix: string;
	suffix: string;
	/** Workspace-relative path of the file being completed. */
	filepath: string;
	/** Repo name (e.g. git repo folder name); used by repo-level templates. */
	reponame: string;
	/** Language id, lowercase (e.g. 'typescript'); '' when unknown. */
	language: string;
	snippets: AutocompleteSnippet[];
}

/** Result of rendering a model-specific FIM template. */
export interface RenderedFimPrompt {
	/** The full prompt text to send to a raw/legacy completions endpoint. */
	prompt: string;
	/** Model stop tokens for this template (FIM boundary tokens etc.). */
	stopTokens: string[];
	/** Which template family rendered this (for logging); e.g. 'codestral', 'qwen'. */
	templateName: string;
}

/** Options driving the mid-stream filter pipeline. */
export interface StreamFilterOptions {
	prefix: string;
	suffix: string;
	/** Whether a multi-line completion is permitted at this cursor position. */
	multiline: boolean;
	/** Stop tokens to cut the stream at (template + provider). */
	stopTokens: string[];
	/** Language comment prefix (e.g. '//'), '' when unknown; used by comment filters. */
	commentPrefix: string;
	/** Resolve with whatever has streamed when this many ms elapse (0 disables). */
	showWhateverWeHaveAtMs?: number;
}
