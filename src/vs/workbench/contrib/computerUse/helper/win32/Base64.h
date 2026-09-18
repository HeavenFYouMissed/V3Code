/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// Standard base64 encoding for the `dataBase64` field of ComputerUseCaptureResult.
//
// The contract requires the raw base64 with no data-URI prefix, standard alphabet, padded.
//
// NEEDS VERIFICATION ON WINDOWS:
//   - Nothing platform-specific. Correctness is by inspection; a single round-trip test against
//     Node's Buffer.from(x, 'base64') would settle it.
//
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace v3cu {

/// Encodes `bytes` as padded standard base64 (RFC 4648) with no line breaks.
std::string Base64Encode(const std::vector<uint8_t>& bytes);

} // namespace v3cu
