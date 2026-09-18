/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Cache-request implementation. Read AxCache.h first: the reason this exists, the reason it is
// per-level rather than per-subtree, and the full verification list are all there.
//
// NEEDS VERIFICATION ON WINDOWS (full list in AxCache.h):
//   - That children's properties really are populated by a TreeScope_Element | TreeScope_Children
//     request. Everything here is pointless if they are not.
//   - That the cache path and the live path produce byte-identical JSON for the same window.
//   - That every UIA_*PropertyId name in kCachedProperties compiles against the SDK in use.
//
#include "AxCache.h"

#include "Log.h"

#include <cstdio>

#include <oleauto.h>

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

/// Every property the walk reads. Anything missing from this list silently falls back to a live read,
/// so the list and ReadFactsFromCache must be kept in step.
const PROPERTYID kCachedProperties[] = {
	UIA_ControlTypePropertyId,
	UIA_NamePropertyId,
	UIA_IsPasswordPropertyId,
	UIA_IsEnabledPropertyId,
	UIA_HasKeyboardFocusPropertyId,
	UIA_IsKeyboardFocusablePropertyId,
	UIA_BoundingRectanglePropertyId,
	UIA_RuntimeIdPropertyId,
	// Pattern availability, which is what `actions` is built from.
	UIA_IsInvokePatternAvailablePropertyId,
	UIA_IsTogglePatternAvailablePropertyId,
	UIA_IsSelectionItemPatternAvailablePropertyId,
	UIA_IsExpandCollapsePatternAvailablePropertyId,
	UIA_IsValuePatternAvailablePropertyId,
	UIA_IsRangeValuePatternAvailablePropertyId,
	UIA_IsScrollPatternAvailablePropertyId,
	UIA_IsTextPatternAvailablePropertyId,
	UIA_IsLegacyIAccessiblePatternAvailablePropertyId,
	// Values.
	UIA_ValueValuePropertyId,
	UIA_ValueIsReadOnlyPropertyId,
	UIA_ToggleToggleStatePropertyId,
	UIA_RangeValueValuePropertyId,
	UIA_ScrollHorizontallyScrollablePropertyId,
	UIA_ScrollVerticallyScrollablePropertyId,
};

/// A VARIANT that clears itself. Every GetCachedPropertyValue hands one out and every one of them
/// leaks a BSTR or a SAFEARRAY if it is not cleared.
class ScopedVariant {
public:
	ScopedVariant() { ::VariantInit(&value_); }
	~ScopedVariant() { ::VariantClear(&value_); }
	ScopedVariant(const ScopedVariant&) = delete;
	ScopedVariant& operator=(const ScopedVariant&) = delete;

	VARIANT* Receive() { return &value_; }
	const VARIANT& Get() const { return value_; }

private:
	VARIANT value_ = {};
};

/// Frees the BSTR it holds. Third copy of this in the helper, and deliberately so: the alternative is
/// a header for one nine-line class shared by three files that are otherwise independent.
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

bool VariantBool(const VARIANT& variant, bool& out) {
	if (variant.vt != VT_BOOL) {
		return false;
	}
	out = variant.boolVal != VARIANT_FALSE;
	return true;
}

bool VariantInt(const VARIANT& variant, int& out) {
	if (variant.vt == VT_I4) {
		out = static_cast<int>(variant.lVal);
		return true;
	}
	if (variant.vt == VT_INT) {
		out = variant.intVal;
		return true;
	}
	return false;
}

bool VariantDouble(const VARIANT& variant, double& out) {
	if (variant.vt == VT_R8) {
		out = variant.dblVal;
		return true;
	}
	if (variant.vt == VT_R4) {
		out = static_cast<double>(variant.fltVal);
		return true;
	}
	return false;
}

bool VariantString(const VARIANT& variant, std::string& out) {
	if (variant.vt != VT_BSTR || variant.bstrVal == nullptr) {
		return false;
	}
	out = WideToUtf8(variant.bstrVal, static_cast<int>(::SysStringLen(variant.bstrVal)));
	return true;
}

