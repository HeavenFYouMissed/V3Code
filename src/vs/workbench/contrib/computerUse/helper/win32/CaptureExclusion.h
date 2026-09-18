/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Hiding V3Code's own windows from a capture.
//
// ComputerUseCaptureParams.excludePids exists so the agent never sees its own window and does not
// recurse on it. Neither DXGI Desktop Duplication nor a GDI BitBlt of the screen offers a "skip
// this window" option — they both read composited output. The documented mechanism that does work
// is SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE): the window stays visible on the
// physical monitor but is omitted from capture APIs.
//
// So: for the duration of one capture, every top-level window belonging to an excluded pid gets
// WDA_EXCLUDEFROMCAPTURE, and the previous affinity is restored on scope exit — including on
// every early-return and exception path. Leaving a foreign window permanently excluded from
// capture would break the user's screen sharing until they restarted the app, which is why the
// restore is RAII rather than a call at the end of the happy path.
//
// Only pids where at least one window was successfully excluded are reported in
// ComputerUseCaptureResult.excludedPids, so the caller can tell when the exclusion did not take.
//
// NEEDS VERIFICATION ON WINDOWS — this is the least certain part of the helper:
//   - Whether SetWindowDisplayAffinity succeeds when called on a window owned by ANOTHER process.
//     If it does not (access denied), the fallback plan must be for the V3Code main process to set
//     WDA_EXCLUDEFROMCAPTURE on its own BrowserWindow handles at startup and for the helper to
//     stop trying. The channel agent needs to know this is open.
//   - Whether WDA_EXCLUDEFROMCAPTURE affects a GDI BitBlt of the screen DC, or only the newer
//     capture APIs. If it only covers the newer APIs, the GDI fallback path will still show the
//     V3Code window.
//   - Whether the exclusion takes effect immediately or needs a compositor frame. The helper
//     sleeps briefly after applying it; the duration is a guess.
//   - Behaviour on Windows 10 builds before 2004, where WDA_EXCLUDEFROMCAPTURE does not exist and
//     the code falls back to WDA_MONITOR.
//
#pragma once

#include "Common.h"

#include <vector>

namespace v3cu {

/// Applies capture exclusion to every top-level window of the given pids and restores the previous
/// affinity when destroyed.
class CaptureExclusionScope {
public:
	/// `pids` may be empty, in which case this does nothing.
	explicit CaptureExclusionScope(const std::vector<unsigned long>& pids);
	~CaptureExclusionScope();

	CaptureExclusionScope(const CaptureExclusionScope&) = delete;
	CaptureExclusionScope& operator=(const CaptureExclusionScope&) = delete;

	/// The pids for which at least one window was actually excluded.
	const std::vector<unsigned long>& ExcludedPids() const { return excludedPids_; }

private:
	struct AppliedWindow {
		HWND window = nullptr;
		DWORD previousAffinity = 0;
	};

	std::vector<AppliedWindow> applied_;
	std::vector<unsigned long> excludedPids_;
};

} // namespace v3cu
