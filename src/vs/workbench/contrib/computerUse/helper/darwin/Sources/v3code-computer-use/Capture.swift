/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit

/// Screenshots.
///
/// Two paths, chosen at runtime. ScreenCaptureKit is primary because it is the only API that can omit an
/// application from a capture — which is what keeps V3Code's own window out of the agent's field of view,
/// and with it the feedback loop where the model reads its own transcript and reacts to it. On systems
/// older than the framework's screenshot entry point, `CGWindowList` stands in; it can approximate the
/// exclusion by compositing only the windows that were not excluded.
enum Capture {
	/// Whether this process has already asked the system for Screen Recording.
	///
	/// `CGRequestScreenCaptureAccess` prompts at most once per process, but asking repeatedly is still
	/// wrong: after a denial it returns immediately and every subsequent capture would pay the call.
	private static var didRequestAccess = false
	private static let requestLock = NSLock()

	/// Returns whether the helper may capture the screen, asking the system if it has not already.
	///
	/// Preflighting alone is not enough, and this was a real bug: `CGPreflightScreenCaptureAccess`
	/// only *reads* the current answer, while `CGRequestScreenCaptureAccess` is what registers this
	/// executable with TCC and raises the prompt. Without ever calling it the helper never appeared as
	/// a screen-recording client at all, so adding it by hand in System Settings had nothing to attach
	/// to and the grant silently did not take.
	///
	/// (An earlier version of this comment claimed the accessibility path prompts. It does not —
	/// `Ax.isProcessTrusted` passes `kAXTrustedCheckOptionPrompt: false` on purpose, because the
	/// helper is a stdio child with no UI and a prompt raised from it appears to come from nowhere.
	/// Screen capture is the one permission this process asks for directly.)
	///
	/// After asking, this WAITS. `CGRequestScreenCaptureAccess` raises the dialog and returns
	/// immediately with the answer as it stands right now — which is `false`, because the user has
	/// not clicked anything yet. Returning on that answer meant the tool reported a permission
	/// failure while the dialog was still open, and the agent, told the failure was terminal, moved
	/// on before the user could approve it. The user then approved a dialog for a request nobody was
	/// waiting on any more, and concluded the feature was broken.
	///
	/// So poll until the grant lands or the budget runs out. This deliberately blocks the calling
	/// tool: waiting a few seconds for a human to click Allow is the correct behaviour, and it is far
	/// cheaper than a false failure that costs a whole turn and the user's confidence.
	private static let grantWaitBudget: TimeInterval = 12.0
	private static let grantPollInterval: TimeInterval = 0.25

	private static func ensureAccess() -> Bool {
		if CGPreflightScreenCaptureAccess() {
			return true
		}
		requestLock.lock()
		defer { requestLock.unlock() }
		if didRequestAccess {
			// Already asked this process; re-read rather than ask again, since the user may have granted
			// it in System Settings since. A grant made after launch does not reach a running process on
			// every macOS version, which is why the error below still tells them to restart.
			return CGPreflightScreenCaptureAccess()
		}
		didRequestAccess = true
		if CGRequestScreenCaptureAccess() {
			return true
		}
		// The dialog is up. Give the user a chance to answer it before calling this a failure.
		let deadline = Date().addingTimeInterval(grantWaitBudget)
		while Date() < deadline {
			Thread.sleep(forTimeInterval: grantPollInterval)
			if CGPreflightScreenCaptureAccess() {
				return true
			}
		}
		return false
	}

