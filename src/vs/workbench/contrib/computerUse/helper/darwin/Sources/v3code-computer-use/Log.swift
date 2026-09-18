/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import Foundation

/// The helper's only diagnostic sink.
///
/// `stdout` carries newline-delimited protocol traffic and nothing else, so a stray `print` would
/// corrupt the stream and desynchronise the caller. Every diagnostic in this executable goes through
/// here and lands on stderr; nothing else in the package may write to stdout except `ResponseWriter`.
enum Log {
	enum Level: String {
		case debug
		case info
		case warn
		case error
	}

	private static let lock = NSLock()

	/// Debug lines are suppressed unless explicitly enabled, so normal operation stays quiet.
	private static let debugEnabled: Bool = {
		let value = ProcessInfo.processInfo.environment["V3CODE_COMPUTER_USE_DEBUG"]
		return value != nil && value != "0" && value != ""
	}()

	static func debug(_ message: @autoclosure () -> String) {
		guard debugEnabled else { return }
		emit(.debug, message())
	}

	static func info(_ message: String) {
		emit(.info, message)
	}

	static func warn(_ message: String) {
		emit(.warn, message)
	}

	static func error(_ message: String) {
		emit(.error, message)
	}

	private static func emit(_ level: Level, _ message: String) {
		let line = "[v3code-computer-use] \(level.rawValue) \(message)\n"
		guard let data = line.data(using: .utf8) else { return }
		lock.lock()
		defer { lock.unlock() }
		FileHandle.standardError.write(data)
	}
}
