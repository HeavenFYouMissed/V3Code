/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Turbo Draft progress dock — Agents-rail strip with live checkpoint stages + V Go-style collapse.
 */

import { $, append, clearNode, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { ITurboDraftService, TurboDraftSession } from './turboDraftService.js';
import {
    isTurboDraftBusyPhase,
    isTurboDraftTerminalPhase,
    TURBO_DRAFT_PROGRESS_STAGES,
    TurboDraftPhase,
} from '../common/turboDraftRunState.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { estimateTokensFromChars, formatTokenCount } from '../common/tokenBudget.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from './voidSettingsPane.js';

export const TURBO_DRAFT_DOCK_IDLE_HEIGHT = 44;
export const TURBO_DRAFT_DOCK_ACTIVE_HEIGHT = 220;
export const TURBO_DRAFT_DOCK_MARGIN_BOTTOM = 8;

// Neutral chrome accent (not alarm-red). Errors still use vscode-errorForeground.
const ACCENT = '#8E8E96';
const ACCENT_SOFT = '#B8B8C0';
const ERROR_ACCENT = '#e85d5d';
const TERMINAL_COLLAPSE_MS = 3200;

const STYLES = `
@keyframes turbo-dock-pop {
	0% { transform: translateY(6px); opacity: 0.7; }
	100% { transform: translateY(0); opacity: 1; }
}
@keyframes turbo-dock-spin {
	to { transform: rotate(360deg); }
}
@keyframes turbo-dock-flash {
	0%, 100% { box-shadow: inset 0 0 0 0 rgba(142, 142, 150, 0); }
	40% { box-shadow: inset 0 0 0 2px rgba(142, 142, 150, 0.45); }
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock {
	flex: 0 0 auto;
	display: flex;
	flex-direction: column;
	margin: 4px 10px ${TURBO_DRAFT_DOCK_MARGIN_BOTTOM}px;
	border-radius: 12px;
	border: 1px solid color-mix(in srgb, ${ACCENT} 22%, transparent);
	background:
		linear-gradient(180deg, color-mix(in srgb, ${ACCENT} 8%, transparent) 0%, transparent 50%),
		color-mix(in srgb, ${ACCENT} 4%, var(--vscode-sideBar-background, #1a1a1d));
	overflow: hidden;
	transition: min-height 220ms cubic-bezier(0.2, 0, 0, 1), max-height 220ms cubic-bezier(0.2, 0, 0, 1);
	min-height: ${TURBO_DRAFT_DOCK_IDLE_HEIGHT}px;
	max-height: ${TURBO_DRAFT_DOCK_IDLE_HEIGHT}px;
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock.is-active {
	min-height: ${TURBO_DRAFT_DOCK_ACTIVE_HEIGHT}px;
	max-height: ${TURBO_DRAFT_DOCK_ACTIVE_HEIGHT}px;
	border-color: color-mix(in srgb, ${ACCENT} 40%, transparent);
	animation: turbo-dock-pop 220ms cubic-bezier(0.2, 0, 0, 1);
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock.is-ready {
	animation: turbo-dock-flash 650ms ease-out;
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock-head {
	display: flex; align-items: center; gap: 8px;
	height: ${TURBO_DRAFT_DOCK_IDLE_HEIGHT}px;
	padding: 0 12px; cursor: pointer; user-select: none; box-sizing: border-box;
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock-title {
	font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
	color: color-mix(in srgb, ${ACCENT} 70%, var(--vscode-foreground));
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock-head-status {
	flex: 1 1 auto; min-width: 0; font-size: 11px; font-weight: 550;
	color: ${ACCENT_SOFT}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock-head-status.idle {
	color: var(--vscode-descriptionForeground); font-weight: 500;
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock-head-status.terminal-ok {
	color: var(--vscode-testing-iconPassed, #73c991);
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock-head-status.terminal-err {
	color: var(--vscode-errorForeground, ${ERROR_ACCENT});
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock-help {
	flex: 0 0 auto; width: 15px; height: 15px; border-radius: 50%; padding: 0;
	border: 1px solid var(--vscode-widget-border, transparent); background: transparent;
	color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1;
	cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock-help:hover {
	color: var(--vscode-foreground); border-color: var(--vscode-descriptionForeground);
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock-body {
	display: none; flex: 1 1 auto; min-height: 0; overflow: auto;
	padding: 2px 12px 12px; box-sizing: border-box; flex-direction: column; gap: 4px;
}
.monaco-workbench .part.unifiedsidebar .turbo-draft-dock.is-active .turbo-draft-dock-body {
	display: flex;
}
.turbo-draft-model-row {
	font-size: 10px; color: var(--vscode-descriptionForeground); padding: 2px 0 6px;
	display: flex; align-items: center; gap: 8px;
}
.turbo-draft-model-row button {
	appearance: none; border: 1px solid color-mix(in srgb, ${ACCENT} 35%, transparent);
	background: transparent; color: ${ACCENT_SOFT}; border-radius: 6px;
	font-size: 10px; padding: 2px 8px; cursor: pointer;
}
.turbo-draft-stage {
	font-size: 11px; line-height: 1.35; color: var(--vscode-descriptionForeground);
	padding: 4px 0; border-left: 2px solid transparent; padding-left: 8px;
	display: flex; flex-direction: column; gap: 2px;
}
.turbo-draft-stage .label { display: flex; align-items: center; gap: 6px; }
.turbo-draft-stage .detail {
	font-size: 10px; opacity: 0.85; padding-left: 18px;
}
.turbo-draft-stage.active {
	color: ${ACCENT_SOFT}; border-left-color: ${ACCENT}; font-weight: 600;
}
.turbo-draft-stage.done { color: var(--vscode-foreground); opacity: 0.78; }
.turbo-draft-stage.failed { color: var(--vscode-errorForeground, ${ERROR_ACCENT}); border-left-color: var(--vscode-errorForeground, ${ERROR_ACCENT}); }
.turbo-draft-stage.upcoming { opacity: 0.45; }
.turbo-draft-spinner {
	width: 10px; height: 10px; border-radius: 50%;
	border: 1.5px solid color-mix(in srgb, ${ACCENT} 35%, transparent);
	border-top-color: ${ACCENT}; animation: turbo-dock-spin 0.7s linear infinite;
	flex: 0 0 auto;
}
.turbo-draft-check { color: var(--vscode-testing-iconPassed, #73c991); font-size: 11px; width: 12px; }
.turbo-draft-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.35; margin: 0 3px; }
.turbo-draft-actions { display: flex; gap: 8px; padding-top: 8px; }
.turbo-draft-actions button {
	appearance: none; border: 1px solid color-mix(in srgb, ${ACCENT} 30%, transparent);
	background: color-mix(in srgb, ${ACCENT} 10%, transparent); color: ${ACCENT_SOFT};
	border-radius: 8px; font-size: 11px; padding: 5px 10px; cursor: pointer;
}
.turbo-draft-intent-row {
	font-size: 11px;
	color: ${ACCENT_SOFT};
	opacity: 0.85;
	margin: 0 0 6px 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.turbo-draft-error-text {
	font-size: 11px; color: var(--vscode-errorForeground, ${ERROR_ACCENT});
	white-space: pre-wrap; padding: 6px 0 0;
}
@media (prefers-reduced-motion: reduce) {
	.monaco-workbench .part.unifiedsidebar .turbo-draft-dock.is-active,
	.monaco-workbench .part.unifiedsidebar .turbo-draft-dock.is-ready,
	.turbo-draft-spinner { animation: none !important; transition: none !important; }
}
`;

let stylesInjected = false;
function injectStyles(): void {
    if (stylesInjected) { return; }
    stylesInjected = true;
    const el = document.createElement('style');
    el.textContent = STYLES;
    document.head.appendChild(el);
}

const STAGE_LABELS: Record<string, string> = {
    reading: 'Reading file',
    recognizing: 'Recognizing intent',
    findingRelated: 'Finding related code',
    organizing: 'Organizing request',
    restructuring: 'Restructuring',
    validating: 'Validating draft',
    repairing: 'Repairing format',
    creatingTabs: 'Creating tabs',
    ready: 'Tab ready',
    verifying: 'Verifying',
    autoFixing: 'Fixing what broke',
};

function phaseLabel(phase: TurboDraftPhase, session?: TurboDraftSession): string {
    if (phase === 'ready') {
        const n = session?.pendingHunks ?? 0;
        const i = (session?.hunkIdx ?? 0) + 1;
        return n > 0
            ? localize('turboDraft.dock.readyNM', "Tab ready · {0}/{1}", i, n)
            : localize('turboDraft.dock.ready', "Tab ready");
    }
    if (phase === 'noChanges') {
        return localize('turboDraft.dock.noChanges', "No useful edits");
    }
    if (phase === 'completed') {
        return localize('turboDraft.dock.completed', "Complete");
    }
    if (phase === 'sourceChanged') {
        return localize('turboDraft.dock.sourceChanged', "File changed");
    }
    if (phase === 'error') {
        return session?.errorMessage?.slice(0, 64) || localize('turboDraft.dock.error', "Error");
    }
    if (phase === 'cancelled') {
        return localize('turboDraft.dock.cancelled', "Cancelled");
    }
    return STAGE_LABELS[phase] ?? localize('turboDraft.dock.idle', "Shift+Tab to draft");
}

function activityLine(session: TurboDraftSession, phase: TurboDraftPhase): string | undefined {
    const d = session.detail;
    switch (phase) {
        case 'reading':
            return d.fileLines !== undefined ? localize('turboDraft.act.read', "Read {0} lines", d.fileLines) : undefined;
        case 'recognizing':
            return localize('turboDraft.act.intent', "{0} Tab edits · {1} chat turns", d.acceptedEditCount ?? 0, d.chatTurnCount ?? 0);
        case 'findingRelated': {
            const related = localize('turboDraft.act.related', "{0} snippets from {1} files", d.relatedSnippetCount ?? 0, d.relatedFileCount ?? 0);
            // Only mention the language server when it actually gave us something.
            const diags = d.diagnosticCount ?? 0;
            const sigs = d.signatureCount ?? 0;
            if (!diags && !sigs) { return related; }
            return `${related} · ${localize('turboDraft.act.truth', "{0} problems, {1} signatures", diags, sigs)}`;
        }
        case 'restructuring':
        case 'repairing': {
            const model = d.modelLabel ?? 'Model';
            // Tokens, not chars: chars are meaningless for judging cost or context pressure.
            const sent = d.promptTokens !== undefined
                ? localize('turboDraft.act.sent', "~{0} tokens sent", formatTokenCount(d.promptTokens))
                : undefined;
            const back = d.streamedChars !== undefined
                ? localize('turboDraft.act.back', "~{0} back", formatTokenCount(estimateTokensFromChars(d.streamedChars)))
                : undefined;
            const parts = [model, sent, back].filter(Boolean);
            return parts.join(' · ');
        }
        case 'validating':
            return d.validHunkCount !== undefined
                ? localize('turboDraft.act.valid', "Validated {0} edits", d.validHunkCount)
                : undefined;
        case 'ready':
            return localize('turboDraft.act.ready', "Hunk {0} of {1}", (session.hunkIdx ?? 0) + 1, session.pendingHunks);
        case 'verifying':
            return localize('turboDraft.act.verifying', "Checking the language server for new problems");
        case 'autoFixing':
            return d.newErrorCount !== undefined
                ? localize('turboDraft.act.autofix', "Repairing {0} new error(s) the draft introduced", d.newErrorCount)
                : undefined;
        default:
            return d.message;
    }
}

export interface ITurboDraftDockService {
    readonly _serviceBrand: undefined;
    register(dock: TurboDraftDock): void;
    unregister(dock: TurboDraftDock): void;
}

export const ITurboDraftDockService = createDecorator<ITurboDraftDockService>('turboDraftDockService');

class TurboDraftDockService implements ITurboDraftDockService {
    declare readonly _serviceBrand: undefined;
    private _dock: TurboDraftDock | undefined;
    register(dock: TurboDraftDock): void { this._dock = dock; }
    unregister(dock: TurboDraftDock): void {
        if (this._dock === dock) { this._dock = undefined; }
    }
}

registerSingleton(ITurboDraftDockService, TurboDraftDockService, InstantiationType.Delayed);

export class TurboDraftDock extends Disposable {
    readonly element: HTMLElement;
    private readonly _headStatus: HTMLElement;
    private readonly _body: HTMLElement;
    private _expanded = false;
    private _manualCollapseForSessionId: string | undefined;
    private _collapseTimer: number | undefined;
    private _collapseForSessionId: string | undefined;
    private readonly _onDidChangeHeight = this._register(new Emitter<number>());
    readonly onDidChangeHeight = this._onDidChangeHeight.event;

    constructor(
        @ITurboDraftService private readonly _turbo: ITurboDraftService,
        @ITurboDraftDockService dockService: ITurboDraftDockService,
        @ICommandService private readonly _commandService: ICommandService,
    ) {
        super();
        injectStyles();
        this.element = $('.turbo-draft-dock');
        this.element.setAttribute('role', 'region');
        this.element.setAttribute('aria-label', localize('turboDraft.dockAria', 'Turbo Draft'));
        this.element.setAttribute('aria-expanded', 'false');

        const head = append(this.element, $('.turbo-draft-dock-head'));
        head.tabIndex = 0;
        append(head, $('span.turbo-draft-dock-title')).textContent = localize('turboDraft.dockTitle', 'Turbo');
        this._headStatus = append(head, $('span.turbo-draft-dock-head-status.idle'));

        const helpBtn = append(head, $('button.turbo-draft-dock-help')) as HTMLButtonElement;
        helpBtn.type = 'button';
        helpBtn.textContent = '?';
        helpBtn.title = localize('turboDraft.dock.helpTitle', 'Turbo Draft shortcuts and settings');
        helpBtn.setAttribute('aria-label', helpBtn.title);
        this._register(addDisposableListener(helpBtn, EventType.CLICK, e => {
            // Without this the click bubbles to the head and just toggles the dock.
            e.stopPropagation();
            e.preventDefault();
            void this._commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID, 'featureOptions');
        }));

        this._body = append(this.element, $('.turbo-draft-dock-body'));
        this._body.setAttribute('aria-live', 'polite');

        const toggle = () => {
            const session = this._turbo.getSession();
            const busy = !!session && (isTurboDraftBusyPhase(session.phase) || session.phase === 'ready');
            if (busy && this._expanded) {
                this._manualCollapseForSessionId = session!.id;
                this._setExpanded(false);
                return;
            }
            if (busy) {
                this._manualCollapseForSessionId = undefined;
                this._setExpanded(true);
                return;
            }
            this._setExpanded(!this._expanded);
        };
        this._register(addDisposableListener(head, EventType.CLICK, toggle));
        this._register(addDisposableListener(head, EventType.KEY_DOWN, e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        }));
        this._register(addDisposableListener(this._body, EventType.CLICK, e => {
            const t = e.target as HTMLElement | null;
            const action = t?.closest?.('[data-turbo-action]') as HTMLElement | null;
            if (!action) { return; }
            e.stopPropagation();
            const name = action.getAttribute('data-turbo-action');
            if (name === 'change-model') { this._turbo.openChangeModel(); }
            else if (name === 'details') { this._turbo.openDetails(); }
        }));

        this._register(this._turbo.onDidChangeSession(s => this._onSession(s)));
        dockService.register(this);
        this._register({ dispose: () => dockService.unregister(this) });
        this._onSession(this._turbo.getSession());
    }

    get height(): number {
        const content = this._expanded ? TURBO_DRAFT_DOCK_ACTIVE_HEIGHT : TURBO_DRAFT_DOCK_IDLE_HEIGHT;
        return content + 4 + TURBO_DRAFT_DOCK_MARGIN_BOTTOM;
    }

    private _onSession(session: TurboDraftSession | undefined): void {
        const phase = session?.phase ?? 'idle';
        const busy = !!session && isTurboDraftBusyPhase(phase);
        const ready = phase === 'ready';
        const terminal = !!session && isTurboDraftTerminalPhase(phase) && phase !== 'ready';

        if (session && this._manualCollapseForSessionId && this._manualCollapseForSessionId !== session.id) {
            this._manualCollapseForSessionId = undefined;
        }

        if ((busy || ready) && this._manualCollapseForSessionId !== session?.id) {
            this._clearCollapseTimer();
            this._setExpanded(true);
        } else if (!session) {
            this._clearCollapseTimer();
            this._setExpanded(false);
        } else if (terminal) {
            this._scheduleCollapse(session.id);
        }

        this.element.classList.toggle('is-ready', !!ready);
        this._render(session);
    }

    private _scheduleCollapse(sessionId: string): void {
        if (this._collapseForSessionId === sessionId && this._collapseTimer !== undefined) {
            return;
        }
        this._clearCollapseTimer();
        this._collapseForSessionId = sessionId;
        this._collapseTimer = mainWindow.setTimeout(() => {
            this._collapseTimer = undefined;
            const current = this._turbo.getSession();
            if (!current || current.id !== sessionId) { return; }
            if (!isTurboDraftTerminalPhase(current.phase) || current.phase === 'ready') { return; }
            if (this._manualCollapseForSessionId === sessionId) { return; }
            this._setExpanded(false);
        }, TERMINAL_COLLAPSE_MS);
    }

    private _clearCollapseTimer(): void {
        if (this._collapseTimer !== undefined) {
            mainWindow.clearTimeout(this._collapseTimer);
            this._collapseTimer = undefined;
        }
        this._collapseForSessionId = undefined;
    }

    private _setExpanded(expanded: boolean): void {
        if (this._expanded === expanded) {
            this._render(this._turbo.getSession());
            return;
        }
        this._expanded = expanded;
        this.element.classList.toggle('is-active', expanded);
        this.element.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        this._render(this._turbo.getSession());
        this._onDidChangeHeight.fire(this.height);
    }

    private _render(session: TurboDraftSession | undefined): void {
        const phase = session?.phase ?? 'idle';
        this._headStatus.textContent = session
            ? `${phaseLabel(phase, session)}${session.modelLabel ? ` · ${session.modelLabel}` : ''}`
            : localize('turboDraft.dock.idleHint', 'Turbo · Shift+Tab');
        this._headStatus.classList.toggle('idle', !session || phase === 'idle');
        this._headStatus.classList.toggle('terminal-ok', phase === 'noChanges' || phase === 'completed' || phase === 'cancelled');
        this._headStatus.classList.toggle('terminal-err', phase === 'error' || phase === 'sourceChanged');

        clearNode(this._body);
        if (!session) {
            append(this._body, $('p.turbo-draft-stage')).textContent =
                localize('turboDraft.dock.blurb', "Shift+Tab drafts the whole file as ghost tabs you Tab/Del through.");
            return;
        }

        const modelRow = append(this._body, $('div.turbo-draft-model-row'));
        append(modelRow, $('span')).textContent = session.modelLabel || localize('turboDraft.dock.noModelShort', 'No model');
        const changeBtn = append(modelRow, $('button')) as HTMLButtonElement;
        changeBtn.textContent = localize('turboDraft.dock.changeModel', 'Change model');
        changeBtn.type = 'button';
        changeBtn.setAttribute('data-turbo-action', 'change-model');

        // Multi-file Deep: say which file of the run this is, so the queue is never a surprise.
        if (session.fileTotal > 1) {
            append(this._body, $('div.turbo-draft-intent-row')).textContent = localize(
                'turboDraft.dock.fileOf',
                "File {0} of {1}: {2}",
                session.fileIndex,
                session.fileTotal,
                session.uri.path.split('/').pop() ?? '',
            );
        }

        // What Turbo thinks you asked for. Shown before it drafts so a wrong read is obvious.
        if (session.intentLabel) {
            append(this._body, $('div.turbo-draft-intent-row')).textContent =
                localize('turboDraft.dock.intent', "Intent: {0}", session.intentLabel);
        }

        const activeIdx = TURBO_DRAFT_PROGRESS_STAGES.indexOf(phase);
        const failedPhase = session.failedPhase;
        let activeRow: HTMLElement | undefined;

        for (let i = 0; i < TURBO_DRAFT_PROGRESS_STAGES.length; i++) {
            const stagePhase = TURBO_DRAFT_PROGRESS_STAGES[i]!;
            // Skip repairing unless we entered it (or failed there).
            // Conditional stages: only shown once actually entered, so a normal clean draft
            // is not padded with rows that never run.
            if (stagePhase === 'repairing' || stagePhase === 'verifying' || stagePhase === 'autoFixing') {
                const visited = session.stageHistory.some(h => h.phase === stagePhase) || failedPhase === stagePhase || phase === stagePhase;
                if (!visited) { continue; }
            }

            const row = append(this._body, $('div.turbo-draft-stage'));
            const label = append(row, $('div.label'));
            const isActive = stagePhase === phase;
            const isDone = (activeIdx >= 0 && i < activeIdx) || (phase === 'ready' && i <= activeIdx)
                || (isTurboDraftTerminalPhase(phase) && phase !== 'ready' && activeIdx >= 0 && i < activeIdx)
                || (isTurboDraftTerminalPhase(phase) && phase !== 'error' && stagePhase === 'ready' && phase === 'completed');
            const isFailed = phase === 'error' && failedPhase === stagePhase;

            if (isFailed) {
                append(label, $('span')).textContent = 'x';
                row.classList.add('failed');
            } else if (isActive && isTurboDraftBusyPhase(phase)) {
                append(label, $('span.turbo-draft-spinner'));
                row.classList.add('active');
                activeRow = row;
            } else if (isDone || (isActive && phase === 'ready')) {
                append(label, $('span.turbo-draft-check')).textContent = 'ok';
                row.classList.add(isActive ? 'active' : 'done');
                if (isActive) { activeRow = row; }
            } else if (isTurboDraftTerminalPhase(phase) && phase !== 'ready' && stagePhase === failedPhase) {
                append(label, $('span')).textContent = 'x';
                row.classList.add('failed');
            } else {
                append(label, $('span.turbo-draft-dot'));
                row.classList.add('upcoming');
            }

            append(label, $('span')).textContent = STAGE_LABELS[stagePhase] ?? stagePhase;
            if (isActive) {
                row.setAttribute('aria-current', 'step');
                const detail = activityLine(session, stagePhase);
                if (detail) {
                    append(row, $('div.detail')).textContent = detail;
                }
            } else if (isDone) {
                const detail = activityLine(session, stagePhase);
                if (detail && (stagePhase === 'reading' || stagePhase === 'recognizing' || stagePhase === 'findingRelated' || stagePhase === 'validating')) {
                    append(row, $('div.detail')).textContent = detail;
                }
            }
        }

        if (phase === 'error' && session.errorMessage) {
            append(this._body, $('div.turbo-draft-error-text')).textContent = session.errorMessage;
        } else if ((phase === 'noChanges' || phase === 'sourceChanged' || phase === 'cancelled') && session.detail.message) {
            append(this._body, $('div.turbo-draft-stage')).textContent = session.detail.message;
        }

        if (isTurboDraftTerminalPhase(phase) && phase !== 'ready') {
            const actions = append(this._body, $('div.turbo-draft-actions'));
            const details = append(actions, $('button')) as HTMLButtonElement;
            details.type = 'button';
            details.textContent = localize('turboDraft.dock.details', 'Details');
            details.setAttribute('data-turbo-action', 'details');
        }

        if (activeRow) {
            activeRow.scrollIntoView({ block: 'nearest' });
        }
    }
}

