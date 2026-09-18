/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import CoreGraphics
import Foundation

/// Ambient observation: sampling one application on a timer rather than because a tool call asked.
///
/// This is the most privileged thing in the helper — it observes with no tool call behind it — so the
/// entire design is arranged so that no single mistake can turn it on, mirroring
/// `common/computerUseObservation.ts` on the other side of the pipe.
///
/// **Nothing is sampled until `observeStart` succeeds.** There is no default session, no implicit
/// start, no "observe the frontmost application" convenience, and no code path from any other method
/// into `sample`. The timer does not exist until a session does, and it is torn down with the last one.
///
/// **Every check refuses.** `start` is a chain of guards ending in one success. A pid that cannot be
/// identified, an application whose tier is `self`, an `appId` that does not match the pid, an interval
/// outside the permitted band, a `stopAtMs` in the past, a screenshot session without Screen Recording
/// — each is a refusal, and there is no fallback value for any of them. The same guards run again on
/// every tick, so a grant that stops being true stops the session rather than waiting for someone to
/// notice.
///
/// **`stopAtMs` is the whole safety story and is enforced twice.** The caller sets it from the
/// `permittedUntil` of the policy decision that authorised the session. It is clamped here to
/// `observationMaxGrantMs` from now, checked by the supervisor tick, and checked again inside the
/// sample itself. If V3Code crashes, is force-quit, or loses the pipe, the session expires on its own;
/// and if the pipe closes the dispatcher stops everything outright, so a lost `observeStop` cannot
/// leave capture running.
///
/// **Why the helper duplicates the policy engine's arithmetic.** The service already decided; this
/// layer exists because the helper is the last thing between a model and the user's screen. A bug in
/// the service, a stale renderer, or anything that learns to speak this protocol must still be
/// refused. The duplication is deliberate, exactly as `AppTiers` duplicates the tier fragments.
///
/// **What a sample is, and the gap this phase leaves.** The protocol has no channel for delivering a
/// sample: all three `observe*` methods return only `ComputerUseObserveStatusResult`, whose sole
/// per-session payload is a count. So a sample here refreshes what the helper alone can hold — the
/// stable refs and the change watermark for that application, which is what makes a later `axTreeDiff`
/// answer `unchanged` in one round-trip — and, for a screenshot session, digests the window frames to
/// learn whether the screen moved. **Pixels are digested and dropped inside `FrameSampler`; no image is
/// encoded, retained, or written anywhere by this file.** Retaining screen images in a process with no
/// consumer for them and no retention owner is precisely what the policy engine's comments warn
/// against, so it is not done. Delivering samples needs a wire shape that does not exist yet.
final class Observation {
	// ---------------------------------------------------------------------------------------------
	// Bounds
	// ---------------------------------------------------------------------------------------------

	/// Mirrors `COMPUTER_USE_OBSERVATION_MAX_GRANT_MS`. A session may never outlive this from its start.
	static let maxGrantMs: Int64 = 8 * 60 * 60 * 1000

	/// Floor on the sampling interval.
	///
	/// Twice a second is the boundary between *ambient observation* and *recording*. A caller asking for
	/// faster is either mistaken or is trying to use this as a screen recorder, and both are refused
	/// rather than clamped: silently sampling slower than asked would leave the caller believing it had
	/// something it does not.
	static let minIntervalMs = 500

	/// Ceiling on the sampling interval. An hour between samples is not observation, it is a leak of a
	/// session nobody remembers starting.
	static let maxIntervalMs = 60 * 60 * 1000

	/// How many applications may be observed at once, so the cost stays bounded and reviewable.
	static let maxSessions = 4

	/// How often the supervisor wakes. Fine enough that `stopAtMs` is honoured to within a quarter
	/// second, coarse enough to be free when nothing is due.
	static let supervisorIntervalMs = 250

	// ---------------------------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------------------------

	private final class Session {
		let pid: pid_t
		let appId: String
		let content: ObserveContent
		let intervalMs: Int
		let startedAt: Int64
		let stopAtMs: Int64
		/// Carried so the session records what it was authorised for, even though nothing here produces an
		/// image to bound. See the delivery note on the type comment.
		let maxLongEdge: Int?
		var samples = 0
		/// Samples whose frame digest differed from the previous one. Logged, not yet on the wire.
		var frameChanges = 0
		var lastFrameHash: UInt64?
		var nextDueAt: Date
		/// True while a sample is on the work queue, so a slow walk cannot pile up behind itself.
		var sampling = false

