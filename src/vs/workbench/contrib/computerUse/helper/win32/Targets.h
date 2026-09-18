/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Resolving a ComputerUseTarget to something actionable.
//
// A `ref` target resolves through the ref table, with the generation check that produces `refStale`.
// It is the primary form and the only robust one.
//
// A `point` target arrives in PHYSICAL SCREEN PIXELS and is used as-is, with no conversion.
//
// This is the division of labour the service owns: the model replies in image pixels of the
// screenshot it was shown, and the service converts those to physical pixels using the `scale` and
// `display.bounds` the helper reported from `capture` before it ever sends a point target. The
// helper cannot do that conversion itself — it would need to know which screenshot the coordinate
// came from, and by the time a point target arrives the caller may have captured a different
// display. So the helper does not second-guess it.
//
// It does sanity-check it, though. If the point falls outside the display the helper most recently
// captured, that is the signature of a missing conversion (an unconverted image coordinate on a
// secondary monitor lands near the virtual-desktop origin, i.e. on the primary display), and the
// helper logs a warning. It still acts on the coordinate: refusing would break a legitimate caller
// that captured one display and is now acting on another.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - The point-target path against a downscaled capture of a secondary monitor, end to end with
//     the service doing the conversion. This is the case where a mistake on either side is visible.
//   - That the out-of-bounds warning fires when a raw image coordinate is sent by mistake.
//   - That a ref from the previous generation returns refStale (the single most valuable test).
//
#pragma once

// Common.h first: it is what pulls in <windows.h> and <objbase.h>. Json.h and Protocol.h are
// pure standard-library headers, so without this line the UI Automation headers below are the
// first thing to reach the compiler in this translation unit and they fail to parse — every
// other UIA-using header here reaches Common.h via Common.h/Apps.h, which is why this file was
// the only one still breaking the build.
#include "Common.h"
#include "Json.h"
#include "Protocol.h"

#include <uiautomation.h>
#include <wrl/client.h>

namespace v3cu {

struct ResolvedTarget {
	/// True when the target was a ref.
	bool fromRef = false;
	/// The element, when one is known. A point target may resolve to an element too, via
	/// ElementFromPoint, which lets a coordinate click still take the accessibility path.
	Microsoft::WRL::ComPtr<IUIAutomationElement> element;
	/// A physical screen pixel to act on, when one could be determined.
	POINT point = {};
	bool hasPoint = false;
};

/// Resolves a ComputerUseTarget. On failure sets `code` (refStale / targetNotFound) and `message`.
bool ResolveTarget(const JsonValue& target, ResolvedTarget& out, ErrorCode& code,
	std::string& message);

} // namespace v3cu
