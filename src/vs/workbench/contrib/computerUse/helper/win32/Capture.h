/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Capture orchestration: pick the display, exclude V3Code's windows, capture, downscale, encode.
//
// SCALE, precisely. ComputerUseCaptureResult.scale is defined as image pixels per physical pixel.
// The helper never upscales, so scale <= 1 always. It is computed once from the long edge and
// applied to both axes so the aspect ratio is preserved exactly, and the value reported is the
// ratio actually achieved after integer rounding — not the ratio requested. A caller multiplying
// a screen coordinate by `scale` and a helper dividing an image coordinate by `scale` must agree
// to the pixel, and they only do if the reported number is the one the image was really built with.
//
// DISPLAY IDENTITY AND BOUNDS. ComputerUseCaptureResult.display carries the captured display's id
// and its PHYSICAL bounds on the virtual desktop, origin included. The service needs the origin to
// turn a model coordinate back into a screen coordinate: without it, every point target on a
// secondary display lands on the primary one. Both bounds and origin come from the MonitorInfo
// selected before either backend runs, which is populated from GetMonitorInfo's rcMonitor — the
// monitor rectangle on the virtual desktop, not a client-relative rectangle — and is in physical
// pixels because the process is per-monitor-v2 aware (see Dpi.h). The same value is therefore
// reported identically on the duplication path and the GDI path.
//
// bounds.width/height are the display's full physical size. The top-level width/height stay the
// (possibly downscaled) image size. They are equal only when scale is 1.
//
// The geometry of the most recent capture is also remembered (see LastCaptureGeometry). It is no
// longer needed to convert point targets — the service does that conversion now — but it is kept as
// a diagnostic: a point that falls outside the last captured display is a strong signal that the
// conversion did not happen, and Targets.cpp warns about it.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - End-to-end: capture a 3840x2160 display with maxLongEdge 1080 and confirm the result is
//     1080x608 (or 1080x607 — see the rounding note in Capture.cpp) with scale 0.28125, and
//     display.bounds { x:0, y:0, width:3840, height:2160 }.
//   - display.bounds on a SECONDARY monitor: a 2560-wide display to the right of a 3840-wide primary
//     must report x=3840, and one to the left must report a negative x.
//   - That the DXGI duplicated texture size equals the monitor bounds size. A mismatch is logged as
//     a warning and the monitor bounds win, because the monitor rect is what the service needs to
//     invert; if the warning ever fires, the two must be reconciled before trusting point targets.
//   - That excluding V3Code's pid really removes its window from the image. See CaptureExclusion.h,
//     which is the part most likely not to work.
//
#pragma once

#include "Common.h"

#include <cstdint>
#include <string>
#include <vector>

namespace v3cu {

/// Parsed ComputerUseCaptureParams.
struct CaptureOptions {
	bool hasDisplayId = false;
	int displayId = 0;
	/// Long-edge budget in pixels. Defaults to COMPUTER_USE_DEFAULT_MAX_LONG_EDGE.
	int maxLongEdge = 1080;
	std::vector<unsigned long> excludePids;
};

/// ComputerUseCaptureDisplay: which display the image came from, and where it is.
struct CapturedDisplay {
	/// Stable within a helper run. This is the monitor index from Monitors.h.
	int displayId = 0;
	/// Full physical bounds on the virtual desktop, origin included. NOT the image size.
	Rect bounds;
};

/// The data behind ComputerUseCaptureResult, minus the base64 step.
struct CaptureOutput {
	int width = 0;
	int height = 0;
	double scale = 1.0;
	std::vector<uint8_t> png;
	std::vector<unsigned long> excludedPids;
	CapturedDisplay display;
};

/// Geometry of the last successful capture, for mapping `point` targets back to the screen.
struct CaptureGeometry {
	bool valid = false;
	/// Physical screen rectangle the image covered.
	Rect sourceBounds;
	/// Image pixels per physical pixel.
	double scale = 1.0;
};

/// Captures the screen. On failure returns false, sets `error`, and sets `permissionProblem` when
/// both backends failed in a way that suggests capture is not permitted at all — the caller maps
/// that to `screenRecordingNotGranted` rather than `internal`.
bool CaptureScreen(const CaptureOptions& options, CaptureOutput& out, std::string& error,
	bool& permissionProblem);

/// Geometry of the most recent successful capture. `valid` is false before the first capture.
CaptureGeometry LastCaptureGeometry();

/// True when at least one capture backend appears usable. Used by `status`.
bool ProbeCaptureAvailable();

} // namespace v3cu
