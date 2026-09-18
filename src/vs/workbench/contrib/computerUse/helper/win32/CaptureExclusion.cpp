/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Capture-exclusion implementation. Read CaptureExclusion.h first — the list of things that may
// simply not work cross-process is there.
// NEEDS VERIFICATION ON WINDOWS (full list in CaptureExclusion.h — this is the least certain file
// in the helper):
//   - Whether SetWindowDisplayAffinity works cross-process at all.
//   - Whether WDA_EXCLUDEFROMCAPTURE affects a GDI BitBlt of the screen.
//   - Whether the 60ms compositor settle below is enough, too much, or unnecessary.
//   - That the destructor always restores affinity, including when the helper is killed mid-capture
//     (it cannot, in that case — a killed helper leaves the window excluded until the app restarts).
//
#include "CaptureExclusion.h"

#include "Log.h"

#include <algorithm>

// WDA_EXCLUDEFROMCAPTURE arrived in the Windows 10 2004 SDK. Defined defensively so the helper
// still builds against an older SDK; the value is the documented one.
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif
#ifndef WDA_MONITOR
#define WDA_MONITOR 0x00000001
#endif
#ifndef WDA_NONE
#define WDA_NONE 0x00000000
#endif

namespace v3cu {
namespace {

struct EnumContext {
	const std::vector<unsigned long>* pids = nullptr;
	std::vector<HWND> windows;
};

BOOL CALLBACK CollectWindowsForPids(HWND window, LPARAM userData) {
	auto* context = reinterpret_cast<EnumContext*>(userData);

	DWORD processId = 0;
	::GetWindowThreadProcessId(window, &processId);
	if (processId == 0) {
		return TRUE;
	}
	const auto found = std::find(context->pids->begin(), context->pids->end(),
		static_cast<unsigned long>(processId));
	if (found == context->pids->end()) {
		return TRUE;
	}
	// Invisible windows contribute nothing to a capture, and excluding them wastes calls that can
	// fail and pollute the log.
	if (!::IsWindowVisible(window)) {
		return TRUE;
	}
	context->windows.push_back(window);
	return TRUE;
}

} // namespace

CaptureExclusionScope::CaptureExclusionScope(const std::vector<unsigned long>& pids) {
	if (pids.empty()) {
		return;
	}

	EnumContext context;
	context.pids = &pids;
	::EnumWindows(CollectWindowsForPids, reinterpret_cast<LPARAM>(&context));

	std::vector<unsigned long> succeededPids;
	for (const HWND window : context.windows) {
		DWORD previous = WDA_NONE;
		if (!::GetWindowDisplayAffinity(window, &previous)) {
			previous = WDA_NONE;
		}
		if (previous == WDA_EXCLUDEFROMCAPTURE) {
			// Already excluded, by V3Code itself most likely. Count it, but do not record it for
			// restore: putting it back to WDA_NONE would undo someone else's intent.
			DWORD processId = 0;
			::GetWindowThreadProcessId(window, &processId);
			succeededPids.push_back(static_cast<unsigned long>(processId));
			continue;
		}

		bool applied = ::SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE) != FALSE;
		if (!applied) {
			// Pre-2004 Windows 10 rejects WDA_EXCLUDEFROMCAPTURE. WDA_MONITOR is the older, cruder
			// equivalent: the window renders black in a capture rather than being removed. Black is
			// still better than the agent seeing its own UI.
			const DWORD firstError = ::GetLastError();
			applied = ::SetWindowDisplayAffinity(window, WDA_MONITOR) != FALSE;
			if (applied) {
				LogWarn("WDA_EXCLUDEFROMCAPTURE rejected (GetLastError=" +
					std::to_string(static_cast<unsigned long>(firstError)) +
					"), fell back to WDA_MONITOR");
			} else {
				LogWarn("SetWindowDisplayAffinity failed for a window, GetLastError=" +
					std::to_string(static_cast<unsigned long>(::GetLastError())));
			}
		}
		if (!applied) {
			continue;
		}

		AppliedWindow record;
		record.window = window;
		record.previousAffinity = previous;
		applied_.push_back(record);

		DWORD processId = 0;
		::GetWindowThreadProcessId(window, &processId);
		succeededPids.push_back(static_cast<unsigned long>(processId));
	}

	std::sort(succeededPids.begin(), succeededPids.end());
	succeededPids.erase(std::unique(succeededPids.begin(), succeededPids.end()),
		succeededPids.end());
	excludedPids_ = std::move(succeededPids);

	if (!applied_.empty()) {
		// The compositor needs a frame to pick the change up before the capture reads the
		// framebuffer. 60ms is roughly four frames at 60Hz — a guess, and one of the things to
		// measure on a real machine.
		::Sleep(60);
	}
}

CaptureExclusionScope::~CaptureExclusionScope() {
	for (const AppliedWindow& record : applied_) {
		if (!::IsWindow(record.window)) {
			continue; // The window went away mid-capture; nothing to restore.
		}
		if (!::SetWindowDisplayAffinity(record.window, record.previousAffinity)) {
			// Worth an error rather than a warning: a window left excluded from capture stays that
			// way until the owning app recreates it, which the user will experience as broken
			// screen sharing.
			LogError("failed to restore window display affinity, GetLastError=" +
				std::to_string(static_cast<unsigned long>(::GetLastError())));
		}
	}
}

} // namespace v3cu
