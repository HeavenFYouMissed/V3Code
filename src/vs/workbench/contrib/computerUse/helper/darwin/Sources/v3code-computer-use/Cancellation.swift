/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import Foundation

/// Cooperative cancellation for in-flight actions.
///
/// `cancel` is handled on the reader thread, not the work queue, precisely so it can land while an
/// action is running — queued behind the action it is meant to stop, it would be useless.
///
/// Cancellation is epoch-based rather than a plain flag. A flag set just after an action finished would
/// cancel the *next* action, which is worse than not cancelling at all: the model asked to stop one
/// thing and a later, unrelated click silently vanished. An action only observes cancels whose epoch is
/// newer than the epoch it started in.
final class Cancellation {
	private let lock = NSLock()
	private var epoch = 0

	/// A token captured at the start of an action.
	struct Token {
		fileprivate let epoch: Int
		fileprivate let source: Cancellation?

		/// A token that never cancels, for work no caller is waiting on.
		///
		/// Used by ambient observation samples. `cancel` means "stop the action I asked for", and an
		/// ambient sample is not that action; letting a cancel aimed at a click silently skip a sample
		/// would make the sample count depend on unrelated traffic. The sample is bounded by the
		/// accessibility messaging timeout and the tree walk's own node ceiling regardless.
		static let uncancellable = Token(epoch: 0, source: nil)

		var isCancelled: Bool {
			source?.hasCancelled(since: epoch) ?? false
		}

		/// Throws `cancelled` if a cancel arrived since this token was taken. Called between the steps of
		/// any multi-step action, so a long `type` or a repeated `key` stops promptly.
		func check() throws {
			if isCancelled {
				throw HelperError(.cancelled, "the action was cancelled")
			}
		}
	}

	func begin() -> Token {
		lock.lock()
		defer { lock.unlock() }
		return Token(epoch: epoch, source: self)
	}

	/// Requests cancellation of anything currently running.
	func cancel() {
		lock.lock()
		epoch += 1
		let current = epoch
		lock.unlock()
		Log.debug("cancellation requested, epoch now \(current)")
	}

	private func hasCancelled(since startEpoch: Int) -> Bool {
		lock.lock()
		defer { lock.unlock() }
		return epoch > startEpoch
	}
}