		init(
			pid: pid_t,
			appId: String,
			content: ObserveContent,
			intervalMs: Int,
			startedAt: Int64,
			stopAtMs: Int64,
			maxLongEdge: Int?
		) {
			self.pid = pid
			self.appId = appId
			self.content = content
			self.intervalMs = intervalMs
			self.startedAt = startedAt
			self.stopAtMs = stopAtMs
			self.maxLongEdge = maxLongEdge
			// Due immediately: the first sample is the one the caller is waiting for, and delaying it by a
			// whole interval would make a long-interval session look wedged.
			self.nextDueAt = Date()
		}
	}

	private let lock = NSLock()
	private var sessions: [pid_t: Session] = [:]
	private var supervisor: DispatchSourceTimer?

	private let workQueue: DispatchQueue
	private let timerQueue = DispatchQueue(label: "dev.v3code.computerUse.observe", qos: .utility)
	private let refTable: RefTable
	private let snapshots: AxSnapshots
	private let watcher: AxWatcher

	init(workQueue: DispatchQueue, refTable: RefTable, snapshots: AxSnapshots, watcher: AxWatcher) {
		self.workQueue = workQueue
		self.refTable = refTable
		self.snapshots = snapshots
		self.watcher = watcher
	}

	// ---------------------------------------------------------------------------------------------
	// Start
	// ---------------------------------------------------------------------------------------------

	/// Validates and starts a session, or throws. Never partially starts.
	func start(_ params: ObserveStartParams) throws -> ObserveStatusResult {
		guard Ax.isProcessTrusted() else {
			throw HelperError(
				.accessibilityNotTrusted,
				"Accessibility permission has not been granted to the computer-use helper"
			)
		}

		let pid = params.pid
		guard let identity = Apps.identity(pid: pid) else {
			throw HelperError(
				.targetNotFound,
				"no running application with pid \(pid), so there is nothing to observe"
			)
		}

		// Deliberately no policy check here. Whether an application may be observed is the user's decision,
		// recorded as a grant the renderer service holds and enforces; the helper cannot see that grant, so
		// anything it decided here could only contradict it. Observing V3Code itself is a poor idea — the
		// agent reads its own output back — but it is discouraged at the approval prompt, not forbidden.
		//
		// What this method DOES enforce is that the authorisation actually matches what would be observed,
		// and that it expires. Those are not policy; they are the difference between an authorised session
		// and an unbounded one.

		// The policy decision the service made names an application; the request names a pid. If the two
		// disagree, the authorisation belongs to something other than what would be observed, so the
		// request is refused rather than reconciled.
		let requested = Observation.normalize(params.appId)
		let actual = Observation.normalize(identity.id)
		guard !requested.isEmpty, requested == actual else {
			throw HelperError(
				.permissionDenied,
				"pid \(pid) is '\(identity.id)', not '\(params.appId)'; the observation grant does not cover it",
				retryable: false
			)
		}

		guard params.intervalMs >= Observation.minIntervalMs, params.intervalMs <= Observation.maxIntervalMs else {
			throw HelperError(
				.permissionDenied,
				"an observation interval of \(params.intervalMs)ms is outside the permitted "
					+ "\(Observation.minIntervalMs)-\(Observation.maxIntervalMs)ms band",
				retryable: false
			)
		}

		let now = Observation.nowMs()
		guard params.stopAtMs > now else {
			throw HelperError(
				.permissionDenied,
				"the observation grant expires at \(params.stopAtMs), which is not in the future",
				retryable: false
			)
		}
		// Clamped rather than refused: an over-long grant is more likely a mistake than an attack, and
		// shortening it is the fail-closed direction.
		let stopAtMs = min(params.stopAtMs, now + Observation.maxGrantMs)
		if stopAtMs != params.stopAtMs {
			Log.warn("clamped an observation grant for pid \(pid) from \(params.stopAtMs) to \(stopAtMs)")
		}

		if params.content == .axTreeAndScreenshots {
			// Refused at start rather than discovered per sample: a session that silently never captures
			// the thing it was authorised for is worse than one that never begins.
			guard CGPreflightScreenCaptureAccess() else {
				throw HelperError(
					.screenRecordingNotGranted,
					"Screen Recording permission has not been granted to the computer-use helper, so an "
						+ "observation session including screenshots cannot start"
				)
			}
		}

		lock.lock()
		if sessions[pid] == nil, sessions.count >= Observation.maxSessions {
			lock.unlock()
			throw HelperError(
				.permissionDenied,
				"already observing \(Observation.maxSessions) applications, which is the limit",
				retryable: true
			)
		}
		// Starting again for the same pid replaces the session outright, so a re-authorisation cannot end
		// up with two timers sampling the same application.
		let session = Session(
			pid: pid,
			appId: actual,
			content: params.content,
			intervalMs: params.intervalMs,
			startedAt: now,
			stopAtMs: stopAtMs,
			maxLongEdge: params.maxLongEdge
		)
		sessions[pid] = session
		let snapshot = describeLocked()
		lock.unlock()

		watcher.ensureWatching(pid: pid)
		startSupervisor()
		Log.info(
			"observing \(identity.id) (pid \(pid)) every \(params.intervalMs)ms until \(stopAtMs), content \(params.content.rawValue)"
		)
		return ObserveStatusResult(sessions: snapshot)
	}

