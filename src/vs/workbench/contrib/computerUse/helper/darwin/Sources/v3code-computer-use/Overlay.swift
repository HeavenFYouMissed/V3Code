/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import AppKit
import Foundation

/// The on-screen indicator of what the agent is doing.
///
/// Without this the agent is invisible: actions that go through the accessibility API move nothing
/// the user can see, so a button simply presses itself and the user has no idea which application is
/// being driven or where. That invisibility is worse than it sounds — the whole reason to prefer the
/// accessibility path is that it does *not* seize the real pointer, and the cost of that is losing
/// the one cue the user had.
///
/// So the agent gets its own cursor, drawn rather than real. A floating panel, a ring around the
/// element about to be acted on, a dot where the action lands, and a label naming the application.
/// Codex's helper does the same thing and its binary shows the same shape — `NSPanel`, `CAShapeLayer`,
/// `NSVisualEffect` — because there is no other way: macOS has exactly one hardware pointer and it
/// belongs to the user.
///
/// Threading: every method here hops to the main thread. AppKit requires it, and the helper's main
/// thread is deliberately kept free running a bare run loop, which is what makes this possible at all.
final class Overlay {

	static let shared = Overlay()

	/// How long an indicator stays up after the action that drew it.
	///
	/// Long enough for a person to follow, short enough not to litter the screen during a fast
	/// sequence. Each new action restarts the clock rather than queueing, so a burst of ten clicks
	/// reads as one continuously-moving indicator rather than ten stacked ghosts.
	private static let visibleSeconds: TimeInterval = 1.8

