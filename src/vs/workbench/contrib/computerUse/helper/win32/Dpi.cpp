/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// DPI implementation. The reasoning lives in Dpi.h; read that first.
//
// Every newer DPI entry point is resolved with GetProcAddress rather than linked, so the binary
// still loads on a machine older than the API. All of these are documented public APIs; nothing
// undocumented is used.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - GetProcAddress names: "SetProcessDpiAwarenessContext", "GetDpiForWindow",
//     "GetAwarenessFromDpiAwarenessContext", "GetThreadDpiAwarenessContext" in user32.dll and
//     "GetDpiForMonitor" in shcore.dll. Spelled from documentation, never resolved at runtime.
//   - That DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is defined by the SDK version used to
//     build (it needs Windows 10 SDK 1703 / 10.0.15063 or newer).
//
#include "Dpi.h"

#include "Log.h"

namespace v3cu {
namespace {

using SetProcessDpiAwarenessContextFn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
using GetDpiForWindowFn = UINT(WINAPI*)(HWND);
using GetThreadDpiAwarenessContextFn = DPI_AWARENESS_CONTEXT(WINAPI*)();
using GetAwarenessFromDpiAwarenessContextFn = DPI_AWARENESS(WINAPI*)(DPI_AWARENESS_CONTEXT);
using GetDpiForMonitorFn = HRESULT(WINAPI*)(HMONITOR, int /*MONITOR_DPI_TYPE*/, UINT*, UINT*);

/// MONITOR_DPI_TYPE::MDT_EFFECTIVE_DPI. Spelled numerically so shcore.h is not required.
constexpr int kEffectiveDpi = 0;

HMODULE User32() {
	static HMODULE module = ::GetModuleHandleW(L"user32.dll");
	return module;
}

HMODULE Shcore() {
	// Loaded rather than fetched: shcore.dll is not guaranteed to be in the process already.
	static HMODULE module = ::LoadLibraryExW(L"shcore.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
	return module;
}

template <typename Fn>
Fn Resolve(HMODULE module, const char* name) {
	if (module == nullptr) {
		return nullptr;
	}
	return reinterpret_cast<Fn>(::GetProcAddress(module, name));
}

const char* DescribeAwareness(DPI_AWARENESS awareness) {
	switch (awareness) {
		case DPI_AWARENESS_UNAWARE: return "unaware";
		case DPI_AWARENESS_SYSTEM_AWARE: return "system-aware";
		case DPI_AWARENESS_PER_MONITOR_AWARE: return "per-monitor-aware";
		default: return "invalid-or-unknown";
	}
}

} // namespace

std::string EnsurePerMonitorV2Awareness() {
	const auto setContext =
		Resolve<SetProcessDpiAwarenessContextFn>(User32(), "SetProcessDpiAwarenessContext");
	if (setContext != nullptr) {
		if (setContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
			LogDebug("SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) succeeded at runtime");
		} else {
			// ERROR_ACCESS_DENIED here means the manifest already set the awareness, which is the
			// expected and preferred outcome. Anything else is worth a warning.
			const DWORD lastError = ::GetLastError();
			if (lastError == ERROR_ACCESS_DENIED) {
				LogDebug("process DPI awareness already set (manifest); runtime call declined");
			} else {
				LogWarn("SetProcessDpiAwarenessContext failed, GetLastError=" +
					std::to_string(static_cast<unsigned long>(lastError)));
			}
		}
	} else {
		LogWarn("SetProcessDpiAwarenessContext unavailable; relying on the manifest alone");
	}

	// Report what actually took effect. PerMonitorV2 reports as DPI_AWARENESS_PER_MONITOR_AWARE
	// here — the V2 distinction is not exposed by GetAwarenessFromDpiAwarenessContext — so
	// "per-monitor-aware" in the log is the success case.
	const auto getThreadContext =
		Resolve<GetThreadDpiAwarenessContextFn>(User32(), "GetThreadDpiAwarenessContext");
	const auto getAwareness = Resolve<GetAwarenessFromDpiAwarenessContextFn>(
		User32(), "GetAwarenessFromDpiAwarenessContext");
	if (getThreadContext != nullptr && getAwareness != nullptr) {
		return DescribeAwareness(getAwareness(getThreadContext()));
	}
	return "unknown";
}

unsigned int GetSystemDpiSafe() {
	const HDC screen = ::GetDC(nullptr);
	if (screen == nullptr) {
		return 96;
	}
	const int dpi = ::GetDeviceCaps(screen, LOGPIXELSX);
	::ReleaseDC(nullptr, screen);
	return dpi > 0 ? static_cast<unsigned int>(dpi) : 96;
}

unsigned int GetDpiForWindowSafe(HWND window) {
	if (window != nullptr) {
		const auto getDpiForWindow = Resolve<GetDpiForWindowFn>(User32(), "GetDpiForWindow");
		if (getDpiForWindow != nullptr) {
			const UINT dpi = getDpiForWindow(window);
			if (dpi > 0) {
				return dpi;
			}
		}
		const HMONITOR monitor = ::MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
		if (monitor != nullptr) {
			return GetDpiForMonitorSafe(monitor);
		}
	}
	return GetSystemDpiSafe();
}

unsigned int GetDpiForMonitorSafe(HMONITOR monitor) {
	if (monitor != nullptr) {
		const auto getDpiForMonitor = Resolve<GetDpiForMonitorFn>(Shcore(), "GetDpiForMonitor");
		if (getDpiForMonitor != nullptr) {
			UINT dpiX = 0;
			UINT dpiY = 0;
			if (SUCCEEDED(getDpiForMonitor(monitor, kEffectiveDpi, &dpiX, &dpiY)) && dpiX > 0) {
				// dpiX and dpiY are equal on every shipping Windows configuration; the API returns
				// both only for symmetry. Using X keeps the single scale factor the contract wants.
				return dpiX;
			}
		}
	}
	return GetSystemDpiSafe();
}

} // namespace v3cu
