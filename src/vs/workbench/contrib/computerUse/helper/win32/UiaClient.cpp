/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// UIA client implementation. See UiaClient.h.
// NEEDS VERIFICATION ON WINDOWS (full list in UiaClient.h):
//   - CLSID_CUIAutomation8 availability and the IUIAutomation2 timeout setters taking effect.
//   - UIA working from an MTA thread with no event handlers registered.
//   - Behaviour against an elevated window: a typed error, never a crash.
//
#include "UiaClient.h"

#include "Log.h"

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

/// Budgets for IUIAutomation2. A hung application must not hang the helper.
constexpr int kConnectionTimeoutMs = 1000;
constexpr int kTransactionTimeoutMs = 3000;

} // namespace

ComApartment::ComApartment() {
	const HRESULT hr = ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
	if (hr == RPC_E_CHANGED_MODE) {
		// Another apartment type is already set for this thread. Do not uninitialize what we did
		// not initialize.
		LogWarn("thread already has a COM apartment of a different type");
		ok_ = false;
		shouldUninitialize_ = false;
		return;
	}
	ok_ = SUCCEEDED(hr);
	shouldUninitialize_ = ok_;
	if (!ok_) {
		LogError("CoInitializeEx failed (" + FormatHResult(hr) + ")");
	}
}

ComApartment::~ComApartment() {
	if (shouldUninitialize_) {
		::CoUninitialize();
	}
}

UiaClient& UiaClient::Instance() {
	static UiaClient client;
	return client;
}

bool UiaClient::Initialize(std::string& error) {
	if (automation_) {
		return true;
	}

	// CUIAutomation8 first, for the timeout setters.
	ComPtr<IUIAutomation> automation;
	HRESULT hr = ::CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER,
		IID_PPV_ARGS(&automation));
	if (SUCCEEDED(hr) && automation) {
		ComPtr<IUIAutomation2> automation2;
		if (SUCCEEDED(automation.As(&automation2)) && automation2) {
			if (FAILED(automation2->put_ConnectionTimeout(kConnectionTimeoutMs))) {
				LogWarn("put_ConnectionTimeout failed; using the UIA default");
			}
			if (FAILED(automation2->put_TransactionTimeout(kTransactionTimeoutMs))) {
				LogWarn("put_TransactionTimeout failed; using the UIA default");
			}
		}
	} else {
		LogWarn("CLSID_CUIAutomation8 unavailable (" + FormatHResult(hr) +
			"); falling back to CLSID_CUIAutomation");
		hr = ::CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
			IID_PPV_ARGS(&automation));
	}

	if (FAILED(hr) || !automation) {
		error = "UI Automation is unavailable (" + FormatHResult(hr) + ")";
		return false;
	}

	automation_ = automation;
	LogInfo("UI Automation client initialized");
	return true;
}

bool UiaClient::ElementFromWindow(HWND window, ComPtr<IUIAutomationElement>& out) {
	if (!automation_ || window == nullptr) {
		return false;
	}
	ComPtr<IUIAutomationElement> element;
	const HRESULT hr = automation_->ElementFromHandle(window, &element);
	if (FAILED(hr) || !element) {
		LogDebug("ElementFromHandle failed (" + FormatHResult(hr) + ")");
		return false;
	}
	out = element;
	return true;
}

bool UiaClient::ElementFromScreenPoint(POINT point, ComPtr<IUIAutomationElement>& out) {
	if (!automation_) {
		return false;
	}
	ComPtr<IUIAutomationElement> element;
	// The point is physical screen pixels, which is what UIA expects from a per-monitor-aware
	// client (see Dpi.h).
	const HRESULT hr = automation_->ElementFromPoint(point, &element);
	if (FAILED(hr) || !element) {
		LogDebug("ElementFromPoint failed (" + FormatHResult(hr) + ")");
		return false;
	}
	out = element;
	return true;
}

} // namespace v3cu
