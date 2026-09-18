/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import ApplicationServices
import Darwin
import Foundation

/// What the helper remembers about the snapshots it has handed out, per application.
///
/// **It does not store the trees.** The nodes themselves live in the caller's cache, because the
/// diff is computed in `common/computerUseAxDiff.ts` and a second copy here would be a megabyte of
/// dead data with no consumer. What the helper keeps is only what the helper alone can know:
///
/// - which generations it actually issued, so a fabricated or long-superseded `sinceGeneration`
///   cannot be vouched for;
/// - whether anything has broken the ref correspondence since — a restart, a cancelled walk, or
///   accessibility being forced on;
/// - the activity counter and a cheap structural fingerprint at snapshot time, which together are
///   what let `axTreeDiff` answer `unchanged` without walking anything.
///
/// Every predicate here fails towards "not comparable" and "not unchanged", because both wrong
/// answers are silent: a caller told the baseline is comparable when it is not will diff two
/// unrelated trees and report nonsense with total confidence, and a caller told nothing changed when
/// something did will act on a screen that has moved on.
final class AxSnapshots {
	/// One issued snapshot, described by everything needed to judge a later request against it.
	struct Record {
		let generation: Int
		let takenAt: Date
		/// `AxWatcher` activity counter at the moment the walk finished.
		let activity: UInt64
		/// Whether a notification path existed for this application when the snapshot was taken.
		let notificationsAvailable: Bool
		/// Cheap structural digest — see `AxSnapshots.fingerprint(pid:)`.
		let fingerprint: UInt64
		/// Process start time, so pid reuse after a restart is detectable.
		let processStartedAt: Double?
	}

	/// How many issued generations per application are remembered.
	///
	/// Matched to `RefTable`'s own retention: vouching for a generation whose refs have already been
	/// evicted would be vouching for handles that no longer resolve.
	private static let retainedRecords = 4

	private let lock = NSLock()
	private var records: [pid_t: [Record]] = [:]
	/// Highest generation known to be incomparable; anything at or below it is refused.
	private var incomparableThrough: [pid_t: Int] = [:]

	/// Remembers a snapshot the helper just issued.
	func record(
		pid: pid_t,
		generation: Int,
		activity: UInt64,
		notificationsAvailable: Bool,
		fingerprint: UInt64
	) {
		let entry = Record(
			generation: generation,
			takenAt: Date(),
			activity: activity,
			notificationsAvailable: notificationsAvailable,
			fingerprint: fingerprint,
			processStartedAt: AxSnapshots.processStartedAt(pid: pid)
		)
		lock.lock()
		defer { lock.unlock() }
		var list = records[pid] ?? []
		list.removeAll { $0.generation == generation }
		list.append(entry)
		if list.count > AxSnapshots.retainedRecords {
			list.removeFirst(list.count - AxSnapshots.retainedRecords)
		}
		records[pid] = list
	}

	/// Moves a remembered generation's watermark forward after an `unchanged` answer.
	///
	/// Necessary because *reading provokes notifications*: the structural probe that proves nothing
	/// changed is itself a traversal, and some applications emit `AXValueChanged` for elements merely
	/// queried. Without this the next check would see a counter that had moved — because of the previous
	/// check — and pay for a full walk. The generation is untouched, so the caller's tree and refs stay
	/// valid; only "the last moment at which this was verified still true" advances.
	func refresh(pid: pid_t, generation: Int, activity: UInt64, fingerprint: UInt64) {
		lock.lock()
		defer { lock.unlock() }
		guard var list = records[pid], let index = list.firstIndex(where: { $0.generation == generation }) else {
			return
		}
		let previous = list[index]
		list[index] = Record(
			generation: previous.generation,
			takenAt: Date(),
			activity: activity,
			notificationsAvailable: previous.notificationsAvailable,
			fingerprint: fingerprint,
			processStartedAt: previous.processStartedAt
		)
		records[pid] = list
	}

