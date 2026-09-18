/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// UIA control type -> ComputerUseAxNode.role.
//
// ONE VOCABULARY, AND WHERE IT COMES FROM. The macOS helper does not have a role table: it emits
// `Ax.normalizeName(rawRole)` — the raw AX role string with the "AX" prefix dropped and the leading
// capital run lower-cased (AxTree.swift, Accessibility.swift). So the vocabulary the model actually
// sees on macOS is exactly the set of AX role constants, and any word this file emits that is not one
// of them is a Windows-only dialect the model has to learn twice.
//
// The reconciliation below was therefore done against the AX role constants themselves, read out of
// AXRoleConstants.h in the macOS SDK, not from memory. What that check established:
//
//   - kAXIncrementorRole, kAXRowRole, kAXValueIndicatorRole, kAXTextAreaRole, kAXUnknownRole,
//     kAXGroupRole, kAXHelpTagRole, kAXSplitterRole and kAXGridRole all exist. So "incrementor",
//     "row", "valueIndicator", "textArea", "unknown", "group", "helpTag" and "splitter" are words
//     macOS really does emit.
//   - There is NO AXColumnHeader role. `kAXSortButtonSubrole` is a SUBROLE of AXButton, and the
//     darwin helper reads roles only, so a macOS column header arrives as "button".
//   - There is NO AXDocument, AXCalendar, AXSeparator, AXStatusBar, AXTitleBar or AXSplitButton role.
//
// THE RULE APPLIED, so the next person does not have to re-derive it:
//   1. If macOS emits a DIFFERENT WORD for the same concept, conform to macOS. That is a genuine
//      disagreement and the model pays for it.
//   2. If macOS has NO WORD for the concept — the platform simply has no such control — keep the
//      Windows word and mark it below as a Windows-only extension. There is nothing to disagree
//      with, and the two in-vocabulary alternatives are always either wrong (a decorative divider is
//      not a draggable "splitter") or information-destroying ("unknown").
//
// CHANGED UNDER RULE 1 (was -> is):
//   - UIA_SpinnerControlTypeId      stepper      -> incrementor    (kAXIncrementorRole)
//   - UIA_CustomControlTypeId       custom       -> unknown        (kAXUnknownRole; "the provider has
//                                                                   no better word" is a concept
//                                                                   macOS already names)
//   - UIA_DocumentControlTypeId     document     -> textArea       (kAXTextAreaRole. UIA defines
//                                                                   Document as a large text surface
//                                                                   supporting the Text pattern,
//                                                                   which is what AXTextArea means.
//                                                                   The editable/read-only
//                                                                   distinction the old comment
//                                                                   wanted to preserve is already in
//                                                                   `actions`: setValue is present
//                                                                   only when it is writable.)
//   - UIA_ThumbControlTypeId        thumb        -> valueIndicator (kAXValueIndicatorRole, the
//                                                                   scrollbar/slider thumb on macOS)
//   - UIA_HeaderControlTypeId       header       -> group          (macOS exposes a table's header
//                                                                   view as a plain AXGroup)
//   - UIA_HeaderItemControlTypeId   columnHeader -> button         (macOS emits AXButton with the
//                                                                   AXSortButton *subrole*, and the
//                                                                   darwin helper does not read
//                                                                   subroles. "button" is also
//                                                                   behaviourally honest: clicking a
//                                                                   column header sorts.)
//   - UIA_ToolTipControlTypeId      toolTip      -> helpTag        (kAXHelpTagRole. Apple jargon, but
//                                                                   it is the word the model will see
//                                                                   from macOS either way.)
//
// KEPT AS WINDOWS-ONLY EXTENSIONS UNDER RULE 2 (macOS has no equivalent concept at all):
//   - UIA_CalendarControlTypeId     calendar     — a month grid. The only date-ish AX role is
//                                                  kAXDateFieldRole, which means a text field you
//                                                  type a date into; telling the model to type into a
//                                                  CalendarView is worse than a new word.
//   - UIA_SeparatorControlTypeId    separator    — a decorative divider. macOS's "splitter" is the
//                                                  DRAGGABLE divider of an AXSplitGroup, so reusing
//                                                  it would invite the model to drag a painted line.
//   - UIA_StatusBarControlTypeId    statusBar
//   - UIA_TitleBarControlTypeId     titleBar     — macOS windows expose their buttons directly on
//                                                  AXWindow with no titlebar element.
//   - UIA_SplitButtonControlTypeId  splitButton  — kAXMenuButtonRole is a button that ONLY opens a
//                                                  menu; a split button has a primary action too.
//
// UNCHANGED AND ALREADY CONFORMING: button, checkBox, comboBox, image, list, menu, menuBar, menuItem,
// outline (AXOutline), progressIndicator, radioButton, row (TreeItem and DataItem both, matching
// macOS nesting AXRow inside AXOutline and AXTable), scrollBar, secureTextField, slider, staticText,
// table, tab/tabGroup, textField, toolbar (AppBar too), window, group (Pane and SemanticZoom both).
//
// DELIBERATELY NOT TOUCHED, and why:
//   - "listItem" is a Windows-only word, but macOS has no single answer for it either: an
//     NSTableView-backed list reports AXRow, a Finder icon view reports AXImage/AXStaticText, and a
//     popup's items report AXMenuItem. There is no conforming word to move to, so churning it would
//     trade one dialect word for a wrong one.
//   - "link" is not in AXRoleConstants.h, but WebKit and Chromium both emit AXLink on macOS, so
//     "link" IS in the vocabulary the model sees. Same for "heading" and "webArea".
//
// A password Edit reports "secureTextField", matching kAXSecureTextFieldSubrole's spelling, because a
// model must never be encouraged to read a password field back out.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - The numeric UIA_*ControlTypeId constants come from uiautomationclient.h; confirm every name
//     used below compiles.
//   - That real applications report the control types this mapping assumes. Chromium, WinUI, WPF
//     and Win32 all differ in how much they populate; the map has an explicit fallback rather than
//     an assertion for exactly that reason.
//
// NEEDS VERIFICATION ON macOS (cannot be checked from the Windows side at all, and each of these
// would change a line above):
//   - What a real macOS table column header emits. If the darwin helper is ever taught to read
//     AXSubrole, both helpers should emit "sortButton" and this file changes with it.
//   - What a graphical NSDatePicker emits. If it turns out to be a role rather than a group, the
//     "calendar" extension above should conform to it.
//   - Whether Chromium on macOS emits "webArea" where Chromium on Windows reports
//     UIA_DocumentControlTypeId. If so, Electron windows will read as textArea here and webArea
//     there, which is a residual disagreement this file cannot fix without sniffing FrameworkId.
//
#pragma once

#include "Common.h"

#include <uiautomation.h>

namespace v3cu {

/// Maps a UIA control type to a contract role. `isPassword` upgrades an Edit to secureTextField.
/// Unknown control types map to "unknown", never to an empty string: the role field is required.
const char* MapUiaControlTypeToRole(CONTROLTYPEID controlType, bool isPassword);

} // namespace v3cu
