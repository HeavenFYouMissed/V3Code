/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { localize } from '../../../../../../nls.js';
import './media/chatUnifiedDiff.css';

type DiffLineKind = 'added' | 'removed' | 'context' | 'hunk' | 'filehead';

interface ParsedDiffLine {
	kind: DiffLineKind;
	text: string;
	oldNo: number | null;
	newNo: number | null;
}

type RenderItem = ParsedDiffLine | { kind: 'collapsed'; count: number };

const CONTEXT_RUN_MIN = 8;
const CONTEXT_EDGE = 3;
const CARD_ROWS = 8;

function unwrapDiffText(diffText: string): string[] {
	const lines = diffText.replace(/\r\n|\r/g, '\n').split('\n');
	while (lines.length > 0 && lines[0].trim() === '') {
		lines.shift();
	}
	while (lines.length > 0 && lines.at(-1)?.trim() === '') {
		lines.pop();
	}
	if (lines[0]?.trim().startsWith('```')) {
		lines.shift();
	}
	if (lines.at(-1)?.trim() === '```') {
		lines.pop();
	}
	return lines;
}

/** Parse a unified patch while tracking line numbers independently for both sides. */
export function parseUnifiedDiffLines(diffText: string): ParsedDiffLine[] {
	const parsed: ParsedDiffLine[] = [];
	let oldLine = 1;
	let newLine = 1;

	for (const raw of unwrapDiffText(diffText)) {
		if (raw.startsWith('diff --git ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
			parsed.push({ kind: 'filehead', text: raw, oldNo: null, newNo: null });
			continue;
		}

		if (raw.startsWith('@@')) {
			const header = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
			if (header) {
				oldLine = Number(header[1]);
				newLine = Number(header[2]);
			}
			parsed.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null });
			continue;
		}

		if (raw.startsWith('\\ No newline at end of file')) {
			parsed.push({ kind: 'filehead', text: raw, oldNo: null, newNo: null });
			continue;
		}

		if (raw.startsWith('+')) {
			parsed.push({ kind: 'added', text: raw.slice(1), oldNo: null, newNo: newLine++ });
			continue;
		}
		if (raw.startsWith('-')) {
			parsed.push({ kind: 'removed', text: raw.slice(1), oldNo: oldLine++, newNo: null });
			continue;
		}

		parsed.push({
			kind: 'context',
			text: raw.startsWith(' ') ? raw.slice(1) : raw,
			oldNo: oldLine++,
			newNo: newLine++,
		});
	}
	return parsed;
}

/** Replace only the middle of long unchanged runs with an explicit gap row. */
export function collapseContextRuns(lines: ParsedDiffLine[]): RenderItem[] {
	const result: RenderItem[] = [];
	for (let index = 0; index < lines.length;) {
		if (lines[index].kind !== 'context') {
			result.push(lines[index++]);
			continue;
		}

		let end = index + 1;
		while (end < lines.length && lines[end].kind === 'context') {
			end++;
		}
		const count = end - index;
		if (count < CONTEXT_RUN_MIN) {
			result.push(...lines.slice(index, end));
		} else {
			result.push(...lines.slice(index, index + CONTEXT_EDGE));
			result.push({ kind: 'collapsed', count: count - (CONTEXT_EDGE * 2) });
			result.push(...lines.slice(end - CONTEXT_EDGE, end));
		}
		index = end;
	}
	return result;
}

function appendNumber(row: HTMLElement, value: number | null): void {
	const number = document.createElement('span');
	number.className = 'chat-patch-preview-line-number';
	number.setAttribute('aria-hidden', 'true');
	number.textContent = value === null ? '' : String(value);
	row.appendChild(number);
}

function appendLine(root: HTMLElement, item: ParsedDiffLine): void {
	const row = document.createElement('div');
	row.className = 'chat-patch-preview-row';
	row.dataset.kind = item.kind;
	row.setAttribute('role', 'row');

	appendNumber(row, item.oldNo);
	appendNumber(row, item.newNo);

	const marker = document.createElement('span');
	marker.className = 'chat-patch-preview-marker';
	marker.setAttribute('aria-hidden', 'true');
	marker.textContent = item.kind === 'added' ? '+' : item.kind === 'removed' ? '-' : '';
	row.appendChild(marker);

	const code = document.createElement('span');
	code.className = 'chat-patch-preview-code';
	code.textContent = item.text;
	row.appendChild(code);
	root.appendChild(row);
}

function appendGap(root: HTMLElement, count: number): void {
	const gap = document.createElement('div');
	gap.className = 'chat-patch-preview-gap';
	gap.setAttribute('role', 'row');
	gap.textContent = localize('chatPatchOmittedLines', "{0} lines omitted", count);
	root.appendChild(gap);
}

function appendRemaining(root: HTMLElement, count: number): void {
	const gap = document.createElement('div');
	gap.className = 'chat-patch-preview-gap';
	gap.setAttribute('role', 'row');
	gap.textContent = localize('chatPatchRemainingRows', "{0} more diff rows", count);
	root.appendChild(gap);
}

export const UNIFIED_DIFF_PREVIEW_LINES = 40;

export function renderUnifiedDiff(diffText: string, maxLines = UNIFIED_DIFF_PREVIEW_LINES): HTMLElement {
	const allItems = collapseContextRuns(parseUnifiedDiffLines(diffText));
	const boundedCount = Math.max(0, Math.min(allItems.length, Math.floor(maxLines)));
	const visibleCount = Math.min(boundedCount, CARD_ROWS);
	const root = document.createElement('div');
	root.className = 'chat-patch-preview';
	root.dataset.truncated = String(visibleCount < allItems.length);
	root.setAttribute('role', 'table');
	root.setAttribute('aria-label', localize('chatPatchPreview', "Patch preview"));
	root.tabIndex = 0;

	for (const item of allItems.slice(0, visibleCount)) {
		if (item.kind === 'collapsed') {
			appendGap(root, item.count);
		} else {
			appendLine(root, item);
		}
	}
	if (visibleCount < allItems.length) {
		appendRemaining(root, allItems.length - visibleCount);
	}
	return root;
}
