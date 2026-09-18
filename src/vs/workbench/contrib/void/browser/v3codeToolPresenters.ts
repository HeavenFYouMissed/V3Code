/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Rich native-chat presentation metadata for V3Code builtin tools.
 * Maps typed tool params/results → invocationMessage, pastTenseMessage,
 * toolSpecificData, and toolResultDetails for the VS Code chat renderer.
 */

import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/path.js';
import { IChatSearchToolInvocationData, IChatSubagentToolInvocationData, IChatTodoListContent } from '../../chat/common/chatService/chatService.js';
import { SLIM_DIFF_LANGUAGE_ID, SlimDiffCardPayload } from '../../chat/common/chatSlimDiffPayload.js';
import { IToolResult, IToolResultInputOutputDetails } from '../../chat/common/tools/languageModelToolsService.js';
import {
	BuiltinToolCallParams,
	BuiltinToolName,
	BuiltinToolResultType,
} from '../common/toolsServiceTypes.js';

export interface V3CodeToolPresentation {
	invocationMessage?: string | MarkdownString;
	pastTenseMessage?: string | MarkdownString;
	toolSpecificData?: IPreparedToolInvocationToolSpecificData;
	toolResultDetails?: IToolResult['toolResultDetails'];
}

type IPreparedToolInvocationToolSpecificData =
	| IChatSearchToolInvocationData
	| IChatSubagentToolInvocationData
	| IChatTodoListContent
	| { kind: 'simpleToolInvocation'; input: string; output: string };

export interface V3CodeToolPresenter {
	readonly icon: ThemeIcon;
	prepare(params: unknown): V3CodeToolPresentation;
	present(params: unknown, result: unknown): V3CodeToolPresentation;
}

function md(text: string): MarkdownString {
	return new MarkdownString(text);
}

/** Title markdown that may include theme icons and the +N/-M colored spans. */
function mdRich(text: string): MarkdownString {
	// isTrusted is required for the markdown renderer to keep <span style="color:…"> nodes.
	return new MarkdownString(text, { supportHtml: true, supportThemeIcons: true, isTrusted: true });
}

function code(text: string): string {
	return `\`${truncate(text, 72)}\``;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	return text.slice(0, max - 1) + '…';
}

function fileLabel(uri: URI): string {
	return basename(uri.fsPath) || uri.fsPath;
}

/**
 * Edit title: just the filename + colored +N -M. The tool card already
 * carries the file icon — a leading "Edited" / "Wrote" verb doubles the header and is
 * what made our cards read as heavy.
 */
function editFileTitle(uri: URI, added?: number | null, removed?: number | null): MarkdownString {
	const parts = [code(fileLabel(uri))];
	// Inline style only — the markdown sanitizer strips custom classes on <span>,
	// but allows color:var(--vscode-…).
	if (added != null && added > 0) {
		parts.push(`<span style="color:var(--vscode-gitDecoration-addedResourceForeground);">+${added}</span>`);
	}
	if (removed != null && removed > 0) {
		parts.push(`<span style="color:var(--vscode-gitDecoration-deletedResourceForeground);">-${removed}</span>`);
	}
	return mdRich(parts.join(' '));
}

/**
 * Short terminal label: strip leading `cd … &&`, collapse absolute paths to basenames,
 * keep ~48 chars. A short label reads better than a 120-char shell line.
 */
function shortCommandLabel(command: string): string {
	let s = (command ?? '').trim().replace(/^(cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*)+/i, '');
	s = s.replace(/(?:\/[\w.@+-]+)+\/([\w.@+-]+)/g, '$1');
	s = s.replace(/\s+/g, ' ').trim();
	return truncate(s || 'command', 48);
}

/** Cap tool-card terminal output so the body never becomes a wall of text. */
function previewOutput(text: string, maxLines = 5, maxChars = 800): string {
	const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
	const clipped = lines.length > maxLines
		? lines.slice(0, maxLines).join('\n') + `\n… ${lines.length - maxLines} more lines`
		: lines.join('\n');
	return clipped.length > maxChars ? clipped.slice(0, maxChars) + '…' : clipped;
}

function uriBasename(uri: URI): string {
	return uri.fsPath.split(/[/\\]/).pop() ?? uri.fsPath;
}

function ioCard(input: string, output: string, inputLanguage?: string): IToolResultInputOutputDetails {
	return {
		input,
		inputLanguage,
		output: [{ type: 'embed', isText: true, value: output }],
	};
}

function textCard(text: string, inputLabel = ''): IToolResultInputOutputDetails {
	return ioCard(inputLabel, text);
}

/**
 * Diff card for an edit. The renderer wants the two texts, not a `+`/`-` dump — see
 * docs/CHAT-DIFF-SPEC.md — so the payload travels as JSON in `input` under a private
 * language tag that chatInputOutputMarkdownProgressPart recognises. `input` is UI-only;
 * the model gets its diff from the tool result string, not from here.
 */
function slimDiffCard(before: string, after: string, path: string): IToolResultInputOutputDetails {
	return {
		input: JSON.stringify({ original: before, modified: after, path } satisfies SlimDiffCardPayload),
		inputLanguage: SLIM_DIFF_LANGUAGE_ID,
		output: [],
	};
}

/** Fallback for edits whose before/after text was too large to keep (and for `git diff`). */
function unifiedDiffCard(diffText: string): IToolResultInputOutputDetails {
	return {
		input: diffText,
		inputLanguage: 'diff',
		output: [],
	};
}

/** Diff card for any of the three edit tools, or undefined when there's nothing to show. */
function editDetails(uri: URI, r: { beforeContent?: string; afterContent?: string; diffText?: string }): IToolResultInputOutputDetails | undefined {
	if (r.beforeContent !== undefined && r.afterContent !== undefined) {
		return slimDiffCard(r.beforeContent, r.afterContent, uri.fsPath);
	}
	return r.diffText ? unifiedDiffCard(r.diffText) : undefined;
}

function uriList(uris: URI[]): URI[] {
	return uris;
}

