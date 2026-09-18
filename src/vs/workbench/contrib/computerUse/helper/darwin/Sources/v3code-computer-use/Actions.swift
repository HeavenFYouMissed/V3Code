/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import ApplicationServices
import CoreGraphics
import Foundation

/// Input dispatch: accessibility first, synthesis only when the element offers nothing usable.
///
/// The accessibility path is preferred for a reason beyond tidiness. `AXUIElementPerformAction` names
/// the element it acts on, so the action either reaches that element or fails; a synthesized click names
/// a coordinate, and whatever moved into that coordinate in the intervening milliseconds receives it
/// instead. Every method here therefore tries to name the element, and reports honestly which path ran.
struct Actions {
	private let refTable: RefTable
	private let cancellation: Cancellation.Token
	private let displays: [Geometry.DisplayInfo]

	init(refTable: RefTable, cancellation: Cancellation.Token) {
		self.refTable = refTable
		self.cancellation = cancellation
		self.displays = Geometry.displays()
	}

	/// A target resolved to whatever the platform can offer for it.
	struct Resolved {
		let entry: RefTable.Entry?
		/// Where to aim a synthesized event, in Quartz points.
		let point: CGPoint
	}

	// ---------------------------------------------------------------------------------------------
	// Resolution
	// ---------------------------------------------------------------------------------------------

	/// Resolves a target, and returns the pid whose tier governs the action.
	///
	/// A `ref` target is governed by the tier of the app that owns the element, not by the frontmost app:
	/// acting on a background window of a terminal must be refused even while a permitted app is in front.
	func resolve(_ target: Target) throws -> (resolved: Resolved, pid: pid_t?) {
		switch target {
		case .ref(let ref):
			let entry = try refTable.resolve(ref)
			guard let frame = Ax.rect(
				position: Ax.copyAttribute(entry.element, kAXPositionAttribute as String),
				size: Ax.copyAttribute(entry.element, kAXSizeAttribute as String)
			) else {
				// No frame means synthesis has nowhere to aim. The accessibility path may still work, so
				// this is not fatal; a zero point is only ever used if a fallback is attempted, and
				// `dispatchSynthesized` rejects it.
				return (Resolved(entry: entry, point: .zero), entry.pid)
			}
			return (Resolved(entry: entry, point: CGPoint(x: frame.midX, y: frame.midY)), entry.pid)

		case .point(let x, let y):
			// Point coordinates arrive as global physical pixels: the service converts image pixels with
			// computerUseCoordinates.imagePointToPhysical, which also adds the display origin, before
			// writing the request. The helper cannot do that conversion itself because it does not know
			// which capture the model was looking at.
			let physical = CGPoint(x: x, y: y)
			let inPoints = Geometry.points(fromPhysicalPoint: physical, displays: displays)
			guard Geometry.display(containingPoint: inPoints, in: displays) != nil else {
				throw HelperError(
					.targetNotFound,
					"point (\(x), \(y)) in physical pixels is not on any display"
				)
			}
			// A hit test gives the accessibility path a chance even for a coordinate target, which turns a
			// blind click into a named one whenever the surface under the point is accessible at all.
			let entry = hitTest(at: inPoints)
			return (Resolved(entry: entry, point: inPoints), entry?.pid)
		}
	}

	/// The element under a screen point, minted into the current generation.
	private func hitTest(at point: CGPoint) -> RefTable.Entry? {
		guard Ax.isProcessTrusted() else { return nil }
		var element: AXUIElement?
		guard AXUIElementCopyElementAtPosition(
			Ax.systemWide(),
			Float(point.x),
			Float(point.y),
			&element
		) == .success,
			let element,
			let pid = Ax.pid(of: element)
		else {
			return nil
		}
		let actions = Ax.actions(element)
		// Minted without advancing the snapshot sequence: a hit test is not a screen read, so it must
		// neither renumber generations nor age out the refs the caller already holds. An element the
		// caller has already seen hands back the very same ref, because the table keys on identity.
		guard let identity = Ax.identity(of: element) else { return nil }
		let ref = refTable.mint(
			element: element,
			pid: pid,
			role: identity.role,
			label: identity.label,
			actions: actions
		)
		return try? refTable.resolve(ref)
	}

