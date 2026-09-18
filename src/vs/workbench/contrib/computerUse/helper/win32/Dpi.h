/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Per-monitor DPI awareness.
//
// WHY THIS FILE EXISTS AT ALL, because it is the subtlest thing in the helper:
//
// Windows lies about coordinates to processes that are not DPI-aware. A DPI-unaware or
// system-DPI-aware process sees a *virtualized* coordinate space: window rects, GetCursorPos and
// UIA bounding rectangles all come back divided by the scale factor, and rounded. On a 150% or
// mixed-DPI setup that rounding is where "the click landed 40 pixels off" comes from — the helper
// reads a virtualized rectangle, computes a centre, and hands back a coordinate that no longer
// corresponds to the pixel the model was looking at in the screenshot.
//
// Declaring PerMonitorV2 removes the lie entirely. For a per-monitor-aware process the virtual
// screen coordinate space *is* physical pixels across every monitor, at every scale factor. That
// single fact is what makes the rest of the helper simple:
//
//   - GetCursorPos, GetWindowRect and UIA BoundingRectangle are already physical pixels; the
//     helper reports them unconverted, which is exactly what ComputerUseRect specifies.
//   - SetCursorPos takes physical pixels, so a click needs no conversion either.
//   - The capture path reads the framebuffer, which is physical pixels by definition, so image
//     pixels and screen pixels differ only by the downscale factor the helper chose. That factor
//     is what `scale` reports.
//
// PerMonitorV2 is declared in the application manifest (v3code-computer-use.manifest) because a
// manifest declaration applies before any code runs, including anything a loaded DLL does in its
// entry point. EnsurePerMonitorV2Awareness below is belt-and-braces for the case where the
// manifest was stripped — it will fail with ERROR_ACCESS_DENIED when the manifest already did the
// job, which is the expected outcome and is logged at debug only.
//
// The per-monitor DPI values are still reported and used for one thing: a caller that wants to
// reason about text size or a window's logical size needs to know the monitor's scale factor.
// They are never used to convert helper coordinates, which are physical throughout.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - That the manifest is actually embedded and takes effect: at startup the helper logs the
//     awareness context it ended up with. Confirm it says per-monitor-v2.
//   - The whole DPI story on a real mixed-DPI multi-monitor setup: 100% primary + 150% secondary,
//     secondary placed to the LEFT of the primary so the virtual screen origin is negative.
//     Confirm a click on a button on the secondary monitor lands on that button.
//   - GetDpiForWindow / GetDpiForMonitor are resolved dynamically; confirm the fallback path is
//     never taken on Windows 10 1809+.
//
#pragma once

#include "Common.h"

namespace v3cu {

/// Attempts to set PerMonitorV2 awareness at runtime. Expected to fail when the manifest already
/// set it; that failure is benign. Returns the awareness description that ended up in effect.
std::string EnsurePerMonitorV2Awareness();

/// DPI of the monitor a window is on. Falls back to the system DPI, then to 96.
unsigned int GetDpiForWindowSafe(HWND window);

/// DPI of a monitor. Falls back to the system DPI, then to 96.
unsigned int GetDpiForMonitorSafe(HMONITOR monitor);

/// The system DPI, for the fallback paths only.
unsigned int GetSystemDpiSafe();

/// Physical pixels per logical pixel for a DPI value: 96 -> 1.0, 144 -> 1.5.
inline double ScaleFactorFromDpi(unsigned int dpi) {
	return dpi == 0 ? 1.0 : static_cast<double>(dpi) / 96.0;
}

} // namespace v3cu
