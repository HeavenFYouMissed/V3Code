/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// A captured, uncompressed frame: 32-bit BGRA, top-down, in physical pixels.
//
// Both capture backends (DesktopDuplication and GdiCapture) produce this shape so the
// orchestration in Capture.cpp is backend-agnostic.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - ForceOpaque: needed because a GDI DIB section leaves the alpha byte at 0, which would encode
//     as a fully transparent PNG. Confirm the resulting screenshot is opaque.
//
#pragma once

#include "Common.h"

#include <cstdint>
#include <vector>

namespace v3cu {

struct Frame {
	int width = 0;
	int height = 0;
	/// Bytes per row. May exceed width * 4 for a DXGI staging texture.
	int stride = 0;
	/// width x height BGRA pixels, first row first.
	std::vector<uint8_t> pixels;
	/// The physical screen rectangle this frame covers. Needed to map image coordinates back to
	/// the screen on a monitor whose origin is not (0, 0).
	Rect sourceBounds;

	bool IsValid() const {
		return width > 0 && height > 0 && stride >= width * 4 &&
			pixels.size() >= static_cast<size_t>(stride) * static_cast<size_t>(height);
	}

	/// Sets every alpha byte to 0xFF. See the header comment.
	void ForceOpaque() {
		for (int row = 0; row < height; ++row) {
			uint8_t* line = pixels.data() + static_cast<size_t>(row) * static_cast<size_t>(stride);
			for (int column = 0; column < width; ++column) {
				line[static_cast<size_t>(column) * 4 + 3] = 0xff;
			}
		}
	}
};

} // namespace v3cu
