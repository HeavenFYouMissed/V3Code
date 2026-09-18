/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// Normally you'd want to put these exports in the files that register them, but if you do that you'll get an import order error if you import them in certain cases.
// (importing them runs the whole file to get the ID, causing an import error). I guess it's best practice to separate out IDs, pretty annoying...

export const VOID_CTRL_L_ACTION_ID = 'void.ctrlLAction'

export const VOID_CTRL_K_ACTION_ID = 'void.ctrlKAction'

export const VOID_ACCEPT_DIFF_ACTION_ID = 'void.acceptDiff'

export const VOID_REJECT_DIFF_ACTION_ID = 'void.rejectDiff'

export const VOID_GOTO_NEXT_DIFF_ACTION_ID = 'void.goToNextDiff'

export const VOID_GOTO_PREV_DIFF_ACTION_ID = 'void.goToPrevDiff'

export const VOID_GOTO_NEXT_URI_ACTION_ID = 'void.goToNextUri'

export const VOID_GOTO_PREV_URI_ACTION_ID = 'void.goToPrevUri'

export const VOID_ACCEPT_FILE_ACTION_ID = 'void.acceptFile'

export const VOID_REJECT_FILE_ACTION_ID = 'void.rejectFile'

export const VOID_ACCEPT_ALL_DIFFS_ACTION_ID = 'void.acceptAllDiffs'

export const VOID_REJECT_ALL_DIFFS_ACTION_ID = 'void.rejectAllDiffs'

export const VOID_TURBO_DRAFT_ACTION_ID = 'void.turboDraft.run'

export const VOID_TURBO_DRAFT_DEEP_ACTION_ID = 'void.turboDraft.deep'

export const VOID_TURBO_DRAFT_DEEP_MULTI_FILE_ACTION_ID = 'void.turboDraft.deepMultiFile'

export const VOID_TURBO_DRAFT_CANCEL_ACTION_ID = 'void.turboDraft.cancel'

export const VOID_TURBO_DRAFT_ACCEPT_HUNK_ACTION_ID = 'void.turboDraft.acceptHunk'

export const VOID_TURBO_DRAFT_REJECT_HUNK_ACTION_ID = 'void.turboDraft.rejectHunk'

export const VOID_TURBO_DRAFT_DISCARD_ACTION_ID = 'void.turboDraft.discard'
