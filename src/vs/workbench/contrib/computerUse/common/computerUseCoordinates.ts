/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { COMPUTER_USE_DEFAULT_MAX_LONG_EDGE, ComputerUseRect } from './computerUseTypes.js';

/**
 * All coordinate arithmetic for computer use, in one place.
 *
 * Three spaces are in play and conflating any two of them produces clicks that land near — but not
 * on — the target, which is the single most common failure mode in this kind of feature:
 *
 * - **image**: pixels of the (usually downscaled) screenshot the model was shown. The model only
 *   ever speaks this space.
 * - **physical**: real device pixels of the display. The OS input APIs speak this space.
 * - **logical**: OS points, i.e. physical divided by `devicePixelRatio`, further scaled by a
 *   window's zoom factor. Some platform APIs report bounds here.
 *
 * Every function takes an explicit {@link ComputerUseCoordinateSpace} rather than reading globals,
 * so this module stays pure and testable headlessly.
 */

/**
 * The measurements needed to convert between coordinate spaces for one capture.
 *
 * Build this once per screenshot and thread it through; deriving it twice invites drift.
 */
export interface ComputerUseCoordinateSpace {
	/** Width of the screenshot handed to the model, in image pixels. */
	readonly imageWidth: number;
	/** Height of the screenshot handed to the model, in image pixels. */
	readonly imageHeight: number;
	/** Width of the captured display, in physical pixels. */
	readonly physicalWidth: number;
	/** Height of the captured display, in physical pixels. */
	readonly physicalHeight: number;
	/**
	 * Physical pixels per logical point, as reported by the OS (2 on a Retina display).
	 * Defaults to 1 when unknown.
	 */
	readonly devicePixelRatio?: number;
	/**
	 * Window zoom factor, where 1 is unzoomed. Applies on top of `devicePixelRatio` and matters
	 * because V3Code's own zoom setting changes it.
	 */
	readonly zoomFactor?: number;
	/**
	 * Physical origin of the captured display within the virtual desktop. Non-zero on secondary
	 * displays, and required for the result to be usable by a global input API.
	 */
	readonly originX?: number;
	readonly originY?: number;
}

/** A point, tagged with nothing — the space is carried by the function you pass it to. */
export interface ComputerUsePoint {
	readonly x: number;
	readonly y: number;
}

/** Target dimensions produced by {@link computeDownscale}. */
export interface ComputerUseDownscale {
	readonly width: number;
	readonly height: number;
	/**
	 * Image pixels per physical pixel. Always in `(0, 1]` — this never upscales, because
	 * inventing detail wastes vision tokens without adding information.
	 */
	readonly scale: number;
}

/**
 * Picks screenshot dimensions for a capture, bounding the longer edge.
 *
 * Aspect ratio is preserved and the result is never larger than the source. A max edge of 1080 is
 * the default because it is the best accuracy-per-token balance for current vision models; smaller
 * is cheaper but starts to lose small UI text.
 */
export function computeDownscale(
	nativeWidth: number,
	nativeHeight: number,
	maxLongEdge: number = COMPUTER_USE_DEFAULT_MAX_LONG_EDGE,
): ComputerUseDownscale {
	if (nativeWidth <= 0 || nativeHeight <= 0) {
		return { width: 0, height: 0, scale: 1 };
	}
	const longEdge = Math.max(nativeWidth, nativeHeight);
	if (maxLongEdge <= 0 || longEdge <= maxLongEdge) {
		return { width: nativeWidth, height: nativeHeight, scale: 1 };
	}
	const scale = maxLongEdge / longEdge;
	// Round rather than floor so a 1-pixel edge is not lost, but clamp to at least 1 so a very
	// aggressive maxLongEdge cannot produce a zero-sized image.
	return {
		width: Math.max(1, Math.round(nativeWidth * scale)),
		height: Math.max(1, Math.round(nativeHeight * scale)),
		scale,
	};
}

/**
 * Effective image-to-physical scale for a space.
 *
 * Derived from the actual dimensions rather than a stored scale factor, so a helper that rounded
 * its output dimensions cannot desynchronize the conversion.
 */
function imageToPhysicalScale(space: ComputerUseCoordinateSpace): { sx: number; sy: number } {
	const sx = space.imageWidth > 0 ? space.physicalWidth / space.imageWidth : 1;
	const sy = space.imageHeight > 0 ? space.physicalHeight / space.imageHeight : 1;
	return { sx, sy };
}

/**
 * Converts a point the model gave us into physical screen pixels ready for an input API.
 *
 * The display origin is added, so the result is a virtual-desktop coordinate valid on a
 * multi-display setup.
 */
export function imagePointToPhysical(
	point: ComputerUsePoint,
	space: ComputerUseCoordinateSpace,
): ComputerUsePoint {
	const { sx, sy } = imageToPhysicalScale(space);
	return {
		x: point.x * sx + (space.originX ?? 0),
		y: point.y * sy + (space.originY ?? 0),
	};
}

/**
 * Converts a physical screen point into the image space the model sees.
 *
 * Used to tell the model where something it did not ask about currently is — for example
 * reporting the cursor position alongside a screenshot.
 */
