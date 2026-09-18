/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// The fallback capture backend: a GDI BitBlt of the screen DC.
//
// Slower and CPU-bound, but it works where Desktop Duplication does not: rotated displays,
// sessions where another process already owns duplication, remote desktop sessions, and machines
// whose GPU driver refuses DuplicateOutput. It reads the same composited output, so coordinates
// are identical — physical pixels of the virtual screen, which is what a per-monitor-aware process
// sees (see Dpi.h).
//
// The mouse cursor is NOT included, matching the duplication path. That is deliberate: a cursor
// baked into the screenshot invites the model to reason about a pointer position that will have
// moved by the time it acts.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - CAPTUREBLT is passed so layered windows are included. It is documented to also cause a
//     visible flicker on some systems; confirm whether that is noticeable, because if it is, the
//     flag is worth dropping for the common case.
//   - Reading a monitor at a negative virtual-screen origin (a display to the left of the primary).
//   - That the DIB section's negative biHeight really produces a top-down buffer.
//
#pragma once

#include "Frame.h"
#include "Monitors.h"

#include <string>

namespace v3cu {

/// Captures one monitor with BitBlt. Returns false with `error` set on failure.
bool CaptureMonitorWithGdi(const MonitorInfo& monitor, Frame& out, std::string& error);

/// True when a 1x1 BitBlt of the screen succeeds. Used by `status` to decide whether capture is
/// possible at all without taking a full screenshot.
bool ProbeGdiCaptureAvailable();

} // namespace v3cu
