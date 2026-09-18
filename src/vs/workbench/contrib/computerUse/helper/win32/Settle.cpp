/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// settle implementation. Read Settle.h first: why there are two signals, why either alone is wrong, and
// the full verification list are all there.
//
// NEEDS VERIFICATION ON WINDOWS (full list in Settle.h):
//   - The tolerance constants below are reasoned, not measured. A blinking caret must not defeat them.
//   - That the sampler is cheap enough to run at 25 Hz.
//   - That notification quiescence and frame stability agree in practice on a real animation.
//
#include "Settle.h"

#include "AxTree.h"
#include "Apps.h"
#include "Cancellation.h"
#include "Log.h"
#include "UiaClient.h"
#include "UiaEvents.h"

#include <cstdlib>
#include <cstring>
#include <utility>
#include <vector>

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

/// Downscale grid. 32x32 BGRA is 4 KB per sample.
constexpr int kGridWidth = 32;
constexpr int kGridHeight = 32;

/// How much one cell may move, per channel, and still count as unchanged. Absorbs dithering, subpixel
/// text rendering, and a caret averaged into a cell.
constexpr int kChannelTolerance = 8;

/// How many cells may exceed the tolerance and still count as a matching frame. Two cells out of 1024 is
/// a caret and a clock digit; a sliding panel moves far more than that.
constexpr int kMaxDifferingCells = 2;

/// Matching frames required before quiescent notifications are believed.
constexpr int kStableFramesToConfirmQuiet = 2;

/// Matching frames required when there are no notifications at all to corroborate.
constexpr int kStableFramesWithoutNotifications = 3;

/// Matching frames required to overrule notifications that never go quiet. Higher than the others on
/// purpose: this is the path a chronically noisy application takes, and a wrong answer here is a wrong
/// answer for every action against that application.
constexpr int kStableFramesToOverruleNoise = 5;

/// A downscaled copy of one window's pixels.
struct FrameSignature {
	bool valid = false;
	std::vector<uint8_t> cells;
};

/// Owns the GDI objects for one sample and releases them in reverse order of creation.
class SamplerResources {
public:
	~SamplerResources() {
		if (previousBitmap != nullptr && memoryDc != nullptr) {
			::SelectObject(memoryDc, previousBitmap);
		}
		if (bitmap != nullptr) {
			::DeleteObject(bitmap);
		}
		if (memoryDc != nullptr) {
			::DeleteDC(memoryDc);
		}
		if (screenDc != nullptr) {
			::ReleaseDC(nullptr, screenDc);
		}
	}

	HDC screenDc = nullptr;
	HDC memoryDc = nullptr;
	HBITMAP bitmap = nullptr;
	HGDIOBJ previousBitmap = nullptr;
	void* bits = nullptr;
};

/// Downscaled pixels of a window's screen rectangle. Returns an invalid signature for a minimized or
/// zero-sized window, which the caller treats as "no frame signal available".
FrameSignature SampleWindow(HWND window) {
	FrameSignature signature;
	if (window == nullptr || ::IsIconic(window)) {
		return signature;
	}

	RECT bounds = {};
	if (!::GetWindowRect(window, &bounds)) {
		return signature;
	}
	const int width = bounds.right - bounds.left;
	const int height = bounds.bottom - bounds.top;
	if (width <= 0 || height <= 0) {
		return signature;
	}

	SamplerResources resources;
	resources.screenDc = ::GetDC(nullptr);
	if (resources.screenDc == nullptr) {
		return signature;
	}
	resources.memoryDc = ::CreateCompatibleDC(resources.screenDc);
	if (resources.memoryDc == nullptr) {
		return signature;
	}

	BITMAPINFO info = {};
	info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
	info.bmiHeader.biWidth = kGridWidth;
	// Negative height requests a top-down DIB. The orientation does not matter for a comparison, but
	// matching the rest of the helper keeps the buffer layout predictable.
	info.bmiHeader.biHeight = -kGridHeight;
	info.bmiHeader.biPlanes = 1;
	info.bmiHeader.biBitCount = 32;
	info.bmiHeader.biCompression = BI_RGB;

	resources.bitmap = ::CreateDIBSection(resources.screenDc, &info, DIB_RGB_COLORS, &resources.bits,
		nullptr, 0);
	if (resources.bitmap == nullptr || resources.bits == nullptr) {
		return signature;
	}
	resources.previousBitmap = ::SelectObject(resources.memoryDc, resources.bitmap);

	// HALFTONE averages the source pixels instead of point-sampling them, which is what makes a small
	// change average away rather than flip a whole cell. SetBrushOrgEx after it is documented as required.
	::SetStretchBltMode(resources.memoryDc, HALFTONE);
	::SetBrushOrgEx(resources.memoryDc, 0, 0, nullptr);

	if (!::StretchBlt(resources.memoryDc, 0, 0, kGridWidth, kGridHeight, resources.screenDc,
			bounds.left, bounds.top, width, height, SRCCOPY)) {
		return signature;
	}

	const size_t size = static_cast<size_t>(kGridWidth) * static_cast<size_t>(kGridHeight) * 4u;
	signature.cells.assign(size, 0);
	::memcpy(signature.cells.data(), resources.bits, size);
	signature.valid = true;
	return signature;
}

