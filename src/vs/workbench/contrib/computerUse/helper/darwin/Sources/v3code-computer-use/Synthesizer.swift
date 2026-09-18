/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import CoreGraphics
import Foundation

/// Raw event injection — the fallback path.
///
/// Every entry point here reports `synthesized`, which is the metric the service watches: synthesis is
/// blind, it hits whatever happens to be under the cursor at the moment the event lands, so a rising
/// fallback rate means the accessibility path is degrading and the feature is getting less safe.
enum Synthesizer {
	/// Pause between paired events so the target application's run loop can process them in order.
	///
	/// Without a gap, a down/up pair posted in the same run-loop turn is frequently coalesced by AppKit
	/// into a no-op, and a chord's modifier flags can be observed after the key event they applied to.
	private static let eventGap: TimeInterval = 0.008

	/// Characters per synthesized keyboard event when typing literal text.
	///
	/// `CGEventKeyboardSetUnicodeString` accepts a string, so text is typed in chunks rather than
	/// character by character. Chunks stay small so a cancel is observed promptly and so a slow text
	/// view is not handed more than it can buffer.
	private static let typeChunkSize = 16

	private static func source() -> CGEventSource? {
		// A private state source does not inherit the user's currently-held modifier keys, so a physical
		// Shift the user happens to be resting on cannot silently alter a synthesized click.
		CGEventSource(stateID: .privateState)
	}

	private static func settle() {
		Thread.sleep(forTimeInterval: eventGap)
	}

	// ---------------------------------------------------------------------------------------------
	// Mouse
	// ---------------------------------------------------------------------------------------------

	static func click(
		at point: CGPoint,
		button: MouseButton,
		flags: CGEventFlags,
		clickCount: Int,
		cancellation: Cancellation.Token
	) throws {
		let source = source()
		let (down, up, cgButton) = eventTypes(for: button)

		// Move first, as a separate event: many controls only enter their hover state on a move, and a
		// down event delivered without one is ignored by some Electron and Java toolkits.
		if let move = CGEvent(
			mouseEventSource: source,
			mouseType: .mouseMoved,
			mouseCursorPosition: point,
			mouseButton: cgButton
		) {
			move.flags = flags
			move.post(tap: .cghidEventTap)
		}
		settle()

		for index in 1...max(1, clickCount) {
			try cancellation.check()
			for type in [down, up] {
				guard let event = CGEvent(
					mouseEventSource: source,
					mouseType: type,
					mouseCursorPosition: point,
					mouseButton: cgButton
				) else {
					throw HelperError(.internalError, "could not create a mouse event")
				}
				event.flags = flags
				// The click state is what turns two clicks into a double-click; without it the target sees
				// two unrelated single clicks.
				event.setIntegerValueField(.mouseEventClickState, value: Int64(index))
				event.post(tap: .cghidEventTap)
				settle()
			}
		}
	}

	static func scroll(
		at point: CGPoint,
		direction: ScrollDirection,
		amount: Double,
		cancellation: Cancellation.Token
	) throws {
		let source = source()
		if let move = CGEvent(
			mouseEventSource: source,
			mouseType: .mouseMoved,
			mouseCursorPosition: point,
			mouseButton: .left
		) {
			move.post(tap: .cghidEventTap)
		}
		settle()

		// Scroll wheel deltas are signed: positive is up and left in Quartz's convention.
		let ticks = max(1, Int(abs(amount).rounded()))
		let magnitude = 3
		let (vertical, horizontal): (Int32, Int32)
		switch direction {
		case .up: (vertical, horizontal) = (Int32(magnitude), 0)
		case .down: (vertical, horizontal) = (Int32(-magnitude), 0)
		case .left: (vertical, horizontal) = (0, Int32(magnitude))
		case .right: (vertical, horizontal) = (0, Int32(-magnitude))
		}

		for _ in 0..<ticks {
			try cancellation.check()
			guard let event = CGEvent(
				scrollWheelEvent2Source: source,
				units: .line,
				wheelCount: 2,
				wheel1: vertical,
				wheel2: horizontal,
				wheel3: 0
			) else {
				throw HelperError(.internalError, "could not create a scroll event")
			}
			event.location = point
			event.post(tap: .cghidEventTap)
			settle()
		}
	}

	private static func eventTypes(
		for button: MouseButton
	) -> (CGEventType, CGEventType, CGMouseButton) {
		switch button {
		case .left: return (.leftMouseDown, .leftMouseUp, .left)
		case .right: return (.rightMouseDown, .rightMouseUp, .right)
		case .middle: return (.otherMouseDown, .otherMouseUp, .center)
		}
	}

	private static func dragType(for button: MouseButton) -> CGEventType {
		switch button {
		case .left: return .leftMouseDragged
		case .right: return .rightMouseDragged
		case .middle: return .otherMouseDragged
		}
	}

