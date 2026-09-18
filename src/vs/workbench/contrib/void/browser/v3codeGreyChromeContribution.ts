/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Force V3Code grey chrome at runtime — overrides cached user theme customizations
 * that may still contain Microsoft blue from prior sessions.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { AppResourcePath, FileAccess } from '../../../../base/common/network.js';
import { deepClone, equals } from '../../../../base/common/objects.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ChatConfiguration } from '../../chat/common/constants.js';
import { IColorCustomizations, IThemeScopedColorCustomizations } from '../../../services/themes/common/workbenchThemeService.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';

/** One-shot migrate: hide the titlebar command center in the focused agent layout. */
const COMMAND_CENTER_OFF_MIGRATION_KEY = 'v3code.chrome.commandCenterOffMigrated';
// New key for the Dark 2026 rollout. Profiles that consumed the earlier V3Code-theme
// migration must run this once too, otherwise an update can leave them on a bundled
// theme whose broken red border tokens make the workbench flash red.
const COLOR_THEME_RESET_MIGRATION_KEY = 'v3code.chrome.colorThemeResetDark2026Migrated';

/**
 * V3Code floating-card chrome — a full geometry/shape layer built on top of the bundled
 * workbench CSS (media/v3.css). The look is a cohesive frame: a LIGHTER shell (title bar +
 * activity rail + status bar + the gaps between parts) with DARKER, rounded "cards" floating
 * in it (sidebar, editor, chat/aux bar, bottom panel). All driven by one stylesheet + a handful
 * of color tokens so it ships with the build and survives any color theme.
 *
 * The master knob is --vscode-v3-part-border-radius (6px; 4px in solo mode). We mirror it
 * and layer every geometry rule: card corners, tab rounding, compact title bar, rounded
 * activity-rail icons, slim status bar, pill scrollbars, rounded inputs/buttons.
 */
const V3_CHROME_STYLE_ID = 'v3code-chrome-borders';
// ============================================================================
// LOCKED LOOK (2026-07-24) — Daniel signed off on this contrast pass. Do not
// "brighten the greys" or flatten card/frame again without an explicit ask.
// Cursor Dark reference ~ editor #181818 / fg #F0F0F0; ours sit nearby, not equal.
// Diff greens/reds stay theme-native (never grey-wash those cards).
// ============================================================================
const V3_FRAME = '#1a1a1e';       // title / activity / status / gaps (trim)
const V3_BACKING = '#0a0a0c';     // deepest grid backing behind cards
const V3_CARD = '#141416';        // editor / sidebar / chat / panel surfaces
const V3_FG = '#EDEBE6';          // primary text (cream-bright)
const V3_FG_SOFT = '#EDEBE6BD';   // sidebar secondary
const V3_MUTED = '#8E8E96';       // description / dim labels
const V3_PLACEHOLDER = '#EDEBE66A';
const V3_COMPOSER = '#222226';     // dropdown/menu fill (NOT the composer - see below)
/* The composer's own fill, matched to the Agent panel composer
	(--agent-workspace-composer-fill in agentWorkspaceShell.css). Kept SEPARATE
	from V3_COMPOSER because that const also feeds dropdown.background: changing
	the const darkens every dropdown in the workbench as a side effect.
	Keep these two hexes in sync so the IDE and Agent composers never drift. */
const V3_COMPOSER_FILL = '#1a191b';

const V3_EDITOR_RADIUS = '10px';  // editor-group card corners
const V3_CARD_RADIUS = '10px';    // sidebar / chat / agents / panel corners
const V3_TAB_RADIUS = '8px';      // compact, symmetrical native editor tabs
const V3_GAP = '5px';             // gap between cards (reveals the shell)
const V3_CHROME_STYLES = `
:root {
	--vscode-v3-part-border-radius: ${V3_EDITOR_RADIUS};
	--v3-editor-radius: ${V3_EDITOR_RADIUS};
	--v3-card-radius: ${V3_CARD_RADIUS};
	--v3-gap: ${V3_GAP};
	--v3-backing: ${V3_BACKING};
}

/* ============================================================================
 * 1. SHELL — the lighter grey that the cards float on. The gaps between parts
 *    reveal this, forming the continuous always-visible frame.
 * ========================================================================== */
.monaco-workbench .monaco-grid-view { background-color: var(--v3-backing); }

/* ============================================================================
 * 2. CARDS — sidebar (files), auxiliary bar (chat), bottom panel. Rounded,
 *    inset by a gap so the shell shows around them.
 * ========================================================================== */
.monaco-workbench .part.sidebar,
.monaco-workbench .part.auxiliarybar,
.monaco-workbench .part.unifiedsidebar,
.monaco-workbench .part.panel {
	border-radius: var(--v3-card-radius);
	overflow: hidden;
}
.monaco-workbench .part.sidebar,
.monaco-workbench .part.auxiliarybar,
.monaco-workbench .part.unifiedsidebar,
.monaco-workbench .part.panel,
.monaco-workbench .part.activitybar { margin: var(--v3-gap); }
/* round the inner composite/viewlet so content clips to the card edge (8px) */
.monaco-workbench .part.sidebar > .content,
.monaco-workbench .part.auxiliarybar > .content,
.monaco-workbench .part.unifiedsidebar > .content,
.monaco-workbench .part.panel > .content { border-radius: var(--v3-card-radius); }

/* ============================================================================
 * 3. EDITOR — gap + rounded card. Round the tabs (top corners) and the
 *    editor body / monaco-editor / overflow-guard (bottom corners) separately,
 *    so editor overlays/hovers are never clipped.
 * ========================================================================== */
.monaco-workbench .part.editor > .content .editor-group-container { margin: var(--v3-gap); }
.monaco-workbench .part.editor > .content .editor-group-container > .title.tabs {
	border-top-left-radius: var(--v3-editor-radius);
	border-top-right-radius: var(--v3-editor-radius);
}
.monaco-workbench .part.editor > .content .editor-group-container > .editor-container,
.monaco-workbench .part.editor > .content .editor-group-container > .editor-container > .editor-instance > .monaco-editor,
.monaco-workbench .part.editor > .content .editor-group-container > .editor-container > .editor-instance > .monaco-editor > .overflow-guard {
	border-bottom-left-radius: var(--v3-editor-radius);
	border-bottom-right-radius: var(--v3-editor-radius);
}
.monaco-workbench .part.editor > .content .editor-group-container.empty > .editor-container {
	border-radius: var(--v3-editor-radius);
}

/* ============================================================================
 * 4. TABS — one compact native shape for files, chat and utility surfaces.
 * Tabs remain a single horizontally scrolling row; their full symmetric shape
 * prevents the old top-only caps from reading as mismatched editor chrome.
 * ========================================================================== */
.monaco-workbench .part.editor .title .tabs-container > .tab {
	height: calc(var(--editor-group-tab-height) - 6px);
	margin: 3px 2px;
	border-radius: ${V3_TAB_RADIUS};
}

/* ============================================================================
 * 5. ACTIVITY RAIL — part of the shell (lighter), with rounded icon targets
 *    instead of VS Code's hard hover squares + left-border active indicator.
 * ========================================================================== */
.monaco-workbench .part.activitybar .monaco-action-bar .action-item .action-label {
	border-radius: var(--v3-editor-radius);
	margin: 2px 4px;
}
.monaco-workbench .part.activitybar .monaco-action-bar .action-item.checked .active-item-indicator::before {
	border-radius: var(--v3-editor-radius);
}

/* ============================================================================
 * 6. TITLE BAR — part of the shell. Round the command-center pill (floating-card look).
 * ========================================================================== */
.monaco-workbench .part.titlebar .command-center .action-item.command-center-center,
.monaco-workbench .part.titlebar .monaco-toolbar .command-center-center {
	border-radius: var(--v3-editor-radius);
}

/* ============================================================================
 * 7. STATUS BAR — slim + part of the shell. Rounded item hovers.
 * ========================================================================== */
.monaco-workbench .part.statusbar { font-size: 11px; }
.monaco-workbench .part.statusbar .statusbar-item > a:hover { border-radius: 4px; }

/* ============================================================================
 * 8. SCROLLBARS — pill sliders (.slider border-radius:50px).
 * ========================================================================== */
.monaco-workbench .monaco-scrollable-element > .scrollbar > .slider { border-radius: 50px; }

/* ============================================================================
 * 9. INPUTS / BUTTONS / POPUPS — rounded for the soft, modern feel.
 * ========================================================================== */
.monaco-workbench .monaco-inputbox { border-radius: var(--v3-editor-radius); }
.monaco-workbench .monaco-button { border-radius: var(--v3-editor-radius); }
.monaco-workbench .quick-input-widget { border-radius: var(--v3-card-radius); overflow: hidden; }
.monaco-workbench .monaco-menu .monaco-action-bar.vertical { border-radius: var(--v3-editor-radius); }

/* ============================================================================
 * 10. FLOATING WIDGETS — suggest/hover/params/notifications/peek all rounded so
 *     nothing breaks the soft near-black card aesthetic.
 * ========================================================================== */
.monaco-editor .suggest-widget,
.monaco-editor .monaco-hover,
.monaco-editor .parameter-hints-widget,
.monaco-workbench .notifications-toasts .notification-toast,
.monaco-workbench .notifications-center,
.monaco-editor .find-widget,
.monaco-editor .peekview-widget { border-radius: var(--v3-card-radius); overflow: hidden; }
.monaco-workbench .monaco-list .monaco-list-row { border-radius: 4px; }

/* ============================================================================
 * 11. SEAMS — the resize sashes sit in the gaps; keep them invisible at rest so
 *     the only separator is the clean dark seam (still draggable to resize).
 *     Hover/active lights the seam with a venom glow line (accent).
 * ========================================================================== */
.monaco-workbench .monaco-sash { background: transparent !important; }
/* The visible seam indicator is the sash's ::before (a thin, centered strip that
   base sash.css lights with --vscode-sash-hoverBorder on .hover/.active). Recolor
   just that line to venom + a tight glow; the element itself stays transparent so
   the hit-area never paints a wide bar. .hover/.active are the classes the Sash
   widget toggles. */
.monaco-workbench .monaco-sash.hover:before,
.monaco-workbench .monaco-sash.active:before {
	background: rgba(80, 168, 230, 0.6) !important;
	box-shadow: 0 0 6px rgba(80, 168, 230, 0.35) !important;
}

/* ============================================================================
 * 12. (relocated) ask_user fix now lives in injectAskUserFixStyles(), injected
 *     unconditionally below — see that function for why.
 * ========================================================================== */
`;

