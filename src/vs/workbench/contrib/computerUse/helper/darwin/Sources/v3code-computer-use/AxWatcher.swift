/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import ApplicationServices
import Foundation

/// A long-lived accessibility notification counter, per application.
///
/// Two features need to know "has this application done anything since a moment I remember", and
/// neither can answer it by polling: `settle` needs to wait for the notifications to *stop*, and
/// `axTreeDiff` needs to answer `unchanged` without walking a three-thousand-node tree. Both reduce
/// to one primitive — a monotonic activity counter plus the time of the last bump — which is what
/// this provides.
///
/// **Threading.** `AXObserver` delivers on a `CFRunLoop`, and the helper's work queue is a serial
/// dispatch queue with no run loop of its own; running one there would block the queue for the whole
/// observation window, which is exactly what must not happen for a watcher that outlives a request.
/// So this owns a dedicated thread whose only job is to run a run loop and take callbacks. Waiters on
/// the work queue block on an `NSCondition` that the callbacks broadcast, which means a settle wait
/// costs one thread parked in a wait, not a spin.
///
/// The counter is deliberately coarse: any qualifying notification from the application counts as one
/// unit of "something happened". Distinguishing kinds would invite a filter, and a filter is where a
/// missed notification turns into a false "nothing changed" — the one wrong answer this must never
/// give.
final class AxWatcher {
	/// What the watcher knows about an application at a moment in time.
	struct Activity {
		/// Monotonic count of qualifying notifications since the application was first watched.
		let count: UInt64
		/// When the counter last moved, or nil if it never has.
		let lastAt: Date?
		/// False when the application accepted no notification registrations at all.
		///
		/// Load-bearing rather than diagnostic: a caller may only conclude "nothing changed" from a
		/// still counter if there was a working notification path that would have moved it.
		let notificationsAvailable: Bool
	}

	/// Notifications registered on each watched application.
	///
	/// Chosen to cover the four things that make a snapshot stale — structure, geometry, content and
	/// focus — while leaving out the ones that fire continuously on their own. `AXValueChanged` is
	/// included even though it is the noisiest of them, because a progress bar's noise costs a settle
	/// wait whereas a missed text-field change costs a wrong answer.
	private static let notifications: [String] = [
		kAXCreatedNotification as String,
		kAXUIElementDestroyedNotification as String,
		kAXValueChangedNotification as String,
		kAXTitleChangedNotification as String,
		kAXLayoutChangedNotification as String,
		kAXWindowCreatedNotification as String,
		kAXWindowMovedNotification as String,
		kAXWindowResizedNotification as String,
		kAXWindowMiniaturizedNotification as String,
		kAXWindowDeminiaturizedNotification as String,
		kAXMainWindowChangedNotification as String,
		kAXFocusedWindowChangedNotification as String,
		kAXFocusedUIElementChangedNotification as String,
		kAXSelectedChildrenChangedNotification as String,
		kAXSelectedRowsChangedNotification as String,
		kAXRowCountChangedNotification as String,
		kAXSelectedTextChangedNotification as String,
		kAXSheetCreatedNotification as String,
		kAXDrawerCreatedNotification as String,
		kAXMenuOpenedNotification as String,
		kAXMenuClosedNotification as String,
	]

	/// Windows registered per application, so a per-element notification that the application element
	/// does not relay is still seen. Bounded because a document app can have dozens.
	private static let maxWatchedWindows = 8

	private final class State {
		let observer: AXObserver
		var registrations: Int
		var count: UInt64 = 0
		var lastAt: Date?
		/// How many traversals of this application the helper currently has in flight.
		var suppressionDepth = 0
		/// Trailing window after the last traversal during which notifications are still attributed to it.
		var suppressedUntil: Date?
		/// Notifications attributed to the helper's own reads. Diagnostic only.
		var provoked: UInt64 = 0

		init(observer: AXObserver, registrations: Int) {
			self.observer = observer
			self.registrations = registrations
		}

		func isSuppressed(at moment: Date) -> Bool {
			if suppressionDepth > 0 {
				return true
			}
			guard let suppressedUntil else { return false }
			return moment < suppressedUntil
		}
	}

	private let condition = NSCondition()
	private var states: [pid_t: State] = [:]
	private var runLoop: CFRunLoop?

