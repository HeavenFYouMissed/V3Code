/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { splitLines } from '../../../../../../base/common/strings.js';
import { URI } from '../../../../../../base/common/uri.js';
import { linesDiffComputers } from '../../../../../../editor/common/diff/linesDiffComputers.js';
import { ILanguageService } from '../../../../../../editor/common/languages/language.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../../../editor/common/languages/modesRegistry.js';
import { localize } from '../../../../../../nls.js';
import './media/chatSlimDiff.css';

type SlimDiffItem =
	| {
		type: 'added' | 'removed' | 'unchanged';
		content: string;
		originalLineNumber?: number;
		modifiedLineNumber?: number;
	}
	| { type: 'collapsed'; lineCount: number };

export interface ISlimDiffOptions {
	/** Unchanged lines kept around each changed range. */
	contextLines?: number;
	/** Show two line-number columns, one compact column, or no line numbers. */
	showLineNumbers?: boolean | 'partial';
	/** Hard limit used before the five-row card preview is selected. */
	maxItems?: number;
	/** Kept for callers that tune code-card indentation. */
	indentThreshold?: number;
	/** Language id or file path used to describe the preview. */
	languageId?: string;
	tabSize?: number;
}

const CARD_ROWS = 5;

function sourceLines(value: string): string[] {
	// The editor differ expects at least one logical line. Empty-file sentinels are
	// removed again when rows are emitted below.
	return splitLines(value);
}

function addContext(
	items: SlimDiffItem[],
	originalLines: readonly string[],
	originalStart: number,
	modifiedStart: number,
	length: number,
): void {
	for (let offset = 0; offset < length; offset++) {
		items.push({
			type: 'unchanged',
			content: originalLines[originalStart - 1 + offset] ?? '',
			originalLineNumber: originalStart + offset,
			modifiedLineNumber: modifiedStart + offset,
		});
	}
}

function addUnchangedRange(
	items: SlimDiffItem[],
	originalLines: readonly string[],
	originalStart: number,
	modifiedStart: number,
	length: number,
	contextLines: number,
	position: 'leading' | 'between' | 'trailing',
): void {
	if (length <= 0) {
		return;
	}

	if (position === 'leading') {
		const kept = Math.min(contextLines, length);
		const omitted = length - kept;
		if (omitted > 0) {
			items.push({ type: 'collapsed', lineCount: omitted });
		}
		addContext(items, originalLines, originalStart + omitted, modifiedStart + omitted, kept);
		return;
	}

	if (position === 'trailing') {
		const kept = Math.min(contextLines, length);
		addContext(items, originalLines, originalStart, modifiedStart, kept);
		const omitted = length - kept;
		if (omitted > 0) {
			items.push({ type: 'collapsed', lineCount: omitted });
		}
		return;
	}

	if (length <= contextLines * 2) {
		addContext(items, originalLines, originalStart, modifiedStart, length);
		return;
	}

	addContext(items, originalLines, originalStart, modifiedStart, contextLines);
	items.push({ type: 'collapsed', lineCount: length - (contextLines * 2) });
	addContext(
		items,
		originalLines,
		originalStart + length - contextLines,
		modifiedStart + length - contextLines,
		contextLines,
	);
}

/**
 * Builds a compact line diff from the editor's native diff computer.
 *
 * Line numbers remain one-based. Long unchanged spans become a single item so a
 * large edit cannot create thousands of DOM nodes in a chat transcript.
 */
export function buildSlimDiffItems(original: string, modified: string, contextLines = 3): SlimDiffItem[] {
	const originalLines = sourceLines(original);
	const modifiedLines = sourceLines(modified);
	const originalIsEmpty = original.length === 0;
	const modifiedIsEmpty = modified.length === 0;
	const diff = linesDiffComputers.getDefault().computeDiff(originalLines, modifiedLines, {
		ignoreTrimWhitespace: false,
		maxComputationTimeMs: 250,
		computeMoves: false,
	});
	if (diff.changes.length === 0) {
		return [];
	}

	const items: SlimDiffItem[] = [];
	const margin = Math.max(0, Math.floor(contextLines));
	let originalCursor = 1;
	let modifiedCursor = 1;

	for (let index = 0; index < diff.changes.length; index++) {
		const change = diff.changes[index];
		const unchangedLength = Math.min(
			change.original.startLineNumber - originalCursor,
			change.modified.startLineNumber - modifiedCursor,
		);
		addUnchangedRange(
			items,
			originalLines,
			originalCursor,
			modifiedCursor,
			unchangedLength,
			margin,
			index === 0 ? 'leading' : 'between',
		);

		for (let line = change.original.startLineNumber; line < change.original.endLineNumberExclusive; line++) {
			if (originalIsEmpty && line === 1) {
				continue;
			}
			items.push({
				type: 'removed',
				content: originalLines[line - 1] ?? '',
				originalLineNumber: line,
			});
		}
		for (let line = change.modified.startLineNumber; line < change.modified.endLineNumberExclusive; line++) {
			if (modifiedIsEmpty && line === 1) {
				continue;
			}
			items.push({
				type: 'added',
				content: modifiedLines[line - 1] ?? '',
				modifiedLineNumber: line,
			});
		}

		originalCursor = change.original.endLineNumberExclusive;
		modifiedCursor = change.modified.endLineNumberExclusive;
	}

	const trailingLength = Math.min(
		originalLines.length - originalCursor + 1,
		modifiedLines.length - modifiedCursor + 1,
	);
	addUnchangedRange(
		items,
		originalLines,
		originalCursor,
		modifiedCursor,
		trailingLength,
		margin,
		'trailing',
	);
	return items;
}

