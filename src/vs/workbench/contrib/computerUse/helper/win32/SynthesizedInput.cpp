/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// SendInput fallback implementation. Read SynthesizedInput.h first, especially the UIPI note.
// NEEDS VERIFICATION ON WINDOWS (full list in SynthesizedInput.h):
//   - SetCursorPos plus button-only SendInput being accepted by real apps.
//   - Every VK mapping in the named-key table, and VkKeyScanW on a non-US layout.
//   - KEYEVENTF_UNICODE with surrogate pairs.
//   - The 4ms inter-event delay: too short and apps coalesce input, too long and typing crawls.
//   - UIPI silently dropping input into elevated windows, which cannot be detected here.
//   - The protocol-3 additions: that SetCursorPos interpolation is seen as a drag by real software,
//     the step cadence, and that a cancelled drag leaves the button up. Full list in the header.
//
#include "SynthesizedInput.h"

#include "Cancellation.h"
#include "Log.h"

#include <vector>

namespace v3cu {
namespace {

/// A pause between synthesized events. Zero would be faster, but many applications coalesce or
/// drop input that arrives in the same millisecond, and a dropped keystroke in the middle of typed
/// text is worse than a slow action.
constexpr DWORD kInterEventDelayMs = 4;

/// Target interval between the interpolated pointer positions of a drag, in milliseconds. Roughly a
/// 100Hz pointer, which is faster than the ~60Hz at which UI toolkits sample and therefore leaves no
/// frame in which the pointer appears not to have moved.
constexpr int kDragStepIntervalMs = 10;

/// Bounds on the number of interpolated steps. The floor matters even for a zero-duration drag: a
/// press-jump-release is read as a click, so the movement is always delivered as several events.
constexpr int kMinDragSteps = 8;
constexpr int kMaxDragSteps = 240;

/// Longest drag this helper will perform. A caller asking for a minute-long drag has a bug, and the
/// helper would sit there holding the mouse button down for the whole of it.
constexpr int kMaxDragDurationMs = 10000;

/// Pause between the button press and the first interpolated move, so the application has processed
/// the press and treats what follows as a drag rather than as a hover.
constexpr DWORD kDragSettleAfterPressMs = 20;

/// Pause between the last interpolated move and the button release. Drop targets frequently compute
/// the drop from the last move they processed rather than from the mouse-up position, so releasing
/// in the same instant as the final move can drop on the previous row.
constexpr DWORD kDragSettleBeforeReleaseMs = 30;

/// Longest hover dwell. Same reasoning as kMaxDragDurationMs: past this the caller should be using
/// `settle`, which reports what it waited for.
constexpr int kMaxMouseMoveSettleMs = 10000;

/// Granularity at which a dwell is broken up so a cancel is observed promptly.
constexpr int kDwellSliceMs = 20;

struct NamedKey {
	const char* name;
	WORD virtualKey;
};

/// Named keys. Aliases are listed separately rather than normalised, so the table is the single
/// place to look when a chord does not work.
const NamedKey kNamedKeys[] = {
	{ "enter", VK_RETURN },
	{ "return", VK_RETURN },
	{ "tab", VK_TAB },
	{ "escape", VK_ESCAPE },
	{ "esc", VK_ESCAPE },
	{ "space", VK_SPACE },
	{ "spacebar", VK_SPACE },
	{ "backspace", VK_BACK },
	{ "delete", VK_DELETE },
	{ "del", VK_DELETE },
	{ "insert", VK_INSERT },
	{ "home", VK_HOME },
	{ "end", VK_END },
	{ "pageup", VK_PRIOR },
	{ "pagedown", VK_NEXT },
	{ "up", VK_UP },
	{ "down", VK_DOWN },
	{ "left", VK_LEFT },
	{ "right", VK_RIGHT },
	{ "printscreen", VK_SNAPSHOT },
	{ "capslock", VK_CAPITAL },
	{ "numlock", VK_NUMLOCK },
	{ "scrolllock", VK_SCROLL },
	{ "pause", VK_PAUSE },
	{ "apps", VK_APPS },
	{ "menu", VK_APPS },
	{ "plus", VK_OEM_PLUS },
	{ "minus", VK_OEM_MINUS },
	{ "comma", VK_OEM_COMMA },
	{ "period", VK_OEM_PERIOD },
	{ "f1", VK_F1 },
	{ "f2", VK_F2 },
	{ "f3", VK_F3 },
	{ "f4", VK_F4 },
	{ "f5", VK_F5 },
	{ "f6", VK_F6 },
	{ "f7", VK_F7 },
	{ "f8", VK_F8 },
	{ "f9", VK_F9 },
	{ "f10", VK_F10 },
	{ "f11", VK_F11 },
	{ "f12", VK_F12 },
	{ "f13", VK_F13 },
	{ "f14", VK_F14 },
	{ "f15", VK_F15 },
	{ "f16", VK_F16 },
	{ "f17", VK_F17 },
	{ "f18", VK_F18 },
	{ "f19", VK_F19 },
	{ "f20", VK_F20 },
	{ "f21", VK_F21 },
	{ "f22", VK_F22 },
	{ "f23", VK_F23 },
	{ "f24", VK_F24 },
	{ "numpad0", VK_NUMPAD0 },
	{ "numpad1", VK_NUMPAD1 },
	{ "numpad2", VK_NUMPAD2 },
	{ "numpad3", VK_NUMPAD3 },
	{ "numpad4", VK_NUMPAD4 },
	{ "numpad5", VK_NUMPAD5 },
	{ "numpad6", VK_NUMPAD6 },
	{ "numpad7", VK_NUMPAD7 },
	{ "numpad8", VK_NUMPAD8 },
	{ "numpad9", VK_NUMPAD9 },
};

/// True for keys whose scan codes require the extended-key flag. Omitting it makes arrow keys and
/// the navigation cluster behave as their numeric-keypad twins in some applications.
bool IsExtendedKey(WORD virtualKey) {
	switch (virtualKey) {
		case VK_UP:
		case VK_DOWN:
		case VK_LEFT:
		case VK_RIGHT:
		case VK_HOME:
		case VK_END:
		case VK_PRIOR:
		case VK_NEXT:
		case VK_INSERT:
		case VK_DELETE:
		case VK_DIVIDE:
		case VK_NUMLOCK:
		case VK_SNAPSHOT:
		case VK_RCONTROL:
		case VK_RMENU:
			return true;
		default:
			return false;
	}
}

bool SendOne(const INPUT& input, const char* what, std::string& error) {
	INPUT copy = input;
	const UINT sent = ::SendInput(1, &copy, sizeof(INPUT));
	if (sent != 1) {
		error = std::string(what) + ": SendInput sent no events, GetLastError=" +
			std::to_string(static_cast<unsigned long>(::GetLastError()));
		return false;
	}
	if (kInterEventDelayMs > 0) {
		::Sleep(kInterEventDelayMs);
	}
	return true;
}

/// The MOUSEEVENTF down/up pair for a button.
void MouseButtonFlags(MouseButton button, DWORD& downFlag, DWORD& upFlag) {
	switch (button) {
		case MouseButton::Right:
			downFlag = MOUSEEVENTF_RIGHTDOWN;
			upFlag = MOUSEEVENTF_RIGHTUP;
			return;
		case MouseButton::Middle:
			downFlag = MOUSEEVENTF_MIDDLEDOWN;
			upFlag = MOUSEEVENTF_MIDDLEUP;
			return;
		case MouseButton::Left:
		default:
			downFlag = MOUSEEVENTF_LEFTDOWN;
			upFlag = MOUSEEVENTF_LEFTUP;
			return;
	}
}

/// Sends one button-only mouse event at the current cursor position.
bool SendMouseButton(DWORD flag, const char* what, std::string& error) {
	INPUT input = {};
	input.type = INPUT_MOUSE;
	input.mi.dwFlags = flag;
	return SendOne(input, what, error);
}

/// Sleeps in slices, returning false as soon as a cancel is observed.
bool SleepCancellable(int totalMs, std::string& error) {
	int remaining = totalMs;
	while (remaining > 0) {
		if (Cancellation::IsRequested()) {
			error = "cancelled";
			return false;
		}
		const int slice = remaining < kDwellSliceMs ? remaining : kDwellSliceMs;
		::Sleep(static_cast<DWORD>(slice));
		remaining -= slice;
	}
	if (Cancellation::IsRequested()) {
		error = "cancelled";
		return false;
	}
	return true;
}

/// Linear interpolation between two physical-pixel coordinates, rounded to the nearest pixel.
long InterpolateCoordinate(long from, long to, int step, int steps) {
	if (steps <= 0) {
		return to;
	}
	const double t = static_cast<double>(step) / static_cast<double>(steps);
	const double value = static_cast<double>(from) + (static_cast<double>(to - from) * t);
	return static_cast<long>(value >= 0.0 ? value + 0.5 : value - 0.5);
}

INPUT MakeKeyInput(WORD virtualKey, bool keyUp) {
	INPUT input = {};
	input.type = INPUT_KEYBOARD;
	input.ki.wVk = virtualKey;
	input.ki.wScan = static_cast<WORD>(::MapVirtualKeyW(virtualKey, MAPVK_VK_TO_VSC));
	input.ki.dwFlags = 0;
	if (keyUp) {
		input.ki.dwFlags |= KEYEVENTF_KEYUP;
	}
	if (IsExtendedKey(virtualKey)) {
		input.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
	}
	return input;
}

INPUT MakeUnicodeInput(wchar_t codeUnit, bool keyUp) {
	INPUT input = {};
	input.type = INPUT_KEYBOARD;
	input.ki.wVk = 0;
	input.ki.wScan = static_cast<WORD>(codeUnit);
	input.ki.dwFlags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0u);
	return input;
}

/// Presses the modifier keys in a stable order. Meta maps to the left Windows key.
bool PressModifiers(unsigned int modifiers, std::string& error) {
	if ((modifiers & kModifierControl) != 0 &&
		!SendOne(MakeKeyInput(VK_CONTROL, false), "modifier ctrl down", error)) {
		return false;
	}
	if ((modifiers & kModifierAlt) != 0 &&
		!SendOne(MakeKeyInput(VK_MENU, false), "modifier alt down", error)) {
		return false;
	}
	if ((modifiers & kModifierShift) != 0 &&
		!SendOne(MakeKeyInput(VK_SHIFT, false), "modifier shift down", error)) {
		return false;
	}
	if ((modifiers & kModifierMeta) != 0 &&
		!SendOne(MakeKeyInput(VK_LWIN, false), "modifier meta down", error)) {
		return false;
	}
	return true;
}

/// Releases the modifier keys in reverse order. Best-effort: a failure here is logged but does not
/// fail the action, because leaving a modifier stuck down is far worse than a misreported success.
void ReleaseModifiers(unsigned int modifiers) {
	std::string ignored;
	if ((modifiers & kModifierMeta) != 0) {
		SendOne(MakeKeyInput(VK_LWIN, true), "modifier meta up", ignored);
	}
	if ((modifiers & kModifierShift) != 0) {
		SendOne(MakeKeyInput(VK_SHIFT, true), "modifier shift up", ignored);
	}
	if ((modifiers & kModifierAlt) != 0) {
		SendOne(MakeKeyInput(VK_MENU, true), "modifier alt up", ignored);
	}
	if ((modifiers & kModifierControl) != 0) {
		SendOne(MakeKeyInput(VK_CONTROL, true), "modifier ctrl up", ignored);
	}
	if (!ignored.empty()) {
		LogWarn("failed to release a modifier: " + ignored);
	}
}

/// Splits a chord on '+' into lower-cased tokens. A trailing '+' means the '+' key itself, so
/// "ctrl++" yields { "ctrl", "plus" }.
std::vector<std::string> SplitChord(const std::string& chord) {
	std::vector<std::string> tokens;
	std::string current;
	for (size_t index = 0; index < chord.size(); ++index) {
		const char ch = chord[index];
		if (ch != '+') {
			current.push_back(ch);
			continue;
		}
		if (current.empty()) {
			// A '+' with nothing before it is the plus key, not a separator.
			tokens.push_back("plus");
			continue;
		}
		tokens.push_back(ToLowerAscii(current));
		current.clear();
	}
	if (!current.empty()) {
		tokens.push_back(ToLowerAscii(current));
	}
	return tokens;
}

/// Resolves a key name to a virtual key, reporting whether shift is needed for it on the current
/// layout (as VkKeyScanW does for characters like ':').
bool ResolveKeyName(const std::string& name, WORD& virtualKey, bool& needsShift) {
	needsShift = false;
	for (const NamedKey& entry : kNamedKeys) {
		if (name == entry.name) {
			virtualKey = entry.virtualKey;
			return true;
		}
	}

	// Single character: ask the active keyboard layout. This is what makes "ctrl+/" work on a
	// layout where '/' is not where a US layout puts it.
	const std::wstring wide = Utf8ToWide(name);
	if (wide.size() == 1) {
		const SHORT scan = ::VkKeyScanW(wide[0]);
		if (scan != -1) {
			virtualKey = static_cast<WORD>(scan & 0xff);
			const int shiftState = (scan >> 8) & 0xff;
			needsShift = (shiftState & 1) != 0;
			return true;
		}
	}
	return false;
}

} // namespace