/** Always injected — V3_CHROME_CSS skips injectChromeStyles() but menubar fix must still load. */
const V3_TOP_ACTIVITY_BAR_MENUBAR_STYLE_ID = 'v3code-top-activity-bar-menubar';
const V3_TOP_ACTIVITY_BAR_MENUBAR_STYLES = `
/* Top activity bar: compact File menu aligned with view icons (V3 Editor tab) */
.monaco-workbench .part.sidebar > .header-or-footer > .composite-bar-container,
.monaco-workbench .pane-composite-part > .header-or-footer > .composite-bar-container {
	display: flex !important;
	flex-direction: row !important;
	align-items: center !important;
}
.monaco-workbench .part.sidebar > .header-or-footer > .composite-bar-container > .menubar.compact,
.monaco-workbench .pane-composite-part > .header-or-footer > .composite-bar-container > .menubar.compact {
	display: flex !important;
	align-items: center !important;
	justify-content: center !important;
	align-self: center !important;
	width: auto !important;
	height: 35px !important;
	flex: 0 0 auto !important;
	margin: 0 !important;
	padding: 0 !important;
	overflow: visible !important;
}
.monaco-workbench .part.sidebar > .header-or-footer > .composite-bar-container > .menubar.compact .toolbar-toggle-more,
.monaco-workbench .part.sidebar > .header-or-footer > .composite-bar-container > .menubar.compact > .menubar-menu-button,
.monaco-workbench .part.sidebar > .header-or-footer > .composite-bar-container > .menubar.compact .menubar-menu-title.toolbar-toggle-more,
.monaco-workbench .pane-composite-part > .header-or-footer > .composite-bar-container > .menubar.compact .toolbar-toggle-more,
.monaco-workbench .pane-composite-part > .header-or-footer > .composite-bar-container > .menubar.compact > .menubar-menu-button,
.monaco-workbench .pane-composite-part > .header-or-footer > .composite-bar-container > .menubar.compact .menubar-menu-title.toolbar-toggle-more {
	width: 28px !important;
	height: 28px !important;
	min-width: 28px !important;
	min-height: 28px !important;
	max-width: 28px !important;
	max-height: 28px !important;
	display: inline-flex !important;
	align-items: center !important;
	justify-content: center !important;
	line-height: 1 !important;
	padding: 0 !important;
	margin: 0 !important;
	box-sizing: border-box !important;
	position: static !important;
	left: auto !important;
	top: auto !important;
}
.monaco-workbench .part.sidebar > .header-or-footer > .composite-bar-container > .composite-bar,
.monaco-workbench .pane-composite-part > .header-or-footer > .composite-bar-container > .composite-bar {
	display: flex !important;
	align-items: center !important;
	flex: 1 1 auto !important;
	min-width: 0 !important;
}
`;

function injectTopActivityBarMenubarStyles(): void {
	const doc = mainWindow.document;
	let style = doc.getElementById(V3_TOP_ACTIVITY_BAR_MENUBAR_STYLE_ID) as HTMLStyleElement | null;
	if (!style) {
		style = doc.createElement('style');
		style.id = V3_TOP_ACTIVITY_BAR_MENUBAR_STYLE_ID;
		doc.head.appendChild(style);
	}
	style.textContent = V3_TOP_ACTIVITY_BAR_MENUBAR_STYLES;
}

// Workspace Trust + confirmation dialogs: the bundled v3.css redefines .monaco-dialog-box
// with flex-direction:row (its dialogs are a redesigned single-row card with a
// close-toolbar). This VS Code build renders the STANDARD two-row dialog, so `row` lays
// the message-row and buttons-row side-by-side and blows the dialog out to ~90vw (the
// broken Workspace Trust prompt). Restore VS Code's vertical stacking while keeping
// the rounded surface/background. Injected after v3.css so it wins the cascade.
const V3_DIALOG_FIX_STYLE_ID = 'v3code-dialog-fix';
const V3_DIALOG_FIX_STYLES = `
.monaco-dialog-box {
	flex-direction: column-reverse !important;
	align-items: stretch !important;
}
.monaco-dialog-box:not(.align-vertical) {
	width: min-content !important;
	min-width: 440px !important;
	max-width: 600px !important;
}
.monaco-dialog-box:not(.align-vertical) .dialog-message-row {
	justify-content: flex-start !important;
	align-items: flex-start !important;
}
.monaco-dialog-box > .dialog-buttons-row {
	padding-top: 18px !important;
}
.monaco-dialog-box > .dialog-buttons-row > .dialog-buttons {
	width: 100% !important;
	justify-content: flex-end !important;
}
`;