	// ---------------------------------------------------------------------------------------------
	// click
	// ---------------------------------------------------------------------------------------------

	func click(_ params: ClickParams, resolved: Resolved) throws -> DispatchMethod {
		indicate("Clicking", resolved: resolved)
		let button = params.button ?? .left
		let modifiers = params.modifiers ?? []
		let clickCount = max(1, params.clickCount ?? 1)

		if let entry = resolved.entry,
			let action = accessibleClickAction(
				for: entry,
				button: button,
				modifiers: modifiers,
				clickCount: clickCount
			) {
			try cancellation.check()
			let result = Ax.perform(entry.element, action)
			if result == .success {
				return .accessibility
			}
			// A refused action is not a reason to give up — some elements advertise AXPress and then
			// decline it — but a dead element is, because synthesis would aim at a stale frame.
			if result == .invalidUIElement {
				throw helperError(from: result, context: "pressing the target element")
			}
			Log.warn("AX action \(action) failed with \(result.rawValue); falling back to synthesis")
		}

		// A plain left click on something that takes keyboard focus — a text field, a text area — is
		// almost always "put the caret here so I can type". Setting AXFocused does that without moving
		// the user's pointer, which is the whole difference between the agent quietly driving an
		// application and the agent visibly taking the mouse away. Deliberately narrow: it is only
		// equivalent to a click for focusable elements, and only for an unmodified single left click.
		if button == .left, clickCount == 1, modifiers.isEmpty,
			let entry = resolved.entry,
			Ax.isSettable(entry.element, kAXFocusedAttribute as String) {
			try cancellation.check()
			if Ax.setValue(entry.element, kAXFocusedAttribute as String, kCFBooleanTrue) == .success {
				return .accessibility
			}
			Log.warn("AXFocused set failed; falling back to synthesis")
		}

		try dispatchSynthesized(resolved) { point in
			try Synthesizer.click(
				at: point,
				button: button,
				flags: Keyboard.flags(for: modifiers),
				clickCount: clickCount,
				cancellation: cancellation
			)
		}
		return .synthesized
	}

	/// Draws the on-screen indicator for one action.
	///
	/// Delegates to `Overlay.announce`, which resolves the frame and falls back sensibly when the verb
	/// carries no target. The previous version returned early on a nil target, which silently disabled
	/// the indicator for `computer_type` — a tool that takes no target parameter at all, so it could
	/// never draw.
	private func indicate(_ verb: String, resolved: Resolved?) {
		Overlay.announce(verb, element: resolved?.entry?.element, point: resolved?.point)
	}

	/// The AX action that faithfully reproduces a click, or nil when none does.
	///
	/// Deliberately conservative. `AXPress` conveys no modifiers, no button and no click count, so it is
	/// only equivalent to a plain single left click; using it for a cmd-click or a double-click would
	/// silently perform a different action than the one requested, which is worse than falling back.
	private func accessibleClickAction(
		for entry: RefTable.Entry,
		button: MouseButton,
		modifiers: [Modifier],
		clickCount: Int
	) -> String? {
		if button == .right, entry.actions.contains(kAXShowMenuAction as String) {
			return kAXShowMenuAction as String
		}
		guard button == .left, clickCount == 1, modifiers.isEmpty else {
			return nil
		}
		// Only AXPress. AXConfirm is tempting but means "commit this field", which for a text field is a
		// Return keypress — a different and occasionally destructive action.
		return entry.actions.contains(kAXPressAction as String) ? kAXPressAction as String : nil
	}

	// ---------------------------------------------------------------------------------------------
	// type
	// ---------------------------------------------------------------------------------------------

