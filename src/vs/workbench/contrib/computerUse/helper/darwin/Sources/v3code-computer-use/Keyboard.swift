/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import CoreGraphics
import Foundation

/// Chord parsing and virtual key codes.
///
/// The codes are the ANSI positional constants from `Carbon/Events.h`, reproduced here rather than
/// imported so the helper does not link Carbon. They are positional, not character-based: `keyCode 12`
/// is the key labelled Q on a US layout and A on AZERTY. That is the right behaviour for chords, which
/// are described by their US names throughout V3Code, and it is why literal text is typed as Unicode
/// (see `Synthesizer.type`) rather than by looking up key codes per character.
enum Keyboard {
	struct Chord {
		let keyCode: CGKeyCode
		let flags: CGEventFlags
	}

	static func flags(for modifiers: [Modifier]) -> CGEventFlags {
		var flags: CGEventFlags = []
		for modifier in modifiers {
			switch modifier {
			case .shift: flags.insert(.maskShift)
			case .control: flags.insert(.maskControl)
			case .alt: flags.insert(.maskAlternate)
			case .meta: flags.insert(.maskCommand)
			}
		}
		return flags
	}

	/// Parses `cmd+shift+p`. Case-insensitive; the final segment is the key.
	static func parse(chord: String) throws -> Chord {
		let segments = chord
			.split(separator: "+", omittingEmptySubsequences: true)
			.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
			.filter { !$0.isEmpty }

		guard let keyName = segments.last else {
			throw HelperError(.internalError, "empty key chord")
		}

		var flags: CGEventFlags = []
		for modifier in segments.dropLast() {
			guard let flag = modifierFlag(named: modifier) else {
				throw HelperError(.internalError, "unknown modifier '\(modifier)' in chord '\(chord)'")
			}
			flags.insert(flag)
		}

		guard let keyCode = keyCode(named: keyName) else {
			throw HelperError(.internalError, "unknown key '\(keyName)' in chord '\(chord)'")
		}
		return Chord(keyCode: keyCode, flags: flags)
	}

	private static func modifierFlag(named name: String) -> CGEventFlags? {
		switch name {
		case "cmd", "command", "meta", "super", "win": return .maskCommand
		case "ctrl", "control": return .maskControl
		case "alt", "option", "opt": return .maskAlternate
		case "shift": return .maskShift
		case "fn", "function": return .maskSecondaryFn
		default: return nil
		}
	}

	private static let named: [String: CGKeyCode] = [
		"return": 36, "enter": 36, "\n": 36,
		"tab": 48,
		"space": 49, "spacebar": 49, " ": 49,
		"delete": 51, "backspace": 51,
		"forwarddelete": 117, "del": 117,
		"escape": 53, "esc": 53,
		"left": 123, "arrowleft": 123,
		"right": 124, "arrowright": 124,
		"down": 125, "arrowdown": 125,
		"up": 126, "arrowup": 126,
		"home": 115,
		"end": 119,
		"pageup": 116, "pgup": 116,
		"pagedown": 121, "pgdn": 121,
		"help": 114, "insert": 114,
		"keypadenter": 76,
		"capslock": 57,
		"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
		"f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
		"f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
	]

	private static let printable: [Character: CGKeyCode] = [
		"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
		"b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
		"1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
		"=": 24, "-": 27, "]": 30, "[": 33, "\\": 42,
		"o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
		"'": 39, ";": 41, ",": 43, "/": 44, ".": 47, "`": 50,
		"n": 45, "m": 46,
	]

	private static func keyCode(named name: String) -> CGKeyCode? {
		if let code = named[name] {
			return code
		}
		if name.count == 1, let code = printable[Character(name)] {
			return code
		}
		return nil
	}
}
