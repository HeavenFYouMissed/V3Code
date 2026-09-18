/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Pattern-based dispatch: the PRIMARY path for click, type and scroll.
//
// A UIA pattern expresses what an element does, not where it is. Invoking a button through
// IUIAutomationInvokePattern hits that button whatever has moved, scrolled or resized since the
// screenshot was taken, and works when the element is partly occluded. Clicking its coordinates
// does not. So the dispatch order for a plain left click is:
//
//   1. Invoke          — buttons, menu items, links, split buttons
//   2. Toggle          — checkboxes, toggle buttons
//   3. SelectionItem   — list items, tabs, radio buttons, tree items
//   4. ExpandCollapse  — combo boxes, tree items, disclosure controls
//   5. LegacyIAccessible.DoDefaultAction — the MSAA bridge, which covers a surprising amount of
//                        older Win32 UI that exposes no modern pattern
//   6. give up, and let the caller fall back to SendInput
//
// Steps 1-5 report method "accessibility". Only step 6 reports "synthesized".
//
// A click that is not a plain single left click — any modifier, a right or middle button, a
// double-click — skips patterns entirely. Patterns cannot express "shift-click" or "double-click";
// pretending otherwise would silently perform a different action from the one requested, which is
// worse than a coordinate click.
//
// NEEDS VERIFICATION ON WINDOWS — the entire file, and specifically:
//   - GetCurrentPatternAs returning S_OK with a null pointer for an unsupported pattern. Every call
//     site null-checks; confirm that is the actual behaviour rather than a failure HRESULT.
//   - Whether Invoke on a Chromium/Electron element works before accessibility is force-enabled in
//     that process. Chromium builds its UIA tree lazily; the first axTree read may be what turns it
//     on, in which case the first action against a fresh Electron window may need a retry.
//   - LegacyIAccessible.DoDefaultAction against Win32 common controls.
//   - IsElementAlive: the intent is that a destroyed element reports UIA_E_ELEMENTNOTAVAILABLE.
//   - GetClickablePoint returning false for an occluded or off-screen element, which is the case
//     the frame-centre fallback exists for.
//
#pragma once

#include "Common.h"
#include "SynthesizedInput.h"

#include <string>
#include <vector>

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {

/// Which patterns an element exposes. Used both for dispatch and to build ComputerUseAxNode.actions.
struct ElementPatterns {
	bool invoke = false;
	bool toggle = false;
	bool selectionItem = false;
	bool expandCollapse = false;
	bool value = false;
	bool valueReadOnly = false;
	bool rangeValue = false;
	bool scroll = false;
	bool text = false;
	bool legacyDefaultAction = false;
	/// True when the element can take keyboard focus.
	bool focusable = false;
};

/// The wire spelling of a toggle state for ComputerUseAxNode.value. Read the long note in
/// UiaActions.cpp before changing it: the spelling is dictated by what the macOS helper emits, not by
/// what reads best.
const char* DescribeToggleState(ToggleState state);

/// The element's UIA runtime id, formatted as "42-131362", or an empty string when the provider does
/// not supply one. This is UIA's own element identity and is what makes a protocol-2 ref stable.
std::string ReadElementRuntimeId(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element);

/// Formats the identity a ref is bound to: runtime id, role and label. Returns an empty string when
/// `runtimeId` is empty, which means "this element cannot be fingerprinted" — see RefTable.h for what
/// that costs.
std::string MakeElementFingerprint(const std::string& runtimeId, const std::string& role,
	const std::string& label);

/// Reads an element's fingerprint with live property calls. Used by RefTable::Resolve to re-check,
/// immediately before dispatch, that the element behind a ref still is what the caller was shown.
/// Returns an empty string for a dead element and for an unfingerprintable one alike; callers that
/// need to tell those apart must also call IsElementAlive.
std::string ReadElementFingerprint(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element);

/// Reads the pattern set. Never fails hard: an unreadable property is reported as absent.
ElementPatterns ReadElementPatterns(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element);

/// The `actions` array for ComputerUseAxNode, in a stable order.
std::vector<std::string> DescribeActions(const ElementPatterns& patterns);

/// True when the element still resolves. A destroyed element must not be acted on.
bool IsElementAlive(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element);

/// The element's screen bounds in physical pixels. Returns false when UIA reports no rectangle.
bool GetElementFrame(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element, Rect& out);

/// The best point to click: the element's clickable point when UIA offers one, otherwise the centre
/// of its bounding rectangle. Physical screen pixels.
bool GetElementPoint(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element, POINT& out);

/// Attempts a plain left click through a pattern. Returns true when a pattern handled it. Returns
/// false when no pattern applies (the caller then synthesizes) or when a pattern was tried and
/// failed, in which case `error` is set.
bool TryPatternClick(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element,
	std::string& error);

/// Attempts to set an element's value through ValuePattern. Returns false when the element has no
/// writable Value pattern.
bool TryPatternSetValue(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element,
	const std::string& text, std::string& error);

/// Attempts to scroll an element through ScrollPattern. Returns false when the element is not
/// scrollable in the requested axis.
bool TryPatternScroll(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element,
	ScrollDirection direction, int amount, std::string& error);

/// Best-effort focus, used before synthesized typing so the keystrokes land in the right place.
bool TryFocusElement(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element);

/// The element's current value string, for ComputerUseAxNode.value. Returns false when the element
/// carries no value.
bool ReadElementValue(const Microsoft::WRL::ComPtr<IUIAutomationElement>& element,
	const ElementPatterns& patterns, std::string& out);

} // namespace v3cu
