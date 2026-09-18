/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import AppKit
import Foundation

/// Clipboard access and application launching.
///
/// Both are things a person at the machine can trivially do and the first cut of this helper could
/// not, which made whole categories of task unreachable — anything beginning "open X", and anything
/// where the useful data is on the clipboard rather than on screen.
enum SystemAccess {

	// ---------------------------------------------------------------------------------------------
	// Clipboard
	// ---------------------------------------------------------------------------------------------

	struct ClipboardContents {
		let text: String
		let length: Int
		let hasNonTextContent: Bool
	}

	/// Reads the clipboard as text.
	///
	/// `hasNonTextContent` exists so the caller can tell "the clipboard is empty" from "the clipboard
	/// holds a screenshot the user copied", which are very different facts and would otherwise both
	/// arrive as an empty string. The model reads the difference and stops guessing.
	static func readClipboard() -> ClipboardContents {
		let pasteboard = NSPasteboard.general
		let text = pasteboard.string(forType: .string) ?? ""
		// Types other than plain text and its close relatives mean there is content we did not read.
		let textish: Set<NSPasteboard.PasteboardType> = [.string, .rtf, .html, .tabularText]
		let hasOther = (pasteboard.types ?? []).contains { !textish.contains($0) }
		return ClipboardContents(
			text: text,
			// UTF-16 code units, not grapheme clusters, so this agrees with the Windows helper and with
			// JavaScript's `.length` on the same string. `text.count` would report a different number for
			// the same clipboard depending on which platform read it, for emoji and combining marks.
			length: text.utf16.count,
			hasNonTextContent: text.isEmpty && hasOther
		)
	}

	/// Replaces the clipboard's contents with text.
	///
	/// `clearContents()` first is required, not tidiness: without it the old representations survive and
	/// a paste can deliver the *previous* clipboard in a richer type that the target prefers.
	static func writeClipboard(text: String) throws {
		let pasteboard = NSPasteboard.general
		pasteboard.clearContents()
		guard pasteboard.setString(text, forType: .string) else {
			throw HelperError(.internalError, "the clipboard rejected the write")
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Launching
	// ---------------------------------------------------------------------------------------------

	struct LaunchOutcome {
		let id: String
		let name: String
		let pid: pid_t
		let launched: Bool
		let frontmost: Bool
	}

	/// Launches an application, or focuses it when it is already running.
	///
	/// `app` may be a bundle identifier, a display name, or an application path, because the model will
	/// usually only know the name a human would say. Already-running is checked first: re-launching a
	/// running application is at best a no-op and at worst opens a second window the user did not ask
	/// for.
	static func openApplication(app: String, waitSeconds: TimeInterval) throws -> LaunchOutcome {
		let workspace = NSWorkspace.shared
		let wanted = app.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !wanted.isEmpty else {
			throw HelperError(.targetNotFound, "no application was named")
		}

		if let running = findRunning(wanted) {
			running.activate(options: [])
			let frontmost = waitForFrontmost(pid: running.processIdentifier, seconds: waitSeconds)
			return LaunchOutcome(
				id: running.bundleIdentifier ?? wanted,
				name: running.localizedName ?? wanted,
				pid: running.processIdentifier,
				launched: false,
				frontmost: frontmost
			)
		}

		guard let url = resolveURL(wanted, workspace: workspace) else {
			throw HelperError(
				.targetNotFound,
				"no application matching '\(wanted)' is running or installed",
				retryable: false
			)
		}

		// NSWorkspace's async open is the only supported path on modern macOS; the semaphore turns it
		// back into the synchronous answer the protocol needs.
		let configuration = NSWorkspace.OpenConfiguration()
		configuration.activates = true
		var launched: NSRunningApplication?
		var failure: Error?
		let semaphore = DispatchSemaphore(value: 0)
		workspace.openApplication(at: url, configuration: configuration) { running, error in
			launched = running
			failure = error
			semaphore.signal()
		}
		if semaphore.wait(timeout: .now() + max(waitSeconds, 1)) != .success {
			throw HelperError(.timeout, "'\(wanted)' did not finish launching in time", retryable: true)
		}
		if let failure {
			throw HelperError(.internalError, "could not launch '\(wanted)': \(failure.localizedDescription)")
		}
		guard let running = launched else {
			throw HelperError(.internalError, "'\(wanted)' launched but reported no process")
		}
		return LaunchOutcome(
			id: running.bundleIdentifier ?? wanted,
			name: running.localizedName ?? wanted,
			pid: running.processIdentifier,
			launched: true,
			frontmost: waitForFrontmost(pid: running.processIdentifier, seconds: waitSeconds)
		)
	}

	/// Finds a running application by bundle identifier or display name, case-insensitively.
	private static func findRunning(_ wanted: String) -> NSRunningApplication? {
		let needle = wanted.lowercased()
		return NSWorkspace.shared.runningApplications.first { candidate in
			guard candidate.activationPolicy == .regular else { return false }
			if candidate.bundleIdentifier?.lowercased() == needle { return true }
			return candidate.localizedName?.lowercased() == needle
		}
	}

	/// Resolves a name, bundle identifier or path to an application URL.
	private static func resolveURL(_ wanted: String, workspace: NSWorkspace) -> URL? {
		if wanted.hasPrefix("/") {
			let url = URL(fileURLWithPath: wanted)
			return FileManager.default.fileExists(atPath: url.path) ? url : nil
		}
		if let byId = workspace.urlForApplication(withBundleIdentifier: wanted) {
			return byId
		}
		// Fall back to the conventional locations, which is what resolves a plain display name.
		for directory in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
			let candidate = URL(fileURLWithPath: directory).appendingPathComponent("\(wanted).app")
			if FileManager.default.fileExists(atPath: candidate.path) {
				return candidate
			}
		}
		return nil
	}

	/// Polls until the pid owns the frontmost application, or the budget runs out.
	///
	/// Reported honestly rather than assumed: activation can be refused or simply lose a race with
	/// another application, and claiming `frontmost: true` when it is not would send the agent reading
	/// somebody else's window.
	private static func waitForFrontmost(pid: pid_t, seconds: TimeInterval) -> Bool {
		let deadline = Date().addingTimeInterval(max(seconds, 0))
		repeat {
			if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
				return true
			}
			Thread.sleep(forTimeInterval: 0.05)
		} while Date() < deadline
		return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
	}
}
