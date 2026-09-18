/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Display enumeration in physical pixels.
//
// `displayId` in ComputerUseCaptureParams is defined by this helper as the zero-based index of
// the monitor in EnumDisplayMonitors order, with the primary monitor guaranteed to be reported
// first. The order is otherwise whatever the OS reports and is stable for a given display
// arrangement, but a caller must not persist a displayId across a monitor being plugged in.
//
// All bounds are physical pixels, which is what EnumDisplayMonitors gives a per-monitor-aware
// process (see Dpi.h). On a multi-monitor setup the origin can be negative: a monitor placed to
// the left of the primary starts at a negative x. Nothing here assumes a non-negative origin.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - That the primary monitor really does sort first, and that ids stay stable across calls.
//   - Bounds on a monitor with a negative origin.
//
#pragma once

#include "Common.h"

#include <vector>

namespace v3cu {

struct MonitorInfo {
	/// Zero-based index used as `displayId` on the wire.
	int id = 0;
	HMONITOR handle = nullptr;
	/// Full monitor bounds in physical screen pixels, including any taskbar.
	Rect bounds;
	/// Effective DPI. 96 is 100% scaling.
	unsigned int dpi = 96;
	bool primary = false;
	/// Device name, e.g. "\\\\.\\DISPLAY1". Used to match a monitor to a DXGI output.
	std::wstring deviceName;
};

/// Enumerates every active monitor, primary first.
std::vector<MonitorInfo> EnumerateMonitors();

/// Finds a monitor by wire id. Returns false when no such monitor exists.
bool FindMonitorById(int id, MonitorInfo& out);

/// The monitor containing a window, or the primary monitor when the window is null.
bool FindMonitorForWindow(HWND window, MonitorInfo& out);

/// The primary monitor.
bool FindPrimaryMonitor(MonitorInfo& out);

/// The whole virtual desktop bounding box in physical pixels, for the GDI fallback capture path.
Rect VirtualScreenBounds();

} // namespace v3cu