function appendNumber(parent: HTMLElement, value: number | undefined, className: string): void {
	const cell = document.createElement('span');
	cell.className = className;
	cell.setAttribute('aria-hidden', 'true');
	cell.textContent = value === undefined ? '' : String(value);
	parent.appendChild(cell);
}

function appendDiffRow(parent: HTMLElement, item: Exclude<SlimDiffItem, { type: 'collapsed' }>, lineNumbers: boolean | 'partial'): void {
	const row = document.createElement('div');
	row.className = 'chat-diff-preview-row';
	row.dataset.kind = item.type;
	row.setAttribute('role', 'row');

	if (lineNumbers === true) {
		appendNumber(row, item.originalLineNumber, 'chat-diff-preview-line-number');
		appendNumber(row, item.modifiedLineNumber, 'chat-diff-preview-line-number');
	} else if (lineNumbers === 'partial') {
		appendNumber(row, item.modifiedLineNumber ?? item.originalLineNumber, 'chat-diff-preview-line-number');
	}

	const marker = document.createElement('span');
	marker.className = 'chat-diff-preview-marker';
	marker.setAttribute('aria-hidden', 'true');
	marker.textContent = item.type === 'added' ? '+' : item.type === 'removed' ? '-' : '';
	row.appendChild(marker);

	const code = document.createElement('span');
	code.className = 'chat-diff-preview-code';
	code.textContent = item.content;
	row.appendChild(code);
	parent.appendChild(row);
}

function appendGapRow(parent: HTMLElement, count: number): void {
	const row = document.createElement('div');
	row.className = 'chat-diff-preview-gap';
	row.setAttribute('role', 'row');
	row.textContent = localize('chatDiffOmittedLines', "{0} unchanged lines", count);
	parent.appendChild(row);
}

function appendRemainingRow(parent: HTMLElement, count: number): void {
	const row = document.createElement('div');
	row.className = 'chat-diff-preview-gap';
	row.setAttribute('role', 'row');
	row.textContent = localize('chatDiffRemainingRows', "{0} more diff rows", count);
	parent.appendChild(row);
}

export function renderSlimDiff(
	original: string,
	modified: string,
	languageService: ILanguageService,
	options: ISlimDiffOptions = {},
): HTMLElement {
	const allItems = buildSlimDiffItems(original, modified, options.contextLines);
	const maxItems = Number.isFinite(options.maxItems)
		? Math.max(0, Math.floor(options.maxItems!))
		: allItems.length;
	const boundedItems = allItems.slice(0, maxItems);
	const shownItems = boundedItems.slice(0, CARD_ROWS);
	const hiddenCount = allItems.length - shownItems.length;

	const root = document.createElement('div');
	root.className = 'chat-diff-preview';
	root.dataset.truncated = String(hiddenCount > 0);
	root.dataset.languageId = resolveLanguageId(languageService, options.languageId);
	root.setAttribute('role', 'table');
	root.setAttribute('aria-label', localize('chatDiffPreview', "Code changes preview"));
	root.tabIndex = 0;
	if (options.tabSize && options.tabSize > 0) {
		root.style.tabSize = String(Math.floor(options.tabSize));
	}

	for (const item of shownItems) {
		if (item.type === 'collapsed') {
			appendGapRow(root, item.lineCount);
		} else {
			appendDiffRow(root, item, options.showLineNumbers ?? false);
		}
	}
	if (hiddenCount > 0) {
		appendRemainingRow(root, hiddenCount);
	}
	return root;
}

export function resolveLanguageId(languageService: ILanguageService, hint: string | undefined): string {
	if (!hint) {
		return PLAINTEXT_LANGUAGE_ID;
	}
	try {
		if (hint.includes('/') || hint.includes('\\') || hint.includes('.')) {
			return languageService.guessLanguageIdByFilepathOrFirstLine?.(URI.file(hint)) ?? PLAINTEXT_LANGUAGE_ID;
		}
		return languageService.isRegisteredLanguageId?.(hint) ? hint : PLAINTEXT_LANGUAGE_ID;
	} catch {
		return PLAINTEXT_LANGUAGE_ID;
	}
}