function injectDialogFixStyles(): void {
	const doc = mainWindow.document;
	let style = doc.getElementById(V3_DIALOG_FIX_STYLE_ID) as HTMLStyleElement | null;
	if (!style) {
		style = doc.createElement('style');
		style.id = V3_DIALOG_FIX_STYLE_ID;
		doc.head.appendChild(style);
	}
	style.textContent = V3_DIALOG_FIX_STYLES;
}

const V3_ASK_USER_FIX_STYLE_ID = 'v3code-ask-user-fix';
// ask_user confirmation widget — stacked full-width option buttons; long labels wrap
// instead of clipping/overflowing. Moved out of V3_CHROME_STYLES because injectChromeStyles()
// is SKIPPED whenever V3_CHROME_CSS is true (see enableFullChromeCss() below), so this fix
// silently never loaded while the raw v3.css chat-confirmation-widget2 rules applied
// unopposed — root cause of clipped/truncated ask_user option labels. Injected unconditionally
// on BOTH V3_CHROME_CSS branches (see constructor).
const V3_ASK_USER_FIX_STYLES = `
.monaco-workbench .chat-confirmation-widget2 .chat-confirmation-widget-buttons .chat-buttons {
	display: flex !important;
	flex-direction: column !important;
	align-items: stretch !important;
	gap: 6px !important;
	max-width: 100% !important;
}
.monaco-workbench .chat-confirmation-widget2 .chat-confirmation-widget-buttons .monaco-button {
	width: 100% !important;
	max-width: 100% !important;
	white-space: normal !important;
	text-align: left !important;
	height: auto !important;
	min-height: 28px !important;
	padding: 8px 12px !important;
	line-height: 1.35 !important;
}
.monaco-workbench .chat-confirmation-widget2 .chat-confirmation-widget-message {
	white-space: pre-wrap !important;
	word-break: break-word !important;
	line-height: 1.45 !important;
}
`;

function injectAskUserFixStyles(): void {
	const doc = mainWindow.document;
	let style = doc.getElementById(V3_ASK_USER_FIX_STYLE_ID) as HTMLStyleElement | null;
	if (!style) {
		style = doc.createElement('style');
		style.id = V3_ASK_USER_FIX_STYLE_ID;
		doc.head.appendChild(style);
	}
	style.textContent = V3_ASK_USER_FIX_STYLES;
}

function injectChromeStyles(): void {
	const doc = mainWindow.document;
	if (doc.getElementById(V3_CHROME_STYLE_ID)) { return; }
	const style = doc.createElement('style');
	style.id = V3_CHROME_STYLE_ID;
	style.textContent = V3_CHROME_STYLES;
	doc.head.appendChild(style);
}

/** Structural 1px seams above the status bar (full workbench width) and chat composer footer. */
const V3_FOOTER_SEAM_STYLE_ID = 'v3code-footer-seam';
const V3_FOOTER_SEAM = '#3A3A42';
const V3_FOOTER_SEAM_STYLES = `
:root { --v3-footer-seam: ${V3_FOOTER_SEAM}; }

.monaco-workbench .part.statusbar {
	position: relative !important;
}
.monaco-workbench .part.statusbar::before {
	content: '' !important;
	position: absolute !important;
	top: 0 !important;
	left: 0 !important;
	right: 0 !important;
	width: 100% !important;
	height: 1px !important;
	background-color: var(--v3-footer-seam) !important;
	z-index: 100 !important;
	pointer-events: none !important;
}

.v3code-chat-footer-region {
	border-top: 1px solid var(--v3-footer-seam) !important;
	flex-shrink: 0 !important;
	box-sizing: border-box !important;
}
`;

function injectFooterSeamStyles(): void {
	const doc = mainWindow.document;
	let style = doc.getElementById(V3_FOOTER_SEAM_STYLE_ID) as HTMLStyleElement | null;
	if (!style) {
		style = doc.createElement('style');
		style.id = V3_FOOTER_SEAM_STYLE_ID;
		doc.head.appendChild(style);
	}
	style.textContent = V3_FOOTER_SEAM_STYLES;
}