export function physicalPointToImage(
	point: ComputerUsePoint,
	space: ComputerUseCoordinateSpace,
): ComputerUsePoint {
	const { sx, sy } = imageToPhysicalScale(space);
	return {
		x: sx === 0 ? 0 : (point.x - (space.originX ?? 0)) / sx,
		y: sy === 0 ? 0 : (point.y - (space.originY ?? 0)) / sy,
	};
}

/**
 * Converts physical pixels to logical OS points.
 *
 * Both `devicePixelRatio` and `zoomFactor` apply; a zoomed window on a Retina display is scaled
 * twice, and missing either factor is a classic off-by-2x bug.
 */
export function physicalToLogical(
	point: ComputerUsePoint,
	space: ComputerUseCoordinateSpace,
): ComputerUsePoint {
	const divisor = (space.devicePixelRatio ?? 1) * (space.zoomFactor ?? 1);
	if (divisor === 0) {
		return point;
	}
	return { x: point.x / divisor, y: point.y / divisor };
}

/** Converts logical OS points to physical pixels. Inverse of {@link physicalToLogical}. */
export function logicalToPhysical(
	point: ComputerUsePoint,
	space: ComputerUseCoordinateSpace,
): ComputerUsePoint {
	const factor = (space.devicePixelRatio ?? 1) * (space.zoomFactor ?? 1);
	return { x: point.x * factor, y: point.y * factor };
}

/**
 * Converts a rectangle from physical pixels into the model's image space.
 *
 * Element bounds arrive from the accessibility tree in physical pixels; the model needs them in
 * image space to reason about what it is looking at.
 */
export function physicalRectToImage(
	rect: ComputerUseRect,
	space: ComputerUseCoordinateSpace,
): ComputerUseRect {
	const { sx, sy } = imageToPhysicalScale(space);
	const safeX = sx === 0 ? 1 : sx;
	const safeY = sy === 0 ? 1 : sy;
	return {
		x: (rect.x - (space.originX ?? 0)) / safeX,
		y: (rect.y - (space.originY ?? 0)) / safeY,
		width: rect.width / safeX,
		height: rect.height / safeY,
	};
}

/** The centre of a rectangle. The natural place to click an element given only its bounds. */
export function rectCenter(rect: ComputerUseRect): ComputerUsePoint {
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Clamps a point into a display's physical bounds.
 *
 * A model that misjudges an edge should click the edge, not be rejected outright — but it must
 * never be able to steer the cursor onto another display by overshooting.
 */
export function clampToDisplay(
	point: ComputerUsePoint,
	space: ComputerUseCoordinateSpace,
): ComputerUsePoint {
	const minX = space.originX ?? 0;
	const minY = space.originY ?? 0;
	const maxX = minX + Math.max(0, space.physicalWidth - 1);
	const maxY = minY + Math.max(0, space.physicalHeight - 1);
	return {
		x: Math.min(Math.max(point.x, minX), maxX),
		y: Math.min(Math.max(point.y, minY), maxY),
	};
}

/** True when a physical point lies inside a display's bounds. */
export function isPointOnDisplay(
	point: ComputerUsePoint,
	space: ComputerUseCoordinateSpace,
): boolean {
	const minX = space.originX ?? 0;
	const minY = space.originY ?? 0;
	return (
		point.x >= minX &&
		point.y >= minY &&
		point.x < minX + space.physicalWidth &&
		point.y < minY + space.physicalHeight
	);
}

/** A display's identity and physical placement, for multi-display resolution. */
export interface ComputerUseDisplayBounds {
	readonly displayId: number;
	readonly bounds: ComputerUseRect;
}

/**
 * Finds which display contains a physical point.
 *
 * Returns `undefined` when the point falls in a gap between displays — which is possible with
 * mismatched resolutions — so callers must handle that rather than assume a display.
 */
export function displayContainingPoint(
	point: ComputerUsePoint,
	displays: readonly ComputerUseDisplayBounds[],
): ComputerUseDisplayBounds | undefined {
	return displays.find(
		d =>
			point.x >= d.bounds.x &&
			point.x < d.bounds.x + d.bounds.width &&
			point.y >= d.bounds.y &&
			point.y < d.bounds.y + d.bounds.height,
	);
}

/**
 * Builds a coordinate space from a capture result and the display it came from.
 *
 * Keeping this construction in one function means the service never assembles a space by hand and
 * so cannot forget the display origin.
 */
export function createCoordinateSpace(
	capture: { readonly width: number; readonly height: number },
	display: ComputerUseDisplayBounds,
	options?: { readonly devicePixelRatio?: number; readonly zoomFactor?: number },
): ComputerUseCoordinateSpace {
	return {
		imageWidth: capture.width,
		imageHeight: capture.height,
		physicalWidth: display.bounds.width,
		physicalHeight: display.bounds.height,
		originX: display.bounds.x,
		originY: display.bounds.y,
		devicePixelRatio: options?.devicePixelRatio,
		zoomFactor: options?.zoomFactor,
	};
}
