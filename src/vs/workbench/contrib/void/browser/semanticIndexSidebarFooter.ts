/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ISemanticIndexService, IndexStatus } from '../common/semanticIndex/semanticIndexTypes.js';
import { REBUILD_INDEX_ID } from './semanticIndexActions.js';

/**
 * Sidebar footer for the V3Code semantic index.
 *
 * Two visual modes:
 *   - ACTIVE (walking/chunking/embedding): real progress bar with percent,
 *     files/sec throughput, ETA, and the current file path.
 *   - IDLE   (ready/idle/uninitialized/error): single-line status.
 *
 * Custom DOM rather than the workbench ProgressBar widget because the footer
 * mounts into an existing chat sidebar container and needs to flow with text
 * and adapt to theme via CSS variables — a focused 30-line element keeps
 * everything in one file and avoids the workbench/ui dependency.
 */
export function mountSemanticIndexFooter(parent: HTMLElement, accessor: ServicesAccessor): IDisposable {
	const store = new DisposableStore();
	const indexService = accessor.get(ISemanticIndexService);
	const commandService = accessor.get(ICommandService);

	const footer = document.createElement('div');
	footer.className = 'v3code-index-footer';
	Object.assign(footer.style, {
		flex: '0 0 auto',
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
		padding: '6px 8px',
		fontSize: '11px',
		lineHeight: '14px',
		borderTop: '1px solid var(--vscode-panel-border, rgba(128,128,128,0.35))',
		color: 'var(--vscode-descriptionForeground, inherit)',
		background: 'var(--vscode-sideBar-background, transparent)',
		cursor: 'pointer',
		userSelect: 'none',
	});
	footer.setAttribute('role', 'button');
	footer.setAttribute('aria-label', 'V3Code semantic index — click to rebuild');

	const headerRow = document.createElement('div');
	Object.assign(headerRow.style, {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '8px',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
	});
	const labelEl = document.createElement('span');
	Object.assign(labelEl.style, { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' });
	const rateEl = document.createElement('span');
	Object.assign(rateEl.style, { flex: '0 0 auto', opacity: '0.85', fontVariantNumeric: 'tabular-nums' });
	headerRow.appendChild(labelEl);
	headerRow.appendChild(rateEl);

	const barOuter = document.createElement('div');
	Object.assign(barOuter.style, {
		position: 'relative',
		height: '4px',
		borderRadius: '2px',
		background: 'rgba(128,128,128,0.2)',
		overflow: 'hidden',
		display: 'none',
	});
	const barInner = document.createElement('div');
	Object.assign(barInner.style, {
		position: 'absolute',
		top: '0',
		left: '0',
		bottom: '0',
		width: '0%',
		backgroundColor: 'var(--vscode-progressBar-background, var(--vscode-button-background, #c586c0))',
		transition: 'width 120ms linear',
	});
	barOuter.appendChild(barInner);

	const detailEl = document.createElement('div');
	Object.assign(detailEl.style, {
		fontSize: '10px',
		opacity: '0.65',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		display: 'none',
	});

	footer.appendChild(headerRow);
	footer.appendChild(barOuter);
	footer.appendChild(detailEl);

	const onClick = () => { commandService.executeCommand(REBUILD_INDEX_ID); };
	footer.addEventListener('click', onClick);
	parent.appendChild(footer);

	const render = () => {
		const s = indexService.getStatus();
		const active = s.state === 'walking' || s.state === 'chunking' || s.state === 'embedding';

		let icon: string;
		let label: string;
		switch (s.state) {
			case 'walking':
				// allow-any-unicode-next-line
				icon = '⟳';
				label = `Scanning workspace · ${s.filesTotal || 0} files found`;
				break;
			case 'chunking':
				// allow-any-unicode-next-line
				icon = '⟳';
				label = `Indexing ${s.filesIndexed}/${s.filesTotal || '?'}`;
				break;
			case 'embedding':
				// allow-any-unicode-next-line
				icon = '⟳';
				label = `Embedding ${(s.embeddedChunks ?? 0).toLocaleString()}/${(s.chunksToEmbed ?? 0).toLocaleString()} chunks`;
				break;
			case 'error':
				icon = '⚠';
				label = `Index error${s.lastError ? ` — ${s.lastError}` : ''}`;
				break;
			case 'ready':
			case 'idle':
				icon = '●';
				if (s.backgroundUpgrade && s.chunksToEmbed) {
					const upct = Math.floor(((s.embeddedChunks ?? 0) / s.chunksToEmbed) * 100);
					label = `Index ready · quality upgrade ${upct}%`;
				} else {
					label = s.filesIndexed > 0
						? `Index ready · ${s.filesIndexed} files · ${s.chunksTotal} chunks`
						: 'Index empty — click to build';
				}
				break;
			default:
				// allow-any-unicode-next-line
				icon = '○';
				label = 'Index not initialized — click to build';
		}
		labelEl.textContent = `${icon}  ${label}`;

		if (active && (s.filesTotal > 0 || (s.chunksToEmbed ?? 0) > 0)) {
			// Embedding progresses over CHUNKS (the file walk is already 100% done).
			const pct = s.state === 'embedding' && (s.chunksToEmbed ?? 0) > 0
				? Math.max(0, Math.min(100, ((s.embeddedChunks ?? 0) / s.chunksToEmbed!) * 100))
				: Math.max(0, Math.min(100, (s.filesIndexed / Math.max(1, s.filesTotal)) * 100));
			barOuter.style.display = 'block';
			barInner.style.width = `${pct.toFixed(1)}%`;
			rateEl.textContent = formatRate(s);
			detailEl.style.display = 'block';
			detailEl.textContent = s.currentFile ? `→ ${truncate(s.currentFile, 80)}` : '';
		} else {
			barOuter.style.display = 'none';
			detailEl.style.display = 'none';
			rateEl.textContent = '';
		}

		footer.title = [
			`State: ${s.state}`,
			`Files: ${s.filesIndexed}/${s.filesTotal || 0}`,
			`Chunks: ${s.chunksTotal}`,
			s.backgroundUpgrade && s.chunksToEmbed ? `Quality upgrade: ${(s.embeddedChunks ?? 0).toLocaleString()}/${s.chunksToEmbed.toLocaleString()} chunks (search fully available)` : null,
			s.filesPerSecond !== undefined ? `Speed: ${s.filesPerSecond.toFixed(1)} ${(s.state === 'embedding' || s.backgroundUpgrade) ? 'chunks' : 'files'}/s` : null,
			s.etaSeconds !== undefined ? `ETA: ${formatDuration(s.etaSeconds)}` : null,
			s.currentFile ? `Current: ${s.currentFile}` : null,
			s.modelId ? `Model: ${s.modelId}` : null,
			s.lastError ? `Last error: ${s.lastError}` : null,
			'Click to rebuild',
		].filter(Boolean).join('\n');
	};
	render();
	store.add(indexService.onDidChangeStatus(render));
	store.add({
		dispose: () => {
			footer.removeEventListener('click', onClick);
			footer.remove();
		},
	});
	return store;
}

function formatRate(s: IndexStatus): string {
	const parts: string[] = [];
	if (s.state === 'embedding' && (s.chunksToEmbed ?? 0) > 0) {
		const pct = Math.max(0, Math.min(100, ((s.embeddedChunks ?? 0) / s.chunksToEmbed!) * 100));
		parts.push(`${pct.toFixed(0)}%`);
	} else if (s.filesTotal > 0) {
		const pct = Math.max(0, Math.min(100, (s.filesIndexed / s.filesTotal) * 100));
		parts.push(`${pct.toFixed(0)}%`);
	}
	if (s.filesPerSecond !== undefined && isFinite(s.filesPerSecond)) {
		parts.push(`${s.filesPerSecond.toFixed(s.filesPerSecond >= 10 ? 0 : 1)}/s`);
	}
	if (s.etaSeconds !== undefined && isFinite(s.etaSeconds) && s.etaSeconds > 0.5) {
		parts.push(`ETA ${formatDuration(s.etaSeconds)}`);
	}
	return parts.join(' · ');
}

function formatDuration(sec: number): string {
	if (sec < 60) return `${Math.ceil(sec)}s`;
	const m = Math.floor(sec / 60);
	const s = Math.round(sec % 60);
	if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const mm = m % 60;
	return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return '…' + s.slice(-(max - 1));
}
