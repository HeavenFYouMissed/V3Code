/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import ApplicationServices
import Foundation

/// Opaque element handles, stable across snapshots as protocol 2 requires.
///
/// This is the single most important correctness property in the helper. A ref is a promise that the
/// element it names is the element the model saw, and the promise is kept by *content*, not by age:
/// a ref is bound to `(element identity, role, label)` and survives as long as all three hold. It is
/// re-validated inside `resolve()` immediately before dispatch, so an element that was relabelled or
/// recycled between the read and the click is refused with `refStale` rather than acted on. That is
/// how an agent avoids clicking Delete when it meant Save: the element pointer may well still be
/// live, it just belongs to a re-laid-out row now, and the fingerprint says so.
///
/// **Why this replaced protocol 1's generation kill-switch.** Version 1 dropped the whole table on
/// every `axTree`, so no ref ever appeared in two snapshots. That is safe but it makes diffing
/// impossible — worse than impossible, because a diff computed against such snapshots matches
/// nothing and silently reports the entire tree as replaced on every turn while looking like it
/// worked. `generation` is now what its name says: a snapshot sequence number. Callers may hold refs
/// across generations, and `ComputerUseAxTreeDiffResult.baselineComparable` is what tells them when
/// they may not.
///
/// Refs are still evicted, but per application and by *staleness of observation* rather than by a
/// global counter: an element that has not been seen in the last few walks of its own application is
/// no longer something the model can reasonably be holding, and keeping it would grow the table
/// without bound over a long session.
final class RefTable {
	struct Entry {
		let element: AXUIElement
		let pid: pid_t
		/// Role at mint time, half of the identity fingerprint.
		let role: String
		/// Label at mint time, the other half. Nil and empty are the same thing here.
		let label: String?
		/// Raw AX action names (`AXPress`), not the normalized wire names, because dispatch compares
		/// against the constants.
		let actions: [String]
		/// Snapshot sequence in which this ref was first handed out.
		let mintedGeneration: Int
		/// The owning application's walk counter the last time this element was seen.
		let lastSeenWalk: Int
	}

	/// How many of an application's own walks an unseen element survives.
	///
	/// Counted per application rather than globally on purpose: walking a second application four
	/// times must not evict the first application's refs, which a global counter would do.
	private static let retainedWalks = 4

	private let lock = NSLock()
	private var entries: [String: Entry] = [:]
	/// Reverse index, so a re-walk hands back the ref it handed out last time instead of minting.
	private var refsByElement: [ElementKey: String] = [:]
	private var walksByPid: [pid_t: Int] = [:]
	private var generationValue = 0
	private var counter = 0

	var generation: Int {
		lock.lock()
		defer { lock.unlock() }
		return generationValue
	}

	/// Starts a new snapshot of one application. Does **not** invalidate refs — see the type comment.
	///
	/// Returns the new snapshot sequence number. Elements of this application that have not been seen
	/// for `retainedWalks` of its walks are evicted here, which is the only place the table shrinks.
	func beginGeneration(pid: pid_t) -> Int {
		lock.lock()
		defer { lock.unlock() }
		generationValue += 1
		let walk = (walksByPid[pid] ?? 0) + 1
		walksByPid[pid] = walk
		let cutoff = walk - RefTable.retainedWalks
		if cutoff > 0 {
			for (ref, entry) in entries where entry.pid == pid && entry.lastSeenWalk < cutoff {
				entries.removeValue(forKey: ref)
				let key = ElementKey(entry.element)
				if refsByElement[key] == ref {
					refsByElement.removeValue(forKey: key)
				}
			}
		}
		return generationValue
	}

