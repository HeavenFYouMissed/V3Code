/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// The wire envelope: ComputerUseRequest in, ComputerUseSuccessResponse or
// ComputerUseErrorResponse out. Mirrors computerUseTypes.ts exactly.
//
// Every handler returns a MethodOutcome, which is either a result JsonValue or a typed error.
// Nothing else in the helper is allowed to write to stdout.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - stdout must be in binary mode so a '\n' is not translated to "\r\n". _setmode is called
//     in Main.cpp; if that were missed, every line would carry a stray CR. Untested.
//
#pragma once

#include "Json.h"

#include <string>

namespace v3cu {

/// The ComputerUseErrorCode string union, one enumerator per member.
enum class ErrorCode {
	AccessibilityNotTrusted,
	ScreenRecordingNotGranted,
	PermissionDenied,
	HelperMissing,
	HelperVersionMismatch,
	AppNotApproved,
	AppTierForbidsAction,
	RefStale,
	TargetNotFound,
	Timeout,
	Cancelled,
	Internal,
};

/// The exact wire string for an error code.
const char* ErrorCodeToWire(ErrorCode code);

/// How an action was dispatched. Mirrors ComputerUseDispatchMethod.
enum class DispatchMethod {
	Accessibility,
	Synthesized,
};

const char* DispatchMethodToWire(DispatchMethod method);

/// A typed failure, serialized as ComputerUseError.
struct MethodError {
	ErrorCode code = ErrorCode::Internal;
	std::string message;
	/// Emitted as `retryable` only when `hasRetryable` is true, so the field is omitted rather
	/// than sent as null when the helper has no opinion.
	bool retryable = false;
	bool hasRetryable = false;
};

/// The outcome of one method call.
struct MethodOutcome {
	bool ok = false;
	JsonValue result;
	MethodError error;

	static MethodOutcome Success(JsonValue result);
	static MethodOutcome Failure(ErrorCode code, std::string message);
	static MethodOutcome FailureRetryable(ErrorCode code, std::string message, bool retryable);
};

/// Builds the ComputerUseActionResult body: `{ "ok": true, "method": "..." }`.
JsonValue MakeActionResult(DispatchMethod method);

/// A parsed request line.
struct Request {
	int64_t id = 0;
	std::string method;
	JsonValue params;
	int64_t protocolVersion = 0;
	bool hasId = false;
};

/// Parses one stdin line. Returns false with `errorMessage` set when the line is not a valid
/// request envelope.
bool ParseRequestLine(const std::string& line, Request& out, std::string& errorMessage);

/// Serializes a success or error response envelope for `id`.
std::string SerializeResponse(int64_t id, const MethodOutcome& outcome);

/// Writes one protocol line to stdout followed by '\n' and flushes. Thread-safe: the reader
/// thread answers `cancel` while the worker thread answers everything else.
void WriteProtocolLine(const std::string& line);

} // namespace v3cu
