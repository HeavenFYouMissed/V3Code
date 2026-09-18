/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import Foundation

/// The sole owner of stdout.
///
/// Framing is one JSON object per line, so a write must be atomic with respect to other writes: two
/// interleaved responses would produce a line the caller cannot parse and could not correlate back to
/// a request. A lock around the whole encode-and-write is cheap at this traffic volume.
final class ResponseWriter {
	private let lock = NSLock()
	private let encoder: JSONEncoder

	init() {
		let encoder = JSONEncoder()
		// No pretty printing: a newline inside a payload would break the framing outright.
		encoder.outputFormatting = [.withoutEscapingSlashes]
		self.encoder = encoder
	}

	func send<R: Encodable>(id: Int, result: R) {
		write(SuccessResponse(id: id, result: result))
	}

	func send(id: Int, error: HelperError) {
		Log.warn("request \(id) failed: \(error.code.rawValue): \(error.message)")
		write(
			ErrorResponse(
				id: id,
				error: WireError(code: error.code, message: error.message, retryable: error.retryable)
			)
		)
	}

	private func write<T: Encodable>(_ response: T) {
		let payload: Data
		do {
			payload = try encoder.encode(response)
		} catch {
			// Encoding our own response type cannot normally fail. Do not attempt a second encode of a
			// fallback object on stdout, because whatever broke may break again mid-line.
			Log.error("failed to encode a response: \(error)")
			return
		}
		lock.lock()
		defer { lock.unlock() }
		var line = payload
		line.append(0x0A)
		FileHandle.standardOutput.write(line)
	}
}
