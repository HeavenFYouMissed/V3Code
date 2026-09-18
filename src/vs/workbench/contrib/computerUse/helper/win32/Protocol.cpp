/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Envelope parsing and serialization. See Protocol.h.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - That fwrite to stdout with _O_BINARY produces exactly one '\n' per response.
//
#include "Protocol.h"

#include "Common.h"

#include <cstdio>
#include <mutex>

namespace v3cu {
namespace {

const std::string kEmptyString;

std::mutex& StdoutMutex() {
	static std::mutex mutex;
	return mutex;
}

} // namespace

const char* ErrorCodeToWire(ErrorCode code) {
	switch (code) {
		case ErrorCode::AccessibilityNotTrusted: return "accessibilityNotTrusted";
		case ErrorCode::ScreenRecordingNotGranted: return "screenRecordingNotGranted";
		case ErrorCode::PermissionDenied: return "permissionDenied";
		case ErrorCode::HelperMissing: return "helperMissing";
		case ErrorCode::HelperVersionMismatch: return "helperVersionMismatch";
		case ErrorCode::AppNotApproved: return "appNotApproved";
		case ErrorCode::AppTierForbidsAction: return "appTierForbidsAction";
		case ErrorCode::RefStale: return "refStale";
		case ErrorCode::TargetNotFound: return "targetNotFound";
		case ErrorCode::Timeout: return "timeout";
		case ErrorCode::Cancelled: return "cancelled";
		case ErrorCode::Internal: return "internal";
	}
	return "internal";
}

const char* DispatchMethodToWire(DispatchMethod method) {
	return method == DispatchMethod::Accessibility ? "accessibility" : "synthesized";
}

MethodOutcome MethodOutcome::Success(JsonValue result) {
	MethodOutcome outcome;
	outcome.ok = true;
	outcome.result = std::move(result);
	return outcome;
}

MethodOutcome MethodOutcome::Failure(ErrorCode code, std::string message) {
	MethodOutcome outcome;
	outcome.ok = false;
	outcome.error.code = code;
	outcome.error.message = std::move(message);
	return outcome;
}

MethodOutcome MethodOutcome::FailureRetryable(ErrorCode code, std::string message, bool retryable) {
	MethodOutcome outcome = Failure(code, std::move(message));
	outcome.error.retryable = retryable;
	outcome.error.hasRetryable = true;
	return outcome;
}

JsonValue MakeActionResult(DispatchMethod method) {
	JsonValue result = JsonValue::MakeObject();
	result.Set("ok", JsonValue::MakeBool(true));
	result.Set("method", JsonValue::MakeString(DispatchMethodToWire(method)));
	return result;
}

bool ParseRequestLine(const std::string& line, Request& out, std::string& errorMessage) {
	JsonValue parsed;
	if (!JsonValue::Parse(line, parsed, errorMessage)) {
		return false;
	}
	if (!parsed.IsObject()) {
		errorMessage = "request is not a JSON object";
		return false;
	}

	const JsonValue* id = parsed.Find("id");
	if (id == nullptr || !id->IsNumber()) {
		errorMessage = "request is missing a numeric id";
		return false;
	}
	const JsonValue* method = parsed.Find("method");
	if (method == nullptr || !method->IsString()) {
		errorMessage = "request is missing a string method";
		return false;
	}

	out.id = id->AsInt();
	out.hasId = true;
	out.method = method->AsString(kEmptyString);

	const JsonValue* params = parsed.Find("params");
	out.params = params != nullptr ? *params : JsonValue::MakeNull();

	const JsonValue* protocolVersion = parsed.Find("protocolVersion");
	out.protocolVersion = protocolVersion != nullptr ? protocolVersion->AsInt(0) : 0;
	return true;
}

std::string SerializeResponse(int64_t id, const MethodOutcome& outcome) {
	JsonValue envelope = JsonValue::MakeObject();
	envelope.Set("id", JsonValue::MakeInt(id));
	if (outcome.ok) {
		envelope.Set("ok", JsonValue::MakeBool(true));
		envelope.Set("result", outcome.result);
	} else {
		envelope.Set("ok", JsonValue::MakeBool(false));
		JsonValue error = JsonValue::MakeObject();
		error.Set("code", JsonValue::MakeString(ErrorCodeToWire(outcome.error.code)));
		error.Set("message", JsonValue::MakeString(outcome.error.message));
		if (outcome.error.hasRetryable) {
			error.Set("retryable", JsonValue::MakeBool(outcome.error.retryable));
		}
		envelope.Set("error", std::move(error));
	}
	return envelope.Serialize();
}

void WriteProtocolLine(const std::string& line) {
	std::lock_guard<std::mutex> guard(StdoutMutex());
	::fwrite(line.data(), 1, line.size(), stdout);
	::fputc('\n', stdout);
	::fflush(stdout);
}

} // namespace v3cu
