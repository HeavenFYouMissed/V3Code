/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import ApplicationServices
import CoreGraphics
import Foundation

/// Thin, non-throwing wrappers over the C Accessibility API.
///
/// Every accessor returns an optional instead of an `AXError`: a missing attribute is the normal case
/// for most elements, not an exceptional one, and threading `AXError` through the tree walk would
/// swamp it. The two errors that *do* matter — a dead element and a timeout — are surfaced explicitly
/// by `checkAlive`.
enum Ax {
	/// How long a single AX round-trip may block before it is abandoned.
	///
	/// An unresponsive target application would otherwise hang the helper's work queue indefinitely and
	/// present to the user as a frozen agent. Two seconds is long enough for a busy app and short
	/// enough that the service's own per-method budget is the thing that fires first.
	static let messagingTimeout: Float = 2.0

	static func isProcessTrusted() -> Bool {
		// Explicitly do not prompt: the helper is a stdio child with no UI, and a prompt raised from
		// here appears to come from nowhere. The service owns the moment the user is asked.
		let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary
		return AXIsProcessTrustedWithOptions(options)
	}

	/// An application element with the messaging timeout already applied.
	static func application(pid: pid_t) -> AXUIElement {
		let element = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(element, messagingTimeout)
		return element
	}

	static func systemWide() -> AXUIElement {
		let element = AXUIElementCreateSystemWide()
		AXUIElementSetMessagingTimeout(element, messagingTimeout)
		return element
	}