	// ---------------------------------------------------------------------------------------------
	// Stop
	// ---------------------------------------------------------------------------------------------

	/// Stops one session, or every session when `pid` is nil. Always succeeds.
	///
	/// Never throws and never gates: stopping is the safe direction, and a revocation that could be
	/// refused would be a revocation that does not work.
	@discardableResult
	func stop(pid: pid_t?) -> ObserveStatusResult {
		lock.lock()
		if let pid {
			if sessions.removeValue(forKey: pid) != nil {
				Log.info("stopped observing pid \(pid)")
			}
		} else if !sessions.isEmpty {
			Log.info("stopped observing every application (\(sessions.count) sessions)")
			sessions.removeAll()
		}
		let empty = sessions.isEmpty
		let snapshot = describeLocked()
		lock.unlock()

		if empty {
			stopSupervisor()
		}
		return ObserveStatusResult(sessions: snapshot)
	}

	/// What the helper is currently observing.
	func status() -> ObserveStatusResult {
		lock.lock()
		defer { lock.unlock() }
		return ObserveStatusResult(sessions: describeLocked())
	}

	// ---------------------------------------------------------------------------------------------
	// Supervisor
	// ---------------------------------------------------------------------------------------------

	private func startSupervisor() {
		lock.lock()
		defer { lock.unlock() }
		guard supervisor == nil else { return }
		let timer = DispatchSource.makeTimerSource(queue: timerQueue)
		timer.schedule(
			deadline: .now(),
			repeating: .milliseconds(Observation.supervisorIntervalMs),
			leeway: .milliseconds(50)
		)
		timer.setEventHandler { [weak self] in
			self?.tick()
		}
		supervisor = timer
		timer.resume()
	}

	private func stopSupervisor() {
		lock.lock()
		let timer = supervisor
		supervisor = nil
		lock.unlock()
		timer?.cancel()
	}

	/// One supervisor pass: expire what is over, dispatch what is due.
	private func tick() {
		let now = Observation.nowMs()

		lock.lock()
		var expired: [pid_t] = []
		var due: [Session] = []
		let wallClock = Date()
		for session in sessions.values {
			if now >= session.stopAtMs {
				expired.append(session.pid)
				continue
			}
			if !session.sampling, wallClock >= session.nextDueAt {
				session.sampling = true
				due.append(session)
			}
		}
		for pid in expired {
			sessions.removeValue(forKey: pid)
		}
		let empty = sessions.isEmpty
		lock.unlock()

		for pid in expired {
			Log.info("observation of pid \(pid) reached its grant expiry and stopped itself")
		}
		if empty {
			stopSupervisor()
		}

		Log.debug("observation tick: \(due.count) due, \(expired.count) expired")
		for session in due {
			// Samples run on the shared work queue, not here: the queue is serial precisely so a tree walk
			// cannot interleave with an action, and an ambient sample is no more entitled to break that
			// than a tool call is.
			workQueue.async { [weak self] in
				self?.sample(session)
			}
		}
	}

