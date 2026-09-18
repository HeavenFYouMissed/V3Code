/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Cancellation flag implementation. See Cancellation.h.
//
// NEEDS VERIFICATION ON WINDOWS: nothing platform-specific.
//
#include "Cancellation.h"

#include "Log.h"
#include "RefTable.h"

namespace v3cu {

std::atomic<bool> Cancellation::requested_{false};

void Cancellation::Request() {
	requested_.store(true, std::memory_order_release);
	// PROTOCOL 2: mark the diff baseline unreliable instead of invalidating every ref.
	//
	// A cancelled walk leaves the caller with a half-read snapshot, so that snapshot must not be used
	// as a diff baseline — the next axTreeDiff answers `baselineComparable: false` and sends a full
	// tree. But the refs themselves stay dispatchable, because what protects a dispatch from landing on
	// the wrong element is the live fingerprint re-check in RefTable::Resolve, not the generation
	// number. Invalidating everything here (which is what protocol 1 did, correctly for protocol 1)
	// would make every Escape cost a full re-read while protecting against nothing Resolve does not
	// already catch.
	RefTable::Instance().MarkBaselineUnreliable();
	LogInfo("cancel requested: diff baseline marked unreliable");
}

void Cancellation::Reset() {
	requested_.store(false, std::memory_order_release);
}

bool Cancellation::IsRequested() {
	return requested_.load(std::memory_order_acquire);
}

} // namespace v3cu
