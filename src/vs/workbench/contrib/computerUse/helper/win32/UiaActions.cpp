/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Pattern dispatch implementation. Read UiaActions.h for the dispatch order and its rationale.
// NEEDS VERIFICATION ON WINDOWS (full list in UiaActions.h):
//   - GetCurrentPatternAs returning S_OK with a null pointer for an unsupported pattern.
//   - Invoke against Chromium/Electron before accessibility is force-enabled there.
//   - LegacyIAccessible.DoDefaultAction against Win32 common controls.
//   - GetClickablePoint returning false for occluded elements.
//   - Whether ScrollPattern reporting failure at the end of its range is common enough that the
//     "succeeded after at least one step" rule below is right.
//
#include "UiaActions.h"

#include "Log.h"
#include "UiaRoles.h"

#include <cstdio>

#include <oleauto.h>

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

/// A BSTR that frees itself. UIA hands out BSTRs from every string property.
class ScopedBstr {
public:
	ScopedBstr() = default;
	~ScopedBstr() {
		if (value_ != nullptr) {
			::SysFreeString(value_);
		}
	}
	ScopedBstr(const ScopedBstr&) = delete;
	ScopedBstr& operator=(const ScopedBstr&) = delete;

	BSTR* Receive() { return &value_; }
	bool Empty() const { return value_ == nullptr || ::SysStringLen(value_) == 0; }
	std::string ToUtf8() const {
		if (value_ == nullptr) {
			return std::string();
		}
		return WideToUtf8(value_, static_cast<int>(::SysStringLen(value_)));
	}

private:
	BSTR value_ = nullptr;
};

/// Fetches a pattern, returning null when the element does not support it. GetCurrentPatternAs is
/// documented to succeed with a null pointer for an unsupported pattern, so both are checked.
template <typename Interface>
ComPtr<Interface> GetPattern(const ComPtr<IUIAutomationElement>& element, PATTERNID patternId) {
	ComPtr<Interface> pattern;
	if (!element) {
		return pattern;
	}
	const HRESULT hr = element->GetCurrentPatternAs(patternId, __uuidof(Interface),
		reinterpret_cast<void**>(pattern.GetAddressOf()));
	if (FAILED(hr)) {
		return ComPtr<Interface>();
	}
	return pattern;
}

/// The calling convention is spelled out because a COM method pointer is __stdcall; omitting it
/// breaks the x86 and arm32 builds even though x64 tolerates it.
using ElementBoolGetter = HRESULT (STDMETHODCALLTYPE IUIAutomationElement::*)(BOOL*);

bool ReadBoolProperty(const ComPtr<IUIAutomationElement>& element, ElementBoolGetter getter) {
	BOOL value = FALSE;
	if (!element || FAILED((element.Get()->*getter)(&value))) {
		return false;
	}
	return value != FALSE;
}

} // namespace

const char* DescribeToggleState(ToggleState state) {
	// "1"/"0"/"2" and NOT "on"/"off"/"mixed", which is what this returned before.
	//
	// The words were more legible, but they were not what the model sees from the other helper. The
	// macOS side has no toggle special case at all: a checkbox's AXValue is a CFNumber and
	// Ax.string turns it into its decimal spelling, so macOS emits "1" and "0". Two helpers spelling
	// the same checkbox two different ways is a worse problem than an unlovely value, because the
	// model cannot even tell that it is the same concept.
	//
	// Indeterminate is the one case where macOS is not self-consistent: AppKit's mixed state is -1
	// (NSControlStateValueMixed) while WebKit and Chromium report 2 for an ARIA mixed checkbox. 2 is
	// chosen here because web content is where mixed checkboxes overwhelmingly occur, and because
	// UIA's own ToggleState_Indeterminate is 2, so the number is not invented.
	//
	// If the team would rather have the legible words, the fix is on the DARWIN side — normalize its
	// checkbox value to on/off/mixed — and then this function flips back. It must not be flipped here
	// alone.
	switch (state) {
		case ToggleState_On: return "1";
		case ToggleState_Off: return "0";
		case ToggleState_Indeterminate: return "2";
	}
	return "0";
}

std::string ReadElementRuntimeId(const ComPtr<IUIAutomationElement>& element) {
	if (!element) {
		return std::string();
	}
	SAFEARRAY* array = nullptr;
	if (FAILED(element->GetRuntimeId(&array)) || array == nullptr) {
		return std::string();
	}
	const auto destroyGuard = MakeScopeExit([array]() { ::SafeArrayDestroy(array); });

	if (::SafeArrayGetDim(array) != 1) {
		return std::string();
	}
	LONG lower = 0;
	LONG upper = 0;
	if (FAILED(::SafeArrayGetLBound(array, 1, &lower)) ||
		FAILED(::SafeArrayGetUBound(array, 1, &upper))) {
		return std::string();
	}

	std::string out;
	for (LONG index = lower; index <= upper; ++index) {
		int part = 0;
		if (FAILED(::SafeArrayGetElement(array, &index, &part))) {
			return std::string();
		}
		if (!out.empty()) {
			out.push_back('-');
		}
		out += std::to_string(part);
	}
	return out;
}

