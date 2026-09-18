/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import AppKit
import Foundation

/// Entry point for `v3code-computer-use`.
///
/// Newline-delimited JSON in on stdin, newline-delimited JSON out on stdout, diagnostics on stderr.
/// The process owns no window and shows no UI; it exits when stdin closes, which is how V3Code shuts it
/// down — there is no quit message, because a helper that could refuse to quit would be a problem.
///
/// Threading:
/// - The **main thread** runs a run loop and nothing else. `NSWorkspace` is main-thread-affine and
///   ScreenCaptureKit delivers its callbacks on a queue that needs the main loop alive, so keeping it
///   free is load-bearing.
/// - A dedicated **reader thread** blocks on stdin and answers `ping`, `status` and `cancel` inline.
/// - A serial **work queue** runs everything that observes or touches the screen, one at a time.

/// Reads length-agnostic newline-delimited frames off a file descriptor.
///
/// Hand-rolled rather than `readLine()` because a request can exceed any fixed buffer and because the
/// reader must distinguish a partial read from end of stream: treating a partial line as a whole one
/// would hand the decoder a truncated object and drop a request the caller is still waiting on.
final class LineReader {
	private let handle: FileHandle
	private var buffer = Data()
	private static let chunkSize = 64 * 1024

	init(handle: FileHandle) {
		self.handle = handle
	}

	/// Blocks until a full line is available. Returns nil at end of stream.
	func next() -> Data? {
		while true {
			if let newline = buffer.firstIndex(of: 0x0A) {
				let line = buffer[buffer.startIndex..<newline]
				buffer.removeSubrange(buffer.startIndex...newline)
				// A trailing CR from a caller that writes CRLF would otherwise land inside the JSON.
				if line.last == 0x0D {
					return line.dropLast()
				}
				return Data(line)
			}
			let chunk = handle.availableData
			if chunk.isEmpty {
				// End of stream. Anything left in the buffer is an unterminated line; it cannot be answered
				// safely, so it is reported and discarded.
				if !buffer.isEmpty {
					Log.warn("discarding \(buffer.count) bytes of unterminated input at end of stream")
					buffer.removeAll()
				}
				return nil
			}
			buffer.append(chunk)
		}
	}
}

let writer = ResponseWriter()
let dispatcher = Dispatcher(writer: writer)

Log.info("starting v3code-computer-use \(HELPER_VERSION), protocol \(COMPUTER_USE_PROTOCOL_VERSION)")

// SIGPIPE would kill the process the instant V3Code went away mid-write, bypassing the orderly
// end-of-stream shutdown below. Ignored so the failing write simply returns.
signal(SIGPIPE, SIG_IGN)

let readerThread = Thread {
	let reader = LineReader(handle: FileHandle.standardInput)
	while let line = reader.next() {
		dispatcher.handle(line: line)
	}
	Log.info("stdin closed; draining in-flight work")
	// Bounded, so a wedged application cannot keep the helper alive after V3Code has gone.
	dispatcher.drain(timeout: 10)
	Log.info("exiting")
	exit(0)
}
readerThread.name = "dev.v3code.computerUse.stdin"
// The default 512 KB is ample for JSON framing, but the reader also runs the inline handlers.
readerThread.stackSize = 1 << 20
readerThread.start()

// The helper is a background accessory: no Dock tile, no menu bar, no activation. Anything else would
// steal focus from the very application the agent is trying to drive.
//
// `.accessory` rather than `.prohibited`, and the difference is load-bearing: a prohibited application
// may not create windows at all, which silently made the on-screen indicator impossible — the panel was
// built, ordered front, and never rendered. `.accessory` is equally invisible (no Dock tile, no menu
// bar) but may show panels, and combined with `.nonactivatingPanel` it still never takes focus.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
// Completes AppKit's launch sequence — connecting to the window server and installing the event
// machinery a panel needs. `RunLoop.main.run()` alone spins the run loop without ever finishing
// launch, which is enough for ScreenCaptureKit callbacks but not enough to put a window on screen.
application.finishLaunching()
RunLoop.main.run()