	static func run(_ params: CaptureParams?, cancellation: Cancellation.Token) throws -> CaptureResult {
		guard ensureAccess() else {
			throw HelperError(
				.screenRecordingNotGranted,
				"Screen Recording permission has not been granted to the computer-use helper. "
					+ "macOS should have just shown a prompt; if it did not, add the helper under "
					+ "Privacy & Security > Screen & System Audio Recording. A grant made while V3Code is "
					+ "running does not reach it — restart V3Code afterwards."
			)
		}
		try cancellation.check()

		let displays = Geometry.displays()
		guard !displays.isEmpty else {
			throw HelperError(.internalError, "no active displays")
		}
		let display = try chooseDisplay(requested: params?.displayId, from: displays)

		// The service passes its own pid; the helper independently adds every process it classifies as
		// V3Code, because tier `self` means "never captured" and the service cannot know about a second
		// instance.
		let requestedPids = Set(params?.excludePids ?? [])
		let excludeCandidates = requestedPids.union(Apps.selfTierPids())

		let native = CGSize(
			width: display.pointBounds.width * display.scale,
			height: display.pointBounds.height * display.scale
		)

		let captured: (image: CGImage, excluded: [pid_t])
		if #available(macOS 14.0, *), screenCaptureKitAvailable {
			captured = try captureWithScreenCaptureKit(
				display: display,
				nativeSize: native,
				excluding: excludeCandidates
			)
		} else {
			Log.info("ScreenCaptureKit unavailable; using the CGWindowList fallback")
			captured = try captureWithWindowList(display: display, excluding: excludeCandidates)
		}
		try cancellation.check()

		let target = Geometry.downscale(
			width: captured.image.width,
			height: captured.image.height,
			maxLongEdge: params?.maxLongEdge ?? COMPUTER_USE_DEFAULT_MAX_LONG_EDGE
		)
		let scaled = target.width == captured.image.width && target.height == captured.image.height
			? captured.image
			: try resize(captured.image, width: target.width, height: target.height)

		let png = try encodePng(scaled)
		// `scale` is image pixels per *physical* pixel, derived from the image the caller is actually
		// getting rather than from the requested bound, so a fallback path that produced a different
		// native size still reports a scale the caller can invert exactly.
		let scale = Double(scaled.width) / Double(max(1, captured.image.width))

