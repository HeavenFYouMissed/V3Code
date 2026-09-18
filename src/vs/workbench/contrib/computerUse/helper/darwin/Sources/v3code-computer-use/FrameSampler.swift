/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import CoreGraphics
import Foundation

/// Digests of what an application's windows currently look like, for change detection only.
///
/// **No pixels ever leave this file.** A sample is composited, reduced to a tile grid, digested to a
/// 64-bit number, and released before the function returns. Nothing is encoded, retained, or written
/// anywhere. That is not tidiness: `settle` and ambient observation both need to know *whether* the
/// screen changed, neither has any use for the image, and an image that is never kept cannot leak.
///
/// **Why frame comparison exists at all.** Notification quiescence misses the exact case `settle` was
/// built for. A layer-backed Core Animation transition — the sheet sliding down, the popover scaling
/// in — updates no accessibility geometry and fires no notification, so an application can be visually
/// mid-animation and accessibility-silent. Only looking at the screen catches that.
///
/// **Why the preflight gate is load-bearing.** Without Screen Recording permission, macOS does not
/// fail these calls; it returns a frame containing the desktop picture and nothing else. Two such
/// frames are identical, so an ungated frame comparison would report rock-solid stability for an
/// application in the middle of an animation — a confident wrong answer, which is worse than no
/// answer. `isAvailable` therefore refuses up front and the callers degrade to notifications only.
enum FrameSampler {
	/// Side of the square tile grid a frame is reduced to before digesting.
	///
	/// 32x32 is coarse on purpose. A blinking text caret, an antialiasing difference, or a one-pixel
	/// focus ring must not read as motion, or `settle` would never settle inside a text field. Anything
	/// large enough to matter to a click — a sheet sliding, a menu unrolling, a list scrolling — moves
	/// far more than a thirty-second of the window.
	static let tileSide = 32

	/// Whether frame comparison can be trusted right now. See the type comment.
	static var isAvailable: Bool {
		CGPreflightScreenCaptureAccess()
	}

	/// A digest of every on-screen window owned by a process, or nil when there is nothing to compare.
	///
	/// Nil rather than a sentinel value for "no windows": a process with no windows on screen is not
	/// stable-looking, it is unobservable, and the callers must treat the two differently.
	static func fingerprint(pid: pid_t) -> UInt64? {
		guard isAvailable else { return nil }
		guard let windows = onScreenWindows(pid: pid), !windows.ids.isEmpty else { return nil }

		// The bounds are folded into the digest as well as being the capture rectangle, so a window that
		// moves without repainting still counts as a change.
		var hash = Hash.combine(Hash.seed, windows.bounds)
		hash = Hash.combine(hash, UInt64(windows.ids.count))

		guard let image = composite(windowIds: windows.ids, bounds: windows.bounds) else {
			return nil
		}
		guard let tiles = reduce(image) else {
			return nil
		}
		return Hash.combine(hash, bytes: tiles)
	}

	// ---------------------------------------------------------------------------------------------
	// Window enumeration
	// ---------------------------------------------------------------------------------------------

	/// On-screen window ids owned by a process, with their union bounds in Quartz points.
	private static func onScreenWindows(pid: pid_t) -> (ids: [CGWindowID], bounds: CGRect)? {
		guard let info = CGWindowListCopyWindowInfo(
			[.optionOnScreenOnly, .excludeDesktopElements],
			kCGNullWindowID
		) as? [[String: Any]] else {
			return nil
		}

		var ids: [CGWindowID] = []
		var union = CGRect.null
		for window in info {
			guard let owner = window[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
				let number = window[kCGWindowNumber as String] as? CGWindowID,
				let boundsValue = window[kCGWindowBounds as String] as? [String: Any],
				let bounds = CGRect(dictionaryRepresentation: boundsValue as CFDictionary),
				bounds.width >= 1, bounds.height >= 1
			else {
				continue
			}
			ids.append(number)
			union = union.union(bounds)
		}
		guard !ids.isEmpty, !union.isNull, union.width >= 1, union.height >= 1 else {
			return nil
		}
		return (ids, union)
	}

	/// Composites just this application's windows, so another application's animation is not mistaken
	/// for the target's.
	private static func composite(windowIds: [CGWindowID], bounds: CGRect) -> CGImage? {
		// CGImage(windowListFromArrayScreenBounds:) wants a CFArray of window ids smuggled through
		// pointer slots, which is the documented calling convention. Id 0 is not a real window and would
		// produce a null slot, so it is dropped rather than force-unwrapped.
		var identifiers: [UnsafeRawPointer?] = windowIds.compactMap { UnsafeRawPointer(bitPattern: UInt($0)) }
		guard !identifiers.isEmpty else { return nil }
		let array = identifiers.withUnsafeMutableBufferPointer { buffer in
			CFArrayCreate(nil, buffer.baseAddress, buffer.count, nil)
		}
		guard let array else { return nil }
		// Nominal resolution rather than best: this is a digest, not a screenshot, and sampling a
		// Retina display at 2x would quadruple the cost of something that runs every 50 ms.
		return CGImage(
			windowListFromArrayScreenBounds: bounds,
			windowArray: array,
			imageOption: [.nominalResolution]
		)
	}

	// ---------------------------------------------------------------------------------------------
	// Reduction
	// ---------------------------------------------------------------------------------------------

	/// Draws an image into a `tileSide` square of 8-bit grey and returns those bytes.
	///
	/// Grey rather than colour because a hue shift with identical luminance is not a motion signal worth
	/// the extra three quarters of the bytes, and the reduction is a box filter over the whole tile, so
	/// the result is stable against sub-tile noise.
	private static func reduce(_ image: CGImage) -> [UInt8]? {
		let side = tileSide
		var pixels = [UInt8](repeating: 0, count: side * side)
		let space = CGColorSpaceCreateDeviceGray()
		let drawn: Bool = pixels.withUnsafeMutableBytes { buffer -> Bool in
			guard let base = buffer.baseAddress,
				let context = CGContext(
					data: base,
					width: side,
					height: side,
					bitsPerComponent: 8,
					bytesPerRow: side,
					space: space,
					bitmapInfo: CGImageAlphaInfo.none.rawValue
				)
			else {
				return false
			}
			context.interpolationQuality = .low
			context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
			return true
		}
		return drawn ? pixels : nil
	}
}