std::string MakeElementFingerprint(const std::string& runtimeId, const std::string& role,
	const std::string& label) {
	if (runtimeId.empty()) {
		// No identity means no fingerprint. Returning something built from role and label alone would
		// make two identical buttons in a toolbar indistinguishable, which is precisely the mistake
		// that lets a ref resolve to the wrong element.
		return std::string();
	}
	// '\x1f' (unit separator) cannot occur in a UIA name, so no label can forge a field boundary.
	return runtimeId + "\x1f" + role + "\x1f" + label;
}

std::string ReadElementFingerprint(const ComPtr<IUIAutomationElement>& element) {
	if (!element) {
		return std::string();
	}
	CONTROLTYPEID controlType = 0;
	if (FAILED(element->get_CurrentControlType(&controlType))) {
		// The element is gone. An empty fingerprint here is indistinguishable from "unfingerprintable",
		// so callers must probe liveness separately rather than inferring death from this.
		return std::string();
	}
	BOOL isPassword = FALSE;
	element->get_CurrentIsPassword(&isPassword);

	ScopedBstr name;
	std::string label;
	if (SUCCEEDED(element->get_CurrentName(name.Receive())) && !name.Empty()) {
		label = name.ToUtf8();
	}

	return MakeElementFingerprint(ReadElementRuntimeId(element),
		MapUiaControlTypeToRole(controlType, isPassword != FALSE), label);
}

ElementPatterns ReadElementPatterns(const ComPtr<IUIAutomationElement>& element) {
	ElementPatterns patterns;
	if (!element) {
		return patterns;
	}

	patterns.invoke = GetPattern<IUIAutomationInvokePattern>(element, UIA_InvokePatternId) != nullptr;
	patterns.toggle = GetPattern<IUIAutomationTogglePattern>(element, UIA_TogglePatternId) != nullptr;
	patterns.selectionItem =
		GetPattern<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId) != nullptr;
	patterns.expandCollapse =
		GetPattern<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId) !=
		nullptr;
	patterns.rangeValue =
		GetPattern<IUIAutomationRangeValuePattern>(element, UIA_RangeValuePatternId) != nullptr;
	patterns.text = GetPattern<IUIAutomationTextPattern>(element, UIA_TextPatternId) != nullptr;
	patterns.legacyDefaultAction =
		GetPattern<IUIAutomationLegacyIAccessiblePattern>(element, UIA_LegacyIAccessiblePatternId) !=
		nullptr;

	const auto valuePattern = GetPattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
	if (valuePattern) {
		patterns.value = true;
		BOOL readOnly = TRUE;
		if (SUCCEEDED(valuePattern->get_CurrentIsReadOnly(&readOnly))) {
			patterns.valueReadOnly = readOnly != FALSE;
		}
	}

	const auto scrollPattern = GetPattern<IUIAutomationScrollPattern>(element, UIA_ScrollPatternId);
	if (scrollPattern) {
		BOOL horizontal = FALSE;
		BOOL vertical = FALSE;
		scrollPattern->get_CurrentHorizontallyScrollable(&horizontal);
		scrollPattern->get_CurrentVerticallyScrollable(&vertical);
		patterns.scroll = horizontal != FALSE || vertical != FALSE;
	}

	patterns.focusable = ReadBoolProperty(element, &IUIAutomationElement::get_CurrentIsKeyboardFocusable);
	return patterns;
}

std::vector<std::string> DescribeActions(const ElementPatterns& patterns) {
	// Stable order so a diff of two axTree snapshots is readable, and so the model sees a
	// consistent vocabulary. Names are verbs the model can act on.
	std::vector<std::string> actions;
	if (patterns.invoke || patterns.legacyDefaultAction) {
		actions.push_back("press");
	}
	if (patterns.toggle) {
		actions.push_back("toggle");
	}
	if (patterns.selectionItem) {
		actions.push_back("select");
	}
	if (patterns.expandCollapse) {
		actions.push_back("expand");
		actions.push_back("collapse");
	}
	if (patterns.value && !patterns.valueReadOnly) {
		actions.push_back("setValue");
	}
	if (patterns.rangeValue) {
		actions.push_back("increment");
		actions.push_back("decrement");
	}
	if (patterns.scroll) {
		actions.push_back("scroll");
	}
	if (patterns.focusable) {
		actions.push_back("focus");
	}
	return actions;
}