	/// Inserts text into one element through the accessibility API.
	///
	/// Two attributes, in this order, and the order is the point:
	///
	/// `kAXSelectedText` replaces the current selection — or inserts at the caret when nothing is
	/// selected — which is exactly what typing does. `kAXValue` replaces the element's *entire*
	/// contents, so using it on a field that already has text silently destroys that text. The first
	/// version of this reached for `kAXValue` alone, which is why it only ever worked on empty fields.
	private func insertText(_ text: String, into element: AXUIElement) -> AXError? {
		// Focus first so the application's own change notifications fire against a focused field, the
		// way they would for a real edit. A failure here is not fatal: many fields accept a value set
		// without being focusable.
		_ = Ax.setValue(element, kAXFocusedAttribute as String, kCFBooleanTrue)

		if Ax.isSettable(element, kAXSelectedTextAttribute as String) {
			let before = Ax.string(Ax.copyAttribute(element, kAXValueAttribute as String))
			let result = Ax.setValue(element, kAXSelectedTextAttribute as String, text as CFString)
			if result == .invalidUIElement {
				return result
			}
			if result == .success {
				// Success from the API is not evidence the text arrived. A web `contenteditable` accepts
				// the write and reports success while the page's own framework never sees an input event,
				// so the DOM is unchanged — observed on Gemini's prompt box, which swallowed 315
				// characters and still displayed its placeholder. The tool then told the model it had
				// typed, which is worse than failing: it reports a result rather than a dispatch.
				//
				// So confirm, and treat "no observable change" as a failure worth falling back from.
				if Self.landed(text, in: element, before: before) {
					return .success
				}
				Log.warn("AXSelectedText reported success but the value did not change; falling back")
			} else {
				Log.warn("AXSelectedText set failed with \(result.rawValue); trying AXValue")
			}
		}

		// Only safe when the field is empty, since this replaces everything. A field with existing
		// content falls through to synthesis rather than having that content silently destroyed.
		if Ax.isSettable(element, kAXValueAttribute as String) {
			let existing = Ax.string(Ax.copyAttribute(element, kAXValueAttribute as String)) ?? ""
			if existing.isEmpty {
				let result = Ax.setValue(element, kAXValueAttribute as String, text as CFString)
				if result != .success || Self.landed(text, in: element, before: existing) {
					return result
				}
				Log.warn("AXValue reported success but the value did not change; falling back")
				return nil
			}
			Log.warn("AXValue would overwrite \(existing.count) existing characters; falling back to synthesis")
		}
		return nil
	}

	/// Whether text actually appeared in the element after a write.
	///
	/// Deliberately lenient: some fields normalize, trim, or reformat what they are given, so this asks
	/// only whether the value *changed* and now contains a recognizable piece of what was sent. A strict
	/// equality check would send perfectly good writes down the synthesis path.
	private static func landed(_ text: String, in element: AXUIElement, before: String?) -> Bool {
		let after = Ax.string(Ax.copyAttribute(element, kAXValueAttribute as String))
		// No readable value at all: nothing to disprove, so believe the API rather than typing twice.
		guard let after else { return true }
		if after != (before ?? "") { return true }
		let probe = String(text.prefix(12))
		return !probe.isEmpty && after.contains(probe)
	}

	func type(_ params: TypeParams, resolved: Resolved?) throws -> DispatchMethod {
		indicate("Typing into", resolved: resolved)
		// A named target first, then whatever holds keyboard focus. The second case is the common one —
		// the model clicks a field and then types with no ref — and before this it went straight to
		// synthesis, which is what moved the user's cursor and let the target application rewrite the
		// text on its way in.
		let target = resolved?.entry?.element ?? Ax.systemWideFocusedElement()
		if let target {
			try cancellation.check()
			if let result = insertText(params.text, into: target) {
				if result == .success {
					return .accessibility
				}
				if result == .invalidUIElement {
					throw helperError(from: result, context: "setting the target's value")
				}
				Log.warn("AX text insertion failed with \(result.rawValue); falling back to synthesis")
			}
		}

		// With a target that could not take a value directly, click it first so the keystrokes land in it
		// rather than in whatever happened to be focused. Skipped rather than failed when the target has
		// no on-screen position: typing into the existing focus is still closer to the request than
		// refusing outright, and the caller named a target it could not aim at.
		if let resolved, Geometry.display(containingPoint: resolved.point, in: displays) != nil {
			try Synthesizer.click(
				at: resolved.point,
				button: .left,
				flags: [],
				clickCount: 1,
				cancellation: cancellation
			)
		}
		try Synthesizer.type(text: params.text, cancellation: cancellation)
		return .synthesized
	}

