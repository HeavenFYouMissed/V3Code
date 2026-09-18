/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Capture orchestration implementation. See Capture.h for the scale contract.
// NEEDS VERIFICATION ON WINDOWS (full list in Capture.h):
//   - The scale arithmetic on a 4K display with maxLongEdge 1080.
//   - display.bounds on a secondary monitor, including a negative origin.
//   - The frame-size / monitor-bounds mismatch warning never firing.
//   - The duplication-to-GDI fallback actually being reached and working.
//
#include "Capture.h"

#include "CaptureExclusion.h"
#include "DesktopDuplication.h"
#include "Frame.h"
#include "GdiCapture.h"
#include "Log.h"
#include "Monitors.h"
#include "PngEncoder.h"

#include <cmath>
#include <mutex>

namespace v3cu {
namespace {

std::mutex& GeometryMutex() {
	static std::mutex mutex;
	return mutex;
}

CaptureGeometry& StoredGeometry() {
	static CaptureGeometry geometry;
	return geometry;
}

/// Picks the monitor to capture: the requested display id, else the display holding the foreground
/// window, else the primary display.
bool SelectMonitor(const CaptureOptions& options, MonitorInfo& out, std::string& error) {
	if (options.hasDisplayId) {
		if (!FindMonitorById(options.displayId, out)) {
			error = "no display with id " + std::to_string(options.displayId);
			return false;
		}
		return true;
	}
	if (FindMonitorForWindow(::GetForegroundWindow(), out)) {
		return true;
	}
	if (FindPrimaryMonitor(out)) {
		return true;
	}
	error = "no displays found";
	return false;
}

/// Computes the target size and the scale actually achieved. Never upscales.
void ComputeTargetSize(int sourceWidth, int sourceHeight, int maxLongEdge, int& targetWidth,
	int& targetHeight, double& scale) {
	const int longEdge = sourceWidth >= sourceHeight ? sourceWidth : sourceHeight;
	if (maxLongEdge <= 0 || longEdge <= maxLongEdge) {
		targetWidth = sourceWidth;
		targetHeight = sourceHeight;
		scale = 1.0;
		return;
	}

	const double requested = static_cast<double>(maxLongEdge) / static_cast<double>(longEdge);
	// The long edge lands exactly on maxLongEdge; the short edge is rounded, which can leave the
	// aspect ratio off by well under half a pixel. Reporting the long-edge ratio is what keeps the
	// caller's coordinate maths and the helper's inverse maths in agreement.
	if (sourceWidth >= sourceHeight) {
		targetWidth = maxLongEdge;
		targetHeight = static_cast<int>(std::lround(static_cast<double>(sourceHeight) * requested));
	} else {
		targetHeight = maxLongEdge;
		targetWidth = static_cast<int>(std::lround(static_cast<double>(sourceWidth) * requested));
	}
	if (targetWidth < 1) {
		targetWidth = 1;
	}
	if (targetHeight < 1) {
		targetHeight = 1;
	}
	scale = requested;
}

} // namespace

CaptureGeometry LastCaptureGeometry() {
	std::lock_guard<std::mutex> guard(GeometryMutex());
	return StoredGeometry();
}

bool ProbeCaptureAvailable() {
	// Deliberately the cheap check. A full DuplicateOutput probe would take a device creation on
	// every `status` call, and `status` is polled by the settings UI.
	return ProbeGdiCaptureAvailable();
}

bool CaptureScreen(const CaptureOptions& options, CaptureOutput& out, std::string& error,
	bool& permissionProblem) {
	permissionProblem = false;

	MonitorInfo monitor;
	if (!SelectMonitor(options, monitor, error)) {
		return false;
	}

	// Exclusion must be applied before the capture and undone after it, on every path. The scope
	// object handles the undo in its destructor.
	CaptureExclusionScope exclusion(options.excludePids);

	Frame frame;
	std::string duplicationError;
	bool captured = CaptureMonitorWithDesktopDuplication(monitor, frame, duplicationError);
	if (!captured) {
		LogWarn("desktop duplication failed (" + duplicationError + "); falling back to GDI");
		ResetDesktopDuplicationCache();
		std::string gdiError;
		captured = CaptureMonitorWithGdi(monitor, frame, gdiError);
		if (!captured) {
			error = "capture failed: desktop duplication (" + duplicationError + ") and GDI (" +
				gdiError + ")";
			// Both backends refusing is what "no screen capture permission" looks like on Windows,
			// which has no such permission as a distinct concept: in practice it means a locked
			// session, the secure desktop, or a policy blocking capture.
			permissionProblem = true;
			return false;
		}
	}

	if (!frame.IsValid()) {
		error = "capture produced an invalid frame";
		return false;
	}

	// The duplicated texture should be exactly the monitor's physical size. If it is not, the
	// monitor rectangle still wins: it is what the service inverts a model coordinate against, and a
	// mismatch means one of the two is not in physical pixels, which must be understood rather than
	// papered over.
	if (frame.width != static_cast<int>(monitor.bounds.width) ||
		frame.height != static_cast<int>(monitor.bounds.height)) {
		LogWarn("captured frame " + std::to_string(frame.width) + "x" +
			std::to_string(frame.height) + " does not match monitor bounds " +
			std::to_string(monitor.bounds.width) + "x" + std::to_string(monitor.bounds.height) +
			"; point targets on this display may be wrong");
	}

	int targetWidth = 0;
	int targetHeight = 0;
	double scale = 1.0;
	ComputeTargetSize(frame.width, frame.height, options.maxLongEdge, targetWidth, targetHeight,
		scale);

	std::vector<uint8_t> png;
	std::string encodeError;
	if (!EncodeBgraToPng(frame.pixels.data(), frame.width, frame.height, frame.stride, targetWidth,
			targetHeight, png, encodeError)) {
		error = "png encode failed: " + encodeError;
		return false;
	}

	out.width = targetWidth;
	out.height = targetHeight;
	out.scale = scale;
	out.png = std::move(png);
	out.excludedPids = exclusion.ExcludedPids();
	// Identical on both backends: taken from the monitor selected above, whose bounds come from
	// GetMonitorInfo's rcMonitor in physical pixels, origin included.
	out.display.displayId = monitor.id;
	out.display.bounds = monitor.bounds;

	{
		std::lock_guard<std::mutex> guard(GeometryMutex());
		StoredGeometry().valid = true;
		StoredGeometry().sourceBounds = frame.sourceBounds;
		StoredGeometry().scale = scale;
	}

	LogDebug("captured display " + std::to_string(monitor.id) + " " + std::to_string(frame.width) +
		"x" + std::to_string(frame.height) + " -> " + std::to_string(targetWidth) + "x" +
		std::to_string(targetHeight));
	return true;
}

} // namespace v3cu