// The bundled v3.css draws its rounded "floating card" geometry by giving each part a MARGIN
// in the layout JavaScript — which we did NOT swap (only the CSS). So on top of that CSS we
// re-add just the gaps + a frame color, which is what makes the rounding actually show.
const V3_GAP_LAYER_ID = 'v3code-gap-layer';
const V3_LAYOUT_GAP = V3_GAP;
const V3_GAP_LAYER = `
:root {
	--vscode-v3-part-border-radius: ${V3_EDITOR_RADIUS};
	--v3-gap: ${V3_LAYOUT_GAP};
	--separator-border: transparent;
}

/*
 * COLOUR vars live on .monaco-workbench, not :root. VS Code emits its --vscode-* theme variables
 * scoped to the workbench element, so on :root they do not exist and every var() below would
 * silently take its hardcoded fallback — pinning the chrome to one palette in every theme. The
 * geometry vars above stay on :root because they are literals and are read outside the workbench.
 *
 * Reading these from the theme is not a change of look for V3Code's own themes: the scoped
 * workbench.colorCustomizations written by writeGreyChromeApplicationOverlay set exactly these
 * values (editor/sideBar/panel.background #141416 = V3_CARD, titleBar/statusBar.background #1a1a1e
 * = V3_FRAME, foreground #EDEBE6 = V3_FG, input.background #222226 = V3_COMPOSER). So V3Code Dark
 * Classic renders byte-identically, and every OTHER theme now gets its own colours instead of this
 * grey. The constants remain as fallbacks for the case where a theme sets none of them.
 */
.monaco-workbench {
	--v3-frame: var(--vscode-titleBar-activeBackground, ${V3_FRAME});
	--v3-card: var(--vscode-editor-background, ${V3_CARD});
	--v3-fg: var(--vscode-foreground, ${V3_FG});
	/* Deliberately NOT var(--vscode-input-background). That token now carries the value picked for
	   small text fields and dropdowns; the composer is a far larger surface and at the same value
	   it reads as a washed-out slab against the cards. Cursor keeps its composer close to the
	   panel it sits in, which is the look being matched here. */
	--v3-composer: ${V3_COMPOSER_FILL};
}

/* Frame grey only on the workbench grid shell — NEVER on nested split-view-view
   (that painted frame into chat/explorer internals). */
.monaco-workbench .monaco-grid-view { background-color: var(--vscode-titleBar-activeBackground, ${V3_FRAME}) !important; }

/* Titlebar stays above card parts so nothing paints under the window chrome. */
.monaco-workbench .part.titlebar {
	z-index: 100 !important;
	position: relative !important;
}
.monaco-workbench .part.titlebar,
.monaco-workbench .part.titlebar > .titlebar-container {
	background-color: var(--vscode-titleBar-activeBackground, ${V3_FRAME}) !important;
}
.monaco-workbench .part.statusbar,
.monaco-workbench .part.statusbar.has-no-folder-context {
	background-color: var(--vscode-statusBar-background, ${V3_FRAME}) !important;
}
.monaco-workbench .part.statusbar {
	z-index: 100 !important;
	position: relative !important;
}

/* The v3 default blue accents are killed through V3CODE_GREY_COLOR_CUSTOMIZATIONS
   (theme-scoped settings) rather than pinned here with !important. Every token that
   used to be pinned — focusBorder, button.background, textLink.*, badge, the list
   selection set — is defined in that map, so the look is unchanged while Theme Builder
   picks can still override it. Never re-pin a Theme Builder token here. */

/* Kill the 1px separator-border strip hugging each sash. */
.monaco-workbench .monaco-split-view2.separator-border > .monaco-scrollable-element > .split-view-container > .split-view-view:not(:first-child)::before {
	display: none !important;
	background: transparent !important;
	content: none !important;
}

/*
 * FLOATING CARDS — equal gutter bars need width+height shrink with margin
 * (margin-only clips right/bottom square). The part itself is the CARD so its
 * radius contrasts with the frame gutter (FRAME-on-FRAME made corners vanish).
 * clip-path forces all 4 corners even when child layers fight border-radius.
 */
.monaco-workbench .part.sidebar,
.monaco-workbench .part.auxiliarybar,
.monaco-workbench .part.unifiedsidebar,
.monaco-workbench .part.panel,
.monaco-workbench .part.activitybar,
.monaco-workbench .part.editor {
	margin: ${V3_LAYOUT_GAP} !important;
	width: calc(100% - (${V3_LAYOUT_GAP} * 2)) !important;
	max-width: calc(100% - (${V3_LAYOUT_GAP} * 2)) !important;
	height: calc(100% - (${V3_LAYOUT_GAP} * 2)) !important;
	max-height: calc(100% - (${V3_LAYOUT_GAP} * 2)) !important;
	min-width: 0 !important;
	min-height: 0 !important;
	box-sizing: border-box !important;
	border-radius: ${V3_CARD_RADIUS} !important;
	overflow: hidden !important;
	border: none !important;
	outline: none !important;
	clip-path: inset(0 round ${V3_CARD_RADIUS}) !important;
}
/* Explorer: keep the card radius visible — a painted border token made the left
   seam look square/wider against the activity-bar gap after the contrast pass. */
.monaco-workbench .part.sidebar {
	border: none !important;
	outline: none !important;
}
/* Surfaces resolve through their own theme token so Theme Builder picks land; the V3
   card grey is only the fallback. On the grey themes the token IS the card grey (see
   V3CODE_GREY_COLOR_CUSTOMIZATIONS), so the default look is unchanged. */
.monaco-workbench .part.sidebar,
.monaco-workbench .part.auxiliarybar,
.monaco-workbench .part.unifiedsidebar {
	background-color: var(--vscode-sideBar-background, ${V3_CARD}) !important;
}
.monaco-workbench .part.panel {
	background-color: var(--vscode-panel-background, ${V3_CARD}) !important;
}
.monaco-workbench .part.editor {
	background-color: var(--vscode-editor-background, ${V3_CARD}) !important;
}
.monaco-workbench .part.sidebar,
.monaco-workbench .part.auxiliarybar,
.monaco-workbench .part.unifiedsidebar {
	overflow: hidden !important;
}
.monaco-workbench .part.sidebar > .content,
.monaco-workbench .part.auxiliarybar > .content,
.monaco-workbench .part.unifiedsidebar > .content,
.monaco-workbench .part.panel > .content,
.monaco-workbench .part.editor > .content {
	border-radius: ${V3_CARD_RADIUS} !important;
	overflow: hidden !important;
	border: none !important;
	clip-path: inset(0 round ${V3_CARD_RADIUS}) !important;
}
.monaco-workbench .part.sidebar > .content,
.monaco-workbench .part.auxiliarybar > .content,
.monaco-workbench .part.unifiedsidebar > .content {
	background-color: var(--vscode-sideBar-background, ${V3_CARD}) !important;
}
.monaco-workbench .part.panel > .content {
	background-color: var(--vscode-panel-background, ${V3_CARD}) !important;
}
.monaco-workbench .part.editor > .content {
	background-color: var(--vscode-editor-background, ${V3_CARD}) !important;
}
.monaco-workbench .part.unifiedsidebar,
.monaco-workbench .part.unifiedsidebar > .content,
.monaco-workbench .part.unifiedsidebar .unified-agents-sidebar,
.monaco-workbench .part.unifiedsidebar .unified-agents-cursor {
	border-radius: ${V3_CARD_RADIUS} !important;
	overflow: hidden !important;
}
.monaco-workbench .part.activitybar,
.monaco-workbench .part.activitybar > .content {
	background-color: var(--vscode-activityBar-background, ${V3_FRAME}) !important;
	border-radius: ${V3_CARD_RADIUS} !important;
	overflow: hidden !important;
	clip-path: inset(0 round ${V3_CARD_RADIUS}) !important;
}

/* Editor group fills the card; keep full 4-corner radius (empty has no title). */
.monaco-workbench .part.editor > .content .editor-group-container,
.monaco-workbench .part.editor > .content .editor-group-container.empty {
	margin: 0 !important;
	border: none !important;
	box-shadow: none !important;
	outline: none !important;
	border-radius: ${V3_EDITOR_RADIUS} !important;
	border-top-left-radius: ${V3_EDITOR_RADIUS} !important;
	border-top-right-radius: ${V3_EDITOR_RADIUS} !important;
	border-bottom-left-radius: ${V3_EDITOR_RADIUS} !important;
	border-bottom-right-radius: ${V3_EDITOR_RADIUS} !important;
	overflow: hidden !important;
	background-color: var(--vscode-editor-background, ${V3_CARD}) !important;
	position: relative !important;
	clip-path: inset(0 round ${V3_EDITOR_RADIUS}) !important;
}
.monaco-workbench .part.editor > .content .editor-group-container.empty > .editor-container,
.monaco-workbench .part.editor > .content .editor-group-container.empty > .editor-group-watermark,
.monaco-workbench .part.editor > .content .editor-group-container.empty::before,
.monaco-workbench .part.editor > .content .editor-group-container.empty::after {
	border-radius: ${V3_EDITOR_RADIUS} !important;
	border-top-left-radius: ${V3_EDITOR_RADIUS} !important;
	border-top-right-radius: ${V3_EDITOR_RADIUS} !important;
	border-bottom-left-radius: ${V3_EDITOR_RADIUS} !important;
	border-bottom-right-radius: ${V3_EDITOR_RADIUS} !important;
}
.monaco-workbench .part.editor > .content .editor-group-container > .title.tabs {
	border-top-left-radius: ${V3_EDITOR_RADIUS} !important;
	border-top-right-radius: ${V3_EDITOR_RADIUS} !important;
	background-color: var(--vscode-editorGroupHeader-tabsBackground, ${V3_CARD}) !important;
}
.monaco-workbench .part.editor > .content .editor-group-container:not(.empty) > .editor-container {
	border-bottom-left-radius: ${V3_EDITOR_RADIUS} !important;
	border-bottom-right-radius: ${V3_EDITOR_RADIUS} !important;
	background-color: var(--vscode-editor-background, ${V3_CARD}) !important;
}
.monaco-workbench .part.editor > .content .editor-group-container.empty > .editor-container {
	background-color: var(--vscode-editor-background, ${V3_CARD}) !important;
}
.monaco-workbench .part.editor .title .tabs-container > .tab {
	height: calc(var(--editor-group-tab-height) - 6px) !important;
	margin: 3px 2px !important;
	border-radius: ${V3_TAB_RADIUS} !important;
}
.monaco-workbench .part.editor > .content .editor-group-container,
.monaco-workbench .part.editor > .content .editor-group-container.empty {
	border-left: none !important;
	border-right: none !important;
	border-top: none !important;
	border-bottom: none !important;
}

/* The dedicated workspace is a transparent native window. The normal chrome
	layer deliberately paints every editor ancestor opaque, which prevents the
	narrow session rail from ever reaching the native material. Clear only the
	ancestors behind that one chat group; the conversation and utility groups
	continue to paint their own nearly-solid surfaces. */
.monaco-workbench.agent-workspace-window,
.monaco-workbench.agent-workspace-window .monaco-grid-view,
.monaco-workbench.agent-workspace-window .part.editor,
.monaco-workbench.agent-workspace-window .part.editor > .content,
.monaco-workbench.agent-workspace-window .part.editor > .content .editor-group-container:has(.chat-editor-relative.agent-workspace-enabled),
.monaco-workbench.agent-workspace-window .part.editor > .content .editor-group-container:has(.chat-editor-relative.agent-workspace-enabled) > .editor-container,
.monaco-workbench.agent-workspace-window .chat-editor-relative.agent-workspace-enabled {
	background-color: transparent !important;
}

/* Remove any leftover auxiliary-bar composite title from the compact shell.
   Layout space is reclaimed via AuxiliaryBarPart hasTitle:false.
   Runtime-injected so it wins over v3 v3.css height:44px rules. */
.monaco-workbench .part.auxiliarybar > .composite.title,
.monaco-workbench .part.auxiliarybar > .title,
.monaco-workbench.v3-simple-style .part.auxiliarybar > .title,
.monaco-workbench.v3-simple-style .part.auxiliarybar > .composite.title,
.monaco-workbench .part.auxiliarybar > .header-or-footer {
	display: none !important;
	visibility: hidden !important;
	height: 0 !important;
	min-height: 0 !important;
	max-height: 0 !important;
	padding: 0 !important;
	margin: 0 !important;
	border: none !important;
	opacity: 0 !important;
	overflow: hidden !important;
	pointer-events: none !important;
}
.monaco-workbench .part.auxiliarybar .pane > .pane-header {
	display: none !important;
	height: 0 !important;
	min-height: 0 !important;
}
/* Chat header actions: New / History / More stay horizontal (never stacked). */
.monaco-workbench .part.auxiliarybar .chat-view-tabs-actions,
.monaco-workbench .part.auxiliarybar .chat-view-tabs-left {
	display: flex !important;
	flex-direction: row !important;
	align-items: center !important;
	gap: 2px !important;
}
.monaco-workbench .part.auxiliarybar .chat-view-tabs-history {
	display: flex !important;
	align-items: center !important;
}
.monaco-workbench .part.activitybar .monaco-action-bar .action-item .action-label {
	border-radius: ${V3_EDITOR_RADIUS} !important;
}
.monaco-workbench .monaco-scrollable-element > .scrollbar > .slider { border-radius: 50px !important; }

/* V3Code: compact watermark shares the welcome scale and centered shortcut rows. */
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark,
.monaco-workbench.v3-simple-style .part.editor > .content .editor-group-container > .editor-group-watermark {
	max-width: 420px !important;
	width: 100% !important;
}
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark > .watermark-container {
	max-width: 420px !important;
	width: 100% !important;
	gap: 18px !important;
}
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .letterpress,
.monaco-workbench.v3-simple-style .part.editor > .content .editor-group-container .editor-group-watermark .letterpress,
.monaco-workbench.v3-simple-style.v3-simple-style .part.editor > .content .editor-group-container .editor-group-watermark .letterpress {
	width: 128px !important;
	max-width: min(128px, 45vw) !important;
	height: 128px !important;
	max-height: min(128px, 24vh) !important;
	min-height: 0 !important;
	flex-shrink: 0 !important;
}
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts {
	width: 100% !important;
	max-width: 360px !important;
}
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts > .watermark-box {
	align-items: center !important;
	width: 100% !important;
}
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts dl {
	display: grid !important;
	grid-template-columns: auto auto !important;
	justify-content: center !important;
	column-gap: 14px !important;
	row-gap: 2px !important;
	margin: 4px 0 !important;
	width: auto !important;
}
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts dt,
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts dd {
	margin: 0 !important;
	margin-inline-start: 0 !important;
	text-align: left !important;
}

/* Resize sashes: invisible at rest (gap = frame). No leftover vertical paint strip. */
.monaco-workbench .monaco-sash,
.monaco-workbench .monaco-sash:before {
	background: transparent !important;
	border: none !important;
	box-shadow: none !important;
}
.monaco-workbench .monaco-sash.hover:before,
.monaco-workbench .monaco-sash.active:before {
	background: rgba(80, 168, 230, 0.6) !important;
	box-shadow: 0 0 6px rgba(80, 168, 230, 0.35) !important;
}

/* Window dragging — whole title bar is drag region except interactive controls. */
.monaco-workbench .part.titlebar,
.monaco-workbench .part.titlebar > .titlebar-container,
.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-drag-region,
.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-left,
.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-center,
.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-right {
	-webkit-app-region: drag !important;
}
.monaco-workbench .part.titlebar .action-item,
.monaco-workbench .part.titlebar .monaco-toolbar,
.monaco-workbench .part.titlebar .command-center,
.monaco-workbench .part.titlebar .monaco-button,
.monaco-workbench .part.titlebar a.action-label,
.monaco-workbench .part.titlebar .menubar,
.monaco-workbench .part.titlebar .window-controls-container,
.monaco-workbench .part.titlebar .v3-repo-pill,
.monaco-workbench .part.titlebar .v3-search-pill,
.monaco-workbench .part.titlebar .v3-profile-button,
.monaco-workbench .part.titlebar .v3-solo-tabs,
.monaco-workbench .part.titlebar .v3-mode-pill {
	-webkit-app-region: no-drag !important;
}

/* Command center is off — the inert .window-title text (folder name, not a button)
   just floats lonely in the titlebar. Hide it; v3-repo-pill is the real control. */
.monaco-workbench .part.titlebar .titlebar-center > .window-title:not(:has(.command-center)) {
	display: none !important;
}
`;