	/// The remembered record for a generation, or nil when the helper cannot vouch for it.
	///
	/// Nil covers all of: never issued, aged out, issued before something broke the correspondence, and
	/// issued to a process that has since restarted under the same pid.
	func vouch(pid: pid_t, generation: Int) -> Record? {
		lock.lock()
		let list = records[pid] ?? []
		let floor = incomparableThrough[pid] ?? 0
		lock.unlock()

		guard generation > floor, let record = list.first(where: { $0.generation == generation }) else {
			return nil
		}
		// A pid that has been recycled is a different application wearing the same number. Comparing
		// across that boundary is the one case where the refs would look plausible and mean nothing.
		if let then = record.processStartedAt, let now = AxSnapshots.processStartedAt(pid: pid), then != now {
			Log.debug("pid \(pid) restarted since generation \(generation); the baseline is not comparable")
			return nil
		}
		return record
	}

	/// Declares every generation issued so far for an application uncomparable.
	///
	/// The recon conclusion, encoded: a `cancel` that interrupts a walk, or forcing accessibility on,
	/// must not invalidate the refs the caller holds — it must say `baselineComparable: false` and let
	/// the caller send a full tree.
	func invalidate(pid: pid_t, currentGeneration: Int, reason: String) {
		lock.lock()
		incomparableThrough[pid] = max(incomparableThrough[pid] ?? 0, currentGeneration)
		lock.unlock()
		Log.debug("baselines for pid \(pid) marked incomparable through generation \(currentGeneration): \(reason)")
	}

	/// Forgets an application entirely, so a dead pid does not accumulate.
	func forget(pid: pid_t) {
		lock.lock()
		defer { lock.unlock() }
		records.removeValue(forKey: pid)
		incomparableThrough.removeValue(forKey: pid)
	}

	// ---------------------------------------------------------------------------------------------
	// Cheap change detection
	// ---------------------------------------------------------------------------------------------

	/// Depth and node ceiling for the structural half of the fingerprint.
	///
	/// Deep enough to reach table rows — a Finder file list sits five or six levels down — and capped so
	/// a pathological tree cannot make the cheap path expensive. A tree larger than the cap digests its
	/// first `structuralLimit` nodes, which still moves when the shape near the top changes.
	private static let structuralDepth = 12
	private static let structuralLimit = 2000

