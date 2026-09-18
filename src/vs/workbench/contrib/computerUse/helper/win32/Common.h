/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Shared primitives for the Windows computer-use helper: UTF-8/UTF-16 conversion, a scope
// guard, a physical-pixel rectangle, and the helper build version.
//
// LANGUAGE CHOICE: C++17 with the Windows SDK only. Rust was considered and rejected: the
// entire surface of this helper is COM (UI Automation, WIC, D3D11/DXGI), and the Rust path
// to those APIs is either the `windows` crate (a third-party dependency, forbidden here) or
// hand-written bindings (more unverifiable code than the C++ it would replace).
//
// NEEDS VERIFICATION ON WINDOWS:
//   - Compiles clean with /W4 under MSVC (cl.exe) x64. Never compiled anywhere.
//   - WideToUtf8/Utf8ToWide round-trip on non-BMP text (emoji in window titles).
//
#pragma once

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>

// WIN32_LEAN_AND_MEAN above excludes OLE/COM from <windows.h>. The UI Automation headers
// (<uiautomation.h> -> UIAutomationCore.h) depend on those COM base declarations, and without
// them UIAutomationCore.h fails to parse its own interface forward-declarations: every provider
// interface reports "missing type specifier"/C2371 redefinition against a declaration in the same
// file. Pulling COM in here — before any translation unit reaches a UIA header — is what makes
// this helper compile at all; it is not incidental.
#include <objbase.h>

#include <cstdint>
#include <string>
#include <utility>

namespace v3cu {

/// Helper build version, reported by `ping` as `helperVersion`. Bump on every shipped change.
inline constexpr const char* kHelperVersion = "0.3.0";

/// Protocol version this helper was built against. Must equal COMPUTER_USE_PROTOCOL_VERSION
/// in src/vs/workbench/contrib/computerUse/common/computerUseTypes.ts.
///
/// Version 2 is not just "more methods": it changes what a ref MEANS. A version-1 helper dropped its
/// whole ref table on every axTree, so no ref ever appeared in two snapshots and a diff of two
/// snapshots would report the entire tree as replaced every turn while looking like it worked. See
/// RefTable.h — refs are now content-bound and survive generations, which is the property the diff
/// engine in common/computerUseAxDiff.ts is built on. A caller must therefore refuse a helper whose
/// ping reports 1, which is exactly what the version mismatch check does.
///
/// Version 3 adds five methods and changes nothing about the existing ones: drag, mouseMove,
/// clipboardRead, clipboardWrite and openApplication. The bump is still mandatory — a version-2
/// helper answers `unknown method 'drag'` with an `internal` error, which reads as a bug rather than
/// as "this helper is too old", and the whole point of the version handshake is that the caller
/// learns the difference at `ping` instead of mid-task.
inline constexpr int kProtocolVersion = 3;

/// Converts a UTF-16 Windows string to UTF-8. Returns an empty string for empty input.
std::string WideToUtf8(const wchar_t* text, int lengthOrNegativeOne = -1);

/// Convenience overload.
std::string WideToUtf8(const std::wstring& text);

/// Converts UTF-8 to UTF-16.
std::wstring Utf8ToWide(const std::string& text);

/// Lower-cases an ASCII/UTF-8 string. Only ASCII letters are folded, which is all the
/// identifier matching in AppTiers needs.
std::string ToLowerAscii(std::string text);

/// A rectangle in physical screen pixels, origin at the top-left of the primary display.
/// Matches ComputerUseRect on the wire.
struct Rect {
	long x = 0;
	long y = 0;
	long width = 0;
	long height = 0;

	bool IsEmpty() const { return width <= 0 || height <= 0; }
};

/// Builds a Rect from a Win32 RECT.
Rect RectFromWin32(const RECT& rect);

/// Runs a callable when it goes out of scope. Used to restore OS state (capture exclusion,
/// released COM apartments) on every exit path, including exceptions.
template <typename Fn>
class ScopeExit {
public:
	explicit ScopeExit(Fn fn) : fn_(std::move(fn)) {}
	~ScopeExit() {
		if (active_) {
			fn_();
		}
	}
	ScopeExit(const ScopeExit&) = delete;
	ScopeExit& operator=(const ScopeExit&) = delete;

	void Dismiss() { active_ = false; }

private:
	Fn fn_;
	bool active_ = true;
};

/// Deduces the callable type for ScopeExit.
template <typename Fn>
ScopeExit<Fn> MakeScopeExit(Fn fn) {
	return ScopeExit<Fn>(std::move(fn));
}

/// Clamps a value into [low, high].
template <typename T>
T Clamp(T value, T low, T high) {
	return value < low ? low : (value > high ? high : value);
}

/// Formats an HRESULT as `0x8007000e` for log messages.
std::string FormatHResult(HRESULT hr);

} // namespace v3cu
