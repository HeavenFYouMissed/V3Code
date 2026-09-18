/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Snapshot ledger implementation. Read AxWatch.h first: the three signals `unchanged` requires, and
// why one signal would not be enough, are the design and they are documented there.
//
// NEEDS VERIFICATION ON WINDOWS (full list in AxWatch.h):
//   - axTreeDiff twice with nothing touched must answer `unchanged: true`; opening a menu must make the
//     very next call answer false.
//   - That web content inside an Electron or WebView2 window fires structure-changed events. If it does
//     not, `unchanged` is wrongly true for exactly the applications V3Code users care about most.
//
#include "AxWatch.h"

#include "Apps.h"
#include "Log.h"
#include "RefTable.h"

#include <string>

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

/// One more than the ref table keeps, so a generation whose refs are still live always has a record to
/// be judged against.
constexpr size_t kMaxLedgerEntries = static_cast<size_t>(kRetainedGenerations) + 1;

} // namespace

AxWatch& AxWatch::Instance() {
	static AxWatch watch;
	return watch;
}

void AxWatch::EnsureWatching(unsigned long pid, IUIAutomation* automation,
	const std::vector<ComPtr<IUIAutomationElement>>& roots) {
	if (watch_.Active() && watchedPid_ == pid) {
		return;
	}
	if (watch_.Active()) {
		// A different application. Two watchers would mean two sets of UIA handlers registered across the
		// desktop and a shared counter that cannot tell them apart.
		LogDebug("moving the change watcher from pid " + std::to_string(watchedPid_) + " to " +
			std::to_string(pid));
		watch_.Stop();
		watchedPid_ = 0;
	}

	std::string error;
	if (!watch_.Start(automation, roots, error)) {
		LogDebug("no change watcher for pid " + std::to_string(pid) + ": " + error);
		return;
	}
	watchedPid_ = pid;
}

void AxWatch::StopWatching() {
	watch_.Stop();
	watchedPid_ = 0;
}

void AxWatch::RecordSnapshot(uint64_t generation, unsigned long pid) {
	AxSnapshotRecord record;
	record.generation = generation;
	record.pid = pid;
	record.watched = watch_.Active() && watchedPid_ == pid;
	record.eventCount = record.watched ? watch_.Events() : 0;
	record.windows = FindAppWindowsForPid(pid);

	ledger_.push_back(record);
	while (ledger_.size() > kMaxLedgerEntries) {
		ledger_.pop_front();
	}
}

const AxSnapshotRecord* AxWatch::Find(uint64_t generation) const {
	for (const AxSnapshotRecord& record : ledger_) {
		if (record.generation == generation) {
			return &record;
		}
	}
	return nullptr;
}

bool AxWatch::BaselineComparable(uint64_t generation, unsigned long pid) const {
	if (generation == 0) {
		// The caller holds no snapshot. Not an error, and not comparable either.
		return false;
	}
	const RefTable& refs = RefTable::Instance();
	if (generation > refs.CurrentGeneration()) {
		// A generation this helper has never issued. Either the caller invented it or it survived a helper
		// restart; both mean its refs are meaningless here.
		return false;
	}
	if (generation < refs.BaselineFloor()) {
		// A cancel, a forced-accessibility enable, or a ref-table overflow happened since. See
		// RefTable::MarkBaselineUnreliable.
		return false;
	}
	const AxSnapshotRecord* record = Find(generation);
	if (record == nullptr) {
		// Pruned from the ledger, so the pid it was taken for is no longer known and cannot be checked.
		return false;
	}
	// A pid reused by a different process after a restart is exactly the case this catches: the refs
	// would resolve against elements of a different application.
	return record->pid == pid;
}

bool AxWatch::NothingChangedSince(uint64_t generation, unsigned long pid) const {
	const AxSnapshotRecord* record = Find(generation);
	if (record == nullptr || record->pid != pid) {
		return false;
	}
	if (!record->watched) {
		// No watcher was running when the snapshot was taken, so there is no evidence either way. The
		// first axTreeDiff for an application always lands here, and the second one can answer properly.
		return false;
	}
	if (!watch_.Active() || watchedPid_ != pid) {
		// The watcher was stopped or moved since. Anything could have happened while it was not looking.
		return false;
	}
	if (watch_.Events() != record->eventCount) {
		return false;
	}
	// The safety net for the new-top-level-window gap documented in UiaEvents.h. Compared in order, so a
	// z-order change also counts as a change — it moves keyboard focus, which the tree reports.
	return FindAppWindowsForPid(pid) == record->windows;
}

} // namespace v3cu