/// A runtime id arrives as a SAFEARRAY of int32. Formatted the same way ReadElementRuntimeId formats a
/// live one, because the two must produce identical fingerprints for the same element.
bool VariantRuntimeId(const VARIANT& variant, std::string& out) {
	if ((variant.vt & VT_ARRAY) == 0 || variant.parray == nullptr) {
		return false;
	}
	SAFEARRAY* array = variant.parray;
	if (::SafeArrayGetDim(array) != 1) {
		return false;
	}
	LONG lower = 0;
	LONG upper = 0;
	if (FAILED(::SafeArrayGetLBound(array, 1, &lower)) ||
		FAILED(::SafeArrayGetUBound(array, 1, &upper))) {
		return false;
	}
	std::string formatted;
	for (LONG index = lower; index <= upper; ++index) {
		int part = 0;
		if (FAILED(::SafeArrayGetElement(array, &index, &part))) {
			return false;
		}
		if (!formatted.empty()) {
			formatted.push_back('-');
		}
		formatted += std::to_string(part);
	}
	out = formatted;
	return true;
}

bool CachedBool(const ComPtr<IUIAutomationElement>& element, PROPERTYID property, bool& out) {
	ScopedVariant variant;
	if (FAILED(element->GetCachedPropertyValue(property, variant.Receive()))) {
		return false;
	}
	return VariantBool(variant.Get(), out);
}

/// Reads a boolean cached property, defaulting to false. Used for pattern availability, where "could
/// not be read" and "not supported" mean the same thing to the caller.
bool CachedFlag(const ComPtr<IUIAutomationElement>& element, PROPERTYID property) {
	bool value = false;
	return CachedBool(element, property, value) && value;
}

std::string FormatRangeValue(double value) {
	char buffer[64] = {};
	::_snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "%.10g", value);
	return buffer;
}

/// The value precedence, shared by both readers so they cannot disagree: a writable or readable Value
/// pattern wins, then a toggle state, then a range value.
void ReadCachedValue(const ComPtr<IUIAutomationElement>& element, ElementFacts& facts) {
	if (facts.patterns.value) {
		ScopedVariant variant;
		std::string text;
		if (SUCCEEDED(element->GetCachedPropertyValue(UIA_ValueValuePropertyId, variant.Receive())) &&
			VariantString(variant.Get(), text) && !text.empty()) {
			facts.value = text;
			facts.hasValue = true;
			return;
		}
	}
	if (facts.patterns.toggle) {
		ScopedVariant variant;
		int state = 0;
		if (SUCCEEDED(
				element->GetCachedPropertyValue(UIA_ToggleToggleStatePropertyId, variant.Receive())) &&
			VariantInt(variant.Get(), state)) {
			facts.value = DescribeToggleState(static_cast<ToggleState>(state));
			facts.hasValue = true;
			return;
		}
	}
	if (facts.patterns.rangeValue) {
		ScopedVariant variant;
		double value = 0.0;
		if (SUCCEEDED(
				element->GetCachedPropertyValue(UIA_RangeValueValuePropertyId, variant.Receive())) &&
			VariantDouble(variant.Get(), value)) {
			facts.value = FormatRangeValue(value);
			facts.hasValue = true;
		}
	}
}

void ReadCachedPatterns(const ComPtr<IUIAutomationElement>& element, ElementFacts& facts) {
	ElementPatterns patterns;
	patterns.invoke = CachedFlag(element, UIA_IsInvokePatternAvailablePropertyId);
	patterns.toggle = CachedFlag(element, UIA_IsTogglePatternAvailablePropertyId);
	patterns.selectionItem = CachedFlag(element, UIA_IsSelectionItemPatternAvailablePropertyId);
	patterns.expandCollapse = CachedFlag(element, UIA_IsExpandCollapsePatternAvailablePropertyId);
	patterns.rangeValue = CachedFlag(element, UIA_IsRangeValuePatternAvailablePropertyId);
	patterns.text = CachedFlag(element, UIA_IsTextPatternAvailablePropertyId);
	patterns.legacyDefaultAction =
		CachedFlag(element, UIA_IsLegacyIAccessiblePatternAvailablePropertyId);
	patterns.value = CachedFlag(element, UIA_IsValuePatternAvailablePropertyId);
	if (patterns.value) {
		bool readOnly = true;
		if (CachedBool(element, UIA_ValueIsReadOnlyPropertyId, readOnly)) {
			patterns.valueReadOnly = readOnly;
		}
	}
	if (CachedFlag(element, UIA_IsScrollPatternAvailablePropertyId)) {
		patterns.scroll = CachedFlag(element, UIA_ScrollHorizontallyScrollablePropertyId) ||
			CachedFlag(element, UIA_ScrollVerticallyScrollablePropertyId);
	}
	bool focusable = false;
	if (CachedBool(element, UIA_IsKeyboardFocusablePropertyId, focusable)) {
		patterns.focusable = focusable;
	}
	facts.patterns = patterns;
}

} // namespace

