/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Ambient observation implementation. Read Observation.h FIRST. The four rules there — nothing before
// start, stopAtMs enforced here, never self, everything the caller supplies is clamped — are the design,
// and the note about what a sample deliberately is not is the part most likely to be misread.
//
// NEEDS VERIFICATION ON WINDOWS (full list in Observation.h):
//   - Self-expiry after V3Code is killed. That is the test that matters.
//   - That the sampling thread's own IUIAutomation instance works and never touches UiaClient's.
//   - That Shutdown() joins cleanly on stdin EOF with no orphan left behind.
//
#include "Observation.h"

#include "AppTiers.h"
#include "Log.h"
#include "UiaClient.h"

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <thread>
#include <vector>

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {
namespace {

using Microsoft::WRL::ComPtr;

/// One running session, as ComputerUseObserveSession describes it.
struct Session {
	unsigned long pid = 0;
	std::string appId;
	int intervalMs = 1000;
	int64_t startedAt = 0;
	int64_t stopAtMs = 0;
	bool screenshots = false;
	uint64_t samples = 0;
	/// GetTickCount64 value of the next due sample. Ticks rather than epoch, so a system clock change
	/// cannot make a session sample in a tight loop.
	ULONGLONG nextDueTick = 0;
};

int64_t NowEpochMs() {
	// Epoch milliseconds, matching Date.now() on the other side of the pipe. stopAtMs is a wall-clock
	// instant negotiated with the policy engine, so it has to be compared against wall clock even though
	// scheduling uses ticks.
	const auto now = std::chrono::system_clock::now().time_since_epoch();
	return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

/// Process-wide observation state. A namespace-scope singleton rather than members on Observation so the
/// header does not have to expose a mutex, a thread and a condition variable to every file that includes
/// it.
struct State {
	std::mutex mutex;
	std::condition_variable wake;
	std::vector<Session> sessions;
	std::thread thread;
	bool running = false;
	bool stopping = false;
};

State& Shared() {
	static State state;
	return state;
}

/// Drops sessions whose stop time has passed. Caller holds the lock.
void PruneExpiredLocked(std::vector<Session>& sessions) {
	const int64_t now = NowEpochMs();
	for (size_t index = sessions.size(); index > 0; --index) {
		Session& session = sessions[index - 1];
		if (session.stopAtMs > now) {
			continue;
		}
		LogInfo("observation of " + session.appId + " (pid " + std::to_string(session.pid) +
			") expired after " + std::to_string(session.samples) + " samples");
		sessions.erase(sessions.begin() + static_cast<ptrdiff_t>(index - 1));
	}
}

JsonValue SerializeSession(const Session& session) {
	JsonValue json = JsonValue::MakeObject();
	json.Set("pid", JsonValue::MakeInt(static_cast<int64_t>(session.pid)));
	json.Set("appId", JsonValue::MakeString(session.appId));
	json.Set("startedAt", JsonValue::MakeInt(session.startedAt));
	json.Set("stopAtMs", JsonValue::MakeInt(session.stopAtMs));
	json.Set("intervalMs", JsonValue::MakeInt(session.intervalMs));
	json.Set("content",
		JsonValue::MakeString(session.screenshots ? "axTreeAndScreenshots" : "axTree"));
	json.Set("samples", JsonValue::MakeInt(static_cast<int64_t>(session.samples)));
	return json;
}

JsonValue SerializeStatusLocked(const std::vector<Session>& sessions) {
	JsonValue list = JsonValue::MakeArray();
	for (const Session& session : sessions) {
		list.Push(SerializeSession(session));
	}
	JsonValue result = JsonValue::MakeObject();
	result.Set("observing", JsonValue::MakeBool(!sessions.empty()));
	result.Set("sessions", std::move(list));
	return result;
}

/// Counts children breadth-first up to a cap. Deliberately shallow: a sample exists to prove the session
/// can still observe the application, not to produce a tree — nothing can consume a tree (Observation.h).
int CountSampleNodes(IUIAutomation* automation, IUIAutomationTreeWalker* walker, HWND window) {
	if (automation == nullptr || walker == nullptr || window == nullptr) {
		return 0;
	}
	ComPtr<IUIAutomationElement> root;
	if (FAILED(automation->ElementFromHandle(window, &root)) || !root) {
		return 0;
	}

	int counted = 1;
	std::vector<ComPtr<IUIAutomationElement>> frontier;
	frontier.push_back(root);
	while (!frontier.empty() && counted < kMaxObserveSampleNodes) {
		ComPtr<IUIAutomationElement> current = frontier.back();
		frontier.pop_back();

		ComPtr<IUIAutomationElement> child;
		if (FAILED(walker->GetFirstChildElement(current.Get(), &child)) || !child) {
			continue;
		}
		while (child && counted < kMaxObserveSampleNodes) {
			++counted;
			frontier.push_back(child);
			ComPtr<IUIAutomationElement> sibling;
			if (FAILED(walker->GetNextSiblingElement(child.Get(), &sibling)) || !sibling) {
				break;
			}
			child = sibling;
		}
	}
	return counted;
}

void SampleLoop() {
	// This thread's own apartment and its own automation object. It must not use UiaClient::Instance(),
	// which belongs to the worker thread — see the note in Observation.h.
	ComApartment apartment;
	if (!apartment.Ok()) {
		LogError("observation thread could not initialize COM; sessions will not sample");
	}

	ComPtr<IUIAutomation> automation;
	ComPtr<IUIAutomationTreeWalker> walker;
	if (apartment.Ok()) {
		if (FAILED(::CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
				IID_PPV_ARGS(&automation))) ||
			!automation) {
			LogWarn("observation thread could not create a UI Automation client");
		} else if (FAILED(automation->get_ControlViewWalker(&walker))) {
			walker.Reset();
		}
	}

	State& state = Shared();
	for (;;) {
		std::vector<unsigned long> due;
		{
			std::unique_lock<std::mutex> guard(state.mutex);
			if (state.stopping) {
				return;
			}

			PruneExpiredLocked(state.sessions);
			if (state.sessions.empty()) {
				// Nothing to do and nothing scheduled. Wait to be woken by a Start or by Shutdown rather
				// than spinning on an empty list.
				state.wake.wait(guard, [&state]() { return state.stopping || !state.sessions.empty(); });
				if (state.stopping) {
					return;
				}
				continue;
			}

			const ULONGLONG now = ::GetTickCount64();
			ULONGLONG nextDue = now + static_cast<ULONGLONG>(kMaxObserveIntervalMs);
			for (Session& session : state.sessions) {
				if (session.nextDueTick <= now) {
					due.push_back(session.pid);
					session.nextDueTick = now + static_cast<ULONGLONG>(session.intervalMs);
				}
				if (session.nextDueTick < nextDue) {
					nextDue = session.nextDueTick;
				}
			}

			if (due.empty()) {
				const ULONGLONG waitMs = nextDue > now ? nextDue - now : 1;
				state.wake.wait_for(guard, std::chrono::milliseconds(waitMs));
				continue;
			}
		}

		// Sampled with the lock released: a UIA round-trip into a hung application must not block
		// observeStop.
		for (const unsigned long pid : due) {
			const HWND window = FindMainWindowForPid(pid);
			if (window == nullptr) {
				// The application closed its windows. Not an error and not a reason to stop the session:
				// stopAtMs and the caller decide when a session ends, not a transiently window-less app.
				continue;
			}
			const int nodes = CountSampleNodes(automation.Get(), walker.Get(), window);

			// >>> THIS IS WHERE THE NEXT PHASE HOOKS IN. When the protocol grows a delivery path, the
			// sample's content is produced here — the accessibility tree, and a capture for a session whose
			// content includes screenshots — and handed to that path. Until then nothing is produced and
			// nothing is retained, deliberately; see Observation.h. A `0 nodes` line here every interval
			// means this thread has no working UI Automation client, which is worth knowing.
			LogDebug("observation sample: pid " + std::to_string(pid) + ", " + std::to_string(nodes) +
				" nodes visible");

			std::lock_guard<std::mutex> guard(state.mutex);
			for (Session& session : state.sessions) {
				if (session.pid == pid) {
					// Counts ATTEMPTS, which is what the contract needs it for: telling a live session from a
					// wedged one. A sample that read nothing still proves the timer is running, and the debug
					// line above is what says whether it read anything.
					++session.samples;
					break;
				}
			}
		}
	}
}

} // namespace

Observation& Observation::Instance() {
	static Observation observation;
	return observation;
}

bool Observation::Start(const ObserveStartOptions& options, ErrorCode& code, std::string& message) {
	if (options.pid == 0) {
		code = ErrorCode::Internal;
		message = "observeStart requires a pid";
		return false;
	}
	if (options.pid == static_cast<unsigned long>(::GetCurrentProcessId())) {
		// Not policy: the helper is a background process with no window, so observing it samples nothing
		// forever. Refusing is a correctness answer, not a permission one.
		code = ErrorCode::TargetNotFound;
		message = "the helper has no window to observe";
		return false;
	}

	AppInfo app;
	if (!GetAppInfoForPid(options.pid, app)) {
		code = ErrorCode::TargetNotFound;
		message = "no process with pid " + std::to_string(options.pid);
		return false;
	}
	// No check for "is this V3Code". Observing V3Code's own window is a poor idea — the agent reads its
	// own output back — but it is discouraged at the approval prompt rather than forbidden here, because
	// the grant is the user's to make. Mirrors helper/darwin Observation.swift.

	if (FindMainWindowForPid(options.pid) == nullptr) {
		code = ErrorCode::TargetNotFound;
		message = "application " + app.id + " has no visible top-level window";
		return false;
	}

	const int64_t now = NowEpochMs();
	if (options.stopAtMs <= now) {
		// Mandatory and load-bearing: a session with no future stop time is a session nothing can be
		// relied upon to end.
		code = ErrorCode::Internal;
		message = "observeStart requires a stopAtMs in the future";
		return false;
	}

	Session session;
	session.pid = options.pid;
	session.appId = options.appId.empty() ? app.id : options.appId;
	session.intervalMs = Clamp(options.intervalMs, kMinObserveIntervalMs, kMaxObserveIntervalMs);
	session.startedAt = now;
	// Clamped, not trusted. Rule 4.
	session.stopAtMs = options.stopAtMs > now + kMaxObserveGrantMs ? now + kMaxObserveGrantMs
																  : options.stopAtMs;
	session.screenshots = options.screenshots;
	session.nextDueTick = ::GetTickCount64();

	if (session.screenshots) {
		// Said out loud, in the log the user's bug report will contain, rather than only in a header
		// comment: the request is recorded but screenshots are not taken. See Observation.h.
		LogWarn("observeStart asked for screenshots of " + session.appId +
			"; protocol 2 has no way to deliver a sample, so no screenshot is captured");
	}
	if (!options.excludePids.empty() || options.maxLongEdge > 0) {
		LogDebug("observeStart screenshot options ignored: no screenshot is captured");
	}

	State& state = Shared();
	{
		std::lock_guard<std::mutex> guard(state.mutex);
		PruneExpiredLocked(state.sessions);

		bool replaced = false;
		for (Session& existing : state.sessions) {
			if (existing.pid == session.pid) {
				// One session per application. Restarting is how a caller extends or narrows a grant, and
				// two sessions for one pid would sample it twice and report it twice.
				existing = session;
				replaced = true;
				break;
			}
		}
		if (!replaced) {
			if (state.sessions.size() >= kMaxObserveSessions) {
				code = ErrorCode::PermissionDenied;
				message = "at most " + std::to_string(kMaxObserveSessions) +
					" applications may be observed at once";
				return false;
			}
			state.sessions.push_back(session);
		}

		if (!state.running) {
			state.running = true;
			state.stopping = false;
			state.thread = std::thread(SampleLoop);
		}
	}
	state.wake.notify_all();

	LogInfo("observing " + session.appId + " (pid " + std::to_string(session.pid) + ") every " +
		std::to_string(session.intervalMs) + "ms until epoch " + std::to_string(session.stopAtMs));
	return true;
}

void Observation::Stop(bool all, unsigned long pid) {
	State& state = Shared();
	{
		std::lock_guard<std::mutex> guard(state.mutex);
		if (all) {
			if (!state.sessions.empty()) {
				LogInfo("stopping all " + std::to_string(state.sessions.size()) +
					" observation session(s)");
			}
			state.sessions.clear();
		} else {
			for (size_t index = 0; index < state.sessions.size(); ++index) {
				if (state.sessions[index].pid == pid) {
					LogInfo("stopping observation of " + state.sessions[index].appId);
					state.sessions.erase(state.sessions.begin() + static_cast<ptrdiff_t>(index));
					break;
				}
			}
		}
	}
	state.wake.notify_all();
}

JsonValue Observation::Status() {
	State& state = Shared();
	std::lock_guard<std::mutex> guard(state.mutex);
	// Pruned before reporting, so an expired session can never be reported as running — not even if the
	// sampling thread is stuck inside a UIA call. observeStatus is the reconciliation input for the
	// service, so it has to be true at the moment it is asked, not eventually.
	PruneExpiredLocked(state.sessions);
	return SerializeStatusLocked(state.sessions);
}

void Observation::Shutdown() {
	State& state = Shared();
	std::thread thread;
	{
		std::lock_guard<std::mutex> guard(state.mutex);
		state.sessions.clear();
		state.stopping = true;
		thread = std::move(state.thread);
		state.running = false;
	}
	state.wake.notify_all();
	if (thread.joinable()) {
		thread.join();
	}
}

} // namespace v3cu
