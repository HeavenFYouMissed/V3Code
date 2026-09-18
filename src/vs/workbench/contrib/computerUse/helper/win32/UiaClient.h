/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// The UI Automation client object, created once and shared.
//
// UIA is the PRIMARY path for every action. SendInput exists only for elements that expose no
// usable pattern, and when it is used the result reports method "synthesized" so the service can
// track the fallback rate.
//
// CUIAutomation8 is preferred over CUIAutomation because it exposes IUIAutomation2, which has
// ConnectionTimeout and TransactionTimeout. Without those, a single hung application can block a
// UIA call for tens of seconds and the helper looks dead. With them, the call fails and the helper
// answers `timeout`, which the service can act on.
//
// There is no Windows equivalent of macOS's Accessibility trust prompt: any process can be a UIA
// client. So `accessibilityTrusted` in the status result means "the UIA client object was created
// successfully", and the real limitation is integrity level — a non-elevated helper cannot read or
// drive an elevated window, and UIA calls against one fail with access denied.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - CLSID_CUIAutomation8 availability and the IUIAutomation2 timeout setters.
//   - MTA is used for the worker thread. UIA clients are documented to work in an MTA, and no
//     event handlers are registered (which is where STA normally becomes necessary), but this is
//     untested.
//   - Behaviour against an elevated window: expect UIA_E_ELEMENTNOTAVAILABLE or E_ACCESSDENIED,
//     which must surface as targetNotFound / accessibilityNotTrusted, not a crash.
//
#pragma once

#include "Common.h"

#include <string>

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {

/// Initializes and uninitializes a COM multithreaded apartment for the calling thread.
class ComApartment {
public:
	ComApartment();
	~ComApartment();

	ComApartment(const ComApartment&) = delete;
	ComApartment& operator=(const ComApartment&) = delete;

	bool Ok() const { return ok_; }

private:
	bool ok_ = false;
	bool shouldUninitialize_ = false;
};

class UiaClient {
public:
	static UiaClient& Instance();

	/// Creates the automation object if it does not exist yet. Idempotent. Returns false with
	/// `error` set when UIA is unavailable.
	bool Initialize(std::string& error);

	/// True when Initialize has succeeded.
	bool IsAvailable() const { return automation_ != nullptr; }

	IUIAutomation* Get() const { return automation_.Get(); }

	/// Wraps ElementFromHandle. Returns false when the window has no UIA element.
	bool ElementFromWindow(HWND window, Microsoft::WRL::ComPtr<IUIAutomationElement>& out);

	/// Wraps ElementFromPoint. `point` is physical screen pixels.
	bool ElementFromScreenPoint(POINT point, Microsoft::WRL::ComPtr<IUIAutomationElement>& out);

private:
	UiaClient() = default;

	Microsoft::WRL::ComPtr<IUIAutomation> automation_;
};

} // namespace v3cu