bool AxCacheRequest::Initialize(IUIAutomation* automation, std::string& error) {
	if (request_) {
		return true;
	}
	if (automation == nullptr) {
		error = "no UI Automation client";
		return false;
	}

	ComPtr<IUIAutomationCacheRequest> request;
	HRESULT hr = automation->CreateCacheRequest(&request);
	if (FAILED(hr) || !request) {
		error = "CreateCacheRequest failed (" + FormatHResult(hr) + ")";
		return false;
	}

	// Full, not None: the walk mints refs from these elements and a ref must stay actionable. See
	// AxCache.h.
	hr = request->put_AutomationElementMode(AutomationElementMode_Full);
	if (FAILED(hr)) {
		error = "put_AutomationElementMode failed (" + FormatHResult(hr) + ")";
		return false;
	}

	hr = request->put_TreeScope(static_cast<TreeScope>(TreeScope_Element | TreeScope_Children));
	if (FAILED(hr)) {
		error = "put_TreeScope failed (" + FormatHResult(hr) + ")";
		return false;
	}

	// The same view the live path's ControlViewWalker uses. If these two ever disagree, the same window
	// yields a different tree depending on which path served it.
	ComPtr<IUIAutomationCondition> controlView;
	if (SUCCEEDED(automation->get_ControlViewCondition(&controlView)) && controlView) {
		if (FAILED(request->put_TreeFilter(controlView.Get()))) {
			error = "put_TreeFilter failed";
			return false;
		}
	} else {
		error = "get_ControlViewCondition failed";
		return false;
	}

	for (const PROPERTYID property : kCachedProperties) {
		const HRESULT added = request->AddProperty(property);
		if (FAILED(added)) {
			// One unsupported property must not cost the whole optimisation, but it does mean the
			// corresponding read will fail and fall back, so it is worth a line in the log.
			LogDebug("cache request rejected property " + std::to_string(static_cast<long>(property)) +
				" (" + FormatHResult(added) + ")");
		}
	}

	request_ = request;
	return true;
}

bool BuildCachedNode(const ComPtr<IUIAutomationElement>& element,
	IUIAutomationCacheRequest* request, ComPtr<IUIAutomationElement>& out) {
	if (!element || request == nullptr) {
		return false;
	}
	ComPtr<IUIAutomationElement> updated;
	const HRESULT hr = element->BuildUpdatedCache(request, &updated);
	if (FAILED(hr) || !updated) {
		LogDebug("BuildUpdatedCache failed (" + FormatHResult(hr) + "); using live property reads");
		return false;
	}
	out = updated;
	return true;
}

void ReadCachedChildren(const ComPtr<IUIAutomationElement>& element,
	std::vector<ComPtr<IUIAutomationElement>>& out) {
	out.clear();
	if (!element) {
		return;
	}
	ComPtr<IUIAutomationElementArray> children;
	// A null array is the documented answer for "no children cached", which is also the answer for a
	// leaf node. Treating it as an error would log once per leaf.
	if (FAILED(element->GetCachedChildren(&children)) || !children) {
		return;
	}
	int length = 0;
	if (FAILED(children->get_Length(&length)) || length <= 0) {
		return;
	}
	out.reserve(static_cast<size_t>(length));
	for (int index = 0; index < length; ++index) {
		ComPtr<IUIAutomationElement> child;
		if (SUCCEEDED(children->GetElement(index, &child)) && child) {
			out.push_back(child);
		}
	}
}

