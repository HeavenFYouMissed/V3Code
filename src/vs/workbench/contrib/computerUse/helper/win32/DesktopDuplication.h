/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// The primary capture backend: DXGI Desktop Duplication.
//
// Chosen over Windows.Graphics.Capture deliberately. WGC would work, but it is a WinRT API whose
// C++ surface is asynchronous, needs a D3D interop device, and needs a dispatcher to pump — a
// large amount of code that cannot be compiled or run on the machine this was written on. Desktop
// Duplication reaches the same framebuffer through a synchronous, plain-C++ COM API. Both are
// documented, GPU-accelerated, and give physical pixels. The contract explicitly permits either.
//
// The duplication object is cached across calls, because DuplicateOutput is the expensive part and
// consecutive `capture` requests almost always target the same monitor. It is torn down and
// rebuilt when the OS invalidates it (DXGI_ERROR_ACCESS_LOST, which happens on a resolution
// change, a UAC prompt, a fullscreen-exclusive transition, or a session switch).
//
// NEEDS VERIFICATION ON WINDOWS — none of the following has been run:
//   - Adapter/output enumeration matching a monitor by DXGI_OUTPUT_DESC.DeviceName against
//     MONITORINFOEXW.szDevice. These are documented to be the same string; unverified.
//   - The AcquireNextFrame retry loop. On an idle desktop the first call can return
//     DXGI_ERROR_WAIT_TIMEOUT repeatedly because there are no updates; the desktop texture is
//     nonetheless valid, so the code retries a bounded number of times and then gives up to the
//     GDI fallback. Confirm a capture of a completely static screen succeeds.
//   - Multi-GPU laptops: the output may belong to an adapter other than the one rendering. The
//     code creates the device on the adapter that owns the output, which is the documented
//     requirement, but hybrid-graphics machines are where this most often goes wrong.
//   - Rotated displays: DXGI_MODE_ROTATION other than identity is refused here and falls through
//     to GDI rather than being rotated by hand. Confirm the fallback triggers on a portrait
//     monitor.
//   - Behaviour under a protected-content window (DRM video), where the duplicated surface may be
//     black.
//
#pragma once

#include "Frame.h"
#include "Monitors.h"

#include <string>

namespace v3cu {

/// Captures one monitor. Returns false with `error` set on any failure; the caller falls back to
/// GdiCapture. Never throws.
bool CaptureMonitorWithDesktopDuplication(const MonitorInfo& monitor, Frame& out,
	std::string& error);

/// Drops any cached device and duplication object. Called when the caller sees repeated failures.
void ResetDesktopDuplicationCache();

} // namespace v3cu