	/// The element that currently holds keyboard focus, anywhere on the system.
	///
	/// This is what makes untargeted typing an accessibility operation rather than a synthesized one:
	/// without it, `type` with no `ref` had nothing to aim at and went straight to fake keystrokes,
	/// which move the real cursor, lose focus races, and get rewritten by the target application's
	/// text substitutions.
	static func systemWideFocusedElement() -> AXUIElement? {
		guard let value = copyAttribute(systemWide(), kAXFocusedUIElementAttribute as String) else {
			return nil
		}
		guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
			return nil
		}
		return (value as! AXUIElement)
	}

	static func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
		var value: CFTypeRef?
		guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
			return nil
		}
		return value
	}

	/// Copies several attributes in one IPC round-trip.
	///
	/// A tree walk asks every node for role, title, value, enabled, focused, position and size. Done
	/// one at a time that is seven round-trips per node; batched it is one, which is the difference
	/// between a usable and an unusable `axTree` on a large window.
	static func copyMultiple(_ element: AXUIElement, _ attributes: [String]) -> [String: CFTypeRef] {
		var values: CFArray?
		let result = AXUIElementCopyMultipleAttributeValues(
			element,
			attributes as CFArray,
			// No options: missing attributes come back as an AXValue of type illegal, which the typed
			// readers below reject anyway, and stopping on error would lose the attributes that did
			// resolve.
			AXCopyMultipleAttributeOptions(rawValue: 0),
			&values
		)
		guard result == .success,
			let array = values as? [CFTypeRef],
			array.count == attributes.count
		else {
			return [:]
		}
		var pairs: [String: CFTypeRef] = [:]
		for (index, attribute) in attributes.enumerated() {
			pairs[attribute] = array[index]
		}
		return pairs
	}

	static func actions(_ element: AXUIElement) -> [String] {
		var names: CFArray?
		guard AXUIElementCopyActionNames(element, &names) == .success,
			let list = names as? [String]
		else {
			return []
		}
		return list
	}

	static func children(_ element: AXUIElement) -> [AXUIElement] {
		guard let value = copyAttribute(element, kAXChildrenAttribute as String),
			let array = value as? [AXUIElement]
		else {
			return []
		}
		return array
	}

	static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
		var settable: DarwinBoolean = false
		guard AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success else {
			return false
		}
		return settable.boolValue
	}

	static func perform(_ element: AXUIElement, _ action: String) -> AXError {
		AXUIElementPerformAction(element, action as CFString)
	}

	static func setValue(_ element: AXUIElement, _ attribute: String, _ value: CFTypeRef) -> AXError {
		AXUIElementSetAttributeValue(element, attribute as CFString, value)
	}

	static func pid(of element: AXUIElement) -> pid_t? {
		var pid: pid_t = 0
		guard AXUIElementGetPid(element, &pid) == .success else { return nil }
		return pid
	}

	/// Whether the element still refers to something live.
	///
	/// A ref can outlive its element — the window closed, the app quit, the view was recycled. Acting on
	/// such an element is the failure mode the whole ref-generation scheme exists to prevent, so this is
	/// checked before every dispatch rather than only at mint time.
	static func checkAlive(_ element: AXUIElement) -> AXError {
		var value: CFTypeRef?
		return AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value)
	}

	// ---------------------------------------------------------------------------------------------
	// Identity
	// ---------------------------------------------------------------------------------------------

	/// Attributes that together decide an element's identity fingerprint.
	private static let identityAttributes: [String] = [
		kAXRoleAttribute as String,
		kAXTitleAttribute as String,
		kAXDescriptionAttribute as String,
		kAXValueAttribute as String,
	]

	/// The `(role, label)` pair a stable ref is bound to, read fresh from the element.
	///
	/// Shares `label(from:role:)` with the tree walk rather than reimplementing the preference order,
	/// because a ref minted from one rule and re-validated against another would go stale the instant
	/// the two disagreed — which is a bug that would look exactly like a flaky application.
	static func identity(of element: AXUIElement) -> (role: String, label: String?)? {
		let attributes = copyMultiple(element, identityAttributes)
		guard let rawRole = string(attributes[kAXRoleAttribute as String]) else {
			return nil
		}
		return (rawRole, label(from: attributes, role: rawRole))
	}

	/// Best available human-readable name, in the order a screen reader would prefer.
	static func label(from attributes: [String: CFTypeRef], role: String) -> String? {
		if let title = string(attributes[kAXTitleAttribute as String]) {
			return title
		}
		if let description = string(attributes[kAXDescriptionAttribute as String]) {
			return description
		}
		// Static text carries its visible text in the value, not the title. Other roles deliberately do
		// not fall back to value, because for a text field the value is the user's content, and copying
		// it into `label` would make the label change as the model types — and, now that refs are bound
		// to the label, would re-mint the ref on every keystroke.
		if role == kAXStaticTextRole as String {
			return string(attributes[kAXValueAttribute as String])
		}
		return nil
	}

	// ---------------------------------------------------------------------------------------------
	// Typed readers
	// ---------------------------------------------------------------------------------------------

	static func string(_ value: CFTypeRef?) -> String? {
		guard let value else { return nil }
		if CFGetTypeID(value) == CFStringGetTypeID() {
			let string = value as! CFString as String
			return string.isEmpty ? nil : string
		}
		if CFGetTypeID(value) == CFNumberGetTypeID() {
			return (value as! NSNumber).stringValue
		}
		if CFGetTypeID(value) == CFBooleanGetTypeID() {
			return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false"
		}
		if CFGetTypeID(value) == AXUIElementGetTypeID() {
			// A value that is itself an element (a slider's linked label, say) has no useful string form.
			return nil
		}
		if CFGetTypeID(value) == AXValueGetTypeID() {
			return string(fromAXValue: value as! AXValue)
		}
		return nil
	}

	static func bool(_ value: CFTypeRef?) -> Bool? {
		guard let value, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
		return CFBooleanGetValue((value as! CFBoolean))
	}

	/// Element bounds in Quartz points, from a batched position and size pair.
	static func rect(position: CFTypeRef?, size: CFTypeRef?) -> CGRect? {
		guard let position, let size,
			CFGetTypeID(position) == AXValueGetTypeID(),
			CFGetTypeID(size) == AXValueGetTypeID()
		else {
			return nil
		}
		var origin = CGPoint.zero
		var extent = CGSize.zero
		guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
			AXValueGetValue(size as! AXValue, .cgSize, &extent)
		else {
			return nil
		}
		return CGRect(origin: origin, size: extent)
	}

	private static func string(fromAXValue value: AXValue) -> String? {
		switch AXValueGetType(value) {
		case .cgPoint:
			var point = CGPoint.zero
			guard AXValueGetValue(value, .cgPoint, &point) else { return nil }
			return "\(point.x),\(point.y)"
		case .cgSize:
			var size = CGSize.zero
			guard AXValueGetValue(value, .cgSize, &size) else { return nil }
			return "\(size.width)x\(size.height)"
		case .cfRange:
			var range = CFRange()
			guard AXValueGetValue(value, .cfRange, &range) else { return nil }
			return "\(range.location)+\(range.length)"
		default:
			return nil
		}
	}

	// ---------------------------------------------------------------------------------------------
	// Naming
	// ---------------------------------------------------------------------------------------------

	/// `AXButton` to `button`, `AXTextField` to `textField`, `AXPress` to `press`.
	///
	/// Roles and action names share this normalizer because they share the convention. Doing it
	/// mechanically rather than through a lookup table means a role Apple adds tomorrow still arrives
	/// in the documented shape instead of leaking `AXWhatever` onto the wire.
	static func normalizeName(_ raw: String) -> String {
		var name = raw
		if name.hasPrefix("AX") {
			name.removeFirst(2)
		}
		guard let first = name.first else { return raw }
		// Runs of capitals are a real occurrence in AX names (`AXURL`, `AXRTF`); lower-casing only the
		// first character would leave `uRL`, so a leading run is lower-cased whole.
		if first.isUppercase, name.count > 1 {
			let characters = Array(name)
			if characters[1].isUppercase {
				var prefixLength = 0
				while prefixLength < characters.count, characters[prefixLength].isUppercase {
					prefixLength += 1
				}
				// Keep the last capital with the following word: `URLValue` becomes `urlValue`.
				if prefixLength < characters.count {
					prefixLength -= 1
				}
				return String(characters[0..<prefixLength]).lowercased()
					+ String(characters[prefixLength...])
			}
		}
		return first.lowercased() + String(name.dropFirst())
	}
}

/// Maps an `AXError` onto the wire's error codes.
func helperError(from error: AXError, context: String) -> HelperError {
	switch error {
	case .success:
		return HelperError(.internalError, "\(context): reported success on a failure path")
	case .apiDisabled, .notImplemented:
		return HelperError(
			.accessibilityNotTrusted,
			"\(context): the Accessibility API is unavailable for this process"
		)
	case .invalidUIElement, .invalidUIElementObserver:
		return HelperError(
			.refStale,
			"\(context): the element no longer exists — re-read the screen"
		)
	case .cannotComplete:
		return HelperError(
			.timeout,
			"\(context): the application did not respond in time",
			retryable: true
		)
	case .attributeUnsupported, .actionUnsupported, .noValue:
		return HelperError(.targetNotFound, "\(context): the element does not support that operation")
	case .notEnoughPrecision, .illegalArgument:
		return HelperError(.internalError, "\(context): illegal argument")
	default:
		return HelperError(.internalError, "\(context): AXError \(error.rawValue)")
	}
}
