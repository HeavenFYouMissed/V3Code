/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Ambient observation: sampling one application on a timer.
//
// THIS IS THE MOST PRIVILEGED THING IN THE HELPER. Every other method observes because a tool call
// asked it to, right now, once. This one keeps observing after the tool call has returned. So the
// discipline here is not "be careful", it is a set of rules that hold even when the caller is buggy,
// malicious, or gone:
//
//   1. NOTHING IS CAPTURED UNTIL observeStart, and nothing after observeStop. There is no warm-up, no
//      speculative sampling, no cache primed "in case". A session that does not exist does no work.
//   2. stopAtMs IS MANDATORY AND ENFORCED HERE, not by the caller. It is the whole safety story: if
//      V3Code crashes, is force-quit, or loses the pipe, a running session must expire on its own rather
//      than keep sampling a user's screen with nobody left to stop it. The sampling thread checks it,
//      and so does every observeStatus, so an expired session cannot be reported as running even if the
//      thread is wedged.
//   3. A session is refused outright for V3Code's own process and for anything the tier classifier calls
//      `self`. Observing ourselves is never a legitimate request and is not made legitimate by a policy
//      decision on the other side of the pipe.
//   4. Bounds are enforced on everything the caller supplies: at most kMaxSessions sessions, an interval
//      clamped to a sane range, and a stop time clamped to at most kMaxGrantMs from now regardless of
//      what was asked for. The policy engine in common/computerUseObservation.ts decides what is
//      permitted; these are the limits that hold when it is wrong.
//
// WHAT A SAMPLE IS, AND WHAT IT IS NOT — READ THIS BEFORE ASSUMING THIS METHOD DELIVERS ANYTHING.
//
// Protocol 2 defines no way for the helper to deliver an observed sample. The wire is strictly
// request/response — every stdout line is a response correlated to a request id — and the three
// observe* methods all return ComputerUseObserveStatusResult, which carries counts and no content.
// There is no event envelope and no drain method.
//
// So a sample here performs the bounded accessibility read that proves the session is alive and able to
// observe, increments `samples`, and retains nothing. In particular it takes NO SCREENSHOT, even when
// `content` is `axTreeAndScreenshots`. That is a deliberate refusal, not an oversight: capturing the
// user's screen every interval and discarding the pixels because nothing can consume them would be pure
// privacy liability — real frames of a real screen, held in a helper's memory for up to eight hours,
// with no consumer to justify them. The session records and reports the `content` it was asked for
// truthfully, so a caller can see what it requested; it simply is not honoured yet.
//
// WHAT THE NEXT PHASE MUST DO: add a delivery path to the protocol (an unsolicited event line, or an
// `observeDrain` method), then decide retention deliberately — how many samples, for how long, and
// whether they touch disk (they must not). The one line to change is marked in Observation.cpp.
//
// Refs are never minted from a sample. That is not an optimisation: a sample runs on its own thread,
// concurrently with whatever the worker thread is doing, and minting into the shared ref table would
// mean an ambient timer could renumber the generation under an in-flight action.
//
// NEEDS VERIFICATION ON WINDOWS — THE WHOLE FILE, and specifically:
//   - THE EXPIRY. Start a session with stopAtMs a few seconds out, then kill V3Code (not the helper) and
//     confirm the session stops itself and the helper exits cleanly when stdin closes. This is the single
//     test that matters here; everything else is bookkeeping.
//   - That the sampling thread's own IUIAutomation instance works. It deliberately does NOT share
//     UiaClient's, because that object was created on the worker thread and IUIAutomation is not
//     documented as thread-safe. Both threads are in the MTA so COM would not marshal and would not
//     complain — which is exactly why this has to be got right by construction rather than by testing.
//   - That Shutdown() from Main.cpp really joins the thread, with no orphaned process left behind.
//   - Sampling cost against a large Electron window at a 1 s interval. If a sample is expensive, the
//     interval floor moves up.
//
#pragma once

#include "Apps.h"
#include "Json.h"
#include "Protocol.h"

#include <cstdint>
#include <string>
#include <vector>

namespace v3cu {

/// Concurrent sessions. Ambient observation of more than a handful of applications at once is not a
/// use case, it is a bug or an attack.
inline constexpr size_t kMaxObserveSessions = 4;

/// Sampling interval floor. Anything faster is a screen recorder, not an observation.
inline constexpr int kMinObserveIntervalMs = 250;

/// Sampling interval ceiling. Beyond this the session is not observing, it is idling.
inline constexpr int kMaxObserveIntervalMs = 60000;

/// COMPUTER_USE_OBSERVATION_MAX_GRANT_MS from common/computerUseObservation.ts. A stopAtMs further out
/// than this is clamped, not honoured.
inline constexpr int64_t kMaxObserveGrantMs = 8 * 60 * 60 * 1000;

/// Nodes one sample reads before it stops. A sample proves observability; it does not need the tree.
inline constexpr int kMaxObserveSampleNodes = 200;

/// Parsed ComputerUseObserveStartParams.
struct ObserveStartOptions {
	unsigned long pid = 0;
	std::string appId;
	int intervalMs = 1000;
	/// Epoch milliseconds. Mandatory — see rule 2 in the file header.
	int64_t stopAtMs = 0;
	/// True for `axTreeAndScreenshots`. Recorded and reported; NOT honoured — see the file header.
	bool screenshots = false;
	int maxLongEdge = 0;
	std::vector<unsigned long> excludePids;
};

class Observation {
public:
	static Observation& Instance();

	/// Starts, or replaces, the session for one pid. Returns false with `code`/`message` set when the
	/// request is refused.
	bool Start(const ObserveStartOptions& options, ErrorCode& code, std::string& message);

	/// Stops the session for `pid`, or every session when `all` is true.
	void Stop(bool all, unsigned long pid);

	/// ComputerUseObserveStatusResult. Prunes expired sessions first, so the answer is what is really
	/// running rather than what was last asked for.
	JsonValue Status();

	/// Stops every session and joins the sampling thread. Called when stdin closes.
	void Shutdown();

private:
	Observation() = default;
};

} // namespace v3cu
