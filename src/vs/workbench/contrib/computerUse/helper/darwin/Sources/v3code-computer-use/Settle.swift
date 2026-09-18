/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import Foundation

/// Waits until an application's UI stops changing.
///
/// **What this is for.** "Clicked while the sheet was still animating" is the largest single class of
/// flaky failure in computer use, and it is invisible from the outside: the click lands, the helper
/// reports success, and the element that received it was whatever occupied that point mid-slide. Every
/// downstream observation is then a description of a screen that no longer exists. The fix has to live
/// here, before the action, and it has to be honest when it fails — hence `settled: false` rather than
/// a silent best effort.
///
/// **Two signals, because either alone is wrong.**
///
/// 1. *Notification quiescence.* An `AXObserver` on the target tells us when the application stopped
///    reporting changes. Cheap, precise, and available for most native UI. But a layer-backed Core
///    Animation transition updates no accessibility geometry and fires no notification, so an
///    application can be visually mid-animation and accessibility-silent — exactly the case that
///    motivated the feature.
/// 2. *Frame stability.* Two consecutive digests of the application's own windows matching. Catches
///    what notifications miss, needs Screen Recording, and is deliberately coarse so a blinking caret
///    is not motion (see `FrameSampler`).
///
/// So quiescence is confirmed by frames when frames are available, and frames stand alone when
/// notifications are not. When neither signal is available the answer is `settled: false` with
/// `notificationsUnavailable` — not an optimistic true, because a caller that cannot tell whether the
/// UI is moving is exactly the caller that must be told so.
///
/// **Thresholds, and why these numbers.** All four are stated as constants and none is a guess:
///
/// - `quietPeriodMs` default 120 ms, from the contract. A 60 Hz frame is 16.7 ms, so this is seven
///   frames of silence — comfortably longer than the gap between notifications during an active
///   animation, and short enough that the common case (a menu opens, one structure change fires,
///   done) costs about 120 ms rather than a whole budget.
/// - `timeoutMs` default 1500 ms, from the contract: AppKit sheet and window transitions run
///   200-350 ms and Core Animation's implicit duration is 250 ms, so 1500 ms clears all of them with
///   room for a loaded machine.
/// - `frameSampleIntervalMs` 50 ms — three frames at 60 Hz. Sampling faster would compare frames a
///   single compositor pass apart and call a mid-animation pause "stable"; sampling slower would leave
///   the budget unable to fit the two consecutive matches a verdict needs.
/// - `frameStableSamples` 2. Two matching samples 50 ms apart is the smallest evidence that means
///   anything. Three was measurably slower on menus and caught nothing extra, because the animations
///   in question all run far longer than 100 ms.
enum Settle {
	/// Hard ceiling on the budget, whatever the caller asks for.
	///
	/// Below the channel's own timeout for `settle` on purpose. A caller that passes a larger
	/// `timeoutMs` would otherwise have the request killed by the channel and see a transport timeout
	/// instead of the honest `settled: false` this method exists to produce.
	static let maxBudgetMs = 4500

	/// Floor on the budget, so a zero or negative value still performs one meaningful check.
	static let minBudgetMs = 16

	static let frameSampleIntervalMs = 50
	static let frameStableSamples = 2

	/// The longest a single condition wait may block, so cancellation is noticed promptly.
	static let pollSliceMs = 10

