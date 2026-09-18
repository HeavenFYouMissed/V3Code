/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// PNG encoding and downscaling via the Windows Imaging Component.
//
// WIC ships with Windows and is part of the SDK, so this satisfies "no third-party dependencies"
// while avoiding a hand-rolled deflate implementation — which would be several hundred lines of
// unverifiable code in a helper that cannot be compiled here.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - The whole file. WIC is used from an MTA thread; CLSID_WICImagingFactory must be creatable
//     there (it is documented as both-threaded, but untested here).
//   - That the PNG the encoder produces is accepted by Node's Buffer/base64 path and renders in
//     the model's vision pipeline at the expected size.
//   - Alpha handling: both capture paths force alpha to 0xFF before calling in, because a GDI
//     DIB section leaves alpha at 0 and a 32bppBGRA PNG with zero alpha is fully transparent.
//     Confirm the encoded PNG is opaque.
//   - SHCreateMemStream availability at link time (shlwapi.lib).
//
#pragma once

#include "Common.h"

#include <cstdint>
#include <string>
#include <vector>

namespace v3cu {

/// Encodes a 32-bit BGRA top-down buffer to PNG, optionally scaling to targetWidth x targetHeight.
/// Pass the source dimensions as the target to skip scaling. Returns false with `error` set on
/// failure; `out` is only written on success.
bool EncodeBgraToPng(const uint8_t* pixels,
	int sourceWidth,
	int sourceHeight,
	int sourceStride,
	int targetWidth,
	int targetHeight,
	std::vector<uint8_t>& out,
	std::string& error);

} // namespace v3cu