const V3_STYLESHEET_ID = 'v3code-v3-stylesheet';

/** Load the bundled workbench CSS without ESM `import './media/v3.css'` (breaks dev module load). */
function injectV3Stylesheet(): void {
	const doc = mainWindow.document;
	if (doc.getElementById(V3_STYLESHEET_ID)) {
		return;
	}
	const link = doc.createElement('link');
	link.id = V3_STYLESHEET_ID;
	link.rel = 'stylesheet';
	link.href = FileAccess.asBrowserUri('vs/workbench/contrib/void/browser/media/v3.css' as AppResourcePath).toString(true);
	doc.head.appendChild(link);
}

function ensureV3WorkbenchClasses(): void {
	const doc = mainWindow.document;
	// Apply the v3 geometry/color gate classes. Returns true once the
	// .monaco-workbench element has been classed (<body> is classed immediately).
	const apply = (): boolean => {
		doc.body.classList.add('v3-simple-style', 'theme-v3');
		const workbench = doc.querySelector('.monaco-workbench');
		if (workbench) {
			workbench.classList.add('v3-simple-style', 'theme-v3');
			return true;
		}
		return false;
	};
	if (apply()) { return; }
	// The workbench mounts shortly after BlockStartup. Observe ONLY until it
	// exists and is classed, then DISCONNECT. A persistent whole-document
	// observer re-ran apply() on EVERY mutation — including the constant DOM
	// churn of chat streaming and editor scrolling — which thrashed layout and
	// was a real source of chat jank. The gate classes live on <body> +
	// .monaco-workbench and persist for the session, so a one-shot apply suffices.
	const observer = new MutationObserver(() => {
		if (apply()) { observer.disconnect(); }
	});
	observer.observe(doc.documentElement, { childList: true, subtree: true });
}

