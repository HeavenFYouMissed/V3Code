/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import CoreGraphics
import Foundation

/// Conversions between the three coordinate spaces the helper touches.
///
/// - *Quartz points*: what the Accessibility API reports and what `CGEvent` consumes. Origin at the
///   top-left of the primary display, y increasing downward, units are logical points.
/// - *Physical pixels*: what the wire protocol uses for `ComputerUseRect`, `cursorPosition` and
///   `point` targets. Same origin and orientation as Quartz points, but multiplied by the backing
///   scale factor of the display the coordinate falls on.
/// - *Image pixels*: only ever inside a capture. The helper never receives image pixels — the service
///   converts with computerUseCoordinates before sending, which is why `imagePointToPhysical` on the
///   TS side adds the display origin.
///
/// On a mixed-DPI multi-display setup the physical space is not globally uniform: each display's
/// coordinates are scaled by its own backing factor. That matches how the TS side composes a
/// per-display coordinate space, and it is exact on the single-display and uniform-DPI cases.
enum Geometry {
	/// One display, described in both spaces so a lookup can go either way.
	struct DisplayInfo {
		let displayId: CGDirectDisplayID
		/// Bounds in Quartz points.
		let pointBounds: CGRect
		let scale: CGFloat

		/// Bounds in physical pixels, i.e. `pointBounds` scaled about the global origin.
		var physicalBounds: CGRect {
			CGRect(
				x: pointBounds.origin.x * scale,
				y: pointBounds.origin.y * scale,
				width: pointBounds.width * scale,
				height: pointBounds.height * scale
			)
		}
	}

	/// Every active display, with its backing scale factor.
	///
	/// The scale factor comes from `CGDisplayModeGetPixelWidth / GetWidth` rather than from `NSScreen`
	/// so this stays callable off the main thread; `NSScreen` is main-thread-only.
	static func displays() -> [DisplayInfo] {
		var count: UInt32 = 0
		guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
			return []
		}
		var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
		guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
			return []
		}
		return ids.prefix(Int(count)).map { id in
			DisplayInfo(displayId: id, pointBounds: CGDisplayBounds(id), scale: scaleFactor(of: id))
		}
	}

	/// Pixels per point for a display. Falls back to 1 when the mode cannot be read.
	static func scaleFactor(of displayId: CGDirectDisplayID) -> CGFloat {
		guard let mode = CGDisplayCopyDisplayMode(displayId), mode.width > 0 else {
			return 1
		}
		return CGFloat(mode.pixelWidth) / CGFloat(mode.width)
	}

	static func display(containingPoint point: CGPoint, in all: [DisplayInfo]) -> DisplayInfo? {
		all.first { $0.pointBounds.contains(point) }
	}

	static func display(containingPhysicalPoint point: CGPoint, in all: [DisplayInfo]) -> DisplayInfo? {
		all.first { $0.physicalBounds.contains(point) }
	}

	static func display(withId displayId: CGDirectDisplayID, in all: [DisplayInfo]) -> DisplayInfo? {
		all.first { $0.displayId == displayId }
	}

	/// Quartz points to physical pixels, using the scale of the display the point lands on.
	static func physicalPoint(fromPoints point: CGPoint, displays all: [DisplayInfo]) -> CGPoint {
		let scale = display(containingPoint: point, in: all)?.scale ?? primaryScale(all)
		return CGPoint(x: point.x * scale, y: point.y * scale)
	}

	/// Physical pixels back to Quartz points, for feeding `CGEvent`.
	static func points(fromPhysicalPoint point: CGPoint, displays all: [DisplayInfo]) -> CGPoint {
		let scale = display(containingPhysicalPoint: point, in: all)?.scale ?? primaryScale(all)
		guard scale > 0 else { return point }
		return CGPoint(x: point.x / scale, y: point.y / scale)
	}

	/// Quartz-point rect to a physical-pixel rect, for `ComputerUseAxNode.frame`.
	static func physicalRect(fromPoints rect: CGRect, displays all: [DisplayInfo]) -> Rect {
		let scale = display(containingPoint: rect.origin, in: all)?.scale
			?? display(containingPoint: CGPoint(x: rect.midX, y: rect.midY), in: all)?.scale
			?? primaryScale(all)
		return Rect(
			x: Double(rect.origin.x * scale),
			y: Double(rect.origin.y * scale),
			width: Double(rect.width * scale),
			height: Double(rect.height * scale)
		)
	}

	/// Downscale so the long edge fits `maxLongEdge`, preserving aspect ratio and never upscaling.
	///
	/// Mirrors `computeDownscale` in computerUseCoordinates.ts, including its handling of degenerate
	/// input, so a screenshot's reported `scale` round-trips through the TS conversion helpers.
	static func downscale(
		width: Int,
		height: Int,
		maxLongEdge: Int
	) -> (width: Int, height: Int, scale: Double) {
		guard width > 0, height > 0, maxLongEdge > 0 else {
			return (width, height, 1)
		}
		let longEdge = max(width, height)
		guard longEdge > maxLongEdge else {
			return (width, height, 1)
		}
		let scale = Double(maxLongEdge) / Double(longEdge)
		let scaledWidth = max(1, Int((Double(width) * scale).rounded()))
		let scaledHeight = max(1, Int((Double(height) * scale).rounded()))
		return (scaledWidth, scaledHeight, scale)
	}

	private static func primaryScale(_ all: [DisplayInfo]) -> CGFloat {
		all.first { $0.pointBounds.origin == .zero }?.scale ?? all.first?.scale ?? 1
	}
}