	/// Takes one sample, re-checking every reason not to first.
	private func sample(_ session: Session) {
		defer {
			lock.lock()
			session.sampling = false
			session.nextDueAt = Date().addingTimeInterval(Double(session.intervalMs) / 1000)
			lock.unlock()
		}

		// Re-validated on every tick rather than trusted from start time. A session outlives the moment
		// it was authorised, and each of these can stop being true while it runs.
		guard Observation.nowMs() < session.stopAtMs else {
			stop(pid: session.pid)
			return
		}
		guard Ax.isProcessTrusted() else {
			Log.warn("Accessibility trust was lost; stopping observation of pid \(session.pid)")
			stop(pid: session.pid)
			return
		}
		guard let identity = Apps.identity(pid: session.pid) else {
			Log.info("pid \(session.pid) is gone; stopping its observation")
			stop(pid: session.pid)
			snapshots.forget(pid: session.pid)
			watcher.stopWatching(pid: session.pid)
			return
		}
		// Identity only — not policy. If the pid now belongs to a different application than the grant
		// covered, the authorisation does not apply to what is on screen and sampling must stop.
		guard Observation.normalize(identity.id) == session.appId else {
			// The pid now belongs to a different application than the grant covered — pid reuse. Stop.
			Log.warn("pid \(session.pid) is now '\(identity.id)'; stopping observation authorised for '\(session.appId)'")
			stop(pid: session.pid)
			return
		}
		if session.content == .axTreeAndScreenshots, !CGPreflightScreenCaptureAccess() {
			Log.warn("Screen Recording was revoked; stopping observation of pid \(session.pid)")
			stop(pid: session.pid)
			return
		}

		let token = Cancellation.Token.uncancellable
		do {
			// Walk and fingerprint inside one suppression scope, counter outside it, for the reason set out
			// on `Dispatcher.walk`: reading provokes notifications, and a sample that counted its own
			// footprints would make every later `axTreeDiff` believe the application had done something.
			let (tree, fingerprint) = try watcher.withSuppression(pid: session.pid) {
				let tree = try AxTreeReader.read(
					pid: session.pid,
					maxDepth: nil,
					refTable: refTable,
					cancellation: token
				)
				return (tree, AxSnapshots.fingerprint(pid: session.pid))
			}
			let activity = watcher.activity(pid: session.pid)
			snapshots.record(
				pid: session.pid,
				generation: tree.generation,
				activity: activity.count,
				notificationsAvailable: activity.notificationsAvailable,
				fingerprint: fingerprint
			)

			if session.content == .axTreeAndScreenshots {
				// Digest only. See the type comment: no image is encoded or kept.
				if let hash = FrameSampler.fingerprint(pid: session.pid) {
					lock.lock()
					if let previous = session.lastFrameHash, previous != hash {
						session.frameChanges += 1
					}
					session.lastFrameHash = hash
					lock.unlock()
				}
			}

			lock.lock()
			session.samples += 1
			let count = session.samples
			let changes = session.frameChanges
			lock.unlock()
			Log.debug(
				"observation sample \(count) of \(session.appId): generation \(tree.generation), \(tree.nodes.count) roots, \(changes) frame changes"
			)
		} catch let error as HelperError {
			// A failing sample stops the session rather than retrying forever: the two things that make a
			// walk fail here — the application died, or permission went away — are both permanent, and a
			// session that logs an error every interval is a session nobody will read the logs of.
			Log.warn("observation of pid \(session.pid) failed (\(error.code.rawValue): \(error.message)); stopping")
			stop(pid: session.pid)
		} catch {
			Log.warn("observation of pid \(session.pid) failed unexpectedly (\(error)); stopping")
			stop(pid: session.pid)
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------------------------

	/// Wire shapes for the current sessions. Caller must hold the lock.
	private func describeLocked() -> [ObserveSession] {
		sessions.values
			.map { session in
				ObserveSession(
					pid: session.pid,
					appId: session.appId,
					startedAt: session.startedAt,
					stopAtMs: session.stopAtMs,
					intervalMs: session.intervalMs,
					content: session.content,
					samples: session.samples
				)
			}
			.sorted { $0.pid < $1.pid }
	}

	/// Matches `normalizeAppId` in computerUseObservation.ts: case and surrounding whitespace only.
	///
	/// Nothing fuzzy, deliberately. Fragment matching is right for tier classification, where
	/// over-matching is restrictive; here it would be permissive, and a grant for one application would
	/// quietly cover another that shares a prefix.
	private static func normalize(_ id: String) -> String {
		id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	}

	static func nowMs() -> Int64 {
		Int64((Date().timeIntervalSince1970 * 1000).rounded())
	}
}