function injectGapLayer(): void {
	const doc = mainWindow.document;
	const existing = doc.getElementById(V3_GAP_LAYER_ID);
	if (existing) { existing.remove(); }
	// Restore the V3Code logo in the empty-editor watermark. The bundled v3.css repoints the
	// letterpress background-image to a path that does not resolve from media/v3.css, which
	// blanks the logo — so we force it back to our own v3code_mark.svg via an absolute URL
	// (a relative url() in an injected <style> would not resolve correctly).
	const markUri = FileAccess.asBrowserUri('vs/workbench/browser/parts/editor/media/v3code_mark.svg' as AppResourcePath).toString(true);
	// V3Code: use the same white source mark for both graphite welcome surfaces.
	const graphiteMarkUri = FileAccess.asBrowserUri('vs/workbench/contrib/void/browser/media/v3-welcome-mark.png' as AppResourcePath).toString(true);
	const logoFix = `
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .letterpress,
.monaco-workbench.vs-dark .part.editor > .content .editor-group-container .editor-group-watermark .letterpress,
.monaco-workbench.v3-simple-style .part.editor > .content .editor-group-container .editor-group-watermark .letterpress {
	background-image: url("${markUri}") !important;
	opacity: 0.5 !important;
}
.monaco-workbench.vs-dark .part.editor > .content .editor-group-container > .editor-group-watermark .letterpress {
	background-image: url("${graphiteMarkUri}") !important;
	opacity: 1 !important;
}
`;
	const style = doc.createElement('style');
	style.id = V3_GAP_LAYER_ID;
	style.textContent = V3_GAP_LAYER + logoFix;
	doc.head.appendChild(style);
}

export const V3CODE_GREY_COLOR_CUSTOMIZATIONS: IThemeScopedColorCustomizations = {
	// The "frame" between parts is the near-black shell showing through the card gaps
	// (see V3_CHROME_STYLES), not contrast outlines. Keep VS Code's two global
	// contrast-outline tokens transparent: an old Theme Builder exposed contrastBorder
	// as "Outlines", and one red pick painted nearly every control in Settings and
	// onboarding. These tokens are accessibility fallbacks for high-contrast themes;
	// the four house themes below are ordinary dark themes with their own focus states.
	'contrastBorder': 'transparent',
	'contrastActiveBorder': 'transparent',
	// --- FRAME (coal grey trim): title / activity / status / tab strip match the gaps ---
	'titleBar.activeBackground': V3_FRAME,
	'titleBar.inactiveBackground': V3_FRAME,
	'activityBar.background': V3_FRAME,
	'statusBar.background': V3_FRAME,
	'statusBar.noFolderBackground': V3_FRAME,
	'statusBar.border': V3_FOOTER_SEAM,
	// Transparent part borders — a painted sideBar/editorGroup border reads as a
	// thick square seam next to the activity-bar gap (the "wider explorer border").
	'editorGroup.border': 'transparent',
	'sideBar.border': 'transparent',
	'panel.border': 'transparent',
	'activityBar.border': 'transparent',

	'editorGroupHeader.tabsBackground': V3_CARD,
	'editorGroupHeader.noTabsBackground': V3_CARD,
	'commandCenter.background': V3_CARD,
	'commandCenter.activeBackground': '#1e1e22',
	// --- CARDS: editor / sidebar / chat / panel surfaces ---
	'editor.background': V3_CARD,
	'editor.foreground': V3_FG,
	'foreground': V3_FG,
	'descriptionForeground': V3_MUTED,
	'sideBar.background': V3_CARD,
	'sideBar.foreground': V3_FG_SOFT,
	'sideBarSectionHeader.background': V3_CARD,
	'sideBarSectionHeader.foreground': V3_FG,
	'panel.background': V3_CARD,
	'panel.foreground': V3_FG,
	'terminal.background': V3_CARD,
	'terminal.foreground': V3_FG,
	'breadcrumb.background': V3_CARD,
	'breadcrumb.foreground': V3_FG_SOFT,
	'tab.activeBackground': V3_CARD,
	'tab.activeForeground': V3_FG,
	'tab.inactiveBackground': V3_FRAME,
	'tab.inactiveForeground': V3_MUTED,
	'tab.hoverBackground': '#1e1e22',
	'list.activeSelectionBackground': '#2A2A30',
	'list.activeSelectionForeground': V3_FG,
	'list.inactiveSelectionBackground': '#1C1B1D',
	'list.inactiveSelectionForeground': V3_FG,
	'list.hoverBackground': '#262627',
	'list.foreground': V3_FG,
	'badge.background': '#3A3A42',
	'badge.foreground': V3_FG,
	// Chat surfaces. These are pinned because the upstream defaults are BLUE — chat.requestCodeBorder
	// registers as #004972B8 — so as soon as void.css stopped hardcoding over them, the message
	// bubble's edge came back blue on the ship theme. Pinning the greys that were previously baked
	// into the CSS keeps V3Code Dark Classic looking exactly as it did, while leaving the Theme
	// Builder swatches free to change them.
	'chat.requestBubbleBackground': '#2A2A30',
	'chat.requestCodeBorder': '#414344',
	'chat.rollingWorkForeground': '#8E8E96',
	'textCodeBlock.background': '#1c1c20',
	'activityBar.foreground': V3_FG_SOFT,
	'activityBar.activeBorder': '#3A3A42',
	'activityBarBadge.background': '#3A3A42',
	'activityBarBadge.foreground': V3_FG,
	'button.background': '#2A2A30',
	'button.foreground': V3_FG,
	'button.hoverBackground': '#3A3A42',
	'button.secondaryBackground': '#1A1A1E',
	'button.secondaryForeground': V3_FG,
	'button.secondaryHoverBackground': '#222227',
	'chat.slashCommandBackground': '#2A2A3066',
	'chat.slashCommandForeground': V3_MUTED,
	// Keep gutter modified neutral — do NOT touch diffEditor.* added/removed (green/red cards).
	'editorGutter.modifiedBackground': '#6B6B73',
	'focusBorder': '#3A3A42',
	'input.background': '#404040',
	'input.foreground': V3_FG,
	'input.placeholderForeground': V3_PLACEHOLDER,
	'inputOption.activeBackground': '#3A3A4266',
	'inputOption.activeBorder': '#3A3A42',
	'dropdown.background': V3_COMPOSER,
	'dropdown.foreground': V3_FG,
	'list.focusAndSelectionOutline': '#3A3A42',
	'list.focusOutline': '#3A3A42',
	'menu.background': V3_CARD,
	'menu.foreground': V3_FG,
	'menu.selectionBackground': '#2A2A30',
	// Selected text in the editor. Never pinned before, so it took whatever the underlying
	// theme set — which on several is a saturated purple/blue, badly out of place against the
	// greys. Translucent on purpose so syntax colours still read through the selection.
	'editor.selectionBackground': '#3A3A4288',
	'editor.inactiveSelectionBackground': '#2A2A3066',
	'editor.selectionHighlightBackground': '#2A2A3055',
	'menu.selectionForeground': V3_FG,
	'panelTitle.activeBorder': '#3A3A42',
	'panelTitle.activeForeground': V3_FG,
	'panelTitle.inactiveForeground': V3_MUTED,
	'problemsInfoIcon.foreground': V3_MUTED,
	'problemsWarningIcon.foreground': V3_MUTED,
	'progressBar.background': '#3A3A42',
	'statusBar.foreground': V3_FG_SOFT,
	'statusBar.debuggingBackground': '#1c1c20',
	'statusBar.debuggingForeground': V3_FG,
	'statusBar.focusBorder': '#3A3A42',
	'statusBarItem.focusBorder': '#3A3A42',
	'statusBarItem.remoteBackground': '#3A3A42',
	'statusBarItem.remoteForeground': V3_FG,
	'titleBar.activeForeground': V3_FG,
	'titleBar.inactiveForeground': V3_MUTED,
	'tab.activeBorderTop': '#3A3A42',
	'tab.selectedBorderTop': '#3A3A42',
	'terminal.tab.activeBorder': '#3A3A42',
	'textLink.activeForeground': '#B8B8C0',
	'textLink.foreground': '#B8B8C0',
	'welcomePage.progress.foreground': '#3A3A42',
};