unsigned int ParseModifierName(const std::string& rawName) {
	const std::string name = ToLowerAscii(rawName);
	if (name == "shift") {
		return kModifierShift;
	}
	if (name == "control" || name == "ctrl") {
		return kModifierControl;
	}
	if (name == "alt" || name == "option" || name == "opt") {
		return kModifierAlt;
	}
	// On Windows the platform-neutral "meta" is the Windows key, which is also what "cmd" from a
	// macOS-shaped chord should map to.
	if (name == "meta" || name == "cmd" || name == "command" || name == "win" || name == "super") {
		return kModifierMeta;
	}
	return kModifierNone;
}

MouseButton ParseMouseButton(const std::string& rawName) {
	const std::string name = ToLowerAscii(rawName);
	if (name == "right") {
		return MouseButton::Right;
	}
	if (name == "middle") {
		return MouseButton::Middle;
	}
	return MouseButton::Left;
}

bool ParseScrollDirection(const std::string& rawName, ScrollDirection& out) {
	const std::string name = ToLowerAscii(rawName);
	if (name == "up") {
		out = ScrollDirection::Up;
		return true;
	}
	if (name == "down") {
		out = ScrollDirection::Down;
		return true;
	}
	if (name == "left") {
		out = ScrollDirection::Left;
		return true;
	}
	if (name == "right") {
		out = ScrollDirection::Right;
		return true;
	}
	return false;
}

