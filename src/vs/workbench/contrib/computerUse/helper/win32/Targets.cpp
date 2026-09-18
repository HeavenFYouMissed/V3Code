/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Target resolution implementation. Point targets are physical screen pixels; see Targets.h for why
// the helper does not convert them.
// NEEDS VERIFICATION ON WINDOWS (full list in Targets.h):
//   - A ref from the previous generation returning refStale. Highest-value test in the helper.
//   - A point target on a downscaled capture of a secondary monitor, with the service converting.
//   - The out-of-bounds warning firing when an unconverted image coordinate arrives.
//
#include "Targets.h"

#include "Capture.h"
#include "Log.h"
#include "RefTable.h"
#include "UiaActions.h"
#include "UiaClient.h"

#include <cmath>

namespace v3cu {
namespace {

const std::string kEmptyString;

/// Takes a point target as physical screen pixels, warning when it looks unconverted.
POINT PointTargetToScreen(double x, double y) {
	POINT screen = {};
	screen.x = static_cast<LONG>(std::lround(x));
	screen.y = static_cast<LONG>(std::lround(y));

	// Diagnostic only. A point outside the display the helper last captured usually means the
	// service sent image pixels without converting them: a downscaled coordinate from a secondary
	// monitor lands near the virtual-desktop origin instead of on that monitor. The action still
	// proceeds, because a caller may legitimately have captured one display and be acting on another.
	const CaptureGeometry geometry = LastCaptureGeometry();
	if (geometry.valid && !geometry.sourceBounds.IsEmpty()) {
		const Rect& bounds = geometry.sourceBounds;
		const bool inside = screen.x >= bounds.x && screen.x < bounds.x + bounds.width &&
			screen.y >= bounds.y && screen.y < bounds.y + bounds.height;
		if (!inside) {
			LogWarn("point target (" + std::to_string(screen.x) + "," + std::to_string(screen.y) +
				") is outside the last captured display bounds (" + std::to_string(bounds.x) + "," +
				std::to_string(bounds.y) + " " + std::to_string(bounds.width) + "x" +
				std::to_string(bounds.height) +
				"); the caller may have sent image pixels instead of physical pixels");
		}
	}
	return screen;
}

bool ResolveRefTarget(const std::string& ref, ResolvedTarget& out, ErrorCode& code,
	std::string& message) {
	Microsoft::WRL::ComPtr<IUIAutomationElement> element;
	switch (RefTable::Instance().Resolve(ref, element)) {
		case RefResolveStatus::Ok:
			break;
		case RefResolveStatus::Stale:
			code = ErrorCode::RefStale;
			message = "ref '" + ref +
				"' was minted before the most recent accessibility read; read the screen again";
			return false;
		case RefResolveStatus::Malformed:
			code = ErrorCode::RefStale;
			message = "ref '" + ref + "' was not minted by this helper";
			return false;
		case RefResolveStatus::NotFound:
			code = ErrorCode::TargetNotFound;
			message = "ref '" + ref + "' is not in the current snapshot";
			return false;
	}

	// A ref can be current and still point at an element the application has destroyed since the
	// snapshot. Acting on it would fail in a confusing way, so check first.
	if (!IsElementAlive(element)) {
		code = ErrorCode::TargetNotFound;
		message = "the element behind ref '" + ref + "' no longer exists";
		return false;
	}

	out.fromRef = true;
	out.element = element;
	POINT point = {};
	if (GetElementPoint(element, point)) {
		out.point = point;
		out.hasPoint = true;
	}
	return true;
}

bool ResolvePointTarget(double x, double y, ResolvedTarget& out) {
	out.fromRef = false;
	out.point = PointTargetToScreen(x, y);
	out.hasPoint = true;

	// Best effort: if UIA can name the element under that point, the action can still go through a
	// pattern and report "accessibility" instead of "synthesized".
	Microsoft::WRL::ComPtr<IUIAutomationElement> element;
	if (UiaClient::Instance().IsAvailable() &&
		UiaClient::Instance().ElementFromScreenPoint(out.point, element)) {
		out.element = element;
	}
	return true;
}

} // namespace

bool ResolveTarget(const JsonValue& target, ResolvedTarget& out, ErrorCode& code,
	std::string& message) {
	if (!target.IsObject()) {
		code = ErrorCode::TargetNotFound;
		message = "target is missing";
		return false;
	}

	const JsonValue* kind = target.Find("kind");
	const std::string kindName = kind != nullptr ? kind->AsString(kEmptyString) : std::string();

	if (kindName == "ref") {
		const JsonValue* ref = target.Find("ref");
		if (ref == nullptr || !ref->IsString()) {
			code = ErrorCode::TargetNotFound;
			message = "ref target has no ref string";
			return false;
		}
		return ResolveRefTarget(ref->AsString(kEmptyString), out, code, message);
	}

	if (kindName == "point") {
		const JsonValue* x = target.Find("x");
		const JsonValue* y = target.Find("y");
		if (x == nullptr || y == nullptr || !x->IsNumber() || !y->IsNumber()) {
			code = ErrorCode::TargetNotFound;
			message = "point target needs numeric x and y";
			return false;
		}
		return ResolvePointTarget(x->AsDouble(), y->AsDouble(), out);
	}

	code = ErrorCode::TargetNotFound;
	message = "unknown target kind '" + kindName + "'";
	return false;
}

} // namespace v3cu
