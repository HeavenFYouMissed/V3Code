/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// One function per method in ComputerUseMethods. Each returns a MethodOutcome and never throws,
// never writes to stdout, and never exits the process.
//
// The mapping from failure to error code is the part worth reviewing, since callers branch on it:
//   - UIA unavailable                        -> accessibilityNotTrusted
//   - both capture backends refused          -> screenRecordingNotGranted
//   - ref from an older generation           -> refStale
//   - ref current but element gone, or a point that resolves to nothing -> targetNotFound
//   - tier refuses the method                -> appTierForbidsAction (never retryable)
//   - cancel flag observed mid-action        -> cancelled
//   - a UIA call exceeded its timeout        -> timeout (retryable)
//   - anything unexpected                    -> internal
//
// NEEDS VERIFICATION ON WINDOWS:
//   - Each handler's happy path, and each error code actually being reachable.
//   - That no handler can take longer than the service's per-method budget on a busy machine.
//
#pragma once

#include "Json.h"
#include "Protocol.h"

namespace v3cu {

MethodOutcome HandlePing();
MethodOutcome HandleStatus();
MethodOutcome HandleCapture(const JsonValue& params);
MethodOutcome HandleClick(const JsonValue& params);
MethodOutcome HandleType(const JsonValue& params);
MethodOutcome HandleKey(const JsonValue& params);
MethodOutcome HandleScroll(const JsonValue& params);
MethodOutcome HandleCursorPosition();
MethodOutcome HandleFrontmostApp();
MethodOutcome HandleListApps();
MethodOutcome HandleAxTree(const JsonValue& params);

// --- protocol version 2 ----------------------------------------------------------------------

MethodOutcome HandleAxTreeDiff(const JsonValue& params);
MethodOutcome HandleSettle(const JsonValue& params);
MethodOutcome HandleForceElectronAccessibility(const JsonValue& params);
MethodOutcome HandleObserveStart(const JsonValue& params);
MethodOutcome HandleObserveStop(const JsonValue& params);
MethodOutcome HandleObserveStatus();

// --- protocol version 3 ------------------------------------------------------------------------
//
// Five methods, none of which has an accessibility path, so all five report method "synthesized"
// where they report one at all. That is inherent rather than a fallback: UIA patterns model
// semantics (invoke, toggle, set value) and cannot express "hold the button down while moving", a
// bare hover, the clipboard, or launching a program. The same is true of `key`; see
// SynthesizedInput.h.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - drag against a real drag-and-drop surface (File Explorer, a reorderable list, a canvas), and
//     that the button is up afterwards in every case including a mid-drag cancel.
//   - mouseMove revealing hover-only UI, with the dwell long enough that the caller's next capture
//     sees it.
//   - clipboardRead/clipboardWrite round-tripping text, including a clipboard held open by another
//     process (the retry path) and a clipboard holding an image (hasNonTextContent).
//   - openApplication in each of its resolution forms. Full list in Apps.h.

MethodOutcome HandleDrag(const JsonValue& params);
MethodOutcome HandleMouseMove(const JsonValue& params);
MethodOutcome HandleClipboardRead();
MethodOutcome HandleClipboardWrite(const JsonValue& params);
MethodOutcome HandleOpenApplication(const JsonValue& params);

} // namespace v3cu
