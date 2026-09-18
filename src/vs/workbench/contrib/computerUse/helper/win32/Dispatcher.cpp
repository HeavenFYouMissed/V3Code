/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Request routing implementation. See Dispatcher.h for the ordering rationale.
// NEEDS VERIFICATION ON WINDOWS:
//   - The tier gate refusing a `type` while a terminal is focused, end to end.
//   - That ping and status still answer when the caller's protocolVersion is wrong. This matters more
//     now than it did: the protocol version moved to 2, so a stale helper or a stale renderer is a case
//     that will actually be hit rather than a theoretical one.
//   - That the extra GetFrontmostApp call this adds to every input action is not a latency problem.
//   - That observeStart is refused for V3Code's own pid by the tier gate here, BEFORE Observation's own
//     self check ever runs. Both must refuse it; the second one existing is not a reason for the first to
//     be missing.
//   - That openApplication is NOT refused when there is no foreground application (an empty desktop,
//     or every window minimised). It is the one input-shaped method that must work from nothing.
//
#include "Dispatcher.h"

#include "Apps.h"
#include "Handlers.h"
#include "Log.h"

namespace v3cu {
namespace {

/// Methods that are answered regardless of the caller's protocol version, so a version mismatch is
/// diagnosable rather than opaque.
bool IsVersionExempt(const std::string& method) {
	return method == "ping" || method == "status";
}

/// Applies the helper-side tier check. Returns an empty outcome-shaped `allowed` result when the
/// method is permitted.
// Resolves which application a method would act on, for logging and for an honest TargetNotFound when
// there is nothing to act on. Authorises NOTHING — see the note at the return.
bool ResolveTarget(const Request& request, MethodOutcome& refusal) {
	const std::string& method = request.method;

	// capture names no single application, so it resolves no target.
	//
	// drag and mouseMove act on whatever is under the pointer, which is the frontmost application by
	// definition, so they resolve the same way the other input methods do.
	//
	// clipboardRead, clipboardWrite and openApplication are deliberately absent. The clipboard belongs
	// to the desktop rather than to any application, and openApplication is the one method whose whole
	// job is to act when the application it names is NOT in front — resolving the frontmost app for it
	// would refuse the call on a bare desktop, which is exactly when it is most useful.
	const bool checksFrontmost = method == "click" || method == "type" || method == "key" ||
		method == "scroll" || method == "drag" || method == "mouseMove";
	// Checked against the app being read: params.pid when given, otherwise the frontmost app.
	const bool checksAxTreeTarget =
		method == "axTree" || method == "axTreeDiff" || method == "settle";
	// Checked against a pid the contract makes REQUIRED, so there is no frontmost fallback: a missing pid
	// is a refusal, not a guess. observeStop and observeStatus are deliberately absent from every list —
	// stopping an observation and asking what is running must never be refused, for the same reason
	// `cancel` never is.
	const bool checksRequiredPid =
		method == "forceElectronAccessibility" || method == "observeStart";
	if (!checksFrontmost && !checksAxTreeTarget && !checksRequiredPid) {
		return true;
	}

	AppInfo app;
	if (checksRequiredPid) {
		const JsonValue* pid = request.params.Find("pid");
		if (pid == nullptr || !pid->IsNumber() || pid->AsInt() <= 0) {
			refusal = MethodOutcome::Failure(ErrorCode::Internal, "'" + method + "' requires a pid");
			return false;
		}
		if (!GetAppInfoForPid(static_cast<unsigned long>(pid->AsInt()), app)) {
			refusal = MethodOutcome::FailureRetryable(ErrorCode::TargetNotFound,
				"no process with pid " + std::to_string(pid->AsInt()), false);
			return false;
		}
	} else if (checksAxTreeTarget) {
		const JsonValue* pid = request.params.Find("pid");
		if (pid != nullptr && pid->IsNumber() && pid->AsInt() > 0) {
			if (!GetAppInfoForPid(static_cast<unsigned long>(pid->AsInt()), app)) {
				refusal = MethodOutcome::FailureRetryable(ErrorCode::TargetNotFound,
					"no process with pid " + std::to_string(pid->AsInt()), false);
				return false;
			}
		} else if (!GetFrontmostApp(app)) {
			refusal = MethodOutcome::FailureRetryable(ErrorCode::TargetNotFound,
				"there is no foreground application", true);
			return false;
		}
	} else if (!GetFrontmostApp(app)) {
		// Refusing rather than acting blind: an input action with no identifiable target app cannot
		// be tier-checked, and an untierable input action is exactly what the tiers exist to stop.
		refusal = MethodOutcome::FailureRetryable(ErrorCode::TargetNotFound,
			"there is no foreground application to act on", true);
		return false;
	}

	// Deliberately no policy check. Whether this application may be driven is the user's decision,
	// recorded as a grant that the renderer service holds and enforces before anything reaches this
	// pipe. The helper cannot see that grant, so any classification applied here could only contradict
	// the user's own choice — a terminal they deliberately granted typing on would be refused anyway.
	// Mirrors helper/darwin Dispatcher.swift, which drops the same check for the same reason.
	LogDebug("'" + method + "' targeting " + app.id + " (" + app.name + ")");
	return true;
}

} // namespace

MethodOutcome Dispatch(const Request& request) {
	if (!IsVersionExempt(request.method) && request.protocolVersion != kProtocolVersion) {
		return MethodOutcome::FailureRetryable(ErrorCode::HelperVersionMismatch,
			"helper speaks protocol version " + std::to_string(kProtocolVersion) +
				", caller sent " + std::to_string(request.protocolVersion),
			false);
	}

	MethodOutcome refusal;
	if (!ResolveTarget(request, refusal)) {
		return refusal;
	}

	const std::string& method = request.method;
	if (method == "ping") {
		return HandlePing();
	}
	if (method == "status") {
		return HandleStatus();
	}
	if (method == "capture") {
		return HandleCapture(request.params);
	}
	if (method == "click") {
		return HandleClick(request.params);
	}
	if (method == "type") {
		return HandleType(request.params);
	}
	if (method == "key") {
		return HandleKey(request.params);
	}
	if (method == "scroll") {
		return HandleScroll(request.params);
	}
	if (method == "cursorPosition") {
		return HandleCursorPosition();
	}
	if (method == "frontmostApp") {
		return HandleFrontmostApp();
	}
	if (method == "listApps") {
		return HandleListApps();
	}
	if (method == "axTree") {
		return HandleAxTree(request.params);
	}
	if (method == "axTreeDiff") {
		return HandleAxTreeDiff(request.params);
	}
	if (method == "settle") {
		return HandleSettle(request.params);
	}
	if (method == "forceElectronAccessibility") {
		return HandleForceElectronAccessibility(request.params);
	}
	if (method == "observeStart") {
		return HandleObserveStart(request.params);
	}
	if (method == "observeStop") {
		return HandleObserveStop(request.params);
	}
	if (method == "observeStatus") {
		return HandleObserveStatus();
	}
	if (method == "drag") {
		return HandleDrag(request.params);
	}
	if (method == "mouseMove") {
		return HandleMouseMove(request.params);
	}
	if (method == "clipboardRead") {
		return HandleClipboardRead();
	}
	if (method == "clipboardWrite") {
		return HandleClipboardWrite(request.params);
	}
	if (method == "openApplication") {
		return HandleOpenApplication(request.params);
	}
	if (method == "cancel") {
		// Normally answered on the reader thread the moment it arrives (see Main.cpp); this path
		// exists so a cancel that reaches the queue is still answered rather than dropped.
		return MethodOutcome::Success(MakeActionResult(DispatchMethod::Accessibility));
	}

	return MethodOutcome::Failure(ErrorCode::Internal, "unknown method '" + method + "'");
}

} // namespace v3cu