bool GetCursorPositionPhysical(POINT& out) {
	// Physical pixels because the process is per-monitor-aware; see Dpi.h.
	return ::GetCursorPos(&out) != FALSE;
}

bool MoveCursorTo(long x, long y, std::string& error) {
	if (!::SetCursorPos(static_cast<int>(x), static_cast<int>(y))) {
		error = "SetCursorPos failed, GetLastError=" +
			std::to_string(static_cast<unsigned long>(::GetLastError()));
		return false;
	}
	return true;
}

bool SynthesizeClick(long x, long y, MouseButton button, unsigned int modifiers, int clickCount,
	std::string& error) {
	if (!MoveCursorTo(x, y, error)) {
		return false;
	}
	if (!PressModifiers(modifiers, error)) {
		ReleaseModifiers(modifiers);
		return false;
	}
	const auto releaseGuard = MakeScopeExit([modifiers]() { ReleaseModifiers(modifiers); });

	DWORD downFlag = MOUSEEVENTF_LEFTDOWN;
	DWORD upFlag = MOUSEEVENTF_LEFTUP;
	MouseButtonFlags(button, downFlag, upFlag);

	const int clicks = Clamp(clickCount, 1, 3);
	for (int index = 0; index < clicks; ++index) {
		if (Cancellation::IsRequested()) {
			error = "cancelled";
			return false;
		}
		if (!SendMouseButton(downFlag, "mouse down", error)) {
			return false;
		}
		if (!SendMouseButton(upFlag, "mouse up", error)) {
			return false;
		}
	}
	return true;
}

