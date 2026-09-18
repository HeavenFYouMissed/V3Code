/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// The two things only the helper can know about a caller's snapshot, which is the whole reason
// `axTreeDiff` is a helper method rather than a common/ function:
//
//   1. baselineComparable — whether refs minted in `sinceGeneration` still mean the same elements.
//   2. unchanged — whether anything observable has happened since `sinceGeneration` at all.
//
// The diff itself is NOT here and must not be. It lives in common/computerUseAxDiff.ts, where it is
// unit-tested once instead of being written twice in Swift and C++.
//
// HOW `unchanged` IS DECIDED, and why it takes three independent signals rather than one. Answering
// "nothing changed" wrongly is the worst bug this file could have: the caller would keep acting on a
// tree that no longer describes the screen, and nothing downstream could detect it. So `unchanged`
// requires ALL of:
//
//   a. The ledger has a record for that exact generation, taken for that exact pid.
//   b. A notification watcher has been running continuously since that record was made, and its event
//      counter has not moved. A watcher that was never started, or was restarted, answers "changed".
//   c. The application's set of top-level windows is byte-for-byte the one recorded. This is the
//      safety net for the gap documented in UiaEvents.h: a menu or dropdown that opens in a NEW
//      top-level window fires no event inside any watched subtree, and without this check it would
//      read as "nothing changed" while a menu is on screen.
//
// Each of (b) and (c) is cheap, and each fails closed. The combination is what makes reporting
// `unchanged` defensible.
//
// HOW `baselineComparable` IS DECIDED: the generation must be within the ref table's retention window,
// at or above its baseline floor (which a cancel or a forced-accessibility raise, see
// RefTable::MarkBaselineUnreliable), and recorded against the same pid. A pid that has been reused by
// a different process after a restart is the case the pid check exists for — the old snapshot's refs
// would resolve against elements of a completely different application.
//
// Lifetime: one watcher, for one pid, replaced when a different pid is asked for. Watching every pid a
// caller has ever looked at would leave UIA handlers registered across the whole desktop.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - THE BEHAVIOUR THAT MATTERS: walk a window with axTreeDiff, touch nothing, walk again, and confirm
//     `unchanged: true` with an empty node list. Then open a menu and confirm the very next call is
//     `unchanged: false`. If the second half fails, this file is dangerous and EnsureWatching should be
//     stubbed out to never watch (which degrades to always sending a full tree — verbose but correct).
//   - That an application with a WebView2 or Electron renderer fires structure-changed events at all
//     when its content changes. If it does not, `unchanged` will be wrongly true for web content, and
//     the window-set check will not catch it because the window set does not change.
//   - Whether keeping a watcher registered between turns measurably slows the watched application. If it
//     does, the trade is worth revisiting: the alternative is to register only for the duration of a
//     walk, which makes `unchanged` impossible.
//
#pragma once

#include "Common.h"
#include "UiaEvents.h"

#include <cstdint>
#include <deque>
#include <vector>

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {

/// What one snapshot saw, kept so a later `sinceGeneration` can be judged against it.
struct AxSnapshotRecord {
	uint64_t generation = 0;
	unsigned long pid = 0;
	/// The watcher's event count at the moment the walk finished.
	uint64_t eventCount = 0;
	/// True when a watcher was actually running for this snapshot. Without it, `unchanged` can never be
	/// answered for this generation, however quiet things look.
	bool watched = false;
	/// The application's top-level windows, in z-order, at snapshot time.
	std::vector<HWND> windows;
};

/// Worker-thread-only. Every method assumes the single-request-at-a-time discipline in Main.cpp.
class AxWatch {
public:
	static AxWatch& Instance();

	/// Starts, or keeps, a change watcher for `pid`. Best effort: a failure to register simply means
	/// `unchanged` can never be true, which is the safe direction.
	void EnsureWatching(unsigned long pid, IUIAutomation* automation,
		const std::vector<Microsoft::WRL::ComPtr<IUIAutomationElement>>& roots);

	/// Drops the watcher. Called when a snapshot is taken for a different application, and on shutdown.
	void StopWatching();

	/// Records what the snapshot numbered `generation` saw. Must be called after the walk finishes, so
	/// events that fired DURING the walk are counted as part of it.
	void RecordSnapshot(uint64_t generation, unsigned long pid);

	/// True when refs minted in `generation` still mean the same elements of `pid`.
	bool BaselineComparable(uint64_t generation, unsigned long pid) const;

	/// True when nothing observable has happened to `pid` since `generation`. Fails closed.
	bool NothingChangedSince(uint64_t generation, unsigned long pid) const;

private:
	AxWatch() = default;

	const AxSnapshotRecord* Find(uint64_t generation) const;

	UiaWatch watch_;
	unsigned long watchedPid_ = 0;
	std::deque<AxSnapshotRecord> ledger_;
};

} // namespace v3cu
