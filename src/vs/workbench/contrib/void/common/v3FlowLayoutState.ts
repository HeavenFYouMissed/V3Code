/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export type V3SoloSurface = 'flow' | 'editor' | 'browser' | 'terminal';

/** What just happened on the right side, so a visible panel can be told apart from a
 *  panel the layout engine reopened by itself. */
export type V3RestoreTrigger = 'editor-close' | 'part-visibility';

export interface V3RightSideState {
	v3ModeActive: boolean;
	activeSurface: V3SoloSurface;
	/** Editors open across ALL groups — files, browsers, diffs. The only honest "is
	 *  something on the right side" signal; part visibility alone lies (a visible but
	 *  empty editor part is the grey box users complain about). */
	openEditorCount: number;
	editorPartVisible: boolean;
	panelVisible: boolean;
	auxiliaryBarMaximized: boolean;
	trigger: V3RestoreTrigger;
	/** For 'editor-close': was the panel already visible BEFORE the editor closed?
	 *  (Captured synchronously in the close handler, before the layout engine reacts.) */
	panelWasVisibleBeforeTrigger: boolean;
}

/**
 * The rubber band: Chat is the resting state of the V3 window. Whenever the right side
 * becomes genuinely empty — no editor open in any group, and no terminal panel that the
 * user (or a surface tab) deliberately put there — the layout snaps back to full-width
 * Flow, no matter which surface tab was selected or who opened what.
 *
 * Failure modes this replaces / avoids:
 *  - restoring on ANY editor close while Flow was selected (it hid files that were still
 *    open — the "chat randomly snaps back" bug);
 *  - never restoring from the Editor/Terminal surfaces or when the panel closed (the
 *    "grey editor until you press the Vibe button" bug);
 *  - and, now that part-visibility changes are a trigger too, hiding a terminal the
 *    user JUST opened by hand — a visible panel counts as content unless it appeared
 *    out of nowhere when an editor closed (core layout restoring the remembered
 *    terminal to keep a valid grid), which is the one stray case that still restores.
 */
export function shouldRestoreFlow(s: V3RightSideState): boolean {
	if (!s.v3ModeActive) { return false; }
	// Something is genuinely on the right: leave it alone, whatever surface is selected.
	if (s.openEditorCount > 0) { return false; }
	// A visible panel is content when someone put it there: any visibility-driven check
	// (the user toggled it, a surface tab showed it), or a panel that was already up
	// before the editor closed. Only "editor closed and the panel appeared by itself" is
	// the stray remembered-terminal case that must still hand the window back.
	if (s.panelVisible && (s.trigger === 'part-visibility' || s.panelWasVisibleBeforeTrigger)) { return false; }
	// Belt: the user chose the Terminal surface and it is showing — that IS the right side.
	if (s.activeSurface === 'terminal' && s.panelVisible) { return false; }
	// Already resting in canonical Flow: nothing to do (and no restore loop).
	const canonical = s.activeSurface === 'flow' && !s.editorPartVisible && !s.panelVisible && s.auxiliaryBarMaximized;
	return !canonical;
}
