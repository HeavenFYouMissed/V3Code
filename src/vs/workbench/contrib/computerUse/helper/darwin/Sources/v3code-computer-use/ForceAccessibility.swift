/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import ApplicationServices
import Foundation

/// Asks a Chromium or Electron process to expose its accessibility tree.
///
/// Chromium keeps its accessibility engine switched off until an assistive client asks for it, and
/// until then it answers a walk with a single placeholder node. That looks identical to a permission
/// failure from the outside, which is the trap this method exists to avoid: the user is sent to
/// System Settings to grant something that is already granted, while the real fix is one attribute.
///
/// `AXManualAccessibility` is the documented Chromium opt-in and is a plain accessibility attribute —
/// public API, no entitlement, no private symbol. Setting it is a request, not a command: the engine
/// then spins up *asynchronously*, so this polls for the tree to appear rather than reporting success
/// the instant the write returns. `applied` and `treePopulated` are separate fields for exactly that
/// reason, and `applied: true, treePopulated: false` is a real and informative outcome.
///
/// **Two consequences worth stating plainly.**
///
/// 1. The flag is a property of the *target process*, not of the connection to it. Turning it on makes
///    that application introspectable to every accessibility client on the machine, not just to
///    V3Code, for as long as it runs. That is true of V3Code itself as much as of anything else, which
///    is why this refuses the `self` tier: the tier already forbids acting on V3Code, and there is no
///    reading of "help the agent" under which V3Code should be making its own transcript readable to
///    whatever else is listening.
/// 2. The first walk afterwards diffs as one enormous addition, because a tree genuinely appeared out
///    of nothing. So the baselines for that pid are marked incomparable here, and the caller gets
///    `baselineComparable: false` and sends a full tree — rather than a delta claiming the whole
///    application was just created.
enum ForceAccessibility {
	/// The Chromium opt-in attribute. Not in the SDK headers as a constant, so it is spelled out.
	static let attribute = "AXManualAccessibility"

	/// Ceiling on the poll, below the channel's own timeout for this method for the same reason as
	/// `Settle.maxBudgetMs`.
	static let maxTimeoutMs = 4500

	/// How often to re-count while waiting. Chromium typically populates in one or two hundred
	/// milliseconds, so 50 ms costs at most a handful of shallow walks and reports promptly.
	static let pollIntervalMs = 50

	/// Depth and node ceiling for the poll's shallow count.
	///
	/// Three levels is enough to distinguish "one placeholder" from "a real window with real content"
	/// and shallow enough that polling it several times a second is free. The count stops early anyway:
	/// the question is only ever "more than one node?".
	static let probeDepth = 3
	static let probeLimit = 64

	static func run(
		_ params: ForceAccessibilityParams,
		refTable: RefTable,
		snapshots: AxSnapshots,
		cancellation: Cancellation.Token
	) throws -> ForceAccessibilityResult {
		guard Ax.isProcessTrusted() else {
			throw HelperError(
				.accessibilityNotTrusted,
				"Accessibility permission has not been granted to the computer-use helper"
			)
		}
		let pid = params.pid
		let application = Ax.application(pid: pid)
		let alive = Ax.checkAlive(application)
		guard alive == .success else {
			throw helperError(from: alive, context: "forcing accessibility on pid \(pid)")
		}

		let started = Date()
		let before = AxTreeReader.shallowCount(pid: pid, maxDepth: probeDepth, limit: probeLimit)

		let result = Ax.setValue(application, attribute, kCFBooleanTrue)
		let applied = result == .success
		if !applied {
			// Not an error. A non-Chromium application simply does not have this attribute, and saying so
			// in a field is more useful than failing a call the caller made speculatively.
			Log.debug("pid \(pid) did not accept \(attribute): AXError \(result.rawValue)")
			return ForceAccessibilityResult(
				applied: false,
				treePopulated: before.nodes > 1,
				waitedMs: 0,
				rootNodeCount: before.roots
			)
		}

		// From here the tree may appear at any moment, so nothing minted before this point can be
		// compared against what comes after.
		refTable.invalidate(pid: pid)
		snapshots.invalidate(
			pid: pid,
			currentGeneration: refTable.generation,
			reason: "accessibility was forced on"
		)

		let budgetMs = min(max(params.timeoutMs ?? COMPUTER_USE_DEFAULT_FORCE_ACCESSIBILITY_TIMEOUT_MS, 0), maxTimeoutMs)
		let deadline = started.addingTimeInterval(Double(budgetMs) / 1000)
		var latest = before
		while true {
			try cancellation.check()
			latest = AxTreeReader.shallowCount(pid: pid, maxDepth: probeDepth, limit: probeLimit)
			if latest.nodes > 1 {
				break
			}
			guard Date() < deadline else { break }
			Thread.sleep(forTimeInterval: Double(pollIntervalMs) / 1000)
		}

		let waited = Int((Date().timeIntervalSince(started) * 1000).rounded())
		Log.debug(
			"forced accessibility on pid \(pid): applied, \(latest.nodes) nodes across \(latest.roots) windows after \(waited)ms"
		)
		return ForceAccessibilityResult(
			applied: true,
			treePopulated: latest.nodes > 1,
			waitedMs: waited,
			rootNodeCount: latest.roots
		)
	}
}