bool SynthesizeDrag(long fromX, long fromY, long toX, long toY, MouseButton button,
	unsigned int modifiers, int durationMs, std::string& error) {
	if (!MoveCursorTo(fromX, fromY, error)) {
		return false;
	}
	if (!PressModifiers(modifiers, error)) {
		ReleaseModifiers(modifiers);
		return false;
	}
	// Declared before the button guard so it runs AFTER it: the button must come up while the
	// modifiers are still held, exactly as a person would release them.
	const auto modifierGuard = MakeScopeExit([modifiers]() { ReleaseModifiers(modifiers); });

	DWORD downFlag = MOUSEEVENTF_LEFTDOWN;
	DWORD upFlag = MOUSEEVENTF_LEFTUP;
	MouseButtonFlags(button, downFlag, upFlag);

	if (!SendMouseButton(downFlag, "drag press", error)) {
		return false;
	}
	// From here on the button is DOWN. Every exit path below must go through this guard, which is
	// why nothing in the rest of this function returns before it is installed.
	bool released = false;
	const auto buttonGuard = MakeScopeExit([upFlag, &released]() {
		if (released) {
			return;
		}
		std::string ignored;
		if (!SendMouseButton(upFlag, "drag release", ignored)) {
			// Nothing further can be done, but the lead needs this in the log: the user's mouse
			// button is now stuck down until they click.
			LogWarn("drag: failed to release the mouse button: " + ignored);
		}
	});

	// A short pause after the press and before any movement: applications latch the drag origin on
	// the button-down message, and one that has not processed it yet reads the first move as a
	// hover and never starts the drag at all.
	::Sleep(kDragSettleAfterPressMs);

	const int duration = Clamp(durationMs, 0, kMaxDragDurationMs);
	const int steps = Clamp(duration / kDragStepIntervalMs, kMinDragSteps, kMaxDragSteps);
	const int stepSleepMs = duration / steps; // 0 for a zero-duration drag, which is allowed.

	for (int step = 1; step <= steps; ++step) {
		if (Cancellation::IsRequested()) {
			error = "cancelled";
			return false;
		}
		const long x = InterpolateCoordinate(fromX, toX, step, steps);
		const long y = InterpolateCoordinate(fromY, toY, step, steps);
		if (!MoveCursorTo(x, y, error)) {
			return false;
		}
		if (stepSleepMs > 0) {
			::Sleep(static_cast<DWORD>(stepSleepMs));
		}
	}

	// Land exactly on the destination. The interpolation already ends there, but rounding is only
	// as trustworthy as the arithmetic above and a drop one pixel off a boundary is a real failure.
	if (!MoveCursorTo(toX, toY, error)) {
		return false;
	}
	::Sleep(kDragSettleBeforeReleaseMs);

	if (!SendMouseButton(upFlag, "drag release", error)) {
		return false;
	}
	released = true;
	return true;
}