		Log.debug(
			"capture display \(display.displayId) \(scaled.width)x\(scaled.height) scale \(scale) excluded \(captured.excluded)"
		)
		return CaptureResult(
			width: scaled.width,
			height: scaled.height,
			scale: scale,
			dataBase64: png.base64EncodedString(),
			excludedPids: captured.excluded.sorted(),
			// Physical bounds including origin — see CaptureDisplay for why the origin matters.
			display: CaptureDisplay(
				displayId: Int(display.displayId),
				bounds: Rect(
					x: Double(display.physicalBounds.origin.x),
					y: Double(display.physicalBounds.origin.y),
					width: Double(display.physicalBounds.width),
					height: Double(display.physicalBounds.height)
				)
			)
		)
	}

	// ---------------------------------------------------------------------------------------------
	// Display selection
	// ---------------------------------------------------------------------------------------------

	/// The requested display, or the one holding the frontmost window.
	///
	/// An unknown `displayId` is an error rather than a silent fall back to the main display: the caller
	/// asked for a specific screen, and handing it a different one would have it act on coordinates from a
	/// screen it never saw.
	private static func chooseDisplay(
		requested: UInt32?,
		from displays: [Geometry.DisplayInfo]
	) throws -> Geometry.DisplayInfo {
		if let requested {
			guard let display = Geometry.display(withId: requested, in: displays) else {
				throw HelperError(.targetNotFound, "no active display with id \(requested)")
			}
			return display
		}
		if let frontmost = Apps.frontmost(),
			let frame = frontmostWindowFrame(pid: frontmost.pid),
			let display = Geometry.display(
				containingPoint: CGPoint(x: frame.midX, y: frame.midY),
				in: displays
			) {
			return display
		}
		return Geometry.display(withId: CGMainDisplayID(), in: displays) ?? displays[0]
	}

	private static func frontmostWindowFrame(pid: pid_t) -> CGRect? {
		guard Ax.isProcessTrusted() else { return nil }
		let application = Ax.application(pid: pid)
		guard let window = Ax.copyAttribute(application, kAXFocusedWindowAttribute as String),
			CFGetTypeID(window) == AXUIElementGetTypeID()
		else {
			return nil
		}
		let element = window as! AXUIElement
		return Ax.rect(
			position: Ax.copyAttribute(element, kAXPositionAttribute as String),
			size: Ax.copyAttribute(element, kAXSizeAttribute as String)
		)
	}

	// ---------------------------------------------------------------------------------------------
	// ScreenCaptureKit
	// ---------------------------------------------------------------------------------------------

	/// Whether the weakly-linked framework actually loaded.
	///
	/// The binary deploys to macOS 12.0 but ScreenCaptureKit only exists from 12.3, so the framework is
	/// weak linked and its classes may be absent at runtime. An `@available` check alone would not catch
	/// that — it tests the OS version, not whether the dylib was found — so the class is probed by name.
	private static let screenCaptureKitAvailable: Bool = {
		NSClassFromString("SCShareableContent") != nil && NSClassFromString("SCScreenshotManager") != nil
	}()

	@available(macOS 14.0, *)
	private static func captureWithScreenCaptureKit(
		display: Geometry.DisplayInfo,
		nativeSize: CGSize,
		excluding pids: Set<pid_t>
	) throws -> (image: CGImage, excluded: [pid_t]) {
		let content: SCShareableContent = try await_(
			timeout: 5,
			description: "enumerating shareable content"
		) { completion in
			SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
				completion(content, error)
			}
		}

		guard let scDisplay = content.displays.first(where: { $0.displayID == display.displayId }) else {
			throw HelperError(.targetNotFound, "display \(display.displayId) is not shareable")
		}

		let excludedApps = content.applications.filter { pids.contains($0.processID) }
		let filter = SCContentFilter(
			display: scDisplay,
			excludingApplications: excludedApps,
			exceptingWindows: []
		)

		let configuration = SCStreamConfiguration()
		// Capture at the display's true pixel size and downscale afterwards, so the resize is a single
		// high-quality step rather than ScreenCaptureKit's scaler followed by ours.
		configuration.width = Int(nativeSize.width.rounded())
		configuration.height = Int(nativeSize.height.rounded())
		configuration.captureResolution = .best
		configuration.showsCursor = true
		configuration.scalesToFit = false

		let image: CGImage = try await_(timeout: 10, description: "capturing the screen") { completion in
			SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
				completion(image, error)
			}
		}
		return (image, excludedApps.map { $0.processID })
	}

	/// Bridges a completion-handler API onto the synchronous work queue.
	///
	/// The work queue is a serial queue precisely so actions cannot interleave, and the request is not
	/// answered until the capture completes, so blocking it here changes nothing observable. The main
	/// thread runs only a run loop, so the callback still has somewhere to land.
	private static func await_<T>(
		timeout: TimeInterval,
		description: String,
		_ body: (@escaping (T?, Error?) -> Void) -> Void
	) throws -> T {
		let semaphore = DispatchSemaphore(value: 0)
		let box = ResultBox<T>()
		body { value, error in
			box.set(value: value, error: error)
			semaphore.signal()
		}
		guard semaphore.wait(timeout: .now() + timeout) == .success else {
			throw HelperError(.timeout, "timed out \(description)", retryable: true)
		}
		if let error = box.error {
			throw mapScreenCaptureError(error, description: description)
		}
		guard let value = box.value else {
			throw HelperError(.internalError, "\(description) returned nothing")
		}
		return value
	}

	/// Turns a ScreenCaptureKit failure into a code the user can act on.
	///
	/// Only the two permission codes become `screenRecordingNotGranted`; everything else stays `internal`,
	/// because telling the user to grant a permission they already granted sends them to the wrong place.
	private static func mapScreenCaptureError(_ error: Error, description: String) -> HelperError {
		let nsError = error as NSError
		// SCStreamErrorUserDeclined and SCStreamErrorMissingEntitlements. Compared as raw values so the
		// mapping still compiles against the 12.0 deployment floor.
		let permissionCodes: Set<Int> = [-3801, -3802]
		if permissionCodes.contains(nsError.code) {
			return HelperError(
				.screenRecordingNotGranted,
				"\(description) was refused: \(nsError.localizedDescription)"
			)
		}
		return HelperError(
			.internalError,
			"\(description) failed: \(nsError.domain) \(nsError.code) \(nsError.localizedDescription)",
			retryable: true
		)
	}

	/// Lock-guarded hand-off from a callback thread to the waiting work queue.
	private final class ResultBox<T> {
		private let lock = NSLock()
		private var storedValue: T?
		private var storedError: Error?

		func set(value: T?, error: Error?) {
			lock.lock()
			defer { lock.unlock() }
			storedValue = value
			storedError = error
		}

		var value: T? {
			lock.lock()
			defer { lock.unlock() }
			return storedValue
		}

		var error: Error? {
			lock.lock()
			defer { lock.unlock() }
			return storedError
		}
	}

	// ---------------------------------------------------------------------------------------------
	// CGWindowList fallback
	// ---------------------------------------------------------------------------------------------

	/// Pre-14.0 capture.
	///
	/// With nothing to exclude this is a plain display grab. With exclusions it composites the on-screen
	/// window list minus the excluded owners, which is not pixel-identical to the real screen — a window
	/// that was behind an excluded one becomes visible — but it does honour the exclusion, and showing a
	/// slightly different stacking order is far less harmful than showing the agent its own UI.
	private static func captureWithWindowList(
		display: Geometry.DisplayInfo,
		excluding pids: Set<pid_t>
	) throws -> (image: CGImage, excluded: [pid_t]) {
		let bounds = display.pointBounds

		guard !pids.isEmpty else {
			guard let image = CGWindowListCreateImage(
				bounds,
				.optionOnScreenOnly,
				kCGNullWindowID,
				[.bestResolution]
			) else {
				throw HelperError(
					.screenRecordingNotGranted,
					"the display could not be captured; Screen Recording permission may have been revoked"
				)
			}
			return (image, [])
		}

		guard let info = CGWindowListCopyWindowInfo(
			[.optionOnScreenOnly, .excludeDesktopElements],
			kCGNullWindowID
		) as? [[String: Any]] else {
			throw HelperError(.internalError, "the window list could not be read")
		}

		var keptWindowIds: [CGWindowID] = []
		var excluded: Set<pid_t> = []
		for window in info {
			guard let owner = window[kCGWindowOwnerPID as String] as? pid_t,
				let number = window[kCGWindowNumber as String] as? CGWindowID
			else {
				continue
			}
			if pids.contains(owner) {
				excluded.insert(owner)
				continue
			}
			keptWindowIds.append(number)
		}

		// CGWindowListCreateImageFromArray wants a CFArray of window ids smuggled through pointer slots,
		// which is the documented calling convention for this API. Id 0 is not a real window and would
		// produce a null slot, so it is dropped rather than force-unwrapped.
		var identifiers: [UnsafeRawPointer?] = keptWindowIds.compactMap {
			UnsafeRawPointer(bitPattern: UInt($0))
		}
		let array = identifiers.withUnsafeMutableBufferPointer { buffer in
			CFArrayCreate(nil, buffer.baseAddress, buffer.count, nil)
		}
		guard let array,
			let image = CGImage(
				windowListFromArrayScreenBounds: bounds,
				windowArray: array,
				imageOption: [.bestResolution]
			)
		else {
			throw HelperError(.internalError, "the filtered window list could not be composited")
		}
		return (image, Array(excluded))
	}

	// ---------------------------------------------------------------------------------------------
	// Image plumbing
	// ---------------------------------------------------------------------------------------------

	private static func resize(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
		let space = image.colorSpace ?? CGColorSpaceCreateDeviceRGB()
		guard let context = CGContext(
			data: nil,
			width: width,
			height: height,
			bitsPerComponent: 8,
			bytesPerRow: 0,
			space: space,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
		) else {
			throw HelperError(.internalError, "could not create a \(width)x\(height) bitmap context")
		}
		context.interpolationQuality = .high
		context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
		guard let resized = context.makeImage() else {
			throw HelperError(.internalError, "could not resize the capture")
		}
		return resized
	}

	private static func encodePng(_ image: CGImage) throws -> Data {
		let data = NSMutableData()
		guard let destination = CGImageDestinationCreateWithData(
			data as CFMutableData,
			"public.png" as CFString,
			1,
			nil
		) else {
			throw HelperError(.internalError, "could not create a PNG encoder")
		}
		CGImageDestinationAddImage(destination, image, nil)
		guard CGImageDestinationFinalize(destination) else {
			throw HelperError(.internalError, "could not encode the capture as PNG")
		}
		return data as Data
	}
}
