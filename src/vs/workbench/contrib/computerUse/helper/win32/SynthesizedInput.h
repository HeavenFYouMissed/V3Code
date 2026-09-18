/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// The SendInput fallback path. THIS IS NOT THE PRIMARY PATH.
//
// Everything here reports method "synthesized" so the service can measure how often the
// accessibility path failed. A rising fallback rate is the health metric for the whole feature, so
// nothing in this file may be reached from a code path that could have used a UIA pattern instead.
//
// The one exception is `key`: a key chord has no UIA equivalent — patterns model semantics
// (invoke, toggle, set value), not keystrokes — so `key` is always synthesized. That is inherent,
// not a fallback, and it is called out in the report rather than hidden here.
//
// COORDINATES. SetCursorPos is used to position the pointer and then the button events are sent
// with no MOUSEEVENTF_ABSOLUTE and no movement. That is deliberate: MOUSEEVENTF_ABSOLUTE takes
// coordinates normalised to 0..65535 across the virtual screen, and getting that mapping right on a
// multi-monitor desktop with a negative origin means dividing by (extent - 1) and rounding — a
// classic source of off-by-one-monitor bugs. SetCursorPos takes physical pixels directly, which is
// exactly what the rest of the helper works in (see Dpi.h), so the conversion disappears.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - That SetCursorPos followed by button-only SendInput is accepted by applications that track
//     mouse movement themselves. If any app misses the click, the fix is to send a
//     MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE first, and the normalisation above becomes necessary.
//   - Every VK mapping in ParseChord. The letter/digit path uses VkKeyScanW, so it follows the
//     user's keyboard layout; the named keys are table-driven. Untested against a non-US layout.
//   - KEYEVENTF_UNICODE typing of non-BMP characters (emoji), which are sent as two surrogate code
//     units.
//   - UIPI: SendInput from a medium-integrity process into an elevated window is silently dropped
//     by Windows. The action will report success because SendInput itself succeeds. There is no
//     documented way to detect this; the service should treat "the screen did not change" after a
//     synthesized action as a possible elevation problem. The lead needs to know this.
//   - Whether WHEEL_DELTA * amount is the right granularity, or whether amount should be treated
//     as lines rather than notches.
//
// NEEDS VERIFICATION ON WINDOWS — the protocol-3 additions (drag, mouseMove):
//   - That SetCursorPos-driven interpolation is enough for a real drag. SetCursorPos does post
//     WM_MOUSEMOVE to the window under the pointer, so an ordinary Win32/WPF/Electron app should
//     see the intermediate positions. Applications that read the pointer through Raw Input or
//     DirectInput (games, some canvas apps) will NOT: those need real MOUSEEVENTF_MOVE events, and
//     the fix is the MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE normalisation described above.
//   - The step cadence (kDragStepIntervalMs). Too coarse and a drop target never lights up; too
//     fine and a slow application's input queue backs up behind the moves.
//   - The pause between the final move and the button release (kDragSettleBeforeReleaseMs). Some
//     drop targets compute the drop from the LAST move they processed, not from the mouse-up
//     position, so releasing in the same millisecond as the final move can drop on the wrong row.
//   - That an aborted drag (cancel mid-glide) really does leave the button up.
//

#pragma once

#include "Common.h"

#include <string>

namespace v3cu {

/// Modifier bit flags, matching ComputerUseModifier.
enum ModifierFlags : unsigned int {
	kModifierNone = 0u,
	kModifierShift = 1u << 0,
	kModifierControl = 1u << 1,
	kModifierAlt = 1u << 2,
	kModifierMeta = 1u << 3,
};

/// Mouse buttons, matching ComputerUseMouseButton.
enum class MouseButton {
	Left,
	Right,
	Middle,
};

/// Scroll directions, matching ComputerUseScrollDirection.
enum class ScrollDirection {
	Up,
	Down,
	Left,
	Right,
};

/// Parses a modifier name. Returns kModifierNone when the name is not a modifier.
unsigned int ParseModifierName(const std::string& name);

/// Parses "left" | "right" | "middle". Defaults to Left for anything else.
MouseButton ParseMouseButton(const std::string& name);

/// Parses a scroll direction. Returns false when the name is not one of the four.
bool ParseScrollDirection(const std::string& name, ScrollDirection& out);

/// The cursor position in physical screen pixels.
bool GetCursorPositionPhysical(POINT& out);

/// Moves the cursor to a physical screen pixel.
bool MoveCursorTo(long x, long y, std::string& error);

/// Clicks at a physical screen pixel with the given modifiers held.
bool SynthesizeClick(long x, long y, MouseButton button, unsigned int modifiers, int clickCount,
	std::string& error);

/// Types literal UTF-8 text as Unicode key events. Aborts early when a cancel is requested.
bool SynthesizeText(const std::string& text, std::string& error);

/// Sends a key chord such as "ctrl+shift+p", `repeat` times. Aborts early on cancel.
bool SynthesizeChord(const std::string& chord, int repeat, std::string& error);

/// Scrolls at a physical screen pixel. `amount` is in notches.
bool SynthesizeScroll(long x, long y, ScrollDirection direction, int amount, std::string& error);

/// Presses at one physical screen pixel, glides to another over `durationMs`, and releases.
///
/// The glide is not decoration. Applications sample the pointer on a timer and decide "this is a
/// drag" only after they have seen the pointer move while the button was down; a press followed by a
/// single jump and a release is read as a click at the destination, or as nothing at all. So the
/// movement is delivered as a series of interpolated steps spread across the requested duration.
///
/// The button is guaranteed to be released on every exit path, including cancellation and a failed
/// SendInput. A stuck mouse button is the single worst failure this file can produce: the desktop
/// keeps rubber-band-selecting under the user's hand until they click again, and nothing on screen
/// explains why.
bool SynthesizeDrag(long fromX, long fromY, long toX, long toY, MouseButton button,
	unsigned int modifiers, int durationMs, std::string& error);

/// Moves the pointer to a physical screen pixel, presses nothing, and stays there for `settleMs`.
///
/// The dwell is the point of the method: hover-triggered UI (menus that open on hover, tooltips,
/// disclosure controls) appears on a delay, so returning the instant the pointer lands means the
/// caller's next screenshot shows the state before whatever the hover was meant to reveal.
bool SynthesizeMouseMove(long x, long y, int settleMs, std::string& error);

} // namespace v3cu