	init() {
		let thread = Thread { [weak self] in
			// `CFRunLoopGetCurrent` is annotated as optional in the Swift overlay but never returns nil on
			// a live thread; there is no run loop to run if it somehow did.
			guard let loop = CFRunLoopGetCurrent() else {
				Log.error("the accessibility watcher thread has no run loop")
				return
			}
			self?.publish(runLoop: loop)
			// A run loop with no sources returns immediately, so a port is added purely to keep it
			// alive until the first observer source arrives.
			let keepAlive = NSMachPort()
			RunLoop.current.add(keepAlive, forMode: .default)
			Log.debug("accessibility watcher run loop started")
			CFRunLoopRun()
		}
		thread.name = "dev.v3code.computerUse.axWatcher"
		thread.stackSize = 1 << 19
		thread.start()
	}

	private func publish(runLoop loop: CFRunLoop) {
		condition.lock()
		runLoop = loop
		condition.broadcast()
		condition.unlock()
	}

	/// Blocks briefly for the watcher thread's run loop to exist. Nil if it never appeared.
	private func awaitRunLoop() -> CFRunLoop? {
		condition.lock()
		defer { condition.unlock() }
		let deadline = Date().addingTimeInterval(1)
		while runLoop == nil, Date() < deadline {
			condition.wait(until: deadline)
		}
		return runLoop
	}

	// ---------------------------------------------------------------------------------------------
	// Registration
	// ---------------------------------------------------------------------------------------------

	/// Starts watching an application, or refreshes the window registrations of one already watched.
	///
	/// Returns whether any notification registration succeeded. False is not an error: a canvas-drawn
	/// or accessibility-less application legitimately offers nothing to observe, and the callers turn
	/// that into `notificationsUnavailable` rather than a failure.
	@discardableResult
	func ensureWatching(pid: pid_t) -> Bool {
		guard Ax.isProcessTrusted() else { return false }

		condition.lock()
		let existing = states[pid]
		condition.unlock()

		if let existing {
			// Windows come and go; re-registering the current set is how a sheet that opened after the
			// first registration still reports its own notifications. An already-registered pair returns
			// `notificationAlreadyRegistered`, which is not counted again.
			let added = register(observer: existing.observer, pid: pid)
			if added > 0 {
				condition.lock()
				existing.registrations += added
				condition.unlock()
			}
			return existing.registrations > 0
		}

		guard let loop = awaitRunLoop() else {
			Log.warn("the accessibility watcher run loop never started; settle and unchanged detection are unavailable")
			return false
		}

		var observer: AXObserver?
		let created = AXObserverCreate(pid, axWatcherCallback, &observer)
		guard created == .success, let observer else {
			Log.debug("could not create an AXObserver for pid \(pid): AXError \(created.rawValue)")
			return false
		}

		let registrations = register(observer: observer, pid: pid)
		guard registrations > 0 else {
			Log.debug("pid \(pid) accepted no accessibility notifications")
			return false
		}

		CFRunLoopAddSource(loop, AXObserverGetRunLoopSource(observer), .defaultMode)
		CFRunLoopWakeUp(loop)

		condition.lock()
		states[pid] = State(observer: observer, registrations: registrations)
		condition.unlock()
		Log.debug("watching pid \(pid) with \(registrations) accessibility notification registrations")
		return true
	}

