/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ITurboDraftService, TURBO_DRAFT_REVIEWING_CONTEXT_KEY } from './turboDraftService.js';
import {
	VOID_TURBO_DRAFT_ACTION_ID,
	VOID_TURBO_DRAFT_DEEP_ACTION_ID,
	VOID_TURBO_DRAFT_DEEP_MULTI_FILE_ACTION_ID,
	VOID_TURBO_DRAFT_CANCEL_ACTION_ID,
	VOID_TURBO_DRAFT_ACCEPT_HUNK_ACTION_ID,
	VOID_TURBO_DRAFT_REJECT_HUNK_ACTION_ID,
	VOID_TURBO_DRAFT_DISCARD_ACTION_ID,
} from './actionIDs.js';

const reviewing = TURBO_DRAFT_REVIEWING_CONTEXT_KEY.isEqualTo(true);
const notReviewing = TURBO_DRAFT_REVIEWING_CONTEXT_KEY.isEqualTo(false);

registerAction2(class TurboDraftAction extends Action2 {
	constructor() {
		super({
			id: VOID_TURBO_DRAFT_ACTION_ID,
			title: localize2('turboDraft.run', 'Turbo Draft'),
			f1: true,
			precondition: EditorContextKeys.editorTextFocus,
			keybinding: {
				primary: KeyMod.Shift | KeyCode.Tab,
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, notReviewing),
			},
			menu: [
				{ id: MenuId.EditorContext, group: 'navigation', order: 2.5 },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ITurboDraftService).startDraft({ mode: 'fast' });
	}
});

registerAction2(class TurboDraftDeepAction extends Action2 {
	constructor() {
		super({
			id: VOID_TURBO_DRAFT_DEEP_ACTION_ID,
			title: localize2('turboDraft.deep', 'Turbo Draft (Deep)'),
			f1: true,
			precondition: EditorContextKeys.editorTextFocus,
			keybinding: {
				// Same Tab family as the fast draft, one modifier deeper: Shift+Tab drafts,
				// Alt+Shift+Tab thinks harder. Alt+Shift+Tab is unbound in core, and Ctrl+Q
				// was not an option because it is Quit on Linux and Quick Access elsewhere.
				primary: KeyMod.Alt | KeyMod.Shift | KeyCode.Tab,
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, notReviewing),
			},
			menu: [
				{ id: MenuId.EditorContext, group: 'navigation', order: 2.6 },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ITurboDraftService).startDraft({ mode: 'deep' });
	}
});

// Shift+Q — Deep across the call-graph blast radius: draft this file, then walk the files
// that actually call into it, so one keypress forms a feature instead of a file.
registerAction2(class TurboDraftDeepMultiFileAction extends Action2 {
	constructor() {
		super({
			id: VOID_TURBO_DRAFT_DEEP_MULTI_FILE_ACTION_ID,
			title: localize2('turboDraft.deepMultiFile', 'Turbo Draft (Deep, multi-file)'),
			f1: true,
			precondition: EditorContextKeys.editorTextFocus,
			keybinding: {
				// NOT plain Shift+Q: a bare Shift+letter binding in the editor swallows the
				// keystroke, so you could never type a capital Q again.
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyQ,
				mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyQ },
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, notReviewing),
			},
			menu: [
				{ id: MenuId.EditorContext, group: 'navigation', order: 2.7 },
			],
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ITurboDraftService).startDraft({ mode: 'deep', multiFile: true });
	}
});

registerAction2(class TurboDraftAcceptHunkAction extends Action2 {
	constructor() {
		super({
			id: VOID_TURBO_DRAFT_ACCEPT_HUNK_ACTION_ID,
			title: localize2('turboDraft.acceptHunk', 'Turbo Draft: Accept Hunk'),
			f1: true,
			precondition: reviewing,
			keybinding: {
				primary: KeyCode.Tab,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, reviewing),
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ITurboDraftService).acceptCurrentHunk();
	}
});

registerAction2(class TurboDraftRejectHunkAction extends Action2 {
	constructor() {
		super({
			id: VOID_TURBO_DRAFT_REJECT_HUNK_ACTION_ID,
			title: localize2('turboDraft.rejectHunk', 'Turbo Draft: Reject Hunk'),
			f1: true,
			precondition: reviewing,
			keybinding: [
				{
					primary: KeyCode.Delete,
					weight: KeybindingWeight.EditorContrib + 100,
					when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, reviewing),
				},
				{
					primary: KeyMod.Shift | KeyCode.Tab,
					weight: KeybindingWeight.EditorContrib + 100,
					when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, reviewing),
				},
			],
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ITurboDraftService).rejectCurrentHunk();
	}
});

registerAction2(class TurboDraftDiscardAction extends Action2 {
	constructor() {
		super({
			id: VOID_TURBO_DRAFT_DISCARD_ACTION_ID,
			title: localize2('turboDraft.discard', 'Turbo Draft: Discard All'),
			f1: true,
			precondition: reviewing,
			keybinding: {
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib + 100,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, reviewing),
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ITurboDraftService).discardDraft();
	}
});

registerAction2(class TurboDraftCancelAction extends Action2 {
	constructor() {
		super({
			id: VOID_TURBO_DRAFT_CANCEL_ACTION_ID,
			title: localize2('turboDraft.cancel', 'Turbo Draft: Cancel'),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(ITurboDraftService).cancelDraft();
	}
});
