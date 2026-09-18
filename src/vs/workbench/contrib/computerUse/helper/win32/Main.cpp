/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Entry point: newline-delimited JSON on stdin, newline-delimited JSON on stdout, logs on stderr.
//
// TWO THREADS, and the reason is `cancel`.
//
// A single-threaded loop cannot answer a cancel: it is inside the action the caller wants to
// cancel. So the main thread does nothing but read lines, and a worker thread executes requests one
// at a time. A `cancel` line is answered on the reading thread immediately — it raises the
// cancellation flag, which every loop in the helper polls, and it invalidates outstanding refs. All
// other requests go on a queue and are executed strictly in order, one at a time, so no two actions
// ever interleave on the machine.
//
// The worker thread owns the COM apartment and therefore every UIA object. The reader thread must
// never touch a COM interface; see the note in RefTable::MarkBaselineUnreliable, which is called from
// the reader thread on a cancel and touches nothing but atomics for exactly that reason.
//
// A THIRD THREAD EXISTS, conditionally: ambient observation runs its own sampling thread with its own
// COM apartment and its own UI Automation object, created on the first observeStart and joined by
// Observation::Shutdown when stdin closes. It shares no COM pointer with the worker. See Observation.h.
//
// stdout is opened in binary mode so a '\n' is written as one byte. Without that, the CRT would
// translate it to "\r\n" and every response line would carry a stray carriage return.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - The whole stdio path: binary mode, that std::getline sees a complete line, and that a
//     response arrives as exactly one line with no trailing CR.
//   - Clean shutdown when V3Code closes the pipe: stdin hits EOF, the worker drains, the process
//     exits 0. Confirm no orphaned process is left behind.
//   - Cancel latency while a long `type` is in flight.
//   - THE OBSERVATION SHUTDOWN PATH, which is the one that matters most in this file now: start an
//     ambient observation session, then close the pipe, and confirm the sampling thread stops, the
//     process exits 0, and nothing is left sampling the user's screen. An orphaned helper with a live
//     observation session is the worst failure this feature could have.
//   - That AxWatch::StopWatching at the end of WorkerLoop does not hang. It unregisters UIA event
//     handlers, and unregistering while a callback is in flight is a documented deadlock (UiaEvents.h).
//   - That an unhandled Win32 structured exception (an access violation inside a third-party UIA
//     provider, which does happen) does not take the helper down silently. The catch(...) below
//     does NOT catch SEH by default; adding /EHa was considered and rejected as too blunt. The
//     service must be prepared to restart the helper.
//
#include "AxWatch.h"
#include "Cancellation.h"
#include "Common.h"
#include "Dispatcher.h"
#include "Dpi.h"
#include "Log.h"
#include "Observation.h"
#include "Protocol.h"
#include "UiaClient.h"

#include <condition_variable>
#include <deque>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

namespace v3cu {
namespace {

/// A line longer than this is not a request the helper will ever be sent legitimately; refusing it
/// keeps a runaway writer from exhausting memory.
constexpr size_t kMaxRequestLineBytes = 8u * 1024u * 1024u;

class RequestQueue {
public:
	void Push(Request request) {
		{
			std::lock_guard<std::mutex> guard(mutex_);
			queue_.push_back(std::move(request));
		}
		condition_.notify_one();
	}

	/// Blocks until a request is available or the queue is closed. Returns false once closed and
	/// drained.
	bool Pop(Request& out) {
		std::unique_lock<std::mutex> guard(mutex_);
		condition_.wait(guard, [this]() { return closed_ || !queue_.empty(); });
		if (queue_.empty()) {
			return false;
		}
		out = std::move(queue_.front());
		queue_.pop_front();
		return true;
	}

	void Close() {
		{
			std::lock_guard<std::mutex> guard(mutex_);
			closed_ = true;
		}
		condition_.notify_all();
	}

private:
	std::mutex mutex_;
	std::condition_variable condition_;
	std::deque<Request> queue_;
	bool closed_ = false;
};

void WorkerLoop(RequestQueue& queue) {
	// The apartment, and therefore every UIA object, belongs to this thread for the process
	// lifetime.
	ComApartment apartment;
	if (!apartment.Ok()) {
		LogError("worker thread could not initialize COM; UIA methods will fail");
	}

	Request request;
	while (queue.Pop(request)) {
		// Cleared per request. A cancel that arrives between two requests is therefore discarded
		// rather than cancelling the next one, which is the behaviour a caller expects.
		Cancellation::Reset();

		MethodOutcome outcome;
		try {
			outcome = Dispatch(request);
		} catch (const std::exception& exception) {
			outcome = MethodOutcome::Failure(ErrorCode::Internal,
				std::string("unhandled exception: ") + exception.what());
		} catch (...) {
			outcome = MethodOutcome::Failure(ErrorCode::Internal, "unhandled exception");
		}

		WriteProtocolLine(SerializeResponse(request.id, outcome));
	}

	// Unregister the change watcher HERE, on the thread that registered it and while its apartment is
	// still alive. Doing it from the reader thread after this one exits would release UIA interface
	// pointers on a thread with no COM apartment.
	AxWatch::Instance().StopWatching();
}

int Run() {
	InitLogFromEnvironment();

	// Binary mode on both ends: no CRLF translation in either direction.
	if (::_setmode(::_fileno(stdout), _O_BINARY) == -1) {
		LogError("could not set stdout to binary mode; responses may carry stray carriage returns");
	}
	if (::_setmode(::_fileno(stdin), _O_BINARY) == -1) {
		LogError("could not set stdin to binary mode");
	}

	const std::string awareness = EnsurePerMonitorV2Awareness();
	LogInfo(std::string("v3code-computer-use ") + kHelperVersion + " protocol " +
		std::to_string(kProtocolVersion) + " dpi-awareness " + awareness);

	RequestQueue queue;
	std::thread worker([&queue]() { WorkerLoop(queue); });

	std::string line;
	while (std::getline(std::cin, line)) {
		// The line was split on '\n'; a '\r' from a CRLF writer would still be attached.
		if (!line.empty() && line.back() == '\r') {
			line.pop_back();
		}
		if (line.empty()) {
			continue;
		}
		if (line.size() > kMaxRequestLineBytes) {
			LogError("dropping a request line of " + std::to_string(line.size()) + " bytes");
			continue;
		}

		Request request;
		std::string parseError;
		if (!ParseRequestLine(line, request, parseError)) {
			// No usable id, so no response can be correlated. Logging is the only honest option;
			// inventing an id would make the caller resolve the wrong pending request.
			LogError("unparseable request: " + parseError);
			continue;
		}

		if (request.method == "cancel") {
			// Answered here rather than on the queue: the worker is busy with the very action being
			// cancelled.
			Cancellation::Request();
			MethodOutcome outcome =
				MethodOutcome::Success(MakeActionResult(DispatchMethod::Accessibility));
			WriteProtocolLine(SerializeResponse(request.id, outcome));
			continue;
		}

		queue.Push(std::move(request));
	}

	LogInfo("stdin closed; draining and exiting");
	queue.Close();
	worker.join();
	// After the worker, because a queued observeStart must not be able to start a session the moment after
	// it was told to stop. Losing the pipe is exactly the case ambient observation must not survive.
	Observation::Instance().Shutdown();
	return 0;
}

} // namespace
} // namespace v3cu

int main() {
	return v3cu::Run();
}
