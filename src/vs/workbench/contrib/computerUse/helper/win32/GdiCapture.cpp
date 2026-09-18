/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// GDI fallback capture implementation. See GdiCapture.h.
// NEEDS VERIFICATION ON WINDOWS (full list in GdiCapture.h):
//   - Whether CAPTUREBLT causes a visible flicker; if it does, weigh that against losing layered
//     windows from the image.
//   - That the negative biHeight really yields a top-down buffer.
//   - Capturing a monitor at a negative virtual-screen origin.
//
#include "GdiCapture.h"

#include "Log.h"

#include <cstring>

namespace v3cu {
namespace {

/// Owns the GDI objects for one capture and releases them in reverse order of creation.
class GdiCaptureResources {
public:
	~GdiCaptureResources() {
		if (previousBitmap != nullptr && memoryDc != nullptr) {
			::SelectObject(memoryDc, previousBitmap);
		}
		if (bitmap != nullptr) {
			::DeleteObject(bitmap);
		}
		if (memoryDc != nullptr) {
			::DeleteDC(memoryDc);
		}
		if (screenDc != nullptr) {
			::ReleaseDC(nullptr, screenDc);
		}
	}

	HDC screenDc = nullptr;
	HDC memoryDc = nullptr;
	HBITMAP bitmap = nullptr;
	HGDIOBJ previousBitmap = nullptr;
	void* bits = nullptr;
};

} // namespace

bool CaptureMonitorWithGdi(const MonitorInfo& monitor, Frame& out, std::string& error) {
	if (monitor.bounds.IsEmpty()) {
		error = "monitor bounds are empty";
		return false;
	}

	const int width = static_cast<int>(monitor.bounds.width);
	const int height = static_cast<int>(monitor.bounds.height);

	GdiCaptureResources resources;
	resources.screenDc = ::GetDC(nullptr);
	if (resources.screenDc == nullptr) {
		error = "GetDC(nullptr) failed";
		return false;
	}
	resources.memoryDc = ::CreateCompatibleDC(resources.screenDc);
	if (resources.memoryDc == nullptr) {
		error = "CreateCompatibleDC failed";
		return false;
	}

	BITMAPINFO info = {};
	info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
	info.bmiHeader.biWidth = width;
	// Negative height requests a top-down DIB, matching Frame's row order.
	info.bmiHeader.biHeight = -height;
	info.bmiHeader.biPlanes = 1;
	info.bmiHeader.biBitCount = 32;
	info.bmiHeader.biCompression = BI_RGB;

	resources.bitmap = ::CreateDIBSection(resources.screenDc, &info, DIB_RGB_COLORS,
		&resources.bits, nullptr, 0);
	if (resources.bitmap == nullptr || resources.bits == nullptr) {
		error = "CreateDIBSection failed";
		return false;
	}
	resources.previousBitmap = ::SelectObject(resources.memoryDc, resources.bitmap);

	// SRCCOPY | CAPTUREBLT: CAPTUREBLT includes layered (transparent) windows, which many modern
	// apps use for shadows and popups. Source coordinates are virtual-screen physical pixels.
	if (!::BitBlt(resources.memoryDc, 0, 0, width, height, resources.screenDc,
			static_cast<int>(monitor.bounds.x), static_cast<int>(monitor.bounds.y),
			SRCCOPY | CAPTUREBLT)) {
		error = "BitBlt failed, GetLastError=" +
			std::to_string(static_cast<unsigned long>(::GetLastError()));
		return false;
	}

	out.width = width;
	out.height = height;
	out.stride = width * 4;
	out.sourceBounds = monitor.bounds;
	out.pixels.assign(static_cast<size_t>(out.stride) * static_cast<size_t>(height), 0);
	::memcpy(out.pixels.data(), resources.bits, out.pixels.size());

	// A DIB section leaves the alpha byte at 0; without this the PNG would be fully transparent.
	out.ForceOpaque();
	return true;
}

bool ProbeGdiCaptureAvailable() {
	const HDC screenDc = ::GetDC(nullptr);
	if (screenDc == nullptr) {
		return false;
	}
	const HDC memoryDc = ::CreateCompatibleDC(screenDc);
	bool ok = false;
	if (memoryDc != nullptr) {
		const HBITMAP bitmap = ::CreateCompatibleBitmap(screenDc, 1, 1);
		if (bitmap != nullptr) {
			const HGDIOBJ previous = ::SelectObject(memoryDc, bitmap);
			ok = ::BitBlt(memoryDc, 0, 0, 1, 1, screenDc, 0, 0, SRCCOPY) != FALSE;
			::SelectObject(memoryDc, previous);
			::DeleteObject(bitmap);
		}
		::DeleteDC(memoryDc);
	}
	::ReleaseDC(nullptr, screenDc);
	return ok;
}

} // namespace v3cu