	/// Moves the pointer without pressing anything, and optionally waits there.
	///
	/// The wait is the useful part. Hover-triggered UI — a menu bar opening, a disclosure control, a
	/// tooltip carrying text the model needs — appears on its own delay, so returning the instant the
	/// pointer lands means the next screenshot shows the state *before* whatever the hover revealed.
	static func mouseMove(to point: CGPoint, settleSeconds: TimeInterval, cancellation: Cancellation.Token) throws {
		guard let move = CGEvent(
			mouseEventSource: source(),
			mouseType: .mouseMoved,
			mouseCursorPosition: point,
			mouseButton: .left
		) else {
			throw HelperError(.internalError, "could not create a mouse-move event")
		}
		move.post(tap: .cghidEventTap)
		guard settleSeconds > 0 else { return }
		// Slept in slices so a cancel lands during the hover rather than after it.
		let slice: TimeInterval = 0.05
		var waited: TimeInterval = 0
		while waited < settleSeconds {
			try cancellation.check()
			Thread.sleep(forTimeInterval: min(slice, settleSeconds - waited))
			waited += slice
		}
	}

	/// Presses at `from`, moves to `to` while held, and releases.
	///
	/// The movement is delivered as interpolated steps rather than one jump, and that is load-bearing
	/// rather than cosmetic: a great deal of software samples pointer position on a timer and decides
	/// "this is a drag" only after observing intermediate positions. A single teleport from `from` to
	/// `to` is commonly seen as a click at one end and nothing else — which looks, from the outside,
	/// exactly like the drag silently not working.
	static func drag(
		from: CGPoint,
		to: CGPoint,
		button: MouseButton,
		flags: CGEventFlags,
		durationSeconds: TimeInterval,
		cancellation: Cancellation.Token
	) throws {
		let source = source()
		let (down, up, cgButton) = eventTypes(for: button)
		let dragged = dragType(for: button)

		func post(_ type: CGEventType, _ point: CGPoint) throws {
			guard let event = CGEvent(
				mouseEventSource: source,
				mouseType: type,
				mouseCursorPosition: point,
				mouseButton: cgButton
			) else {
				throw HelperError(.internalError, "could not create a drag event")
			}
			event.flags = flags
			event.post(tap: .cghidEventTap)
		}

		// Hover first, for the same reason `click` does: some toolkits ignore a press that arrives with
		// no preceding move.
		try post(.mouseMoved, from)
		settle()
		try post(down, from)
		settle()

		// One step per event gap, so the glide takes about the requested wall-clock time. Bounded at both
		// ends: too few steps and the drag is not recognised, too many and a long drag becomes a hang.
		let steps = max(8, min(120, Int(durationSeconds / eventGap)))
		for index in 1...steps {
			try cancellation.check()
			let progress = Double(index) / Double(steps)
			try post(dragged, CGPoint(
				x: from.x + (to.x - from.x) * progress,
				y: from.y + (to.y - from.y) * progress
			))
			settle()
		}

		// Land exactly on the target before releasing; interpolation can leave a sub-pixel gap, and a
		// release one pixel off the drop zone is a drag that visibly did nothing.
		try post(dragged, to)
		settle()
		try post(up, to)
		settle()
	}

	// ---------------------------------------------------------------------------------------------
	// Keyboard
	// ---------------------------------------------------------------------------------------------

	/// Types literal text as Unicode, so the result does not depend on the user's keyboard layout.
	static func type(text: String, cancellation: Cancellation.Token) throws {
		guard !text.isEmpty else { return }
		let source = source()
		var chunk: [UniChar] = []
		chunk.reserveCapacity(typeChunkSize)

		func flush() throws {
			guard !chunk.isEmpty else { return }
			try cancellation.check()
			for keyDown in [true, false] {
				guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: keyDown) else {
					throw HelperError(.internalError, "could not create a keyboard event")
				}
				event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
				event.post(tap: .cghidEventTap)
				settle()
			}
			chunk.removeAll(keepingCapacity: true)
		}

		for unit in Array(text.utf16) {
			// Newlines are sent as Return rather than as a literal character: a text view given U+000A
			// as a Unicode payload usually inserts nothing, and the visible effect of typing a newline is
			// what the caller asked for.
			if unit == 0x0A || unit == 0x0D {
				try flush()
				try key(keyCode: 36, flags: [], cancellation: cancellation)
				continue
			}
			chunk.append(unit)
			if chunk.count >= typeChunkSize {
				try flush()
			}
		}
		try flush()
	}

	static func key(keyCode: CGKeyCode, flags: CGEventFlags, cancellation: Cancellation.Token) throws {
		try cancellation.check()
		let source = source()
		for keyDown in [true, false] {
			guard let event = CGEvent(
				keyboardEventSource: source,
				virtualKey: keyCode,
				keyDown: keyDown
			) else {
				throw HelperError(.internalError, "could not create a keyboard event")
			}
			event.flags = flags
			event.post(tap: .cghidEventTap)
			settle()
		}
	}

	static func cursorPosition() -> CGPoint {
		// CGEvent with a nil source reports the current pointer location in Quartz points, which keeps
		// this callable off the main thread unlike NSEvent.mouseLocation.
		CGEvent(source: nil)?.location ?? .zero
	}
}