	/// Hands out the ref for an element, reusing the previous one when its identity has not changed.
	///
	/// A fingerprint change mints a *new* token and leaves the old entry in place rather than
	/// rewriting it. Leaving it is deliberate: the caller may still be holding the old ref, and an
	/// entry whose fingerprint no longer matches produces an accurate `refStale` from `resolve`,
	/// whereas a deleted entry produces a vague "unknown ref".
	func mint(element: AXUIElement, pid: pid_t, role: String, label: String?, actions: [String]) -> String {
		lock.lock()
		defer { lock.unlock() }

		let walk = walksByPid[pid] ?? 0
		let key = ElementKey(element)
		let fingerprintLabel = RefTable.normalizeLabel(label)

		if let existing = refsByElement[key],
			let entry = entries[existing],
			entry.pid == pid,
			entry.role == role,
			entry.label == fingerprintLabel {
			entries[existing] = Entry(
				element: entry.element,
				pid: pid,
				role: role,
				label: fingerprintLabel,
				actions: actions,
				mintedGeneration: entry.mintedGeneration,
				lastSeenWalk: walk
			)
			return existing
		}

		counter += 1
		// The minting generation stays in the token purely for human legibility in logs and error
		// messages. Nothing reasons about it — staleness is decided by the fingerprint, not by age.
		let ref = "e\(generationValue).\(counter)"
		entries[ref] = Entry(
			element: element,
			pid: pid,
			role: role,
			label: fingerprintLabel,
			actions: actions,
			mintedGeneration: generationValue,
			lastSeenWalk: walk
		)
		refsByElement[key] = ref
		return ref
	}

	/// Resolves a ref, re-validating liveness and identity. Throws `refStale` when either fails.
	func resolve(_ ref: String) throws -> Entry {
		lock.lock()
		let entry = entries[ref]
		let current = generationValue
		lock.unlock()

		guard let entry else {
			throw HelperError(
				.refStale,
				"ref '\(ref)' is not known to this helper (current generation \(current)). Read the accessibility tree to obtain refs."
			)
		}

		let alive = Ax.checkAlive(entry.element)
		guard alive == .success else {
			throw helperError(from: alive, context: "resolving ref '\(ref)'")
		}

		// The fingerprint re-check is what makes a stable ref safe. Without it, "stable" would mean
		// "we stopped checking", and the model would act on a recycled row.
		guard let identity = Ax.identity(of: entry.element) else {
			throw HelperError(
				.refStale,
				"ref '\(ref)' no longer describes itself; re-read the accessibility tree."
			)
		}
		let label = RefTable.normalizeLabel(identity.label)
		guard identity.role == entry.role, label == entry.label else {
			throw HelperError(
				.refStale,
				"ref '\(ref)' was \(RefTable.describe(role: entry.role, label: entry.label)) and is now "
					+ "\(RefTable.describe(role: identity.role, label: label)); re-read the accessibility tree."
			)
		}
		return entry
	}

	/// Drops every ref belonging to an application.
	///
	/// Called when the correspondence is known to be broken rather than merely suspect — the process
	/// restarted, or accessibility was just forced on and the tree is about to appear from nothing.
	/// Handing back refs from before such an event would be handing back a promise we cannot keep.
	func invalidate(pid: pid_t) {
		lock.lock()
		defer { lock.unlock() }
		for (ref, entry) in entries where entry.pid == pid {
			entries.removeValue(forKey: ref)
			let key = ElementKey(entry.element)
			if refsByElement[key] == ref {
				refsByElement.removeValue(forKey: key)
			}
		}
		Log.debug("invalidated every ref for pid \(pid)")
	}

	/// An empty label and an absent label are the same fact, so they must compare equal.
	private static func normalizeLabel(_ label: String?) -> String? {
		guard let label, !label.isEmpty else { return nil }
		return label
	}

	private static func describe(role: String, label: String?) -> String {
		guard let label else { return "a \(role) with no label" }
		return "a \(role) labelled \"\(label)\""
	}

	/// Dictionary key over `AXUIElement`, which is a CFType and therefore has real equality.
	///
	/// `CFEqual` on two `AXUIElementRef`s compares the elements they denote, not the pointers, which is
	/// exactly the identity a stable ref needs.
	private struct ElementKey: Hashable {
		let element: AXUIElement

		init(_ element: AXUIElement) {
			self.element = element
		}

		static func == (lhs: ElementKey, rhs: ElementKey) -> Bool {
			CFEqual(lhs.element, rhs.element)
		}

		func hash(into hasher: inout Hasher) {
			hasher.combine(CFHash(element))
		}
	}
}
