/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// `settle`: wait until an application's UI stops changing, or say plainly that it did not.
//
// WHY IT IS IN THE HELPER AT ALL. Notification quiescence needs a UIA event subscription on a live
// callback, and frame comparison needs raster frames. Neither can cross the stdio pipe: the events
// would arrive too late to be a quiet-period measurement, and the frames must never leave the helper —
// sending a screenshot per 40 ms sample to answer "has it stopped moving yet" would cost more than the
// action being settled.
//
// TWO SIGNALS, BECAUSE EITHER ALONE IS WRONG.
//
//   Notifications alone miss the exact case this exists to catch. A Fluent or Core Animation transition
//   moves layers, not accessibility geometry; an application can be visually mid-slide and completely
//   accessibility-silent. Settling on notification silence would then report `settled: true` while the
//   sheet is still moving, which is the original bug wearing a disguise.
//
//   Frames alone are worse. A blinking text caret changes pixels forever, a clock updates every second,
//   and a video keeps playing. Frame comparison alone would burn the whole budget on a perfectly settled
//   window. That is why the tolerance below is not zero and why notifications are the primary signal.
//
// So: notifications going quiet is the good outcome, confirmed by a couple of matching frames.
// Consecutive matching frames alone are accepted as `frameStable` when notifications never go quiet, and
// as `notificationsUnavailable` when there were no notifications to be had. A budget that runs out with
// neither reports `settled: false`, which the caller MUST surface to the model rather than proceeding —
// see the contract note on ComputerUseSettleResult.settled.
//
// THE FRAME SIGNATURE is a 32x32 halftone-downscaled copy of the target window's pixels: 4 KB, one
// BitBlt-and-StretchBlt, cheap enough to take every 40 ms. Downscaling is what makes the tolerance work:
// a caret or a one-character clock tick averages away inside a cell, while a sliding panel moves every
// cell it crosses.
//
// NEEDS VERIFICATION ON WINDOWS — THE WHOLE FILE, and specifically:
//   - THE TOLERANCE NUMBERS. kChannelTolerance, kMaxDifferingCells and the three stable-frame counts are
//     reasoned, not measured. The way to measure them: log every sample's differing-cell count while
//     opening a menu, resizing a window, and sitting still in an editor with a blinking caret. A caret
//     that trips the comparison shows up as settle always reporting `budgetExceeded` for text editors.
//   - That a 32x32 HALFTONE StretchBlt of a window rectangle is cheap enough to run at 25 Hz without
//     showing up as helper CPU. If it is not, the grid or the interval moves, not the design.
//   - That SetStretchBltMode(HALFTONE) followed by SetBrushOrgEx is doing what it is supposed to. Without
//     the brush-origin call the halftone result is documented to be wrong, which would show up as noisy
//     comparisons and settle never converging.
//   - That capturing the window RECTANGLE from the screen DC picks up the target window and not whatever
//     is in front of it. It does not: an overlapping window IS included, and a notification toast
//     drifting across the target would read as motion. PrintWindow would avoid that but does not capture
//     GPU-composited content, which is most of what matters here. The trade is deliberate; if it proves
//     to be a problem in practice, the fix is to compare only the target's visible region.
//   - Whether an application that is animating but has notifications enabled ever reaches `quiescent`
//     early — that is, whether the two signals actually agree in practice.
//
#pragma once

#include "Common.h"
#include "Protocol.h"

#include <cstdint>
#include <string>

namespace v3cu {

/// COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS from computerUseTypes.ts.
inline constexpr int kDefaultSettleBudgetMs = 1500;

/// COMPUTER_USE_DEFAULT_SETTLE_QUIET_MS from computerUseTypes.ts.
inline constexpr int kDefaultSettleQuietMs = 120;

/// Sampling period. 40 ms is ~2.5 frames at 60 Hz: fast enough to see an animation, slow enough that the
/// sampling itself is not the thing keeping the machine busy.
inline constexpr int kSettleSampleIntervalMs = 40;

/// Parsed ComputerUseSettleParams.
struct SettleOptions {
	bool hasPid = false;
	unsigned long pid = 0;
	int timeoutMs = kDefaultSettleBudgetMs;
	int quietPeriodMs = kDefaultSettleQuietMs;
	bool requireFrameStability = true;
};

/// The data behind ComputerUseSettleResult.
struct SettleOutcome {
	bool settled = false;
	int waitedMs = 0;
	/// One of the ComputerUseSettleReason strings. Never null.
	const char* reason = "budgetExceeded";
	int frameSamples = 0;
	bool hasFrameSamples = false;
	uint64_t notifications = 0;
	bool hasNotifications = false;
};

/// Waits for the target application's UI to stop changing. Returns false only when the wait could not be
/// attempted at all — an unreadable target or a cancel. A UI that never settles is a successful call with
/// `settled: false`.
bool WaitForSettle(const SettleOptions& options, SettleOutcome& out, ErrorCode& code,
	std::string& message);

} // namespace v3cu
