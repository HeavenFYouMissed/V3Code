/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Method handlers. See Handlers.h for the failure-to-error-code mapping.
// NEEDS VERIFICATION ON WINDOWS (full list in Handlers.h):
//   - Every handler's happy path, and that each error code is actually reachable.
//   - That the capture result matches ComputerUseCaptureResult field for field, including the new
//     `display` object and the omission of nothing that is required.
//   - The accessibility-vs-synthesized split reported by click/type/scroll against real apps; that
//     ratio is the health metric for the feature.
//   - The protocol-3 handlers: drag, mouseMove, clipboardRead, clipboardWrite, openApplication.
//     Per-method list in Handlers.h; the launch and clipboard specifics are in Apps.h and in the
//     ClipboardScope comment below.
//
#include "Handlers.h"

#include "Apps.h"
#include "AxTree.h"
#include "Base64.h"
#include "Cancellation.h"
#include "Capture.h"
#include "GdiCapture.h"
#include "Log.h"
#include "Observation.h"
#include "Settle.h"
#include "SynthesizedInput.h"
#include "Targets.h"
#include "UiaActions.h"
#include "UiaClient.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace v3cu {
namespace {

const std::string kEmptyString;

/// COMPUTER_USE_DEFAULT_MAX_LONG_EDGE from computerUseTypes.ts.
constexpr int kDefaultMaxLongEdge = 1080;

/// COMPUTER_USE_DEFAULT_FORCE_ACCESSIBILITY_TIMEOUT_MS from computerUseTypes.ts.
constexpr int kDefaultForceAccessibilityTimeoutMs = 1000;

// Defaults for the three optional protocol-3 timings. The contract names no constants for any of
// them, so these are matched to helper/darwin's Dispatcher.swift rather than chosen independently:
// the same request must behave the same on both platforms, and a caller that omits the field is
// exactly the caller who would never notice the difference until it broke something.

/// ComputerUseDragParams.durationMs: "a short humane glide". Long enough that a 60Hz application
/// samples the pointer around fifteen times during the movement.
constexpr int kDefaultDragDurationMs = 250;

/// ComputerUseMouseMoveParams.settleMs. Zero: a caller that wants to wait for hover UI says so, and
/// the tool layer does. Dwelling by default would silently add a quarter of a second to every
/// pointer move.
constexpr int kDefaultMouseMoveSettleMs = 0;

/// ComputerUseOpenApplicationParams.waitMs: "a few seconds". A cold launch of a large application
/// exceeds this, which is why the result reports `frontmost` honestly instead of failing.
constexpr int kDefaultOpenApplicationWaitMs = 5000;

/// Attempts to open the clipboard before giving up. Another process holding it is normal and
/// transient — every clipboard manager on the machine grabs it on every copy.
constexpr int kClipboardOpenAttempts = 10;
constexpr DWORD kClipboardRetryDelayMs = 20;

/// Opens the clipboard for the life of the scope and closes it on EVERY exit path.
///
/// This is why it is a type rather than two calls: a leaked clipboard lock wedges copy and paste
/// for the whole desktop until this process exits, and there is no way for the user to work out
/// why. An early return on an error path is exactly how that happens.
class ClipboardScope {
public:
	ClipboardScope() {
		for (int attempt = 0; attempt < kClipboardOpenAttempts; ++attempt) {
			if (::OpenClipboard(nullptr) != FALSE) {
				open_ = true;
				return;
			}
			::Sleep(kClipboardRetryDelayMs);
		}
		LogWarn("clipboard: OpenClipboard failed after " + std::to_string(kClipboardOpenAttempts) +
			" attempts, GetLastError=" +
			std::to_string(static_cast<unsigned long>(::GetLastError())));
	}
	~ClipboardScope() {
		if (open_) {
			::CloseClipboard();
		}
	}
	ClipboardScope(const ClipboardScope&) = delete;
	ClipboardScope& operator=(const ClipboardScope&) = delete;