	// ---------------------------------------------------------------------------------------------
	// key
	// ---------------------------------------------------------------------------------------------

	/// Always `synthesized`: a key chord has no accessibility equivalent.
	///
	/// Reported honestly rather than as `accessibility` even though no fallback occurred, because the
	/// service uses the method to measure how much blind input is being injected, and a chord is blind
	/// input by construction — it goes to whatever holds focus.
	func key(_ params: KeyParams) throws -> DispatchMethod {
		// No target and no pointer movement: falls back to the focused element, which is where the
		// keystroke is about to land.
		indicate("Pressing \(params.chord) in", resolved: nil)
		let chord = try Keyboard.parse(chord: params.chord)
		let repeats = max(1, params.repeatCount ?? 1)
		for _ in 0..<repeats {
			try Synthesizer.key(
				keyCode: chord.keyCode,
				flags: chord.flags,
				cancellation: cancellation
			)
		}
		return .synthesized
	}

	// ---------------------------------------------------------------------------------------------
	// scroll
	// ---------------------------------------------------------------------------------------------

	func scroll(_ params: ScrollParams, resolved: Resolved) throws -> DispatchMethod {
		indicate("Scrolling", resolved: resolved)
		let ticks = max(1, Int(abs(params.amount).rounded()))

		// Steppers, sliders and scroll bars expose their movement as increment and decrement actions,
		// which move the exact control the caller named instead of whatever the pointer is over.
		if let entry = resolved.entry,
			let action = incrementAction(for: entry, direction: params.direction) {
			var performed = 0
			for _ in 0..<ticks {
				try cancellation.check()
				let result = Ax.perform(entry.element, action)
				if result != .success {
					if result == .invalidUIElement {
						throw helperError(from: result, context: "scrolling the target element")
					}
					break
				}
				performed += 1
			}
			if performed == ticks {
				return .accessibility
			}
			Log.warn("AX \(action) completed \(performed)/\(ticks) ticks; falling back to synthesis")
		}

		try dispatchSynthesized(resolved) { point in
			try Synthesizer.scroll(
				at: point,
				direction: params.direction,
				amount: params.amount,
				cancellation: cancellation
			)
		}
		return .synthesized
	}

	private func incrementAction(for entry: RefTable.Entry, direction: ScrollDirection) -> String? {
		switch direction {
		case .up, .left:
			return entry.actions.contains(kAXIncrementAction as String)
				? kAXIncrementAction as String
				: nil
		case .down, .right:
			return entry.actions.contains(kAXDecrementAction as String)
				? kAXDecrementAction as String
				: nil
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Shared fallback plumbing
	// ---------------------------------------------------------------------------------------------

	/// Runs a synthesis closure against a resolved target's point, refusing to guess at a location.
	///
	/// An element with no frame yields `.zero`, which is a real screen coordinate — the top-left corner —
	/// so posting there would click the Apple menu instead of failing. That is exactly the class of
	/// silent mis-action this helper must not commit.
	private func dispatchSynthesized(
		_ resolved: Resolved,
		_ body: (CGPoint) throws -> Void
	) throws {
		let point = resolved.point
		guard Geometry.display(containingPoint: point, in: displays) != nil else {
			throw HelperError(
				.targetNotFound,
				"the target has no on-screen position, so it cannot receive a synthesized event"
			)
		}
		try body(point)
	}
}