class TurboDraftStatusBarContribution extends Disposable implements IWorkbenchContribution {
    static readonly ID = 'v3code.turboDraft.statusBar';
    private entry: IStatusbarEntryAccessor | undefined;

    constructor(
        @IStatusbarService private readonly statusbar: IStatusbarService,
        @ITurboDraftService private readonly turbo: ITurboDraftService,
    ) {
        super();
        this._register(this.turbo.onDidChangeSession(s => this._render(s)));
        this._render(this.turbo.getSession());
    }

    private _render(session: TurboDraftSession | undefined): void {
        const quiet = !session
            || session.phase === 'idle'
            || session.phase === 'cancelled'
            || session.phase === 'completed'
            || session.phase === 'noChanges';
        if (quiet) {
            this.entry?.dispose();
            this.entry = undefined;
            return;
        }

        let text: string;
        if (session.phase === 'ready') {
            text = `$(check) Turbo · ${session.pendingHunks}`;
        } else if (session.phase === 'error' || session.phase === 'sourceChanged') {
            text = `$(error) Turbo · ${phaseLabel(session.phase, session)}`;
        } else {
            text = `$(sync~spin) Turbo · ${phaseLabel(session.phase, session)}`;
        }
        const props = {
            name: localize('turboDraft.sb.name', 'Turbo Draft'),
            text,
            ariaLabel: localize('turboDraft.sb.aria', 'Turbo Draft'),
            command: 'void.turboDraft.run',
            tooltip: `${phaseLabel(session.phase, session)}${session.modelLabel ? ` · ${session.modelLabel}` : ''}`,
        };
        if (this.entry) {
            this.entry.update(props);
        } else {
            this.entry = this._register(this.statusbar.addEntry(props, 'v3code.turboDraft', StatusbarAlignment.RIGHT, 57));
        }
    }
}

registerWorkbenchContribution2(TurboDraftStatusBarContribution.ID, TurboDraftStatusBarContribution, WorkbenchPhase.AfterRestored);