bool IsElementAlive(const ComPtr<IUIAutomationElement>& element) {
	if (!element) {
		return false;
	}
	// Any current-property read round-trips to the provider, so this is the cheapest liveness probe.
	// A destroyed element fails with UIA_E_ELEMENTNOTAVAILABLE.
	CONTROLTYPEID controlType = 0;
	return SUCCEEDED(element->get_CurrentControlType(&controlType));
}

bool GetElementFrame(const ComPtr<IUIAutomationElement>& element, Rect& out) {
	if (!element) {
		return false;
	}
	RECT bounds = {};
	if (FAILED(element->get_CurrentBoundingRectangle(&bounds))) {
		return false;
	}
	// UIA reports an empty rectangle for an off-screen element rather than failing.
	const Rect frame = RectFromWin32(bounds);
	if (frame.IsEmpty()) {
		return false;
	}
	out = frame;
	return true;
}

bool GetElementPoint(const ComPtr<IUIAutomationElement>& element, POINT& out) {
	if (!element) {
		return false;
	}

	// GetClickablePoint knows about occlusion and about controls whose centre is not clickable
	// (a tall list item with a narrow hit area, for example), so it is preferred.
	POINT clickable = {};
	BOOL gotClickable = FALSE;
	if (SUCCEEDED(element->GetClickablePoint(&clickable, &gotClickable)) && gotClickable != FALSE) {
		out = clickable;
		return true;
	}

	Rect frame;
	if (!GetElementFrame(element, frame)) {
		return false;
	}
	out.x = frame.x + frame.width / 2;
	out.y = frame.y + frame.height / 2;
	return true;
}

bool TryPatternClick(const ComPtr<IUIAutomationElement>& element, std::string& error) {
	if (!element) {
		return false;
	}

	if (const auto invoke = GetPattern<IUIAutomationInvokePattern>(element, UIA_InvokePatternId)) {
		const HRESULT hr = invoke->Invoke();
		if (SUCCEEDED(hr)) {
			return true;
		}
		error = "Invoke failed (" + FormatHResult(hr) + ")";
		LogWarn("uia: " + error);
		return false;
	}

	if (const auto toggle = GetPattern<IUIAutomationTogglePattern>(element, UIA_TogglePatternId)) {
		const HRESULT hr = toggle->Toggle();
		if (SUCCEEDED(hr)) {
			return true;
		}
		error = "Toggle failed (" + FormatHResult(hr) + ")";
		LogWarn("uia: " + error);
		return false;
	}

	if (const auto selectionItem =
			GetPattern<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId)) {
		const HRESULT hr = selectionItem->Select();
		if (SUCCEEDED(hr)) {
			return true;
		}
		error = "Select failed (" + FormatHResult(hr) + ")";
		LogWarn("uia: " + error);
		return false;
	}

	if (const auto expandCollapse =
			GetPattern<IUIAutomationExpandCollapsePattern>(element, UIA_ExpandCollapsePatternId)) {
		// A click on a collapsible thing means "flip it", so read the state first rather than
		// always expanding.
		ExpandCollapseState state = ExpandCollapseState_LeafNode;
		HRESULT hr = expandCollapse->get_CurrentExpandCollapseState(&state);
		if (SUCCEEDED(hr)) {
			hr = state == ExpandCollapseState_Expanded ? expandCollapse->Collapse()
													   : expandCollapse->Expand();
			if (SUCCEEDED(hr)) {
				return true;
			}
		}
		error = "Expand/Collapse failed (" + FormatHResult(hr) + ")";
		LogWarn("uia: " + error);
		return false;
	}

	if (const auto legacy = GetPattern<IUIAutomationLegacyIAccessiblePattern>(
			element, UIA_LegacyIAccessiblePatternId)) {
		// The MSAA bridge. Only useful when the element actually advertises a default action;
		// calling DoDefaultAction on something with none returns a failure we would rather treat as
		// "no pattern" so the caller can synthesize.
		ScopedBstr defaultAction;
		if (SUCCEEDED(legacy->get_CurrentDefaultAction(defaultAction.Receive())) &&
			!defaultAction.Empty()) {
			const HRESULT hr = legacy->DoDefaultAction();
			if (SUCCEEDED(hr)) {
				return true;
			}
			LogDebug("uia: DoDefaultAction failed (" + FormatHResult(hr) +
				"); falling back to synthesized input");
		}
	}

	// No usable pattern. Not an error — the caller synthesizes and reports "synthesized".
	return false;
}

