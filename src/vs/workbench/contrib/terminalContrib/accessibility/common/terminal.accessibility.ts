/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export const enum TerminalAccessibilityCommandId {
	FocusAccessibleBuffer = 'workbench.action.terminal.focusAccessibleBuffer',
	AccessibleBufferGoToNextCommand = 'workbench.action.terminal.accessibleBufferGoToNextCommand',
	AccessibleBufferGoToPreviousCommand = 'workbench.action.terminal.accessibleBufferGoToPreviousCommand',
	ScrollToBottomAccessibleView = 'workbench.action.terminal.scrollToBottomAccessibleView',
	ScrollToTopAccessibleView = 'workbench.action.terminal.scrollToTopAccessibleView',
}

export const defaultTerminalAccessibilityCommandsToSkipShell = [
	TerminalAccessibilityCommandId.FocusAccessibleBuffer
];