	static func run(
		_ params: SettleParams?,
		pid: pid_t,
		watcher: AxWatcher,
		cancellation: Cancellation.Token
	) throws -> SettleResult {
		let started = Date()
		let budgetMs = clamp(params?.timeoutMs ?? COMPUTER_USE_DEFAULT_SETTLE_BUDGET_MS, minBudgetMs, maxBudgetMs)
		let quietMs = clamp(params?.quietPeriodMs ?? COMPUTER_USE_DEFAULT_SETTLE_QUIET_MS, 1, budgetMs)
		let requireFrames = params?.requireFrameStability ?? true
		let deadline = started.addingTimeInterval(Double(budgetMs) / 1000)
		let quiet = Double(quietMs) / 1000

		let notificationsAvailable = watcher.ensureWatching(pid: pid)
		var reading = watcher.activity(pid: pid)
		let baseline = reading.count
		var notifications = 0

		var frameHash: UInt64?
		var frameSamples = 0
		var consecutiveMatches = 0
		var nextFrameSampleAt = started
		var everQuiet = false
		// Sampled once rather than per iteration: the permission cannot change mid-wait, and the whole
		// point of the gate is that a false negative here is safe while a false positive is not.
		let framesUsable = requireFrames && FrameSampler.isAvailable

		// Neither signal exists: there is nothing to wait *for*, so waiting out the budget would cost the
		// agent a second and a half to learn what is already known. Answer immediately and honestly.
		if !notificationsAvailable && !framesUsable {
			Log.debug("settle for pid \(pid) has neither notifications nor frame comparison available")
			return SettleResult(
				settled: false,
				waitedMs: elapsedMs(since: started),
				reason: .notificationsUnavailable,
				frameSamples: nil,
				notifications: nil
			)
		}

		while Date() < deadline {
			try cancellation.check()

			if framesUsable, Date() >= nextFrameSampleAt {
				frameSamples += 1
				nextFrameSampleAt = Date().addingTimeInterval(Double(frameSampleIntervalMs) / 1000)
				if let sample = FrameSampler.fingerprint(pid: pid) {
					if let previous = frameHash, previous == sample {
						consecutiveMatches += 1
					} else {
						consecutiveMatches = 1
					}
					frameHash = sample
				} else {
					// The application has no window on screen to compare. That is not stability, so the
					// evidence is discarded rather than counted.
					consecutiveMatches = 0
					frameHash = nil
				}
			}

			// Quiet is measured from the last notification, or from the start when none has ever arrived,
			// so a settle always waits at least one quiet period. A notification already in flight when
			// the call arrived would otherwise be missed entirely.
			let since = reading.lastAt ?? started
			let quietAt = since.addingTimeInterval(quiet)
			if Date() >= quietAt {
				everQuiet = true
				if !framesUsable || consecutiveMatches >= frameStableSamples {
					return SettleResult(
						settled: true,
						waitedMs: elapsedMs(since: started),
						reason: notificationsAvailable ? .quiescent : .notificationsUnavailable,
						frameSamples: framesUsable ? frameSamples : nil,
						notifications: notificationsAvailable ? notifications : nil
					)
				}
			}

			var wakeAt = min(quietAt, deadline)
			if framesUsable {
				wakeAt = min(wakeAt, nextFrameSampleAt)
			}
			wakeAt = min(wakeAt, Date().addingTimeInterval(Double(pollSliceMs) / 1000))

			let next = watcher.wait(pid: pid, past: reading.count, until: wakeAt)
			if next.count > reading.count {
				notifications += Int(next.count - reading.count)
				reading = next
			} else if !notificationsAvailable {
				// No notification path: the loop is driven purely by the frame schedule, so it must not
				// spin. `wait` already blocked until `wakeAt`.
				reading = next
			}
		}

		// The budget is gone. Frames are the only remaining evidence, and they are only worth reporting
		// as a verdict if they actually matched.
		let waited = elapsedMs(since: started)
		if framesUsable, consecutiveMatches >= frameStableSamples {
			return SettleResult(
				settled: true,
				waitedMs: waited,
				reason: notificationsAvailable ? (everQuiet ? .quiescent : .frameStable) : .notificationsUnavailable,
				frameSamples: frameSamples,
				notifications: notificationsAvailable ? notifications : nil
			)
		}
		if !notificationsAvailable {
			return SettleResult(
				settled: false,
				waitedMs: waited,
				reason: .notificationsUnavailable,
				frameSamples: framesUsable ? frameSamples : nil,
				notifications: nil
			)
		}
		Log.debug(
			"settle for pid \(pid) exhausted its \(budgetMs)ms budget after \(notifications) notifications and \(frameSamples) frames; baseline count was \(baseline)"
		)
		return SettleResult(
			settled: false,
			waitedMs: waited,
			reason: .budgetExceeded,
			frameSamples: framesUsable ? frameSamples : nil,
			notifications: notifications
		)
	}

	private static func clamp(_ value: Int, _ lower: Int, _ upper: Int) -> Int {
		min(max(value, lower), upper)
	}

	private static func elapsedMs(since start: Date) -> Int {
		Int((Date().timeIntervalSince(start) * 1000).rounded())
	}
}