bool TryPatternSetValue(const ComPtr<IUIAutomationElement>& element, const std::string& text,
	std::string& error) {
	const auto valuePattern = GetPattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
	if (!valuePattern) {
		return false;
	}
	BOOL readOnly = TRUE;
	if (FAILED(valuePattern->get_CurrentIsReadOnly(&readOnly)) || readOnly != FALSE) {
		return false;
	}

	const std::wstring wide = Utf8ToWide(text);
	BSTR value = ::SysAllocStringLen(wide.c_str(), static_cast<UINT>(wide.size()));
	if (value == nullptr) {
		error = "SysAllocStringLen failed";
		return false;
	}
	const auto freeGuard = MakeScopeExit([value]() { ::SysFreeString(value); });

	const HRESULT hr = valuePattern->SetValue(value);
	if (FAILED(hr)) {
		error = "SetValue failed (" + FormatHResult(hr) + ")";
		LogWarn("uia: " + error);
		return false;
	}
	return true;
}

bool TryPatternScroll(const ComPtr<IUIAutomationElement>& element, ScrollDirection direction,
	int amount, std::string& error) {
	const auto scrollPattern = GetPattern<IUIAutomationScrollPattern>(element, UIA_ScrollPatternId);
	if (!scrollPattern) {
		return false;
	}

	const bool horizontal =
		direction == ScrollDirection::Left || direction == ScrollDirection::Right;
	BOOL scrollable = FALSE;
	const HRESULT queryResult = horizontal
		? scrollPattern->get_CurrentHorizontallyScrollable(&scrollable)
		: scrollPattern->get_CurrentVerticallyScrollable(&scrollable);
	if (FAILED(queryResult) || scrollable == FALSE) {
		return false;
	}

	// ScrollPattern has no "by N pixels": it scrolls by increments. One protocol tick maps to one
	// small increment, repeated, which is the closest analogue to a wheel notch.
	const ScrollAmount noAmount = ScrollAmount_NoAmount;
	ScrollAmount step = ScrollAmount_SmallIncrement;
	if (direction == ScrollDirection::Up || direction == ScrollDirection::Left) {
		step = ScrollAmount_SmallDecrement;
	}

	const int notches = Clamp(amount, 1, 100);
	for (int index = 0; index < notches; ++index) {
		const HRESULT hr = horizontal ? scrollPattern->Scroll(step, noAmount)
									  : scrollPattern->Scroll(noAmount, step);
		if (FAILED(hr)) {
			// Reaching the end of the scrollable range is reported as a failure by some providers.
			// Treat a failure after at least one successful step as success rather than an error.
			if (index > 0) {
				LogDebug("uia: Scroll stopped after " + std::to_string(index) + " steps (" +
					FormatHResult(hr) + ")");
				return true;
			}
			error = "Scroll failed (" + FormatHResult(hr) + ")";
			return false;
		}
	}
	return true;
}

bool TryFocusElement(const ComPtr<IUIAutomationElement>& element) {
	if (!element) {
		return false;
	}
	const HRESULT hr = element->SetFocus();
	if (FAILED(hr)) {
		LogDebug("uia: SetFocus failed (" + FormatHResult(hr) + ")");
		return false;
	}
	return true;
}

bool ReadElementValue(const ComPtr<IUIAutomationElement>& element, const ElementPatterns& patterns,
	std::string& out) {
	if (!element) {
		return false;
	}

	if (patterns.value) {
		const auto valuePattern = GetPattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
		if (valuePattern) {
			ScopedBstr value;
			if (SUCCEEDED(valuePattern->get_CurrentValue(value.Receive())) && !value.Empty()) {
				out = value.ToUtf8();
				return true;
			}
		}
	}

	if (patterns.toggle) {
		const auto togglePattern =
			GetPattern<IUIAutomationTogglePattern>(element, UIA_TogglePatternId);
		if (togglePattern) {
			ToggleState state = ToggleState_Off;
			if (SUCCEEDED(togglePattern->get_CurrentToggleState(&state))) {
				out = DescribeToggleState(state);
				return true;
			}
		}
	}

	if (patterns.rangeValue) {
		const auto rangePattern =
			GetPattern<IUIAutomationRangeValuePattern>(element, UIA_RangeValuePatternId);
		if (rangePattern) {
			double value = 0.0;
			if (SUCCEEDED(rangePattern->get_CurrentValue(&value))) {
				char buffer[64] = {};
				::_snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "%.10g", value);
				out = buffer;
				return true;
			}
		}
	}

	return false;
}

} // namespace v3cu