	bool IsOpen() const { return open_; }

private:
	bool open_ = false;
};

/// True when the clipboard advertises a format that is not one of the text formats.
///
/// Used only to tell "the clipboard is empty" apart from "the clipboard holds an image or a file
/// drop", which is a distinction the caller cannot otherwise make from an empty string.
bool ClipboardHasNonTextFormat() {
	UINT format = 0;
	while ((format = ::EnumClipboardFormats(format)) != 0) {
		switch (format) {
			case CF_TEXT:
			case CF_OEMTEXT:
			case CF_UNICODETEXT:
			case CF_LOCALE:
			case CF_DSPTEXT:
				break;
			default:
				return true;
		}
	}
	return false;
}

/// Reads CF_UNICODETEXT. The clipboard must already be open. Returns the text and its length in
/// UTF-16 code units, which is what a JavaScript caller's `text.length` will agree with.
bool ReadClipboardUnicodeText(std::string& text, size_t& lengthInCharacters) {
	if (::IsClipboardFormatAvailable(CF_UNICODETEXT) == FALSE) {
		return false;
	}
	// Owned by the clipboard. Never GlobalFree this handle.
	const HANDLE handle = ::GetClipboardData(CF_UNICODETEXT);
	if (handle == nullptr) {
		LogWarn("clipboard: GetClipboardData(CF_UNICODETEXT) returned null despite the format being "
			"available, GetLastError=" +
			std::to_string(static_cast<unsigned long>(::GetLastError())));
		return false;
	}
	const auto* locked = static_cast<const wchar_t*>(::GlobalLock(handle));
	if (locked == nullptr) {
		return false;
	}
	const std::wstring wide(locked);
	::GlobalUnlock(handle);

	lengthInCharacters = wide.size();
	text = WideToUtf8(wide);
	return true;
}

/// Resolves one end of a drag to a physical screen point.
bool ResolveDragPoint(const JsonValue& params, const char* key, POINT& out, ErrorCode& code,
	std::string& message) {
	const JsonValue* target = params.Find(key);
	if (target == nullptr) {
		code = ErrorCode::TargetNotFound;
		message = std::string("drag requires a '") + key + "' target";
		return false;
	}
	ResolvedTarget resolved;
	if (!ResolveTarget(*target, resolved, code, message)) {
		if (message.empty()) {
			message = std::string("drag '") + key + "' target could not be resolved";
		}
		return false;
	}
	if (!resolved.hasPoint) {
		// A ref whose element reports no bounding rectangle. There is nowhere to press, and
		// guessing a point would drag from somewhere the caller never asked for.
		code = ErrorCode::TargetNotFound;
		message = std::string("the drag '") + key + "' target has no on-screen position";
		return false;
	}
	out = resolved.point;
	return true;
}

MethodOutcome CancelledOutcome() {
	return MethodOutcome::FailureRetryable(ErrorCode::Cancelled, "the action was cancelled", false);
}

/// Shared by axTree and axTreeDiff, which take the same parameters.
AxTreeOptions ParseAxTreeOptions(const JsonValue& params) {
	AxTreeOptions options;
	if (const JsonValue* pid = params.Find("pid")) {
		if (pid->IsNumber() && pid->AsInt() > 0) {
			options.hasPid = true;
			options.pid = static_cast<unsigned long>(pid->AsInt());
		}
	}
	if (const JsonValue* maxDepth = params.Find("maxDepth")) {
		if (maxDepth->IsNumber() && maxDepth->AsInt() > 0) {
			options.maxDepth = static_cast<int>(maxDepth->AsInt());
		}
	}
	return options;
}

MethodOutcome AxTreeFailure(ErrorCode code, const std::string& message) {
	const bool retryable = code == ErrorCode::TargetNotFound || code == ErrorCode::Timeout;
	return MethodOutcome::FailureRetryable(code, message, retryable);
}

/// Parses the optional modifiers array.
unsigned int ParseModifiers(const JsonValue& params) {
	unsigned int modifiers = kModifierNone;
	const JsonValue* list = params.Find("modifiers");
	if (list == nullptr || !list->IsArray()) {
		return modifiers;
	}
	for (const JsonValue& entry : list->AsArray()) {
		modifiers |= ParseModifierName(entry.AsString(kEmptyString));
	}
	return modifiers;
}

} // namespace