	/// Adds the notification set to the application element and to its current windows.
	///
	/// Both, because neither alone is enough. Registering on the application element is what catches the
	/// app-wide notifications — `AXWindowCreated`, `AXFocusedUIElementChanged` — and, in practice, most
	/// descendant notifications too: a measured Finder run relayed `AXRowCountChanged` from a file list
	/// six levels down to an application-element observer. Registering on the windows as well covers the
	/// applications that do not relay.
	private func register(observer: AXObserver, pid: pid_t) -> Int {
		let application = Ax.application(pid: pid)
		// The refcon is an unretained self. The watcher is owned by the dispatcher and lives as long as
		// the process, so there is no window in which a callback could find it deallocated; retaining
		// here instead would make the cycle permanent for no gain.
		let refcon = Unmanaged.passUnretained(self).toOpaque()

		var added = 0
		var elements: [AXUIElement] = [application]
		let windows = (Ax.copyAttribute(application, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
		elements.append(contentsOf: windows.prefix(AxWatcher.maxWatchedWindows))

		for element in elements {
			for notification in AxWatcher.notifications {
				let result = AXObserverAddNotification(observer, element, notification as CFString, refcon)
				if result == .success {
					added += 1
				}
			}
		}
		return added
	}

	/// Stops watching an application and releases its run loop source.
	func stopWatching(pid: pid_t) {
		condition.lock()
		let state = states.removeValue(forKey: pid)
		let loop = runLoop
		condition.unlock()

		guard let state else { return }
		if let loop {
			CFRunLoopRemoveSource(loop, AXObserverGetRunLoopSource(state.observer), .defaultMode)
			CFRunLoopWakeUp(loop)
		}
		Log.debug("stopped watching pid \(pid)")
	}

	// ---------------------------------------------------------------------------------------------
	// Observation
	// ---------------------------------------------------------------------------------------------

	/// The current activity reading for an application.
	func activity(pid: pid_t) -> Activity {
		condition.lock()
		defer { condition.unlock() }
		guard let state = states[pid] else {
			return Activity(count: 0, lastAt: nil, notificationsAvailable: false)
		}
		return Activity(count: state.count, lastAt: state.lastAt, notificationsAvailable: state.registrations > 0)
	}

	/// How long after a traversal ends its provoked notifications keep arriving.
	///
	/// Measured, not guessed: a full walk of Finder provoked upwards of thirty `AXValueChanged`
	/// notifications for elements it merely queried, and the tail of that burst was still being delivered
	/// after the walk had returned. 60 ms covered it with room to spare. The cost of the window is that a
	/// real change landing inside it is attributed to us and missed — 60 ms of blindness immediately after
	/// a read, against a fast path that is otherwise unusable.
	static let suppressionGraceMs = 60

	/// Runs a traversal of an application with its provoked notifications attributed to us, not to it.
	///
	/// **Without this the activity counter is meaningless and the `unchanged` fast path can never fire.**
	/// Reading an accessibility tree makes some applications emit `AXValueChanged` for the elements read;
	/// measured against Finder, each traversal provoked around forty. A watermark recorded after one
	/// traversal therefore never matches the reading taken during the next, because the next traversal has
	/// itself moved the counter — the comparison measures the helper's own footprints and nothing else.
	///
	/// Scoped as a closure so the suppression cannot be left on by an early return or a thrown error, which
	/// would silence a genuinely changing application indefinitely.
	func withSuppression<T>(pid: pid_t, _ body: () throws -> T) rethrows -> T {
		condition.lock()
		states[pid]?.suppressionDepth += 1
		condition.unlock()
		defer {
			condition.lock()
			if let state = states[pid] {
				state.suppressionDepth = max(0, state.suppressionDepth - 1)
				if state.suppressionDepth == 0 {
					state.suppressedUntil = Date()
						.addingTimeInterval(Double(AxWatcher.suppressionGraceMs) / 1000)
				}
			}
			condition.unlock()
		}
		return try body()
	}

	/// Blocks until the activity counter moves past `count`, or until `deadline`.
	///
	/// Returns the reading at wake-up either way, so a caller distinguishes "something happened" from
	/// "the wait expired" by comparing counts rather than by a separate flag it could forget to check.
	func wait(pid: pid_t, past count: UInt64, until deadline: Date) -> Activity {
		condition.lock()
		defer { condition.unlock() }
		while true {
			guard let state = states[pid] else {
				// Nothing is watching this application, so the counter can never move. Sleep out the
				// deadline rather than returning at once: an unwatched pid must not turn a caller's wait
				// loop into a spin.
				condition.wait(until: deadline)
				return Activity(count: count, lastAt: nil, notificationsAvailable: false)
			}
			if state.count > count || Date() >= deadline {
				return Activity(
					count: state.count,
					lastAt: state.lastAt,
					notificationsAvailable: state.registrations > 0
				)
			}
			condition.wait(until: deadline)
		}
	}

	/// Called from the watcher thread for every qualifying notification.
	fileprivate func record(pid: pid_t, notification: String) {
		var attributedToUs = false
		condition.lock()
		if let state = states[pid] {
			let now = Date()
			if state.isSuppressed(at: now) {
				// Provoked by a traversal of ours. Counted separately so the noise is visible in logs
				// without it polluting the signal, and deliberately not broadcast: nobody is waiting to be
				// told that we just read something.
				state.provoked &+= 1
				attributedToUs = true
			} else {
				state.count &+= 1
				state.lastAt = now
			}
		}
		if !attributedToUs {
			condition.broadcast()
		}
		condition.unlock()
		Log.debug("ax notification \(notification) from pid \(pid)\(attributedToUs ? " (provoked by our own read)" : "")")
	}
}

/// The C callback `AXObserverCreate` requires.
///
/// A file-scope, non-capturing closure so Swift can lower it to a function pointer. The pid comes from
/// the element rather than from the refcon, so one callback serves every watched application.
private let axWatcherCallback: AXObserverCallback = { _, element, notification, refcon in
	guard let refcon else { return }
	let watcher = Unmanaged<AxWatcher>.fromOpaque(refcon).takeUnretainedValue()
	guard let pid = Ax.pid(of: element) else { return }
	watcher.record(pid: pid, notification: notification as String)
}