function lineRangeLabel(start: number | null, end: number | null): string {
	if (start != null && end != null) {
		return ` (L${start}-${end})`;
	}
	if (start != null) {
		return ` (from L${start})`;
	}
	if (end != null) {
		return ` (to L${end})`;
	}
	return '';
}

function searchData(): IChatSearchToolInvocationData {
	return { kind: 'search' };
}

function defaultPresenter(icon: ThemeIcon, running: string, done: string): V3CodeToolPresenter {
	return {
		icon,
		prepare: () => ({ invocationMessage: md(running) }),
		present: (_p, result) => ({
			pastTenseMessage: md(done),
			toolResultDetails: textCard(typeof result === 'string' ? result : JSON.stringify(result, null, 2)),
		}),
	};
}

function stringResultPresenter(icon: ThemeIcon, running: (p: unknown) => string, done: (p: unknown) => string, format: (r: { result: string }) => string): V3CodeToolPresenter {
	return {
		icon,
		prepare: (params) => ({ invocationMessage: md(running(params)) }),
		present: (params, result) => {
			const r = result as { result: string };
			return {
				pastTenseMessage: md(done(params)),
				toolResultDetails: textCard(format(r)),
			};
		},
	};
}

const presenters: Partial<Record<BuiltinToolName, V3CodeToolPresenter>> = {
	reload_window: {
		icon: Codicon.refresh,
		prepare: () => ({ invocationMessage: md('Reloading V3Code window') }),
		present: (_params, result) => {
			const r = result as BuiltinToolResultType['reload_window'];
			return {
				pastTenseMessage: md(r.scheduled ? 'V3Code window reload scheduled' : 'V3Code window reload not scheduled'),
				toolResultDetails: textCard(r.scheduled ? 'The current window will reload now. Saved files and this chat are preserved.' : 'No reload was scheduled.'),
			};
		},
	},
	ask_user: {
		icon: Codicon.commentDiscussion,
		prepare: (params) => {
			const p = params as { question: string };
			return { invocationMessage: md(`Asking: ${p.question}`) };
		},
		present: (params, result) => {
			const p = params as { question: string };
			return {
				pastTenseMessage: md(`Asked: ${p.question}`),
				toolResultDetails: textCard(typeof result === 'string' ? result : String(result ?? '')),
			};
		},
	},
	read_file: {
		icon: Codicon.file,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['read_file'];
			return { invocationMessage: md(`Reading ${code(fileLabel(p.uri))}${lineRangeLabel(p.startLine, p.endLine)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['read_file'];
			const r = result as BuiltinToolResultType['read_file'];
			const suffix = r.hasNextPage ? ' (partial)' : '';
			return {
				pastTenseMessage: md(`Read ${code(fileLabel(p.uri))} (${r.totalNumLines} lines${suffix})`),
				// The filename/range already lives in the fixed header. Repeating it as an Input
				// code block made reads taller than edit cards and created a bright nested box.
				toolResultDetails: textCard(r.fileContents),
			};
		},
	},

	ls_dir: {
		icon: Codicon.folder,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['ls_dir'];
			return { invocationMessage: md(`Listing ${code(fileLabel(p.uri))}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['ls_dir'];
			const r = result as BuiltinToolResultType['ls_dir'];
			const count = r.children?.length ?? 0;
			const uris = (r.children ?? []).map(c => c.uri);
			return {
				pastTenseMessage: md(`Listed ${code(fileLabel(p.uri))} (${count} items)`),
				toolResultDetails: uris.length ? uriList(uris) : textCard('(empty directory)'),
			};
		},
	},

	get_dir_tree: {
		icon: Codicon.listTree,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['get_dir_tree'];
			return { invocationMessage: md(`Reading tree ${code(fileLabel(p.uri))}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['get_dir_tree'];
			const r = result as BuiltinToolResultType['get_dir_tree'];
			return {
				pastTenseMessage: md(`Read tree ${code(fileLabel(p.uri))}`),
				toolResultDetails: textCard(r.str),
			};
		},
	},

	search_pathnames_only: {
		icon: Codicon.search,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['search_pathnames_only'];
			return {
				invocationMessage: md(`Searching paths ${code(p.query)}`),
				toolSpecificData: searchData(),
			};
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['search_pathnames_only'];
			const r = result as BuiltinToolResultType['search_pathnames_only'];
			const suffix = r.hasNextPage ? '+' : '';
			return {
				pastTenseMessage: md(`Found ${r.uris.length}${suffix} paths for ${code(p.query)}`),
				toolResultDetails: uriList(r.uris),
			};
		},
	},

	search_for_files: {
		icon: Codicon.search,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['search_for_files'];
			return {
				invocationMessage: md(`Searching ${code(p.query)}`),
				toolSpecificData: searchData(),
			};
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['search_for_files'];
			const r = result as BuiltinToolResultType['search_for_files'];
			const suffix = r.hasNextPage ? '+' : '';
			return {
				pastTenseMessage: md(`Found ${r.uris.length}${suffix} files for ${code(p.query)}`),
				toolResultDetails: uriList(r.uris),
			};
		},
	},

	search_in_file: {
		icon: Codicon.search,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['search_in_file'];
			return {
				invocationMessage: md(`Searching in ${code(fileLabel(p.uri))} for ${code(p.query)}`),
				toolSpecificData: searchData(),
			};
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['search_in_file'];
			const r = result as BuiltinToolResultType['search_in_file'];
			return {
				pastTenseMessage: md(`Found ${r.lines.length} matches in ${code(fileLabel(p.uri))}`),
				toolResultDetails: textCard(r.lines.length ? `Lines: ${r.lines.join(', ')}` : 'No matches'),
			};
		},
	},

	find_text: {
		icon: Codicon.search,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['find_text'];
			return {
				invocationMessage: md(`Grepped ${code(p.query)}`),
				toolSpecificData: searchData(),
			};
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['find_text'];
			const r = result as BuiltinToolResultType['find_text'];
			const suffix = r.hasNextPage ? '+' : '';
			const preview = r.matches.slice(0, 8).map(m => `${uriBasename(m.uri)}:${m.lineNumber} ${truncate(m.previewText.trim(), 60)}`).join('\n');
			return {
				pastTenseMessage: md(`Grepped ${code(p.query)} (${r.matches.length}${suffix} matches)`),
				// Keep grep in the same compact header/body card as reads, memory, and diffs.
				// The old URI-list renderer used a separate, taller bright list treatment.
				toolResultDetails: textCard(preview || 'No matches'),
			};
		},
	},

	semantic_search: {
		icon: Codicon.search,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['semantic_search'];
			return {
				invocationMessage: md(`Searching semantically ${code(p.query)}`),
				toolSpecificData: searchData(),
			};
		},
		present: (_params, result) => {
			const r = result as BuiltinToolResultType['semantic_search'];
			const lines = r.hits.slice(0, 12).map(h => {
				const path = h.chunk?.file ? basename(h.chunk.file) : '?';
				const score = h.score?.toFixed(2) ?? '?';
				return `${path} (score ${score})\n${truncate(h.content.trim(), 120)}`;
			}).join('\n\n');
			return {
				pastTenseMessage: md(`Searched semantically (${r.hits.length} hits, index ${r.indexState})`),
				toolResultDetails: textCard(lines || 'No hits'),
			};
		},
	},

	read_lint_errors: {
		icon: Codicon.warning,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['read_lint_errors'];
			return { invocationMessage: md(`Reading lints ${code(fileLabel(p.uri))}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['read_lint_errors'];
			const r = result as BuiltinToolResultType['read_lint_errors'];
			const errors = r.lintErrors ?? [];
			const text = errors.map(e => `L${e.startLineNumber}: [${e.code}] ${e.message}`).join('\n') || 'No lint errors';
			return {
				pastTenseMessage: md(`Read lints ${code(fileLabel(p.uri))} (${errors.length} problems)`),
				toolResultDetails: textCard(text),
			};
		},
	},

	security_scan: {
		icon: Codicon.shield,
		prepare: () => {
			return { invocationMessage: md(`Running security scan`) };
		},
		present: (_params, result) => {
			const r = result as BuiltinToolResultType['security_scan'];
			if (!r.ran) {
				return {
					pastTenseMessage: md(`Security scan could not run`),
					toolResultDetails: textCard(r.error ?? 'Unknown error'),
				};
			}
			const summary = `${r.findingCount} finding${r.findingCount === 1 ? '' : 's'} in ${r.filesScanned} file${r.filesScanned === 1 ? '' : 's'}`;
			return {
				pastTenseMessage: md(`Security scan — ${summary}`),
				toolResultDetails: textCard(`${r.human}\n\nSince last scan:\n${r.memory}`),
			};
		},
	},

	read_skill: {
		icon: Codicon.book,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['read_skill'];
			return { invocationMessage: md(`Reading skill ${code(p.name)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['read_skill'];
			const r = result as BuiltinToolResultType['read_skill'];
			if (!r.found) {
				const list = r.availableNames.length ? r.availableNames.join(', ') : '(no skills found)';
				return {
					pastTenseMessage: md(`Skill ${code(p.name)} not found`),
					toolResultDetails: textCard(`No skill named "${p.name}". Available: ${list}`),
				};
			}
			return {
				pastTenseMessage: md(`Read skill ${code(r.name)}`),
				toolResultDetails: textCard(`${r.filePath}\n\n${r.content}`),
			};
		},
	},

	get_build_errors: {
		icon: Codicon.error,
		prepare: () => ({ invocationMessage: md('Reading build errors') }),
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['get_build_errors'];
			const r = result as BuiltinToolResultType['get_build_errors'];
			const scope = p.pathFilter ? ` matching ${code(p.pathFilter)}` : '';
			const kinds = p.errorsOnly ? 'errors' : 'errors/warnings';
			if (r.problems.length === 0) {
				return {
					pastTenseMessage: md(`Checked live ${kinds}${scope}`),
					toolResultDetails: textCard(`No ${kinds}${p.pathFilter ? ` matching "${p.pathFilter}"` : ''} are currently reported in the editor's live diagnostics. Diagnostic coverage may be incomplete; this does not establish which files were analyzed or replace a full build.`),
				};
			}
			const text = r.problems.slice(0, 20).map(p => `${p.file}:${p.line} [${p.severity}] ${p.message}`).join('\n');
			return {
				pastTenseMessage: md(`Found ${r.total} build problems${r.truncated ? '+' : ''}`),
				toolResultDetails: textCard(text),
			};
		},
	},

	edit_file: {
		icon: Codicon.file,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['edit_file'];
			return { invocationMessage: mdRich(code(fileLabel(p.uri))) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['edit_file'];
			const r = result as Awaited<BuiltinToolResultType['edit_file']>;
			const details = editDetails(p.uri, r) ?? textCard(r.searchReplaceBlocks ?? '(edit applied)');
			return {
				pastTenseMessage: editFileTitle(p.uri, r.added, r.removed),
				toolResultDetails: details,
			};
		},
	},

	rewrite_file: {
		icon: Codicon.file,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['rewrite_file'];
			return { invocationMessage: mdRich(code(fileLabel(p.uri))) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['rewrite_file'];
			const r = result as Awaited<BuiltinToolResultType['rewrite_file']>;
			const details = editDetails(p.uri, r) ?? textCard('(file rewritten)');
			return {
				pastTenseMessage: editFileTitle(p.uri, r.added, r.removed),
				toolResultDetails: details,
			};
		},
	},

	append_file: {
		icon: Codicon.file,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['append_file'];
			return { invocationMessage: mdRich(code(fileLabel(p.uri))) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['append_file'];
			const r = result as Awaited<BuiltinToolResultType['append_file']>;
			const details = editDetails(p.uri, r) ?? textCard('(content appended)');
			return {
				pastTenseMessage: editFileTitle(p.uri, r.added, r.removed),
				toolResultDetails: details,
			};
		},
	},

	create_file_or_folder: {
		icon: Codicon.newFile,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['create_file_or_folder'];
			const kind = p.isFolder ? 'folder' : 'file';
			return { invocationMessage: md(`Creating ${kind} ${code(fileLabel(p.uri))}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['create_file_or_folder'];
			const r = result as BuiltinToolResultType['create_file_or_folder'];
			const kind = p.isFolder ? 'folder' : 'file';
			return {
				pastTenseMessage: md(r.alreadyExists ? `${kind} ${code(fileLabel(p.uri))} already exists` : `Created ${kind} ${code(fileLabel(p.uri))}`),
				toolResultDetails: uriList([p.uri]),
			};
		},
	},

	delete_file_or_folder: {
		icon: Codicon.trash,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['delete_file_or_folder'];
			return { invocationMessage: md(`Deleting ${code(fileLabel(p.uri))}`) };
		},
		present: (params) => {
			const p = params as BuiltinToolCallParams['delete_file_or_folder'];
			return {
				pastTenseMessage: md(`Deleted ${code(fileLabel(p.uri))}`),
				toolResultDetails: uriList([p.uri]),
			};
		},
	},

	run_command: {
		icon: Codicon.terminal,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['run_command'];
			return { invocationMessage: mdRich(code(shortCommandLabel(p.command))) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['run_command'];
			const r = result as BuiltinToolResultType['run_command'];
			const label = shortCommandLabel(p.command);
			const exit = r.resolveReason.type === 'done' && r.resolveReason.exitCode !== 0
				? ` <span style="color:var(--vscode-gitDecoration-deletedResourceForeground);">exit ${r.resolveReason.exitCode}</span>`
				: '';
			// Output only — never put the full command in an "Input" pane. Title is the description.
			return {
				pastTenseMessage: mdRich(`${code(label)}${exit}`),
				toolResultDetails: textCard(previewOutput(r.result || '(no output)')),
			};
		},
	},

	run_persistent_command: {
		icon: Codicon.terminal,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['run_persistent_command'];
			return { invocationMessage: mdRich(code(shortCommandLabel(p.command))) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['run_persistent_command'];
			const r = result as BuiltinToolResultType['run_persistent_command'];
			return {
				pastTenseMessage: mdRich(code(shortCommandLabel(p.command))),
				toolResultDetails: textCard(previewOutput(r.result || '(no output)')),
			};
		},
	},

	open_persistent_terminal: {
		icon: Codicon.terminal,
		prepare: () => ({ invocationMessage: md('Opening terminal') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['open_persistent_terminal'];
			return { pastTenseMessage: md(`Opened terminal \`${r.persistentTerminalId}\``) };
		},
	},

	kill_persistent_terminal: {
		icon: Codicon.terminal,
		prepare: () => ({ invocationMessage: md('Closing terminal') }),
		present: () => ({ pastTenseMessage: md('Closed terminal') }),
	},

	run_sandbox: {
		icon: Codicon.beaker,
		prepare: () => ({ invocationMessage: md('Running sandbox') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['run_sandbox'];
			const output = [r.result, r.error ? `Error: ${r.error}` : '', ...r.logs].filter(Boolean).join('\n');
			return {
				pastTenseMessage: md(`Sandbox finished (${r.durationMs}ms)`),
				toolResultDetails: textCard(output || '(no output)'),
			};
		},
	},

	remember: {
		icon: Codicon.notebook,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['remember'];
			return { invocationMessage: md(`Remembering note on ${code(p.symbolName)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['remember'];
			const r = result as BuiltinToolResultType['remember'];
			return {
				pastTenseMessage: md(`Saved note on ${code(p.symbolName)}`),
				toolResultDetails: textCard(r.note.note),
			};
		},
	},

	forget: {
		icon: Codicon.notebook,
		prepare: () => ({ invocationMessage: md('Forgetting note') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['forget'];
			return { pastTenseMessage: md(r.deleted ? 'Deleted note' : 'Note not found') };
		},
	},

	team_checkin: {
		icon: Codicon.organization,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['team_checkin'];
			return { invocationMessage: md(p.status === 'done' ? 'Checking out of the team board' : 'Checking in on the team board') };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['team_checkin'];
			return { pastTenseMessage: md(r.status === 'done' ? `Checked out ${code(r.agentId)}` : `Checked in as ${code(r.agentId)}`) };
		},
	},

	team_board: {
		icon: Codicon.organization,
		prepare: () => ({ invocationMessage: md('Reading the team board') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['team_board'];
			const text = r.entries.map(e => `${e.agentId}: ${e.doing}${e.where ? ` [${e.where}]` : ''}`).join('\n');
			return {
				pastTenseMessage: md(r.entries.length ? `Team board: ${r.entries.length} active agent(s)` : 'Team board: empty'),
				toolResultDetails: textCard(text || 'No agents checked in'),
			};
		},
	},

	team_contract: {
		icon: Codicon.lock,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['team_contract'];
			return { invocationMessage: md(p.action === 'clear' ? `Clearing contract ${code(p.key)}` : `Freezing contract ${code(p.key)}`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['team_contract'];
			return {
				pastTenseMessage: md(r.action === 'clear' ? `Cleared contract ${code(r.key)}` : `Froze contract ${code(r.key)}`),
				toolResultDetails: textCard(r.contracts.map(c => `${c.key} = ${c.value}`).join('\n') || 'No contracts on the board'),
			};
		},
	},

	list_notes: {
		icon: Codicon.notebook,
		prepare: () => ({ invocationMessage: md('Listing notes') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['list_notes'];
			const text = r.notes.map(n => `${n.symbolName} @ ${n.filePath}: ${truncate(n.note, 80)}`).join('\n');
			return {
				pastTenseMessage: md(`Listed ${r.notes.length} notes`),
				toolResultDetails: textCard(text || 'No notes'),
			};
		},
	},

	search_notes: {
		icon: Codicon.notebook,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['search_notes'];
			return { invocationMessage: md(`Searching notes ${code(p.query)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['search_notes'];
			const r = result as BuiltinToolResultType['search_notes'];
			const text = r.notes.map(n => `${n.symbolName}: ${truncate(n.note, 80)}`).join('\n');
			return {
				pastTenseMessage: md(`Found ${r.notes.length} notes for ${code(p.query)}`),
				toolResultDetails: textCard(text || 'No notes'),
			};
		},
	},

	workspace_delta: {
		icon: Codicon.database,
		prepare: () => ({ invocationMessage: md('Reading workspace delta') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['workspace_delta'];
			return {
				pastTenseMessage: md(`Workspace delta (${r.changedFiles.length} files, ${r.buildErrorCount} errors)`),
				toolResultDetails: textCard(r.summary || JSON.stringify(r, null, 2)),
			};
		},
	},

	search_memory: {
		icon: Codicon.search,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['search_memory'];
			return { invocationMessage: md(`Searching indexed memory ${code(p.query)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['search_memory'];
			const r = result as BuiltinToolResultType['search_memory'];
			const text = r.hits.slice(0, 15).map(hit => `[${hit.kind}] ${hit.id}: ${truncate(hit.summary, 120)}`).join('\n');
			return {
				pastTenseMessage: md(r.unavailable ? 'Indexed memory unavailable' : `Found ${r.hits.length} indexed memory hits for ${code(p.query)}`),
				toolResultDetails: textCard(text || 'No hits'),
			};
		},
	},

	get_memory_checkpoint: {
		icon: Codicon.archive,
		prepare: () => ({ invocationMessage: md('Opening memory checkpoint') }),
		present: (_params, result) => {
			const r = result as BuiltinToolResultType['get_memory_checkpoint'];
			const checkpoint = r.evidence?.checkpoint;
			return {
				pastTenseMessage: md(checkpoint ? `Opened memory checkpoint ${code(checkpoint.id)}` : 'Memory checkpoint not found'),
				toolResultDetails: textCard(checkpoint ? `${checkpoint.summary}\n\n${r.evidence?.events.length ?? 0} source event(s) on this page` : 'Not found'),
			};
		},
	},

	search_chat_memory: {
		icon: Codicon.history,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['search_chat_memory'];
			return { invocationMessage: md(`Searching memory ${code(p.query)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['search_chat_memory'];
			const r = result as BuiltinToolResultType['search_chat_memory'];
			const text = r.events.slice(0, 15).map(e => `[${e.kind}] ${e.title}: ${truncate(e.body, 100)}`).join('\n');
			return {
				pastTenseMessage: md(r.unavailable ? 'Memory unavailable' : `Found ${r.events.length} memory events for ${code(p.query)}`),
				toolResultDetails: textCard(text || 'No events'),
			};
		},
	},

	get_chat_session: {
		icon: Codicon.history,
		prepare: () => ({ invocationMessage: md('Reading chat session') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['get_chat_session'];
			return {
				pastTenseMessage: md(`Loaded ${r.events.length} session events`),
				toolResultDetails: textCard(r.events.slice(0, 15).map(e => `[${e.kind}] ${e.title}`).join('\n') || 'Empty'),
			};
		},
	},

	get_chat_thread: {
		icon: Codicon.history,
		prepare: () => ({ invocationMessage: md('Reading chat thread') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['get_chat_thread'];
			return {
				pastTenseMessage: md(`Loaded ${r.events.length} thread events`),
				toolResultDetails: textCard(r.events.slice(0, 15).map(e => `[${e.kind}] ${e.title}`).join('\n') || 'Empty'),
			};
		},
	},

	deep_recall: {
		icon: Codicon.archive,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['deep_recall'];
			return { invocationMessage: md(`Deep recall ${code(p.query)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['deep_recall'];
			const r = result as BuiltinToolResultType['deep_recall'];
			const text = r.hits.slice(0, 12).map(h => `[${h.kind}] ${h.file ?? ''} ${truncate(h.snippet, 100)}`).join('\n');
			return {
				pastTenseMessage: md(r.unavailable ? 'Shadow archive unavailable' : `Deep recall ${r.hits.length} hits for ${code(p.query)}`),
				toolResultDetails: textCard(text || 'No hits'),
			};
		},
	},

	get_shadow_record: {
		icon: Codicon.archive,
		prepare: () => ({ invocationMessage: md('Fetching shadow record') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['get_shadow_record'];
			return {
				pastTenseMessage: md(r.record ? 'Loaded shadow record' : 'Shadow record not found'),
				toolResultDetails: textCard(r.record?.text ?? '(not found)'),
			};
		},
	},

	get_editorial_briefing: {
		icon: Codicon.book,
		prepare: () => ({ invocationMessage: md('Reading editorial briefing') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['get_editorial_briefing'];
			return {
				pastTenseMessage: md(`Editorial briefing: ${code(r.projectName)} (${r.branches.length} branches)`),
				toolResultDetails: textCard(r.readme || r.branches.map(b => b.name).join(', ') || '(empty)'),
			};
		},
	},

	search_editorial: {
		icon: Codicon.book,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['search_editorial'];
			return { invocationMessage: md(`Searching editorial ${code(p.query)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['search_editorial'];
			const r = result as BuiltinToolResultType['search_editorial'];
			const text = r.branches.map(b => `${b.name}: ${truncate(b.miniReadme, 100)}`).join('\n\n');
			return {
				pastTenseMessage: md(`Found ${r.branches.length} editorial branches for ${code(p.query)}`),
				toolResultDetails: textCard(text || 'No branches'),
			};
		},
	},

	recent_edits: {
		icon: Codicon.history,
		prepare: () => ({ invocationMessage: md('Reading recent edits') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['recent_edits'];
			const text = r.edits.slice(0, 15).map(e => e.summary || e.relativePath).join('\n');
			return {
				pastTenseMessage: md(`${r.edits.length} recent edits`),
				toolResultDetails: textCard(text || 'No recent edits'),
			};
		},
	},

	index_health: {
		icon: Codicon.pulse,
		prepare: () => ({ invocationMessage: md('Checking index health') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['index_health'];
			const s = r.status;
			const upgrade = s.backgroundUpgrade && s.chunksToEmbed
				? `, quality upgrade ${Math.floor(((s.embeddedChunks ?? 0) / s.chunksToEmbed) * 100)}%`
				: '';
			const summary = `${s.state}: ${s.filesIndexed}/${s.filesTotal} files, ${s.chunksTotal} chunks${upgrade}${s.currentFile ? ` — indexing ${s.currentFile}` : ''}`;
			return {
				pastTenseMessage: md(`Index ${s.state}${r.rebuildStarted ? ' (rebuild started)' : ''}`),
				toolResultDetails: textCard(summary),
			};
		},
	},

	session_diff: {
		icon: Codicon.diff,
		prepare: () => ({ invocationMessage: md('Reading session diff') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['session_diff'];
			const text = r.files.map(f => `${f.status}\t${f.path}`).join('\n');
			return {
				pastTenseMessage: md(`${r.count} changed files this session`),
				toolResultDetails: textCard(text || 'No changes'),
			};
		},
	},

	get_file_context: {
		icon: Codicon.symbolClass,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['get_file_context'];
			return { invocationMessage: md(`Reading context ${code(basename(p.filePath))}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['get_file_context'];
			const r = result as BuiltinToolResultType['get_file_context'];
			return {
				pastTenseMessage: md(`File context ${code(basename(p.filePath))} (${r.symbols.length} symbols)`),
				toolResultDetails: textCard(JSON.stringify(r, null, 2)),
			};
		},
	},

	get_file_dependencies: {
		icon: Codicon.typeHierarchySub,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['get_file_dependencies'];
			return { invocationMessage: md(`Reading dependencies ${code(basename(p.filePath))}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['get_file_dependencies'];
			const r = result as BuiltinToolResultType['get_file_dependencies'];
			return {
				pastTenseMessage: md(`Dependencies ${code(basename(p.filePath))} (${r.directImports.length} imports)`),
				toolResultDetails: textCard(JSON.stringify(r, null, 2)),
			};
		},
	},

	get_symbol_context: {
		icon: Codicon.symbolMethod,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['get_symbol_context'];
			return { invocationMessage: md(`Reading symbol ${code(p.symbolName)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['get_symbol_context'];
			const r = result as BuiltinToolResultType['get_symbol_context'];
			return {
				pastTenseMessage: md(`Symbol context ${code(p.symbolName)} (${r.references.length} refs)`),
				toolResultDetails: textCard(JSON.stringify(r, null, 2)),
			};
		},
	},

	get_call_graph: {
		icon: Codicon.typeHierarchy,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['get_call_graph'];
			return { invocationMessage: md(`Reading call graph ${code(p.symbolName)} (${p.direction})`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['get_call_graph'];
			const r = result as BuiltinToolResultType['get_call_graph'];
			return {
				pastTenseMessage: md(`Call graph ${code(p.symbolName)} (${r.totalNodes} nodes)`),
				toolResultDetails: textCard(JSON.stringify(r, null, 2)),
			};
		},
	},

	pack_context: {
		icon: Codicon.package,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['pack_context'];
			return { invocationMessage: md(`Packing context ${code(p.symbolName)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['pack_context'];
			const r = result as BuiltinToolResultType['pack_context'];
			return {
				pastTenseMessage: md(`Packed context ${code(p.symbolName)} (~${r.meta.estimated_tokens} tokens)`),
				toolResultDetails: textCard(JSON.stringify(r, null, 2)),
			};
		},
	},

	get_project_briefing: {
		icon: Codicon.project,
		prepare: () => ({ invocationMessage: md('Reading project briefing') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['get_project_briefing'];
			return {
				pastTenseMessage: md(`Project briefing (${r.notes.length} notes)`),
				toolResultDetails: textCard(JSON.stringify(r, null, 2)),
			};
		},
	},

	web_search: {
		icon: Codicon.globe,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['web_search'];
			return { invocationMessage: md(`Searching web ${code(p.query)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['web_search'];
			const r = result as BuiltinToolResultType['web_search'];
			const text = r.results.map(res => `${res.title}\n${res.url}\n${res.snippet}`).join('\n\n');
			return {
				pastTenseMessage: md(`Web search ${code(p.query)} (${r.results.length} results)`),
				toolResultDetails: textCard(text || 'No results'),
			};
		},
	},

	repo_hygiene: {
		icon: Codicon.sourceControl,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['repo_hygiene'];
			const verb = p.action === 'plan' ? 'Checking worktrees and branches' : p.action === 'push' ? `Pushing ${code(p.path ?? '')}` : p.action === 'remove' ? `Removing worktree ${code(p.path ?? '')}` : 'Forgetting stale worktree records';
			return { invocationMessage: md(verb) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['repo_hygiene'];
			const r = result as BuiltinToolResultType['repo_hygiene'];
			return {
				pastTenseMessage: md(p.action === 'plan' ? 'Checked worktrees and branches' : p.action === 'push' ? 'Pushed' : p.action === 'remove' ? 'Removed worktree' : 'Pruned stale records'),
				toolResultDetails: textCard(r.output),
			};
		},
	},

	git_status: {
		icon: Codicon.sourceControl,
		prepare: () => ({ invocationMessage: md('Reading git status') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_status'];
			return {
				pastTenseMessage: md('Read git status'),
				toolResultDetails: textCard(r.status),
			};
		},
	},

	git_stage: {
		icon: Codicon.sourceControl,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_stage'];
			return { invocationMessage: md(`Staging ${p.paths.length} file(s)`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['git_stage'];
			const r = result as BuiltinToolResultType['git_stage'];
			return {
				pastTenseMessage: md(`Staged ${p.paths.length} file(s)`),
				toolResultDetails: textCard(r.output),
			};
		},
	},

	git_commit: {
		icon: Codicon.sourceControl,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_commit'];
			const pathNote = p.paths?.length ? ` (${p.paths.length} file(s))` : '';
			return { invocationMessage: md(`Committing ${code(truncate(p.message, 60))}${pathNote}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['git_commit'];
			const r = result as BuiltinToolResultType['git_commit'];
			return {
				pastTenseMessage: md(`Committed ${code(truncate(p.message, 40))}`),
				toolResultDetails: textCard(r.output),
			};
		},
	},

	git_diff: {
		icon: Codicon.diff,
		prepare: () => ({ invocationMessage: md('Reading git diff') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_diff'];
			return {
				pastTenseMessage: md('Read git diff'),
				toolResultDetails: ioCard('git diff', r.diff, 'diff'),
			};
		},
	},

	git_log: {
		icon: Codicon.history,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_log'];
			return { invocationMessage: md(`Reading git log (${p.count})`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_log'];
			return {
				pastTenseMessage: md('Read git log'),
				toolResultDetails: textCard(r.log),
			};
		},
	},

	git_branch: {
		icon: Codicon.sourceControl,
		prepare: () => ({ invocationMessage: md('Reading git branches') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_branch'];
			return {
				pastTenseMessage: md(`On branch ${code(r.branch)}`),
				toolResultDetails: textCard(r.branches),
			};
		},
	},

	git_push: {
		icon: Codicon.cloudUpload,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_push'];
			const target = p.branch ?? 'current branch';
			return { invocationMessage: md(`Pushing ${code(target)}`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_push'];
			return { pastTenseMessage: md('Pushed to remote'), toolResultDetails: textCard(r.output) };
		},
	},

	git_pull: {
		icon: Codicon.cloudDownload,
		prepare: () => ({ invocationMessage: md('Pulling from remote') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_pull'];
			return { pastTenseMessage: md('Pulled from remote'), toolResultDetails: textCard(r.output) };
		},
	},

	git_fetch: {
		icon: Codicon.repoFetch,
		prepare: () => ({ invocationMessage: md('Fetching from remote') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_fetch'];
			return { pastTenseMessage: md('Fetched from remote'), toolResultDetails: textCard(r.output) };
		},
	},

	git_checkout: {
		icon: Codicon.sourceControl,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_checkout'];
			return { invocationMessage: md(p.create ? `Creating branch ${code(p.branch)}` : `Checking out ${code(p.branch)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['git_checkout'];
			const r = result as BuiltinToolResultType['git_checkout'];
			return {
				pastTenseMessage: md(p.create ? `Created branch ${code(p.branch)}` : `Checked out ${code(p.branch)}`),
				toolResultDetails: textCard(r.output),
			};
		},
	},

	git_stash: {
		icon: Codicon.archive,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_stash'];
			return { invocationMessage: md(`Git stash ${code(p.action)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['git_stash'];
			const r = result as BuiltinToolResultType['git_stash'];
			return {
				pastTenseMessage: md(`Git stash ${p.action}`),
				toolResultDetails: textCard(r.output),
			};
		},
	},

	git_remote: {
		icon: Codicon.repo,
		prepare: () => ({ invocationMessage: md('Reading git remotes') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_remote'];
			return { pastTenseMessage: md('Read git remotes'), toolResultDetails: textCard(r.output) };
		},
	},

	git_show: {
		icon: Codicon.gitCommit,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_show'];
			return { invocationMessage: md(`Git show ${code(p.ref)}`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_show'];
			return { pastTenseMessage: md('Git show'), toolResultDetails: textCard(r.output) };
		},
	},

	git_blame: {
		icon: Codicon.gitCommit,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_blame'];
			return { invocationMessage: md(`Git blame ${code(p.path)}`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_blame'];
			return { pastTenseMessage: md('Git blame'), toolResultDetails: textCard(r.output) };
		},
	},

	git_merge: {
		icon: Codicon.sourceControl,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_merge'];
			return { invocationMessage: md(p.abort ? 'Abort merge' : `Merge ${code(p.branch ?? '')}`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_merge'];
			return { pastTenseMessage: md('Git merge'), toolResultDetails: textCard(r.output) };
		},
	},

	git_rebase: {
		icon: Codicon.sourceControl,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_rebase'];
			return { invocationMessage: md(`Git rebase ${code(p.action)}`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_rebase'];
			return { pastTenseMessage: md('Git rebase'), toolResultDetails: textCard(r.output) };
		},
	},

	git_cherry_pick: {
		icon: Codicon.sourceControl,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_cherry_pick'];
			return { invocationMessage: md(p.abort ? 'Abort cherry-pick' : `Cherry-pick ${code(p.commit ?? '')}`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_cherry_pick'];
			return { pastTenseMessage: md('Cherry-pick'), toolResultDetails: textCard(r.output) };
		},
	},

	git_restore: {
		icon: Codicon.discard,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_restore'];
			return { invocationMessage: md(`Restore ${p.paths.length} path(s)`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_restore'];
			return { pastTenseMessage: md('Restored paths'), toolResultDetails: textCard(r.output) };
		},
	},

	git_reset: {
		icon: Codicon.discard,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['git_reset'];
			return { invocationMessage: md(`Reset (${p.mode}) to ${code(p.ref)}`) };
		},
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['git_reset'];
			return { pastTenseMessage: md('Git reset'), toolResultDetails: textCard(r.output) };
		},
	},

	open_browser: {
		icon: Codicon.globe,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['open_browser'];
			return { invocationMessage: md(`Opening ${code(p.url)}`) };
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['open_browser'];
			const r = result as BuiltinToolResultType['open_browser'];
			return {
				pastTenseMessage: md(r.opened ? `Opened ${code(p.url)}` : `Failed to open ${code(p.url)}`),
			};
		},
	},

	generate_image: {
		icon: Codicon.fileMedia,
		prepare: () => ({ invocationMessage: md('Generating image') }),
		present: (_p, result) => {
			const r = result as BuiltinToolResultType['generate_image'];
			// `r.uri` is already a `file://` URI; `URI.file()` expects a filesystem PATH.
			// Passing the URI string into `URI.file()` produced
			// `file:///file:/Users/.../assets/foo.png` (double `file:` prefix), which is the
			// "Webview.loadLocalResource ... ENOENT '/file:/Users/.../assets/foo.png'" the user
			// reported when clicking the generated-image link. Use `fsPath` for `URI.file()`.
			return {
				pastTenseMessage: md(`Generated image ${code(basename(r.path))}`),
				toolResultDetails: uriList([URI.file(r.fsPath)]),
			};
		},
	},

	launch_subagent: {
		icon: Codicon.organization,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['launch_subagent'];
			return {
				invocationMessage: md(p.description || 'Launching subagent'),
				toolSpecificData: {
					kind: 'subagent',
					description: p.description,
					prompt: p.prompt,
					agentName: 'Background subagent',
				} satisfies IChatSubagentToolInvocationData,
			};
		},
		present: (params, result) => {
			const p = params as BuiltinToolCallParams['launch_subagent'];
			const r = result as BuiltinToolResultType['launch_subagent'];
			return {
				pastTenseMessage: md(`${p.description || 'Subagent'} (${r.status})`),
				toolSpecificData: {
					kind: 'subagent',
					description: p.description,
					prompt: p.prompt,
					result: r.result,
					agentName: 'Background subagent',
				} satisfies IChatSubagentToolInvocationData,
				toolResultDetails: textCard(r.result),
			};
		},
	},

	update_plan: {
		icon: Codicon.checklist,
		prepare: (params) => {
			const p = params as BuiltinToolCallParams['update_plan'];
			const todoList = coerceTodoListForPlan(p.todos);
			return {
				invocationMessage: md(`Updating plan (${todoList.length} items)`),
				toolSpecificData: { kind: 'todoList', todoList },
			};
		},
		present: (params, result) => {
			const r = result as BuiltinToolResultType['update_plan'];
			const todoList = coerceTodoListForPlan(r.todos);
			return {
				pastTenseMessage: md(`Updated plan (${todoList.length} items)`),
				toolSpecificData: { kind: 'todoList', todoList },
			};
		},
	},
};

// Browser automation tools (native-routed but also registered for some) — string result pattern
const browserTools: BuiltinToolName[] = [
	'open_browser_page', 'read_page', 'click_element', 'type_in_page', 'screenshot_page',
	'navigate_page', 'hover_element', 'drag_element', 'handle_dialog', 'run_playwright_code',
	'extract_page_data', 'get_browser_console_logs', 'reconstruct_page_sources',
	'get_computed_styles', 'watch_page', 'save_browser_session', 'restore_browser_session',
	'fill_form', 'intercept_network', 'get_browser_network_log',
];

for (const name of browserTools) {
	presenters[name] = stringResultPresenter(
		Codicon.globe,
		() => `Running ${name.replace(/_/g, ' ')}`,
		() => `Ran ${name.replace(/_/g, ' ')}`,
		r => r.result,
	);
}

// Native-routed tools that may still appear in registry for completeness
presenters.run_subagent = {
	icon: Codicon.organization,
	prepare: (params) => {
		const p = params as BuiltinToolCallParams['run_subagent'];
		return {
			invocationMessage: md(p.description || 'Running subagent'),
			toolSpecificData: {
				kind: 'subagent',
				description: p.description,
				prompt: p.prompt,
				agentName: p.agentName,
			} satisfies IChatSubagentToolInvocationData,
		};
	},
	present: (params, result) => {
		const p = params as BuiltinToolCallParams['run_subagent'];
		const r = result as BuiltinToolResultType['run_subagent'];
		return {
			pastTenseMessage: md(p.description || 'Subagent completed'),
			toolSpecificData: {
				kind: 'subagent',
				description: p.description,
				prompt: p.prompt,
				agentName: p.agentName,
				result: r.result,
			} satisfies IChatSubagentToolInvocationData,
			toolResultDetails: textCard(r.result),
		};
	},
};

presenters.rename_symbol = stringResultPresenter(
	Codicon.symbolMethod,
	p => `Renaming ${code((p as BuiltinToolCallParams['rename_symbol']).symbol)}`,
	p => `Renamed ${code((p as BuiltinToolCallParams['rename_symbol']).symbol)}`,
	r => r.result,
);

presenters.list_code_usages = stringResultPresenter(
	Codicon.references,
	p => `Finding usages of ${code((p as BuiltinToolCallParams['list_code_usages']).symbol)}`,
	p => `Found usages of ${code((p as BuiltinToolCallParams['list_code_usages']).symbol)}`,
	r => r.result,
);

presenters.run_tests = stringResultPresenter(
	Codicon.beaker,
	() => 'Running tests',
	() => 'Ran tests',
	r => r.result,
);

function coerceTodoListForPlan(raw: unknown): IChatTodoListContent['todoList'] {
	if (typeof raw === 'string') {
		try { raw = JSON.parse(raw); } catch { return []; }
	}
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
		.map((t, i) => ({
			id: typeof t.id === 'string' && t.id ? t.id : String(i),
			title: typeof t.content === 'string' ? t.content : (typeof t.title === 'string' ? t.title : ''),
			status: mapTodoStatus(typeof t.status === 'string' ? t.status : ''),
		}));
}

function mapTodoStatus(status: string): 'not-started' | 'in-progress' | 'completed' {
	switch (status) {
		case 'in_progress': return 'in-progress';
		case 'completed':
		case 'cancelled': return 'completed';
		default: return 'not-started';
	}
}

const fallbackIcon = Codicon.tools;

export function getV3CodeToolPresenter(toolName: BuiltinToolName): V3CodeToolPresenter {
	return presenters[toolName] ?? defaultPresenter(fallbackIcon, `Running \`${toolName}\``, `Ran \`${toolName}\``);
}

export function getV3CodeToolIcon(toolName: BuiltinToolName): ThemeIcon {
	return getV3CodeToolPresenter(toolName).icon;
}