MethodOutcome HandlePing() {
	JsonValue result = JsonValue::MakeObject();
	result.Set("protocolVersion", JsonValue::MakeInt(kProtocolVersion));
	result.Set("platform", JsonValue::MakeString("win32"));
	result.Set("helperVersion", JsonValue::MakeString(kHelperVersion));
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleStatus() {
	// `status` must never fail: its whole job is to report what is broken.
	std::string uiaError;
	const bool uiaAvailable = UiaClient::Instance().Initialize(uiaError);
	if (!uiaAvailable) {
		LogWarn("status: UIA unavailable: " + uiaError);
	}
	const bool captureAvailable = ProbeCaptureAvailable();

	JsonValue result = JsonValue::MakeObject();
	// `installed` is trivially true from inside the running helper; the service uses it to
	// distinguish "no helper on disk" from "helper answered".
	result.Set("installed", JsonValue::MakeBool(true));
	result.Set("protocolVersion", JsonValue::MakeInt(kProtocolVersion));
	// Windows has no accessibility trust prompt: any process may be a UIA client. This therefore
	// reports whether the UIA client object could be created. The real restriction is integrity
	// level, which cannot be probed without a target window.
	result.Set("accessibilityTrusted", JsonValue::MakeBool(uiaAvailable));
	// Windows has no screen-recording permission either. This reports whether a capture is
	// currently possible at all, which is false on the secure desktop or a locked session.
	result.Set("screenRecordingGranted", JsonValue::MakeBool(captureAvailable));
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleCapture(const JsonValue& params) {
	CaptureOptions options;
	options.maxLongEdge = kDefaultMaxLongEdge;

	if (const JsonValue* displayId = params.Find("displayId")) {
		if (displayId->IsNumber()) {
			options.hasDisplayId = true;
			options.displayId = static_cast<int>(displayId->AsInt());
		}
	}
	if (const JsonValue* maxLongEdge = params.Find("maxLongEdge")) {
		if (maxLongEdge->IsNumber()) {
			const int requested = static_cast<int>(maxLongEdge->AsInt());
			if (requested > 0) {
				options.maxLongEdge = requested;
			}
		}
	}
	if (const JsonValue* excludePids = params.Find("excludePids")) {
		for (const JsonValue& entry : excludePids->AsArray()) {
			if (entry.IsNumber()) {
				const int64_t pid = entry.AsInt();
				if (pid > 0) {
					options.excludePids.push_back(static_cast<unsigned long>(pid));
				}
			}
		}
	}

	CaptureOutput output;
	std::string error;
	bool permissionProblem = false;
	if (!CaptureScreen(options, output, error, permissionProblem)) {
		if (Cancellation::IsRequested()) {
			return CancelledOutcome();
		}
		if (permissionProblem) {
			return MethodOutcome::FailureRetryable(ErrorCode::ScreenRecordingNotGranted, error, true);
		}
		return MethodOutcome::FailureRetryable(ErrorCode::Internal, error, true);
	}

	JsonValue excluded = JsonValue::MakeArray();
	for (const unsigned long pid : output.excludedPids) {
		excluded.Push(JsonValue::MakeInt(static_cast<int64_t>(pid)));
	}

	// ComputerUseCaptureDisplay. bounds is the display's FULL physical size and origin on the
	// virtual desktop, which is what the service needs to invert a model coordinate; width/height
	// below are the image size and are smaller whenever scale < 1.
	JsonValue bounds = JsonValue::MakeObject();
	bounds.Set("x", JsonValue::MakeInt(output.display.bounds.x));
	bounds.Set("y", JsonValue::MakeInt(output.display.bounds.y));
	bounds.Set("width", JsonValue::MakeInt(output.display.bounds.width));
	bounds.Set("height", JsonValue::MakeInt(output.display.bounds.height));
	JsonValue display = JsonValue::MakeObject();
	display.Set("displayId", JsonValue::MakeInt(output.display.displayId));
	display.Set("bounds", std::move(bounds));

	JsonValue result = JsonValue::MakeObject();
	result.Set("width", JsonValue::MakeInt(output.width));
	result.Set("height", JsonValue::MakeInt(output.height));
	result.Set("scale", JsonValue::MakeDouble(output.scale));
	result.Set("format", JsonValue::MakeString("png"));
	result.Set("dataBase64", JsonValue::MakeString(Base64Encode(output.png)));
	result.Set("excludedPids", std::move(excluded));
	result.Set("display", std::move(display));
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleClick(const JsonValue& params) {
	std::string uiaError;
	UiaClient::Instance().Initialize(uiaError);

	const JsonValue* target = params.Find("target");
	ResolvedTarget resolved;
	ErrorCode code = ErrorCode::TargetNotFound;
	std::string message;
	if (target == nullptr || !ResolveTarget(*target, resolved, code, message)) {
		return MethodOutcome::FailureRetryable(code,
			message.empty() ? "click target could not be resolved" : message, false);
	}

	const unsigned int modifiers = ParseModifiers(params);
	const MouseButton button = ParseMouseButton(
		params.Find("button") != nullptr ? params.Find("button")->AsString(kEmptyString)
										: std::string());
	int clickCount = 1;
	if (const JsonValue* count = params.Find("clickCount")) {
		if (count->IsNumber()) {
			clickCount = static_cast<int>(count->AsInt(1));
		}
	}
	clickCount = Clamp(clickCount, 1, 3);

	// A pattern can express "activate this element" and nothing more. A modified click, a
	// non-left button, or a double-click means something different, so those skip patterns
	// entirely rather than quietly performing a plain activation.
	const bool patternEligible =
		modifiers == kModifierNone && button == MouseButton::Left && clickCount == 1;

	if (patternEligible && resolved.element) {
		std::string patternError;
		if (TryPatternClick(resolved.element, patternError)) {
			return MethodOutcome::Success(MakeActionResult(DispatchMethod::Accessibility));
		}
		if (!patternError.empty()) {
			LogWarn("click: pattern dispatch failed (" + patternError +
				"); falling back to synthesized input");
		}
	}

	if (!resolved.hasPoint) {
		return MethodOutcome::FailureRetryable(ErrorCode::TargetNotFound,
			"the target exposes no usable action and no on-screen position", false);
	}
	if (Cancellation::IsRequested()) {
		return CancelledOutcome();
	}

	std::string synthesizeError;
	if (!SynthesizeClick(resolved.point.x, resolved.point.y, button, modifiers, clickCount,
			synthesizeError)) {
		if (Cancellation::IsRequested()) {
			return CancelledOutcome();
		}
		return MethodOutcome::FailureRetryable(ErrorCode::Internal, synthesizeError, true);
	}
	return MethodOutcome::Success(MakeActionResult(DispatchMethod::Synthesized));
}

MethodOutcome HandleType(const JsonValue& params) {
	const JsonValue* text = params.Find("text");
	if (text == nullptr || !text->IsString()) {
		return MethodOutcome::Failure(ErrorCode::Internal, "type requires a text string");
	}
	const std::string& literal = text->AsString(kEmptyString);

	std::string uiaError;
	UiaClient::Instance().Initialize(uiaError);

	// With a target, the contract says the text REPLACES the target's value, which is exactly what
	// ValuePattern::SetValue does — and it does it atomically, without the intermediate states a
	// select-all-then-type would produce.
	if (const JsonValue* target = params.Find("target")) {
		ResolvedTarget resolved;
		ErrorCode code = ErrorCode::TargetNotFound;
		std::string message;
		if (!ResolveTarget(*target, resolved, code, message)) {
			return MethodOutcome::FailureRetryable(code, message, false);
		}

		if (resolved.element) {
			std::string setValueError;
			if (TryPatternSetValue(resolved.element, literal, setValueError)) {
				return MethodOutcome::Success(MakeActionResult(DispatchMethod::Accessibility));
			}
			if (!setValueError.empty()) {
				LogWarn("type: SetValue failed (" + setValueError + "); falling back to keystrokes");
			}
			// No writable Value pattern. Focus the element so the keystrokes land in it, then
			// synthesize. Note this APPENDS rather than replaces: without a Value pattern there is
			// no reliable, provider-agnostic way to clear the field first, and a synthesized
			// select-all would fire on whatever currently has focus if SetFocus silently failed.
			// The caller sees method "synthesized" and can tell the difference.
			TryFocusElement(resolved.element);
		} else if (resolved.hasPoint) {
			std::string clickError;
			if (!SynthesizeClick(resolved.point.x, resolved.point.y, MouseButton::Left,
					kModifierNone, 1, clickError)) {
				return MethodOutcome::FailureRetryable(ErrorCode::Internal, clickError, true);
			}
		}
	}

	if (Cancellation::IsRequested()) {
		return CancelledOutcome();
	}
	std::string error;
	if (!SynthesizeText(literal, error)) {
		if (Cancellation::IsRequested()) {
			return CancelledOutcome();
		}
		return MethodOutcome::FailureRetryable(ErrorCode::Internal, error, true);
	}
	return MethodOutcome::Success(MakeActionResult(DispatchMethod::Synthesized));
}

MethodOutcome HandleKey(const JsonValue& params) {
	const JsonValue* chord = params.Find("chord");
	if (chord == nullptr || !chord->IsString()) {
		return MethodOutcome::Failure(ErrorCode::Internal, "key requires a chord string");
	}
	int repeat = 1;
	if (const JsonValue* repeatValue = params.Find("repeat")) {
		if (repeatValue->IsNumber()) {
			repeat = static_cast<int>(repeatValue->AsInt(1));
		}
	}

	if (Cancellation::IsRequested()) {
		return CancelledOutcome();
	}

	// Always synthesized, and not because of a fallback: UIA patterns model semantics, not
	// keystrokes, so there is no accessibility path for a key chord at all.
	std::string error;
	if (!SynthesizeChord(chord->AsString(kEmptyString), repeat, error)) {
		if (Cancellation::IsRequested()) {
			return CancelledOutcome();
		}
		return MethodOutcome::FailureRetryable(ErrorCode::Internal, error, false);
	}
	return MethodOutcome::Success(MakeActionResult(DispatchMethod::Synthesized));
}

MethodOutcome HandleScroll(const JsonValue& params) {
	const JsonValue* directionValue = params.Find("direction");
	ScrollDirection direction = ScrollDirection::Down;
	if (directionValue == nullptr ||
		!ParseScrollDirection(directionValue->AsString(kEmptyString), direction)) {
		return MethodOutcome::Failure(ErrorCode::Internal,
			"scroll requires direction up, down, left or right");
	}

	int amount = 1;
	if (const JsonValue* amountValue = params.Find("amount")) {
		if (amountValue->IsNumber()) {
			amount = static_cast<int>(amountValue->AsInt(1));
		}
	}
	if (amount <= 0) {
		return MethodOutcome::Failure(ErrorCode::Internal, "scroll amount must be positive");
	}

	std::string uiaError;
	UiaClient::Instance().Initialize(uiaError);

	const JsonValue* target = params.Find("target");
	ResolvedTarget resolved;
	ErrorCode code = ErrorCode::TargetNotFound;
	std::string message;
	if (target == nullptr || !ResolveTarget(*target, resolved, code, message)) {
		return MethodOutcome::FailureRetryable(code,
			message.empty() ? "scroll target could not be resolved" : message, false);
	}

	if (resolved.element) {
		std::string scrollError;
		if (TryPatternScroll(resolved.element, direction, amount, scrollError)) {
			return MethodOutcome::Success(MakeActionResult(DispatchMethod::Accessibility));
		}
		if (!scrollError.empty()) {
			LogWarn("scroll: ScrollPattern failed (" + scrollError + "); falling back to the wheel");
		}
	}

	if (!resolved.hasPoint) {
		return MethodOutcome::FailureRetryable(ErrorCode::TargetNotFound,
			"the target is not scrollable and has no on-screen position", false);
	}
	if (Cancellation::IsRequested()) {
		return CancelledOutcome();
	}

	std::string error;
	if (!SynthesizeScroll(resolved.point.x, resolved.point.y, direction, amount, error)) {
		if (Cancellation::IsRequested()) {
			return CancelledOutcome();
		}
		return MethodOutcome::FailureRetryable(ErrorCode::Internal, error, true);
	}
	return MethodOutcome::Success(MakeActionResult(DispatchMethod::Synthesized));
}

MethodOutcome HandleCursorPosition() {
	POINT point = {};
	if (!GetCursorPositionPhysical(point)) {
		return MethodOutcome::FailureRetryable(ErrorCode::Internal, "GetCursorPos failed", true);
	}
	JsonValue result = JsonValue::MakeObject();
	// Physical screen pixels, per the contract and per Dpi.h.
	result.Set("x", JsonValue::MakeInt(point.x));
	result.Set("y", JsonValue::MakeInt(point.y));
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleFrontmostApp() {
	AppInfo app;
	if (!GetFrontmostApp(app)) {
		return MethodOutcome::FailureRetryable(ErrorCode::TargetNotFound,
			"there is no foreground application", true);
	}
	return MethodOutcome::Success(SerializeApp(app, true));
}

MethodOutcome HandleListApps() {
	const std::vector<AppInfo> apps = ListApps();
	JsonValue result = JsonValue::MakeArray();
	for (const AppInfo& app : apps) {
		result.Push(SerializeApp(app, false));
	}
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleAxTree(const JsonValue& params) {
	const AxTreeOptions options = ParseAxTreeOptions(params);

	JsonValue result;
	ErrorCode code = ErrorCode::Internal;
	std::string message;
	if (!BuildAxTree(options, result, code, message)) {
		return AxTreeFailure(code, message);
	}
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleAxTreeDiff(const JsonValue& params) {
	const AxTreeOptions options = ParseAxTreeOptions(params);

	// A missing or negative sinceGeneration is not an error: 0 means "I hold no snapshot", which
	// BuildAxTreeDiff answers with baselineComparable false and a full tree. Refusing the call would make
	// the very first read of an application fail.
	uint64_t sinceGeneration = 0;
	if (const JsonValue* since = params.Find("sinceGeneration")) {
		if (since->IsNumber() && since->AsInt() > 0) {
			sinceGeneration = static_cast<uint64_t>(since->AsInt());
		}
	}

	JsonValue result;
	ErrorCode code = ErrorCode::Internal;
	std::string message;
	if (!BuildAxTreeDiff(options, sinceGeneration, result, code, message)) {
		return AxTreeFailure(code, message);
	}
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleSettle(const JsonValue& params) {
	SettleOptions options;
	if (const JsonValue* pid = params.Find("pid")) {
		if (pid->IsNumber() && pid->AsInt() > 0) {
			options.hasPid = true;
			options.pid = static_cast<unsigned long>(pid->AsInt());
		}
	}
	if (const JsonValue* timeout = params.Find("timeoutMs")) {
		if (timeout->IsNumber() && timeout->AsInt() > 0) {
			options.timeoutMs = static_cast<int>(timeout->AsInt());
		}
	}
	if (const JsonValue* quiet = params.Find("quietPeriodMs")) {
		if (quiet->IsNumber() && quiet->AsInt() > 0) {
			options.quietPeriodMs = static_cast<int>(quiet->AsInt());
		}
	}
	if (const JsonValue* frames = params.Find("requireFrameStability")) {
		if (frames->IsBool()) {
			options.requireFrameStability = frames->AsBool(true);
		}
	}

	SettleOutcome outcome;
	ErrorCode code = ErrorCode::Internal;
	std::string message;
	if (!WaitForSettle(options, outcome, code, message)) {
		const bool retryable = code == ErrorCode::TargetNotFound;
		return MethodOutcome::FailureRetryable(code, message, retryable);
	}

	JsonValue result = JsonValue::MakeObject();
	// `settled: false` is a SUCCESSFUL response, not an error. The caller has to see it to know the UI is
	// still moving; turning it into a failure would hide the one fact this method exists to report.
	result.Set("settled", JsonValue::MakeBool(outcome.settled));
	result.Set("waitedMs", JsonValue::MakeInt(outcome.waitedMs));
	result.Set("reason", JsonValue::MakeString(outcome.reason));
	if (outcome.hasFrameSamples) {
		result.Set("frameSamples", JsonValue::MakeInt(outcome.frameSamples));
	}
	if (outcome.hasNotifications) {
		result.Set("notifications", JsonValue::MakeInt(static_cast<int64_t>(outcome.notifications)));
	}
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleForceElectronAccessibility(const JsonValue& params) {
	const JsonValue* pid = params.Find("pid");
	if (pid == nullptr || !pid->IsNumber() || pid->AsInt() <= 0) {
		// Required by the contract, and deliberately not defaulted to the frontmost application: enabling
		// accessibility in a process the caller did not name is not a guess worth making.
		return MethodOutcome::Failure(ErrorCode::Internal,
			"forceElectronAccessibility requires a pid");
	}

	int timeoutMs = kDefaultForceAccessibilityTimeoutMs;
	if (const JsonValue* timeout = params.Find("timeoutMs")) {
		if (timeout->IsNumber() && timeout->AsInt() > 0) {
			timeoutMs = static_cast<int>(timeout->AsInt());
		}
	}

	ForceAccessibilityOutcome outcome;
	ErrorCode code = ErrorCode::Internal;
	std::string message;
	if (!ForceElectronAccessibility(static_cast<unsigned long>(pid->AsInt()), timeoutMs, outcome, code,
			message)) {
		const bool retryable = code == ErrorCode::TargetNotFound;
		return MethodOutcome::FailureRetryable(code, message, retryable);
	}

	JsonValue result = JsonValue::MakeObject();
	result.Set("applied", JsonValue::MakeBool(outcome.applied));
	result.Set("treePopulated", JsonValue::MakeBool(outcome.treePopulated));
	result.Set("waitedMs", JsonValue::MakeInt(outcome.waitedMs));
	result.Set("rootNodeCount", JsonValue::MakeInt(outcome.rootNodeCount));
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleObserveStart(const JsonValue& params) {
	const JsonValue* pid = params.Find("pid");
	if (pid == nullptr || !pid->IsNumber() || pid->AsInt() <= 0) {
		return MethodOutcome::Failure(ErrorCode::Internal, "observeStart requires a pid");
	}
	const JsonValue* stopAt = params.Find("stopAtMs");
	if (stopAt == nullptr || !stopAt->IsNumber()) {
		// Mandatory. See rule 2 in Observation.h: without it, nothing can be relied upon to end the
		// session.
		return MethodOutcome::Failure(ErrorCode::Internal, "observeStart requires stopAtMs");
	}

	ObserveStartOptions options;
	options.pid = static_cast<unsigned long>(pid->AsInt());
	options.stopAtMs = stopAt->AsInt();
	if (const JsonValue* appId = params.Find("appId")) {
		options.appId = appId->AsString(kEmptyString);
	}
	if (const JsonValue* interval = params.Find("intervalMs")) {
		if (interval->IsNumber() && interval->AsInt() > 0) {
			options.intervalMs = static_cast<int>(interval->AsInt());
		}
	}
	if (const JsonValue* content = params.Find("content")) {
		options.screenshots = content->AsString(kEmptyString) == "axTreeAndScreenshots";
	}
	if (const JsonValue* maxLongEdge = params.Find("maxLongEdge")) {
		if (maxLongEdge->IsNumber() && maxLongEdge->AsInt() > 0) {
			options.maxLongEdge = static_cast<int>(maxLongEdge->AsInt());
		}
	}
	if (const JsonValue* excludePids = params.Find("excludePids")) {
		for (const JsonValue& entry : excludePids->AsArray()) {
			if (entry.IsNumber() && entry.AsInt() > 0) {
				options.excludePids.push_back(static_cast<unsigned long>(entry.AsInt()));
			}
		}
	}

	ErrorCode code = ErrorCode::Internal;
	std::string message;
	if (!Observation::Instance().Start(options, code, message)) {
		// Never retryable: every refusal here is a decision about what may be observed, and retrying the
		// identical request gets the identical answer.
		return MethodOutcome::FailureRetryable(code, message, false);
	}
	// The status result, not an ok flag, so start is self-verifying: the caller sees what is actually
	// running rather than assuming its request took effect.
	return MethodOutcome::Success(Observation::Instance().Status());
}

MethodOutcome HandleObserveStop(const JsonValue& params) {
	// No pid means stop everything, which is what a revocation or a shutdown wants.
	bool all = true;
	unsigned long pid = 0;
	if (const JsonValue* value = params.Find("pid")) {
		if (value->IsNumber() && value->AsInt() > 0) {
			all = false;
			pid = static_cast<unsigned long>(value->AsInt());
		}
	}
	Observation::Instance().Stop(all, pid);
	return MethodOutcome::Success(Observation::Instance().Status());
}

MethodOutcome HandleObserveStatus() {
	return MethodOutcome::Success(Observation::Instance().Status());
}

// --- protocol version 3 ------------------------------------------------------------------------

MethodOutcome HandleDrag(const JsonValue& params) {
	// UIA is initialised because a ref target still has to resolve through the ref table and its
	// bounding rectangle. The DISPATCH is always synthesized: no pattern can express "hold the
	// button down while moving", so unlike click there is no accessibility path to prefer here.
	std::string uiaError;
	UiaClient::Instance().Initialize(uiaError);

	POINT from = {};
	POINT to = {};
	ErrorCode code = ErrorCode::TargetNotFound;
	std::string message;
	if (!ResolveDragPoint(params, "from", from, code, message) ||
		!ResolveDragPoint(params, "to", to, code, message)) {
		return MethodOutcome::FailureRetryable(code, message, false);
	}

	const unsigned int modifiers = ParseModifiers(params);
	const MouseButton button = ParseMouseButton(
		params.Find("button") != nullptr ? params.Find("button")->AsString(kEmptyString)
										: std::string());

	int durationMs = kDefaultDragDurationMs;
	if (const JsonValue* duration = params.Find("durationMs")) {
		if (duration->IsNumber() && duration->AsInt() >= 0) {
			durationMs = static_cast<int>(duration->AsInt());
		}
	}

	if (Cancellation::IsRequested()) {
		return CancelledOutcome();
	}

	std::string error;
	if (!SynthesizeDrag(from.x, from.y, to.x, to.y, button, modifiers, durationMs, error)) {
		if (Cancellation::IsRequested()) {
			return CancelledOutcome();
		}
		return MethodOutcome::FailureRetryable(ErrorCode::Internal, error, true);
	}
	return MethodOutcome::Success(MakeActionResult(DispatchMethod::Synthesized));
}

MethodOutcome HandleMouseMove(const JsonValue& params) {
	std::string uiaError;
	UiaClient::Instance().Initialize(uiaError);

	const JsonValue* target = params.Find("target");
	ResolvedTarget resolved;
	ErrorCode code = ErrorCode::TargetNotFound;
	std::string message;
	if (target == nullptr || !ResolveTarget(*target, resolved, code, message)) {
		return MethodOutcome::FailureRetryable(code,
			message.empty() ? "mouseMove target could not be resolved" : message, false);
	}
	if (!resolved.hasPoint) {
		return MethodOutcome::FailureRetryable(ErrorCode::TargetNotFound,
			"the mouseMove target has no on-screen position", false);
	}

	int settleMs = kDefaultMouseMoveSettleMs;
	if (const JsonValue* settle = params.Find("settleMs")) {
		if (settle->IsNumber() && settle->AsInt() >= 0) {
			settleMs = static_cast<int>(settle->AsInt());
		}
	}

	if (Cancellation::IsRequested()) {
		return CancelledOutcome();
	}

	std::string error;
	if (!SynthesizeMouseMove(resolved.point.x, resolved.point.y, settleMs, error)) {
		if (Cancellation::IsRequested()) {
			return CancelledOutcome();
		}
		return MethodOutcome::FailureRetryable(ErrorCode::Internal, error, true);
	}
	// Always synthesized. Moving the pointer is not something an element can be asked to do.
	return MethodOutcome::Success(MakeActionResult(DispatchMethod::Synthesized));
}

MethodOutcome HandleClipboardRead() {
	const ClipboardScope clipboard;
	if (!clipboard.IsOpen()) {
		// Another process is holding it. Retryable, and genuinely so: clipboard managers hold it
		// for a few milliseconds at a time.
		return MethodOutcome::FailureRetryable(ErrorCode::Internal,
			"the clipboard could not be opened; another process is holding it", true);
	}

	std::string text;
	size_t lengthInCharacters = 0;
	const bool haveText = ReadClipboardUnicodeText(text, lengthInCharacters);

	// Deliberately exclusive: "holds something that is not text AND THEREFORE WAS NOT READ". A rich
	// copy carries both an image and its text, and the text is what the caller receives, so
	// reporting non-text content alongside it would be reporting a loss that did not happen. The
	// distinction this field exists to draw is "empty" versus "not text", and both of those have
	// no text.
	const bool hasNonTextContent = !haveText && ClipboardHasNonTextFormat();

	// Only the length is logged. The clipboard routinely holds passwords and the contents of
	// whatever the user last copied for their own reasons; the disclosure to the model is the
	// caller's decision to make, but this helper is not going to also write it to a log file.
	LogDebug("clipboardRead: " + std::to_string(lengthInCharacters) + " characters, nonText=" +
		(hasNonTextContent ? "true" : "false"));

	JsonValue result = JsonValue::MakeObject();
	result.Set("text", JsonValue::MakeString(text));
	// UTF-16 code units, which is what `String.prototype.length` reports for the same string.
	result.Set("length", JsonValue::MakeInt(static_cast<int64_t>(lengthInCharacters)));
	result.Set("hasNonTextContent", JsonValue::MakeBool(hasNonTextContent));
	return MethodOutcome::Success(std::move(result));
}

MethodOutcome HandleClipboardWrite(const JsonValue& params) {
	const JsonValue* text = params.Find("text");
	if (text == nullptr || !text->IsString()) {
		return MethodOutcome::Failure(ErrorCode::Internal, "clipboardWrite requires a text string");
	}
	const std::wstring wide = Utf8ToWide(text->AsString(kEmptyString));

	const ClipboardScope clipboard;
	if (!clipboard.IsOpen()) {
		return MethodOutcome::FailureRetryable(ErrorCode::Internal,
			"the clipboard could not be opened; another process is holding it", true);
	}
	if (::EmptyClipboard() == FALSE) {
		return MethodOutcome::FailureRetryable(ErrorCode::Internal,
			"EmptyClipboard failed, GetLastError=" +
				std::to_string(static_cast<unsigned long>(::GetLastError())),
			true);
	}

	// GMEM_MOVEABLE is required: SetClipboardData rejects a fixed allocation.
	const size_t bytes = (wide.size() + 1) * sizeof(wchar_t);
	const HGLOBAL handle = ::GlobalAlloc(GMEM_MOVEABLE, bytes);
	if (handle == nullptr) {
		return MethodOutcome::FailureRetryable(ErrorCode::Internal,
			"GlobalAlloc failed for " + std::to_string(bytes) + " bytes", true);
	}
	void* locked = ::GlobalLock(handle);
	if (locked == nullptr) {
		::GlobalFree(handle);
		return MethodOutcome::FailureRetryable(ErrorCode::Internal, "GlobalLock failed", true);
	}
	std::memcpy(locked, wide.c_str(), bytes);
	::GlobalUnlock(handle);

	if (::SetClipboardData(CF_UNICODETEXT, handle) == nullptr) {
		// Ownership did NOT transfer, so this block owns the allocation and must release it.
		const unsigned long lastError = static_cast<unsigned long>(::GetLastError());
		::GlobalFree(handle);
		return MethodOutcome::FailureRetryable(ErrorCode::Internal,
			"SetClipboardData failed, GetLastError=" + std::to_string(lastError), true);
	}
	// From here the CLIPBOARD owns `handle`. Freeing it now would hand every subsequent paste a
	// dangling block, so there is deliberately no cleanup on this path.

	// Neither "accessibility" nor a fallback from it; the clipboard is simply not an element. See
	// the note at the top of Handlers.h.
	return MethodOutcome::Success(MakeActionResult(DispatchMethod::Synthesized));
}

MethodOutcome HandleOpenApplication(const JsonValue& params) {
	const JsonValue* app = params.Find("app");
	if (app == nullptr || !app->IsString() || app->AsString(kEmptyString).empty()) {
		return MethodOutcome::Failure(ErrorCode::Internal,
			"openApplication requires an app identifier or name");
	}

	int waitMs = kDefaultOpenApplicationWaitMs;
	if (const JsonValue* wait = params.Find("waitMs")) {
		if (wait->IsNumber() && wait->AsInt() >= 0) {
			waitMs = static_cast<int>(wait->AsInt());
		}
	}

	OpenApplicationOutcome outcome;
	ErrorCode code = ErrorCode::Internal;
	std::string message;
	if (!OpenApplication(app->AsString(kEmptyString), waitMs, outcome, code, message)) {
		// A timeout is worth retrying with a longer budget; "nothing by that name" is not.
		const bool retryable = code == ErrorCode::Timeout;
		return MethodOutcome::FailureRetryable(code, message, retryable);
	}

	JsonValue result = JsonValue::MakeObject();
	result.Set("app", SerializeApp(outcome.app, false));
	result.Set("launched", JsonValue::MakeBool(outcome.launched));
	// Reported as observed, not as intended. Windows refuses foreground changes from a process the
	// user is not interacting with, and a false `true` here sends the caller off to screenshot a
	// window that is still behind another one.
	result.Set("frontmost", JsonValue::MakeBool(outcome.frontmost));
	return MethodOutcome::Success(std::move(result));
}

} // namespace v3cu