ElementFacts ReadFactsFromCache(const ComPtr<IUIAutomationElement>& element) {
	ElementFacts facts;
	if (!element) {
		return facts;
	}

	CONTROLTYPEID controlType = 0;
	if (FAILED(element->get_CachedControlType(&controlType))) {
		// Not in the cache. The caller falls back to a live read rather than emitting a node with a
		// guessed role.
		return facts;
	}
	facts.controlType = controlType;

	BOOL flag = FALSE;
	if (SUCCEEDED(element->get_CachedIsPassword(&flag))) {
		facts.isPassword = flag != FALSE;
	}
	flag = TRUE;
	if (SUCCEEDED(element->get_CachedIsEnabled(&flag))) {
		facts.enabled = flag != FALSE;
	}
	flag = FALSE;
	if (SUCCEEDED(element->get_CachedHasKeyboardFocus(&flag))) {
		facts.focused = flag != FALSE;
	}

	ScopedBstr name;
	if (SUCCEEDED(element->get_CachedName(name.Receive())) && !name.Empty()) {
		facts.label = name.ToUtf8();
		facts.hasLabel = true;
	}

	RECT bounds = {};
	if (SUCCEEDED(element->get_CachedBoundingRectangle(&bounds))) {
		const Rect frame = RectFromWin32(bounds);
		if (!frame.IsEmpty()) {
			facts.frame = frame;
			facts.hasFrame = true;
		}
	}

	ScopedVariant runtimeId;
	std::string formatted;
	if (SUCCEEDED(element->GetCachedPropertyValue(UIA_RuntimeIdPropertyId, runtimeId.Receive())) &&
		VariantRuntimeId(runtimeId.Get(), formatted)) {
		facts.runtimeId = formatted;
	} else {
		// One live call rather than no fingerprint at all: without a runtime id the ref cannot be stable,
		// and an unstable ref is the failure this whole tier is built to avoid.
		facts.runtimeId = ReadElementRuntimeId(element);
	}

	ReadCachedPatterns(element, facts);
	// A password field's value is never read back: the model has no legitimate use for it and a
	// transcript containing it is a leak. Suppressed here, in the reader, so no caller can forget.
	if (!facts.isPassword) {
		ReadCachedValue(element, facts);
	}

	facts.ok = true;
	return facts;
}

ElementFacts ReadFactsLive(const ComPtr<IUIAutomationElement>& element) {
	ElementFacts facts;
	if (!element) {
		return facts;
	}

	CONTROLTYPEID controlType = 0;
	if (FAILED(element->get_CurrentControlType(&controlType))) {
		// The element went away mid-walk.
		return facts;
	}
	facts.controlType = controlType;

	BOOL isPassword = FALSE;
	element->get_CurrentIsPassword(&isPassword);
	facts.isPassword = isPassword != FALSE;

	BOOL enabled = TRUE;
	if (SUCCEEDED(element->get_CurrentIsEnabled(&enabled))) {
		facts.enabled = enabled != FALSE;
	}
	BOOL focused = FALSE;
	if (SUCCEEDED(element->get_CurrentHasKeyboardFocus(&focused))) {
		facts.focused = focused != FALSE;
	}

	ScopedBstr name;
	if (SUCCEEDED(element->get_CurrentName(name.Receive())) && !name.Empty()) {
		facts.label = name.ToUtf8();
		facts.hasLabel = true;
	}

	Rect frame;
	if (GetElementFrame(element, frame)) {
		facts.frame = frame;
		facts.hasFrame = true;
	}

	facts.runtimeId = ReadElementRuntimeId(element);
	facts.patterns = ReadElementPatterns(element);
	if (!facts.isPassword) {
		std::string value;
		if (ReadElementValue(element, facts.patterns, value)) {
			facts.value = value;
			facts.hasValue = true;
		}
	}

	facts.ok = true;
	return facts;
}

} // namespace v3cu