bool SynthesizeMouseMove(long x, long y, int settleMs, std::string& error) {
	if (!MoveCursorTo(x, y, error)) {
		return false;
	}
	const int dwell = Clamp(settleMs, 0, kMaxMouseMoveSettleMs);
	if (dwell == 0) {
		return true;
	}
	return SleepCancellable(dwell, error);
}

bool SynthesizeText(const std::string& text, std::string& error) {
	const std::wstring wide = Utf8ToWide(text);
	for (const wchar_t codeUnit : wide) {
		// Checked per character so a long paste aborts promptly.
		if (Cancellation::IsRequested()) {
			error = "cancelled";
			return false;
		}

		// A Unicode newline event does not produce Enter in most applications, and a caller typing
		// a multi-line string means "press Return here". Same for tab.
		if (codeUnit == L'\r') {
			continue; // CRLF arrives as \r\n; the \n does the work.
		}
		if (codeUnit == L'\n') {
			if (!SendOne(MakeKeyInput(VK_RETURN, false), "return down", error) ||
				!SendOne(MakeKeyInput(VK_RETURN, true), "return up", error)) {
				return false;
			}
			continue;
		}
		if (codeUnit == L'\t') {
			if (!SendOne(MakeKeyInput(VK_TAB, false), "tab down", error) ||
				!SendOne(MakeKeyInput(VK_TAB, true), "tab up", error)) {
				return false;
			}
			continue;
		}

		if (!SendOne(MakeUnicodeInput(codeUnit, false), "unicode down", error) ||
			!SendOne(MakeUnicodeInput(codeUnit, true), "unicode up", error)) {
			return false;
		}
	}
	return true;
}

