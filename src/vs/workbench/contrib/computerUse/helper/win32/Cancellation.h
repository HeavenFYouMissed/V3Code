/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Cooperative cancellation for in-flight actions.
//
// `cancel` arrives on the reader thread while the worker thread is inside a UIA call. It cannot
// interrupt a blocking COM call, so instead it raises this flag and every loop in the helper
// checks it between steps: per keystroke while typing, per tick while scrolling, per node while
// walking the tree, per retry while capturing. Worst case the caller waits for one in-flight
// COM call, which is bounded by the UIA timeout.
//
// A cancel marks the diff BASELINE unreliable rather than invalidating refs (protocol 2 — see the
// long note in Cancellation.cpp and the rules in RefTable.h). A cancelled read leaves the caller with
// an unclear view of the screen, so the next axTreeDiff must send a full tree; but the refs stay
// dispatchable because RefTable::Resolve re-verifies each one against the live element anyway.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - That a long `type` really does abort promptly: measure the latency between writing a
//     cancel request and the type response arriving.
//
#pragma once

#include <atomic>

namespace v3cu {

/// Process-wide cancellation flag. One in-flight action at a time, so one flag suffices.
class Cancellation {
public:
	/// Raised by the reader thread when a `cancel` request arrives.
	static void Request();

	/// Cleared by the worker thread before it begins a new request.
	static void Reset();

	/// True when a cancel has been requested and not yet cleared.
	static bool IsRequested();

private:
	static std::atomic<bool> requested_;
};

} // namespace v3cu
