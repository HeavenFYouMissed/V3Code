/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import AppKit
import ApplicationServices
import Foundation

/// Application identity, via NSWorkspace.
///
/// `id` is the bundle identifier because that is what approval decisions and tier classification are
/// keyed on: a display name is localized and a process name is trivially spoofed, so neither is a safe
/// identity for a security decision.
enum Apps {
	/// NSWorkspace is main-thread-affine, so every read here hops to the main queue. The main thread runs
	/// only a run loop — the stdin reader has its own thread — so this cannot deadlock.
	private static func onMain<T>(_ body: @escaping () -> T) -> T {
		if Thread.isMainThread {
			return body()
		}
		return DispatchQueue.main.sync(execute: body)
	}

	static func identity(pid: pid_t) -> (id: String, name: String)? {
		onMain {
			guard let app = NSRunningApplication(processIdentifier: pid) else { return nil }
			return describe(app)
		}
	}

	static func frontmost() -> (id: String, name: String, pid: pid_t)? {
		onMain {
			guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
			let described = describe(app)
			return (described.id, described.name, app.processIdentifier)
		}
	}

	/// Every app with a Dock presence.
	///
	/// Agents and accessory processes are filtered out: they have no windows to see or act on, and
	/// including them would bury the handful of apps the model actually cares about in a list of
	/// eighty XPC helpers.
	static func list() -> [AppResult] {
		onMain {
			NSWorkspace.shared.runningApplications
				.filter { $0.activationPolicy == .regular }
				.map { app in
					let described = describe(app)
					return AppResult(id: described.id, name: described.name, pid: app.processIdentifier)
				}
		}
	}

	/// Pids of every running app that classifies as V3Code itself.
	///
	/// Used to harden `capture`: the service passes its own pid, but tier `self` means "never captured",
	/// so the helper independently excludes anything it recognises as V3Code — including a second window
	/// or a stale instance the service did not know about.
	static func selfTierPids() -> [pid_t] {
		onMain {
			NSWorkspace.shared.runningApplications.compactMap { app -> pid_t? in
				let described = describe(app)
				guard AppTiers.classify(id: described.id, name: described.name) == .selfApp else {
					return nil
				}
				return app.processIdentifier
			}
		}
	}

	/// Title of an application's focused window, or nil when accessibility is unavailable.
	///
	/// Deliberately never throws: `frontmostApp` is an observation, and failing the whole call because a
	/// title could not be read would make the app-identity path depend on a permission it does not need.
	static func focusedWindowTitle(pid: pid_t) -> String? {
		guard Ax.isProcessTrusted() else { return nil }
		let application = Ax.application(pid: pid)
		guard let window = Ax.copyAttribute(application, kAXFocusedWindowAttribute as String)
			?? Ax.copyAttribute(application, kAXMainWindowAttribute as String)
		else {
			return nil
		}
		guard CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
		return Ax.string(Ax.copyAttribute(window as! AXUIElement, kAXTitleAttribute as String))
	}

	private static func describe(_ app: NSRunningApplication) -> (id: String, name: String) {
		let name = app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)"
		// A bundle-less process (a bare executable) has no bundle identifier; fall back to the name so
		// tier classification still has something to match on rather than an empty string.
		let id = app.bundleIdentifier ?? name
		return (id, name)
	}
}
