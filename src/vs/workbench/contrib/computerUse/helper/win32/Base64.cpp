/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
//
// base64 encoder. See Base64.h.
//
// NEEDS VERIFICATION ON WINDOWS: nothing platform-specific.
//
#include "Base64.h"

namespace v3cu {
namespace {

constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

} // namespace

std::string Base64Encode(const std::vector<uint8_t>& bytes) {
	std::string out;
	out.reserve(((bytes.size() + 2) / 3) * 4);

	size_t index = 0;
	const size_t fullTriples = bytes.size() / 3;
	for (size_t triple = 0; triple < fullTriples; ++triple) {
		const uint32_t chunk = (static_cast<uint32_t>(bytes[index]) << 16) |
			(static_cast<uint32_t>(bytes[index + 1]) << 8) |
			static_cast<uint32_t>(bytes[index + 2]);
		index += 3;
		out.push_back(kAlphabet[(chunk >> 18) & 0x3f]);
		out.push_back(kAlphabet[(chunk >> 12) & 0x3f]);
		out.push_back(kAlphabet[(chunk >> 6) & 0x3f]);
		out.push_back(kAlphabet[chunk & 0x3f]);
	}

	const size_t remaining = bytes.size() - index;
	if (remaining == 1) {
		const uint32_t chunk = static_cast<uint32_t>(bytes[index]) << 16;
		out.push_back(kAlphabet[(chunk >> 18) & 0x3f]);
		out.push_back(kAlphabet[(chunk >> 12) & 0x3f]);
		out.push_back('=');
		out.push_back('=');
	} else if (remaining == 2) {
		const uint32_t chunk = (static_cast<uint32_t>(bytes[index]) << 16) |
			(static_cast<uint32_t>(bytes[index + 1]) << 8);
		out.push_back(kAlphabet[(chunk >> 18) & 0x3f]);
		out.push_back(kAlphabet[(chunk >> 12) & 0x3f]);
		out.push_back(kAlphabet[(chunk >> 6) & 0x3f]);
		out.push_back('=');
	}

	return out;
}

} // namespace v3cu