bool SynthesizeChord(const std::string& chord, int repeat, std::string& error) {
	const std::vector<std::string> tokens = SplitChord(chord);
	if (tokens.empty()) {
		error = "empty chord";
		return false;
	}

	unsigned int modifiers = kModifierNone;
	std::string keyName;
	for (size_t index = 0; index < tokens.size(); ++index) {
		const unsigned int modifier = ParseModifierName(tokens[index]);
		const bool isLast = index + 1 == tokens.size();
		if (modifier != kModifierNone && !isLast) {
			modifiers |= modifier;
			continue;
		}
		if (!isLast) {
			error = "unrecognised modifier '" + tokens[index] + "' in chord '" + chord + "'";
			return false;
		}
		keyName = tokens[index];
	}

	// A chord that is only modifiers ("ctrl+shift") is treated as pressing those modifiers, which
	// is almost never what a caller means, so refuse it rather than doing something surprising.
	if (ParseModifierName(keyName) != kModifierNone) {
		error = "chord '" + chord + "' has no non-modifier key";
		return false;
	}

	WORD virtualKey = 0;
	bool needsShift = false;
	if (!ResolveKeyName(keyName, virtualKey, needsShift)) {
		error = "unrecognised key '" + keyName + "' in chord '" + chord + "'";
		return false;
	}
	if (needsShift) {
		modifiers |= kModifierShift;
	}

	const int repeats = Clamp(repeat, 1, 64);
	if (!PressModifiers(modifiers, error)) {
		ReleaseModifiers(modifiers);
		return false;
	}
	const auto releaseGuard = MakeScopeExit([modifiers]() { ReleaseModifiers(modifiers); });

	for (int index = 0; index < repeats; ++index) {
		if (Cancellation::IsRequested()) {
			error = "cancelled";
			return false;
		}
		if (!SendOne(MakeKeyInput(virtualKey, false), "key down", error) ||
			!SendOne(MakeKeyInput(virtualKey, true), "key up", error)) {
			return false;
		}
	}
	return true;
}

bool SynthesizeScroll(long x, long y, ScrollDirection direction, int amount, std::string& error) {
	if (!MoveCursorTo(x, y, error)) {
		return false;
	}

	const int notches = Clamp(amount, 1, 100);
	const bool horizontal =
		direction == ScrollDirection::Left || direction == ScrollDirection::Right;
	// Positive WHEEL_DELTA scrolls away from the user (up) and, for the horizontal wheel, right.
	const int sign =
		(direction == ScrollDirection::Up || direction == ScrollDirection::Right) ? 1 : -1;

	for (int index = 0; index < notches; ++index) {
		if (Cancellation::IsRequested()) {
			error = "cancelled";
			return false;
		}
		INPUT input = {};
		input.type = INPUT_MOUSE;
		input.mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
		input.mi.mouseData = static_cast<DWORD>(static_cast<int>(sign * WHEEL_DELTA));
		if (!SendOne(input, "wheel", error)) {
			return false;
		}
	}
	return true;
}

} // namespace v3cu