/** Grey overrides apply only on these themes — never globally (breaks light themes + V3Code Hard). */
/**
 * Themes that get the grey chrome painted over them.
 *
 * This used to list seven. Because the same 89-key palette is written into every scope, all seven
 * rendered IDENTICALLY — picking V3Code Cyber, Dark Midnight, Dark+ or Dark Modern changed nothing
 * at all, which is what "switching themes does nothing" actually was. Four of them were stock VS
 * Code themes, so a user choosing Dark+ silently got V3Code grey instead of Dark+.
 *
 * Only the default V3Code theme keeps the grey now. Every other theme renders as itself. Themes
 * removed from this list are cleaned out of the user's settings by pruneUnscopedGreyChrome below —
 * shortening the list alone would leave the old scopes written and still winning.
 */
const GREY_CHROME_THEME_SCOPES = [
	'V3Code Dark Classic',
	'V3Code Dev',
	'V3Code Cyber',
	'V3Code Dark Midnight',
] as const;

/**
 * Themes previously grey-scoped, whose stale overrides must be removed on upgrade.
 *
 * Only the STOCK VS Code themes. The first cut of this freed V3Code's own themes too, which was
 * wrong in both directions: it did not fix the reported bug (those are our themes — they are
 * SUPPOSED to wear the house palette), and it left anyone sitting on V3Code Dev looking at that
 * theme's raw purple and blue instead of the greys. The actual defect was hijacking themes that
 * are not ours: someone picking Dark+ expects Dark+, not V3Code grey wearing its name.
 */
const LEGACY_GREY_CHROME_THEME_SCOPES = [
	'Dark+',
	'Dark Modern',
	'Dark 2026',
] as const;

// Keep this explicit list intact: the post-package verifier checks that it reached the
// renderer bundle. These old Theme Builder controls have no safe meaning in the floating-card
// design and can paint a workspace-wide outline from a single stale profile value.
const V3CODE_UNSUPPORTED_BORDER_CUSTOMIZATIONS = [
	'panel.border',
	'contrastBorder',
	'contrastActiveBorder',
] as const;

export function mergeScopedGreyChromeCustomizations(existing: IColorCustomizations): IColorCustomizations {
	const merged: IColorCustomizations = { ...existing };
	// Strip legacy global grey keys so light themes and V3Code Hard are not polluted.
	for (const key of Object.keys(V3CODE_GREY_COLOR_CUSTOMIZATIONS)) {
		delete merged[key];
	}
	// Strip accidental neon primaries left in USER/APPLICATION from Theme Builder
	// (panel.border #ff0000 painted every Settings card via --void-border-* before
	// those tokens were decoupled). Exact pure red/green/blue only — never soft tints.
	const stripNeon = (bag: IThemeScopedColorCustomizations): void => {
		for (const [k, v] of Object.entries(bag)) {
			if (typeof v !== 'string') { continue; }
			const hex = v.trim().toLowerCase();
			if (hex === '#ff0000' || hex === '#f00' || hex === '#00ff00' || hex === '#0f0' || hex === '#0000ff' || hex === '#00f') {
				delete bag[k];
			}
		}
	};
	stripNeon(merged as IThemeScopedColorCustomizations);
	// These borders are force-reset, not merely defaulted.
	//
	// The floating-card design separates parts with GAPS, so any visible value here paints seams
	// that are not supposed to exist. panel.border caused this complaint twice. contrastBorder,
	// previously exposed as Theme Builder's "Outlines", is broader still: VS Code deliberately
	// applies it around nearly every control, which painted Settings and onboarding red together.
	//
	// The Theme Builder controls for these are removed, so clearing them on the way through stops
	// an old pick surviving forever in a scope the user has no obvious way to clean.
	const clearUnsupportedBorders = (bag: IThemeScopedColorCustomizations): void => {
		for (const key of V3CODE_UNSUPPORTED_BORDER_CUSTOMIZATIONS) {
			if (bag[key] !== undefined) {
				delete bag[key];
			}
		}
	};
	clearUnsupportedBorders(merged as IThemeScopedColorCustomizations);
	// Remove grey values previously written into themes that are no longer scoped, so those themes
	// go back to looking like themselves. Only keys whose value still EQUALS the grey palette are
	// dropped: anything the user changed in Theme Builder differs, and is theirs to keep.
	for (const themeName of LEGACY_GREY_CHROME_THEME_SCOPES) {
		const scopeKey = `[${themeName}]`;
		const scope = merged[scopeKey] as IThemeScopedColorCustomizations | undefined;
		if (!scope) { continue; }
		const kept: IThemeScopedColorCustomizations = {};
		for (const [k, v] of Object.entries(scope)) {
			if (V3CODE_GREY_COLOR_CUSTOMIZATIONS[k] !== v) { kept[k] = v; }
		}
		if (Object.keys(kept).length > 0) {
			merged[scopeKey] = kept;
		} else {
			delete merged[scopeKey];
		}
	}

	for (const themeName of GREY_CHROME_THEME_SCOPES) {
		const scopeKey = `[${themeName}]`;
		const prior = { ...((merged[scopeKey] as IThemeScopedColorCustomizations | undefined) ?? {}) };
		stripNeon(prior);
		clearUnsupportedBorders(prior);
		// Grey is the BASE coat, the user's picks are the top coat. Spreading grey last
		// overwrote every Theme Builder choice on each config change ("I can't change it").
		merged[scopeKey] = { ...V3CODE_GREY_COLOR_CUSTOMIZATIONS, ...prior };
	}
	return merged;
}

/**
 * Legacy cleanup, run once at startup. Older builds of Theme Builder wrote UNSCOPED keys
 * (e.g. panel.border / focusBorder = red) that painted every theme; we keep only
 * `[Theme Name]` scopes and re-apply grey chrome underneath the user's own picks.
 */
export function sanitizeV3ColorCustomizations(existing: IColorCustomizations | undefined): IColorCustomizations {
	const scopedOnly: IColorCustomizations = {};
	for (const [key, value] of Object.entries(existing ?? {})) {
		if (key.startsWith('[') && key.endsWith(']')) {
			scopedOnly[key] = value as IThemeScopedColorCustomizations;
		}
	}
	return mergeScopedGreyChromeCustomizations(scopedOnly);
}

/**
 * Remove only the retired Theme Builder values that can leak across themes.
 *
 * This is deliberately pure: configuration values can be shared with the theme service, so
 * mutating a nested scope in place can create a theme change without a configuration write.
 * Returning a deep clone also lets the caller compare before writing and makes repeated startup
 * cleanup a no-op after the first successful pass.
 */
