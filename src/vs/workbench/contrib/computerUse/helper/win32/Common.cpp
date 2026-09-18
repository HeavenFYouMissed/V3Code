/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Implementation of the shared primitives declared in Common.h.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - WideCharToMultiByte sizing calls (the two-pass pattern below) on strings containing
//     surrogate pairs.
//
#include "Common.h"

#include <cstdio>

namespace v3cu {

std::string WideToUtf8(const wchar_t* text, int lengthOrNegativeOne) {
	if (text == nullptr) {
		return std::string();
	}
	if (lengthOrNegativeOne == 0) {
		return std::string();
	}
	const int required = ::WideCharToMultiByte(CP_UTF8, 0, text, lengthOrNegativeOne, nullptr, 0, nullptr, nullptr);
	if (required <= 0) {
		return std::string();
	}
	std::string out(static_cast<size_t>(required), '\0');
	const int written = ::WideCharToMultiByte(CP_UTF8, 0, text, lengthOrNegativeOne, &out[0], required, nullptr, nullptr);
	if (written <= 0) {
		return std::string();
	}
	out.resize(static_cast<size_t>(written));
	// When lengthOrNegativeOne is -1 the conversion includes the terminating NUL; drop it so the
	// std::string length is the text length rather than text length + 1.
	if (lengthOrNegativeOne < 0 && !out.empty() && out.back() == '\0') {
		out.pop_back();
	}
	return out;
}

std::string WideToUtf8(const std::wstring& text) {
	if (text.empty()) {
		return std::string();
	}
	return WideToUtf8(text.c_str(), static_cast<int>(text.size()));
}

std::wstring Utf8ToWide(const std::string& text) {
	if (text.empty()) {
		return std::wstring();
	}
	const int required = ::MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
	if (required <= 0) {
		return std::wstring();
	}
	std::wstring out(static_cast<size_t>(required), L'\0');
	const int written = ::MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), &out[0], required);
	if (written <= 0) {
		return std::wstring();
	}
	out.resize(static_cast<size_t>(written));
	return out;
}

std::string ToLowerAscii(std::string text) {
	for (char& ch : text) {
		if (ch >= 'A' && ch <= 'Z') {
			ch = static_cast<char>(ch - 'A' + 'a');
		}
	}
	return text;
}

Rect RectFromWin32(const RECT& rect) {
	Rect out;
	out.x = rect.left;
	out.y = rect.top;
	out.width = rect.right - rect.left;
	out.height = rect.bottom - rect.top;
	return out;
}

std::string FormatHResult(HRESULT hr) {
	char buffer[32] = {};
	::_snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "0x%08lx", static_cast<unsigned long>(hr));
	return std::string(buffer);
}

} // namespace v3cu