	/// A digest of an application's shape, costing one attribute-free traversal.
	///
	/// The second half of the `unchanged` answer, and the reason that answer can be trusted. A
	/// notification counter that has not moved is *not* sufficient evidence of stillness: measured
	/// against Finder, ten files created in a displayed folder changed the tree from 639 nodes to 739
	/// and the `AXRowCountChanged` notification for it did not arrive for more than half a second.
	/// A helper that answered `unchanged` in that window would be telling the model the screen is as it
	/// remembers while ten rows it cannot see have appeared.
	///
	/// So the digest has two parts. The *coarse* part covers what one round-trip can see — window count,
	/// each window's title and frame, and the focused element's role, label and value. The *structural*
	/// part is a child-count traversal with no attribute reads at all, which is what actually notices
	/// rows appearing, a sheet arriving, or a subtree collapsing. It costs one `AXChildren` round-trip
	/// per node — measured at roughly a tenth of a full walk of the same tree, because a full walk also
	/// batches seven attributes and an action list per node — so the cheap path stays cheap and stops
	/// being wrong.
	///
	/// What it still cannot see: a change that alters neither the shape of the tree nor anything coarse,
	/// such as a label or value deep inside an unfocused subtree, when no notification arrives for it
	/// either. That residue is why `unchanged` is *two* conditions and not one, and why a caller that
	/// needs certainty asks for the tree.
	static func fingerprint(pid: pid_t) -> UInt64 {
		let application = Ax.application(pid: pid)
		var hash = Hash.seed

		let structure = AxTreeReader.shallowCount(
			pid: pid,
			maxDepth: structuralDepth,
			limit: structuralLimit
		)
		hash = Hash.combine(hash, UInt64(structure.roots))
		hash = Hash.combine(hash, UInt64(structure.nodes))

		let windows = (Ax.copyAttribute(application, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
		hash = Hash.combine(hash, UInt64(windows.count))
		for window in windows.prefix(16) {
			let attributes = Ax.copyMultiple(window, [
				kAXTitleAttribute as String,
				kAXPositionAttribute as String,
				kAXSizeAttribute as String,
			])
			hash = Hash.combine(hash, Ax.string(attributes[kAXTitleAttribute as String]) ?? "")
			if let rect = Ax.rect(
				position: attributes[kAXPositionAttribute as String],
				size: attributes[kAXSizeAttribute as String]
			) {
				hash = Hash.combine(hash, rect)
			}
		}

		if let focused = Ax.copyAttribute(application, kAXFocusedUIElementAttribute as String),
			CFGetTypeID(focused) == AXUIElementGetTypeID() {
			let element = focused as! AXUIElement
			if let identity = Ax.identity(of: element) {
				hash = Hash.combine(hash, identity.role)
				hash = Hash.combine(hash, identity.label ?? "")
			}
			hash = Hash.combine(hash, Ax.string(Ax.copyAttribute(element, kAXValueAttribute as String)) ?? "")
		}
		return hash
	}

	/// Wall-clock start time of a process, used only to notice pid reuse.
	///
	/// `sysctl(KERN_PROC_PID)` is public API and needs no entitlement. A failure returns nil and is
	/// treated as "unknown", never as "changed": refusing every baseline because a sysctl failed would
	/// turn a diagnostic into an outage.
	private static func processStartedAt(pid: pid_t) -> Double? {
		var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
		var info = kinfo_proc()
		var size = MemoryLayout<kinfo_proc>.stride
		let result = sysctl(&mib, u_int(mib.count), &info, &size, nil, 0)
		guard result == 0, size > 0 else { return nil }
		let started = info.kp_proc.p_starttime
		return Double(started.tv_sec) + Double(started.tv_usec) / 1_000_000
	}
}

/// FNV-1a, used wherever the helper needs a cheap value-identity digest.
///
/// Not a cryptographic hash and not used as one: every consumer compares a digest against one it
/// computed itself moments earlier, so the only property required is that different inputs rarely
/// collide. Hand-rolled because the alternative is a dependency, and the package has none.
enum Hash {
	static let seed: UInt64 = 0xcbf2_9ce4_8422_2325
	private static let prime: UInt64 = 0x0000_0100_0000_01b3

	static func combine(_ hash: UInt64, _ byte: UInt8) -> UInt64 {
		(hash ^ UInt64(byte)) &* prime
	}

	static func combine(_ hash: UInt64, _ value: UInt64) -> UInt64 {
		var result = hash
		for shift in stride(from: 0, to: 64, by: 8) {
			result = combine(result, UInt8((value >> UInt64(shift)) & 0xff))
		}
		return result
	}

	static func combine(_ hash: UInt64, _ text: String) -> UInt64 {
		var result = hash
		for byte in text.utf8 {
			result = combine(result, byte)
		}
		// A separator, so ("ab", "c") and ("a", "bc") do not digest alike.
		return combine(result, UInt8(0))
	}

	static func combine<Bytes: Sequence>(_ hash: UInt64, bytes: Bytes) -> UInt64 where Bytes.Element == UInt8 {
		var result = hash
		for byte in bytes {
			result = combine(result, byte)
		}
		return result
	}

	/// Rounded to whole pixels: sub-pixel jitter in a reported frame is not a change worth reacting to.
	static func combine(_ hash: UInt64, _ rect: CGRect) -> UInt64 {
		var result = hash
		for value in [rect.origin.x, rect.origin.y, rect.width, rect.height] {
			result = combine(result, UInt64(bitPattern: Int64(value.rounded())))
		}
		return result
	}
}
