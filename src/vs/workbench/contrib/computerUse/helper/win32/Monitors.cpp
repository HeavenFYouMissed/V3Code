/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Monitor enumeration implementation. See Monitors.h.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - EnumDisplayMonitors callback signature and the MONITORINFOEXW szDevice contents.
//   - Ordering: the sort below puts the primary first and is otherwise stable.
//
#include "Monitors.h"

#include "Dpi.h"
#include "Log.h"

#include <algorithm>

namespace v3cu {
namespace {

BOOL CALLBACK CollectMonitor(HMONITOR monitor, HDC /*deviceContext*/, LPRECT /*clip*/,
	LPARAM userData) {
	auto* collected = reinterpret_cast<std::vector<MonitorInfo>*>(userData);

	MONITORINFOEXW info = {};
	info.cbSize = sizeof(info);
	if (!::GetMonitorInfoW(monitor, &info)) {
		return TRUE; // Skip this monitor; keep enumerating.
	}

	MonitorInfo entry;
	entry.handle = monitor;
	entry.bounds = RectFromWin32(info.rcMonitor);
	entry.primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
	entry.dpi = GetDpiForMonitorSafe(monitor);
	entry.deviceName = info.szDevice;
	collected->push_back(entry);
	return TRUE;
}

} // namespace

std::vector<MonitorInfo> EnumerateMonitors() {
	std::vector<MonitorInfo> monitors;
	if (!::EnumDisplayMonitors(nullptr, nullptr, CollectMonitor,
			reinterpret_cast<LPARAM>(&monitors))) {
		LogWarn("EnumDisplayMonitors failed");
	}

	// Primary first, then left-to-right, then top-to-bottom. Deterministic so a displayId means
	// the same thing across two calls with the same arrangement.
	std::stable_sort(monitors.begin(), monitors.end(),
		[](const MonitorInfo& left, const MonitorInfo& right) {
			if (left.primary != right.primary) {
				return left.primary;
			}
			if (left.bounds.x != right.bounds.x) {
				return left.bounds.x < right.bounds.x;
			}
			return left.bounds.y < right.bounds.y;
		});

	for (size_t index = 0; index < monitors.size(); ++index) {
		monitors[index].id = static_cast<int>(index);
	}
	return monitors;
}

bool FindMonitorById(int id, MonitorInfo& out) {
	const std::vector<MonitorInfo> monitors = EnumerateMonitors();
	for (const MonitorInfo& monitor : monitors) {
		if (monitor.id == id) {
			out = monitor;
			return true;
		}
	}
	return false;
}

bool FindMonitorForWindow(HWND window, MonitorInfo& out) {
	if (window == nullptr) {
		return FindPrimaryMonitor(out);
	}
	const HMONITOR handle = ::MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
	const std::vector<MonitorInfo> monitors = EnumerateMonitors();
	for (const MonitorInfo& monitor : monitors) {
		if (monitor.handle == handle) {
			out = monitor;
			return true;
		}
	}
	return FindPrimaryMonitor(out);
}

bool FindPrimaryMonitor(MonitorInfo& out) {
	const std::vector<MonitorInfo> monitors = EnumerateMonitors();
	if (monitors.empty()) {
		return false;
	}
	out = monitors.front(); // Sorted primary-first by EnumerateMonitors.
	return true;
}

Rect VirtualScreenBounds() {
	Rect bounds;
	bounds.x = ::GetSystemMetrics(SM_XVIRTUALSCREEN);
	bounds.y = ::GetSystemMetrics(SM_YVIRTUALSCREEN);
	bounds.width = ::GetSystemMetrics(SM_CXVIRTUALSCREEN);
	bounds.height = ::GetSystemMetrics(SM_CYVIRTUALSCREEN);
	return bounds;
}

} // namespace v3cu
