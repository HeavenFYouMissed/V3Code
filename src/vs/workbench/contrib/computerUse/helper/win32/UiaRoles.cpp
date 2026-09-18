/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Role mapping table. The rationale, the reconciliation rule, and every word that changed are in
// UiaRoles.h. Do not edit a mapping here without editing the list there.
// NEEDS VERIFICATION ON WINDOWS (full list in UiaRoles.h):
//   - That every UIA_*ControlTypeId name below compiles against the SDK in use.
//   - That real apps (Win32, WPF, WinUI, Chromium) report the control types assumed here.
//   - Specifically that Chromium reports UIA_DocumentControlTypeId for a web root, which is now
//     mapped to "textArea"; if it reports something else the mapping note in UiaRoles.h is wrong.
//
#include "UiaRoles.h"

#include "Log.h"

namespace v3cu {

const char* MapUiaControlTypeToRole(CONTROLTYPEID controlType, bool isPassword) {
	if (controlType == UIA_EditControlTypeId) {
		return isPassword ? "secureTextField" : "textField";
	}

	switch (controlType) {
		case UIA_ButtonControlTypeId: return "button";
		// Windows-only extension: macOS has no calendar role. See UiaRoles.h, rule 2.
		case UIA_CalendarControlTypeId: return "calendar";
		case UIA_CheckBoxControlTypeId: return "checkBox";
		case UIA_ComboBoxControlTypeId: return "comboBox";
		case UIA_HyperlinkControlTypeId: return "link";
		case UIA_ImageControlTypeId: return "image";
		case UIA_ListItemControlTypeId: return "listItem";
		case UIA_ListControlTypeId: return "list";
		case UIA_MenuControlTypeId: return "menu";
		case UIA_MenuBarControlTypeId: return "menuBar";
		case UIA_MenuItemControlTypeId: return "menuItem";
		case UIA_ProgressBarControlTypeId: return "progressIndicator";
		case UIA_RadioButtonControlTypeId: return "radioButton";
		case UIA_ScrollBarControlTypeId: return "scrollBar";
		case UIA_SliderControlTypeId: return "slider";
		// kAXIncrementorRole. Was "stepper", which macOS never emits.
		case UIA_SpinnerControlTypeId: return "incrementor";
		// Windows-only extension.
		case UIA_StatusBarControlTypeId: return "statusBar";
		case UIA_TabControlTypeId: return "tabGroup";
		case UIA_TabItemControlTypeId: return "tab";
		case UIA_TextControlTypeId: return "staticText";
		case UIA_ToolBarControlTypeId: return "toolbar";
		// kAXHelpTagRole. Was "toolTip".
		case UIA_ToolTipControlTypeId: return "helpTag";
		case UIA_TreeControlTypeId: return "outline";
		case UIA_TreeItemControlTypeId: return "row";
		// kAXUnknownRole. Was "custom"; macOS says "unknown" for the same thing.
		case UIA_CustomControlTypeId: return "unknown";
		case UIA_GroupControlTypeId: return "group";
		// kAXValueIndicatorRole. Was "thumb". A WPF GridSplitter also reports Thumb and will read as
		// valueIndicator, which is wrong for that case and cannot be told apart without inspecting the
		// parent; flagged rather than guessed.
		case UIA_ThumbControlTypeId: return "valueIndicator";
		case UIA_DataGridControlTypeId: return "table";
		case UIA_DataItemControlTypeId: return "row";
		// kAXTextAreaRole. Was "document".
		case UIA_DocumentControlTypeId: return "textArea";
		// Windows-only extension.
		case UIA_SplitButtonControlTypeId: return "splitButton";
		case UIA_WindowControlTypeId: return "window";
		case UIA_PaneControlTypeId: return "group";
		// macOS exposes a header VIEW as a plain group and each header ITEM as a button.
		case UIA_HeaderControlTypeId: return "group";
		case UIA_HeaderItemControlTypeId: return "button";
		case UIA_TableControlTypeId: return "table";
		// Windows-only extensions.
		case UIA_TitleBarControlTypeId: return "titleBar";
		case UIA_SeparatorControlTypeId: return "separator";
		case UIA_SemanticZoomControlTypeId: return "group";
		case UIA_AppBarControlTypeId: return "toolbar";
		default:
			// A provider that reports an unrecognised control type is a provider bug, but the role
			// field is required, so emit "unknown" rather than an empty string and log it once at
			// debug level so it can be chased down without spamming.
			LogDebug("unmapped UIA control type " + std::to_string(static_cast<long>(controlType)));
			return "unknown";
	}
}

} // namespace v3cu