export function sanitizeV3UserColorCustomizations(existing: IColorCustomizations): IColorCustomizations {
	const next = deepClone(existing);
	const stripNeon = (bag: Record<string, unknown>): void => {
		for (const [key, value] of Object.entries(bag)) {
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				stripNeon(value as Record<string, unknown>);
				continue;
			}
			if (typeof value !== 'string') {
				continue;
			}
			const hex = value.trim().toLowerCase();
			if (hex === '#ff0000' || hex === '#f00' || hex === '#00ff00' || hex === '#0f0' || hex === '#0000ff' || hex === '#00f') {
				delete bag[key];
			}
		}
	};

	stripNeon(next as Record<string, unknown>);

	// Very old Theme Builder builds wrote these unscoped, affecting every theme.
	for (const key of V3CODE_UNSUPPORTED_BORDER_CUSTOMIZATIONS) {
		delete next[key];
	}

	// A USER value wins over the APPLICATION base coat. Remove stale hard-outline tokens from
	// the house-theme scopes once; the application overlay supplies transparent values after it.
	for (const themeName of GREY_CHROME_THEME_SCOPES) {
		const scopeKey = `[${themeName}]`;
		const value = next[scopeKey];
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			continue;
		}
		for (const key of V3CODE_UNSUPPORTED_BORDER_CUSTOMIZATIONS) {
			delete value[key];
		}
	}

	return next;
}

// EXPERIMENT: when true, load the full bundled workbench CSS (imported in void.contribution.ts)
// and activate it via the v3 body/workbench gate classes, clearing our own overrides so
// the full card look shows. Set false to fall back to V3Code's near-black card chrome.
const V3_CHROME_CSS = true;

class V3CodeGreyChromeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.v3codeGreyChrome';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IThemeService private readonly themeService: IThemeService,
	) {
		super();
		injectV3Stylesheet();
		injectTopActivityBarMenubarStyles();
		injectDialogFixStyles();
		injectFooterSeamStyles();
		injectAskUserFixStyles();
		this.migrateCommandCenterOff();
		// Reset first, then the ensure-default pass below fills in anything still unset.
		this.migrateColorThemeToDefault();
		this.ensureDefaultColorTheme();
		// USER cleanup must happen before the APPLICATION overlay and only on this startup path.
		// Running it from the theme-change callback creates a feedback loop: overlay adds the
		// transparent border keys, cleanup removes the USER copies, and both writes trigger the
		// callback again. That loop made settings.json and editor decorations visibly flash.
		this.stripNeonUserColorCustomizations();
		if (V3_CHROME_CSS) {
			this.enableFullChromeCss();
		} else {
			this.applyGreyChrome();
			injectChromeStyles();
		}
		// This contribution runs at BlockStartup, which is before the color theme has finished
		// applying. Running once there left the workbench painted with pre-theme border colours
		// (red card outlines in the MCP panel and elsewhere) until something happened to make
		// the pass run again — pressing Theme Builder's Reset "fixed" it only because the write
		// fired a change event, not because it changed any value. Re-apply when the theme
		// actually lands, and on every later theme switch.
		this._register(this.themeService.onDidColorThemeChange(() => this.reapplyChromeColors()));
		// NOTE: do NOT re-sanitize on every CONFIGURATION change. Theme Builder writes
		// theme-scoped keys, and a live config listener here deleted each pick milliseconds
		// after the user made it — that was the "the color won't change" bug. Theme changes
		// only; the two calls below never touch the user's own theme-scoped picks.
	}

	/**
	 * Idempotent colour re-application. Safe to run repeatedly: the overlay writes only when
	 * its APPLICATION value actually changes. USER cleanup is intentionally excluded from this
	 * theme-change path so a configuration write cannot recursively retrigger itself.
	 */
	private reapplyChromeColors(): void {
		if (V3_CHROME_CSS) {
			ensureV3WorkbenchClasses();
			this.writeGreyChromeApplicationOverlay();
		} else {
			this.applyGreyChrome();
		}
	}

	/** Missing / broken theme → the stable bundled Dark 2026 baseline. */
	private ensureDefaultColorTheme(): void {
		const theme = this.configurationService.getValue<string>('workbench.colorTheme');
		if (!theme || theme === 'None') {
			void this.configurationService.updateValue('workbench.colorTheme', 'Dark 2026', ConfigurationTarget.USER);
		}
	}

	/**
	 * One-shot: move a fresh profile onto the stable bundled baseline theme.
	 *
	 * This overwrites a deliberate choice, which ensureDefaultColorTheme deliberately does not —
	 * it only fills in an unset theme. Existing profiles that already ran this migration keep any
	 * theme they subsequently selected; new profiles start on Dark 2026 and can still choose another.
	 *
	 * Guarded by storage so it happens exactly once per profile. Someone who re-picks their theme
	 * after the update keeps it — an override that reasserted itself on every launch would be
	 * indistinguishable from the app refusing to let them change it.
	 */
	private migrateColorThemeToDefault(): void {
		if (this.storageService.getBoolean(COLOR_THEME_RESET_MIGRATION_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		void this.configurationService.updateValue('workbench.colorTheme', 'Dark 2026', ConfigurationTarget.USER);
		this.storageService.store(COLOR_THEME_RESET_MIGRATION_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	/** Profiles that already had window.commandCenter:true keep it until this one-shot flip. */
	private migrateCommandCenterOff(): void {
		if (this.storageService.getBoolean(COMMAND_CENTER_OFF_MIGRATION_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		void this.configurationService.updateValue('window.commandCenter', false, ConfigurationTarget.USER);
		this.storageService.store(COMMAND_CENTER_OFF_MIGRATION_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	// The bundled v3.css gates ALL of its geometry + color rules behind .v3-simple-style
	// and .theme-v3 on <body> and .monaco-workbench. Add them (retrying until the
	// workbench element exists) and strip our color overrides so the full palette shows.
	private enableFullChromeCss(): void {
		ensureV3WorkbenchClasses();
		this.writeGreyChromeApplicationOverlay();
		injectGapLayer();
	}

	private applyGreyChrome(): void {
		if (this.configurationService.getValue(ChatConfiguration.TitleBarSignInEnabled) !== false) {
			this.configurationService.updateValue(ChatConfiguration.TitleBarSignInEnabled, false, ConfigurationTarget.APPLICATION);
		}

		this.writeGreyChromeApplicationOverlay();
	}

	/** Only merge into APPLICATION — never bake USER Theme Builder keys into APPLICATION. */
	private writeGreyChromeApplicationOverlay(): void {
		const inspected = this.configurationService.inspect<IColorCustomizations>('workbench.colorCustomizations');
		const application = inspected.applicationValue ?? {};
		const next = mergeScopedGreyChromeCustomizations(application);
		if (equals(application, next)) {
			return;
		}
		void this.configurationService.updateValue(
			'workbench.colorCustomizations',
			next,
			ConfigurationTarget.APPLICATION,
		);
	}

	/** Cleanup for colors stuck in USER from the retired Theme Builder. */
	private stripNeonUserColorCustomizations(): void {
		const inspected = this.configurationService.inspect<IColorCustomizations>('workbench.colorCustomizations');
		const user = inspected.userValue;
		if (!user || typeof user !== 'object') {
			return;
		}
		const next = sanitizeV3UserColorCustomizations(user);
		if (!equals(user, next)) {
			void this.configurationService.updateValue('workbench.colorCustomizations', next, ConfigurationTarget.USER);
		}
	}
}

registerWorkbenchContribution2(V3CodeGreyChromeContribution.ID, V3CodeGreyChromeContribution, WorkbenchPhase.BlockStartup);