	/// Where the indicator sits in the global window order.
	///
	/// Above `.mainMenu` so it survives an application going full-screen, and well above the ordinary
	/// and floating levels every application competes in. Deliberately not `.screenSaver`, which some
	/// macOS releases reserve and clamp for unprivileged processes — a clamped level silently drops the
	/// panel back into the normal band, where it renders behind whatever the agent is driving.
	private static let overlayLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.maximumWindow)) - 1)

	private var panel: NSPanel?
	private var ringLayer: CAShapeLayer?
	private var cursorLayer: CAShapeLayer?
	private var labelLayer: CATextLayer?
	private var hideWorkItem: DispatchWorkItem?

	/// Whether the indicator is drawn at all. Off means this class does nothing anywhere.
	private var enabled = true

	private init() {}

	func setEnabled(_ value: Bool) {
		DispatchQueue.main.async {
			self.enabled = value
			if !value {
				self.teardown()
			}
		}
	}

	/// Announces one action, resolving the element's frame and the acting application itself.
	///
	/// Lives here rather than on `Actions` because the verbs are spread across two files: `click`,
	/// `type` and `scroll` are in `Actions`, while `drag` and `mouseMove` are dispatched directly. The
	/// first cut only wired the three in `Actions`, which made the agent look broken — a drag across the
	/// screen and every `cmd+` chord drew nothing, so the indicator appeared to work only sometimes.
	///
	/// Every argument is optional because the verbs know different amounts. `computer_type` carries no
	/// target at all, so it falls back to whatever holds keyboard focus; a chord has neither, so it falls
	/// back to the pointer. Something is always shown, because "the agent did something just now" is the
	/// information the user actually needs.
	static func announce(_ verb: String, element: AXUIElement? = nil, point: CGPoint? = nil) {
		let target = element ?? Ax.systemWideFocusedElement()
		var rect: CGRect?
		var label: String?
		var pid: pid_t?
		if let target {
			let attributes = Ax.copyMultiple(target, [
				kAXPositionAttribute as String,
				kAXSizeAttribute as String,
			])
			rect = Ax.rect(
				position: attributes[kAXPositionAttribute as String],
				size: attributes[kAXSizeAttribute as String]
			)
			label = Ax.identity(of: target)?.label
			pid = Ax.pid(of: target)
		}
		// Prefer the explicit point, then the middle of the target, then the pointer — in that order,
		// because each is a weaker guess about where the user should be looking.
		let anchor = point
			?? rect.map { CGPoint(x: $0.midX, y: $0.midY) }
			?? CGEvent(source: nil)?.location
			?? .zero
		let app = (pid ?? Apps.frontmost()?.pid).flatMap { Ax.pid(of: Ax.application(pid: $0)) != nil ? Apps.identity(pid: $0)?.name : nil }
		let subject = [label, app].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " — ")
		shared.show(
			at: anchor,
			targetRect: rect,
			label: subject.isEmpty ? verb : "\(verb) \(subject)"
		)
	}

	/// Shows the indicator for one action.
	///
	/// - Parameters:
	///   - point: where the action lands, in global CoreGraphics coordinates (top-left origin).
	///   - targetRect: the element's frame, when one is known, also top-left origin. Drawn as a ring.
	///   - label: short description shown beside the cursor, e.g. `Clicking "Save" in TextEdit`.
	///
	/// Fire-and-forget by design: an indicator that could fail an action would be a bad trade, so
	/// every failure here is silent. The action must happen whether or not the user can see it.
	func show(at point: CGPoint, targetRect: CGRect?, label: String) {
		DispatchQueue.main.async {
			guard self.enabled else { return }
			self.ensurePanel()
			guard let panel = self.panel else {
				Log.warn("overlay: no panel; screens=\(NSScreen.screens.count) union=\(Self.unionFrame())")
				return
			}

			let origin = Self.appKitOrigin()
			// CoreGraphics measures y downward from the top of the primary display; AppKit measures it
			// upward from the bottom. Every coordinate crossing this boundary has to be flipped, and
			// getting it wrong puts the indicator on the opposite side of the screen from the action.
			let flippedPoint = CGPoint(x: point.x - origin.x, y: origin.y - point.y)

			self.cursorLayer?.position = flippedPoint

			if let rect = targetRect, rect.width > 0, rect.height > 0 {
				let flippedRect = CGRect(
					x: rect.minX - origin.x,
					y: origin.y - rect.maxY,
					width: rect.width,
					height: rect.height
				)
				self.ringLayer?.path = CGPath(
					roundedRect: flippedRect.insetBy(dx: -3, dy: -3),
					cornerWidth: 6,
					cornerHeight: 6,
					transform: nil
				)
				self.ringLayer?.isHidden = false
			} else {
				self.ringLayer?.isHidden = true
			}

			if let labelLayer = self.labelLayer {
				labelLayer.string = label
				let width = min(max(CGFloat(label.count) * 7.5 + 20, 90), 420)
				// Above the cursor by default, below it near the top of the screen, so the label never
				// runs off the edge and becomes unreadable.
				let above = flippedPoint.y + 22
				let fits = above + 22 < panel.frame.height
				labelLayer.frame = CGRect(
					x: min(max(flippedPoint.x - 8, 4), panel.frame.width - width - 4),
					y: fits ? above : flippedPoint.y - 40,
					width: width,
					height: 22
				)
				labelLayer.isHidden = label.isEmpty
			}

			// Re-asserted on every show rather than set once at creation. A window level is not as sticky
			// as it looks: activating another application, a Space switch, or a display change can leave
			// the panel ordered behind the very window it is annotating — which is exactly the symptom
			// this fixes, an indicator visible only in the instant the covering application closed.
			panel.level = Self.overlayLevel
			panel.orderFrontRegardless()
			Log.info(
				"overlay: shown at \(flippedPoint) visible=\(panel.isVisible) "
					+ "level=\(panel.level.rawValue) screens=\(NSScreen.screens.count)"
			)
			self.scheduleHide()
		}
	}

	/// Hides the indicator immediately, e.g. when a run is cancelled.
	func hide() {
		DispatchQueue.main.async {
			self.hideWorkItem?.cancel()
			self.panel?.orderOut(nil)
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Internals — main thread only
	// ---------------------------------------------------------------------------------------------

	private func scheduleHide() {
		hideWorkItem?.cancel()
		let item = DispatchWorkItem { [weak self] in self?.panel?.orderOut(nil) }
		hideWorkItem = item
		DispatchQueue.main.asyncAfter(deadline: .now() + Self.visibleSeconds, execute: item)
	}

	/// The union of every display, in AppKit coordinates, plus the flip origin.
	private static func appKitOrigin() -> CGPoint {
		// The primary screen's top edge is the zero line CoreGraphics measures down from.
		let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
		let minX = NSScreen.screens.map(\.frame.minX).min() ?? 0
		return CGPoint(x: minX, y: primaryTop)
	}

	private static func unionFrame() -> CGRect {
		NSScreen.screens.reduce(CGRect.null) { $0.union($1.frame) }
	}

	private func ensurePanel() {
		let frame = Self.unionFrame()
		if let panel {
			// Displays can be added, removed or rearranged mid-session; resize rather than rebuild so a
			// monitor change does not drop the indicator.
			if panel.frame != frame {
				panel.setFrame(frame, display: false)
				panel.contentView?.frame = CGRect(origin: .zero, size: frame.size)
			}
			return
		}
		guard !frame.isNull else { return }

		let panel = NSPanel(
			contentRect: frame,
			// `.nonactivatingPanel` is the load-bearing flag: without it, showing the indicator would
			// steal focus from the application the agent is driving and break the very action it is
			// announcing.
			styleMask: [.borderless, .nonactivatingPanel],
			backing: .buffered,
			defer: false
		)
		panel.isOpaque = false
		panel.backgroundColor = .clear
		panel.hasShadow = false
		panel.ignoresMouseEvents = true
		panel.isMovable = false
		// Above ordinary windows and full-screen applications, and present on every Space, because the
		// agent can drive an application the user is not currently looking at.
		panel.isFloatingPanel = true
		panel.level = Self.overlayLevel
		panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
		panel.hidesOnDeactivate = false

		let content = NSView(frame: CGRect(origin: .zero, size: frame.size))
		content.wantsLayer = true
		content.layer?.backgroundColor = NSColor.clear.cgColor
		panel.contentView = content

		let ring = CAShapeLayer()
		ring.fillColor = NSColor.systemBlue.withAlphaComponent(0.10).cgColor
		ring.strokeColor = NSColor.systemBlue.cgColor
		ring.lineWidth = 2
		ring.isHidden = true
		content.layer?.addSublayer(ring)
		ringLayer = ring

		let cursor = CAShapeLayer()
		cursor.path = Self.cursorPath()
		cursor.fillColor = NSColor.systemBlue.cgColor
		cursor.strokeColor = NSColor.white.cgColor
		cursor.lineWidth = 1.5
		cursor.shadowColor = NSColor.black.cgColor
		cursor.shadowOpacity = 0.35
		cursor.shadowRadius = 3
		cursor.shadowOffset = CGSize(width: 0, height: -1)
		content.layer?.addSublayer(cursor)
		cursorLayer = cursor

		let label = CATextLayer()
		label.fontSize = 12
		label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
		label.foregroundColor = NSColor.white.cgColor
		label.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.92).cgColor
		label.cornerRadius = 5
		label.alignmentMode = .center
		label.truncationMode = .end
		label.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
		label.isHidden = true
		content.layer?.addSublayer(label)
		labelLayer = label

		self.panel = panel
	}

	private func teardown() {
		hideWorkItem?.cancel()
		panel?.orderOut(nil)
		panel = nil
		ringLayer = nil
		cursorLayer = nil
		labelLayer = nil
	}

	/// An arrow pointing up-left from the origin, the shape a pointer is expected to be.
	private static func cursorPath() -> CGPath {
		let path = CGMutablePath()
		path.move(to: CGPoint(x: 0, y: 0))
		path.addLine(to: CGPoint(x: 0, y: -18))
		path.addLine(to: CGPoint(x: 5, y: -13.5))
		path.addLine(to: CGPoint(x: 8.5, y: -20))
		path.addLine(to: CGPoint(x: 12, y: -18.5))
		path.addLine(to: CGPoint(x: 8.5, y: -12))
		path.addLine(to: CGPoint(x: 14, y: -11.5))
		path.closeSubpath()
		return path
	}
}