/// True when two signatures are the same picture within tolerance.
bool SignaturesMatch(const FrameSignature& first, const FrameSignature& second) {
	if (!first.valid || !second.valid || first.cells.size() != second.cells.size()) {
		return false;
	}
	int differing = 0;
	for (size_t index = 0; index + 3 < first.cells.size(); index += 4) {
		int delta = 0;
		for (size_t channel = 0; channel < 3; ++channel) {
			const int lhs = static_cast<int>(first.cells[index + channel]);
			const int rhs = static_cast<int>(second.cells[index + channel]);
			const int difference = lhs > rhs ? lhs - rhs : rhs - lhs;
			if (difference > delta) {
				delta = difference;
			}
		}
		if (delta > kChannelTolerance) {
			++differing;
			if (differing > kMaxDifferingCells) {
				return false;
			}
		}
	}
	return true;
}

} // namespace

bool WaitForSettle(const SettleOptions& options, SettleOutcome& out, ErrorCode& code,
	std::string& message) {
	std::string uiaError;
	// A failure here is not fatal: without UIA there are no notifications, but frame comparison still
	// works, and reporting `notificationsUnavailable` is exactly what that situation is for.
	const bool uiaAvailable = UiaClient::Instance().Initialize(uiaError);
	if (!uiaAvailable) {
		LogWarn("settle: UIA unavailable (" + uiaError + "); frame comparison only");
	}

	AxTreeOptions target;
	target.hasPid = options.hasPid;
	target.pid = options.pid;
	AppInfo app;
	std::vector<HWND> windows;
	if (!ResolveAxTarget(target, app, windows, code, message)) {
		return false;
	}

	UiaWatch watch;
	if (uiaAvailable) {
		std::string watchError;
		if (!watch.Start(UiaClient::Instance().Get(), RootElementsForWindows(windows), watchError)) {
			LogDebug("settle: no notifications for " + app.id + " (" + watchError + ")");
		}
	}
	const bool notificationsAvailable = watch.Active();

	const int budget = options.timeoutMs > 0 ? options.timeoutMs : kDefaultSettleBudgetMs;
	const int quiet = options.quietPeriodMs > 0 ? options.quietPeriodMs : kDefaultSettleQuietMs;
	const HWND sampled = windows.front();

	const ULONGLONG start = ::GetTickCount64();
	FrameSignature previous;
	int stableFrames = 0;
	int frameSamples = 0;
	bool frameSignalAvailable = false;

	for (;;) {
		const int elapsed = static_cast<int>(::GetTickCount64() - start);
		if (elapsed >= budget) {
			break;
		}
		::Sleep(kSettleSampleIntervalMs);
		if (Cancellation::IsRequested()) {
			code = ErrorCode::Cancelled;
			message = "the settle wait was cancelled";
			return false;
		}

		if (options.requireFrameStability || !notificationsAvailable) {
			FrameSignature current = SampleWindow(sampled);
			++frameSamples;
			if (current.valid) {
				frameSignalAvailable = true;
				stableFrames = SignaturesMatch(previous, current) ? stableFrames + 1 : 0;
				previous = std::move(current);
			} else {
				// A window that cannot be sampled contributes nothing rather than counting as stable.
				stableFrames = 0;
			}
		}

		const bool framesConfirm = !options.requireFrameStability || !frameSignalAvailable ||
			stableFrames >= kStableFramesToConfirmQuiet;
		const bool quiescent = notificationsAvailable &&
			static_cast<int>(::GetTickCount64() - watch.LastEventTick()) >= quiet;

		if (quiescent && framesConfirm) {
			out.settled = true;
			out.reason = "quiescent";
			break;
		}
		if (!notificationsAvailable && frameSignalAvailable &&
			stableFrames >= kStableFramesWithoutNotifications) {
			out.settled = true;
			out.reason = "notificationsUnavailable";
			break;
		}
		if (notificationsAvailable && frameSignalAvailable &&
			stableFrames >= kStableFramesToOverruleNoise) {
			out.settled = true;
			out.reason = "frameStable";
			break;
		}
	}

	out.waitedMs = static_cast<int>(::GetTickCount64() - start);
	if (!out.settled) {
		// Deliberately NOT dressed up. A caller that treats this as settled will dispatch into a moving
		// window; the whole point of the field is that it can say no.
		out.reason = notificationsAvailable || frameSignalAvailable ? "budgetExceeded"
																   : "notificationsUnavailable";
	}
	if (frameSamples > 0) {
		out.frameSamples = frameSamples;
		out.hasFrameSamples = true;
	}
	if (notificationsAvailable) {
		out.notifications = watch.Events();
		out.hasNotifications = true;
	}

	watch.Stop();
	LogDebug("settle: " + app.id + " settled=" + (out.settled ? "true" : "false") + " reason=" +
		out.reason + " waited=" + std::to_string(out.waitedMs) + "ms frames=" +
		std::to_string(out.frameSamples) + " notifications=" + std::to_string(out.notifications));
	return true;
}

} // namespace v3cu
