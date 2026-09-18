/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ComputerUseCoordinateSpace,
	clampToDisplay,
	computeDownscale,
	createCoordinateSpace,
	displayContainingPoint,
	imagePointToPhysical,
	isPointOnDisplay,
	logicalToPhysical,
	physicalPointToImage,
	physicalRectToImage,
	physicalToLogical,
	rectCenter,
} from '../../common/computerUseCoordinates.js';

suite('ComputerUse - coordinates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** A 3024x1964 Retina display captured down to a 1080 long edge. */
	const retina: ComputerUseCoordinateSpace = {
		imageWidth: 1080,
		imageHeight: 701,
		physicalWidth: 3024,
		physicalHeight: 1964,
		devicePixelRatio: 2,
		zoomFactor: 1,
		originX: 0,
		originY: 0,
	};

	test('computeDownscale bounds the long edge and preserves aspect ratio', () => {
		assert.deepStrictEqual(computeDownscale(3024, 1964, 1080), {
			width: 1080,
			height: 701,
			scale: 1080 / 3024,
		});
	});

	test('computeDownscale never upscales a small capture', () => {
		assert.deepStrictEqual(computeDownscale(800, 600, 1080), {
			width: 800,
			height: 600,
			scale: 1,
		});
	});

	test('computeDownscale handles a portrait display by bounding the height', () => {
		assert.deepStrictEqual(computeDownscale(1200, 2400, 1080), {
			width: 540,
			height: 1080,
			scale: 0.45,
		});
	});

	test('computeDownscale is defensive about degenerate input', () => {
		assert.deepStrictEqual(
			[computeDownscale(0, 0), computeDownscale(100, 100, 0)],
			[
				{ width: 0, height: 0, scale: 1 },
				{ width: 100, height: 100, scale: 1 },
			],
		);
	});

	test('image and physical points round-trip', () => {
		const original = { x: 540, y: 350 };
		const physical = imagePointToPhysical(original, retina);
		const back = physicalPointToImage(physical, retina);
		assert.deepStrictEqual(
			[Math.round(back.x), Math.round(back.y)],
			[original.x, original.y],
		);
	});

	test('imagePointToPhysical scales up and adds the display origin', () => {
		const secondary: ComputerUseCoordinateSpace = { ...retina, originX: 3024, originY: 0 };
		const physical = imagePointToPhysical({ x: 540, y: 350 }, secondary);
		assert.deepStrictEqual(
			[Math.round(physical.x), Math.round(physical.y)],
			[3024 + 1512, 981],
		);
	});

	test('physical and logical points round-trip through dpr and zoom', () => {
		const zoomed: ComputerUseCoordinateSpace = { ...retina, devicePixelRatio: 2, zoomFactor: 1.5 };
		const physical = { x: 600, y: 300 };
		const logical = physicalToLogical(physical, zoomed);
		assert.deepStrictEqual(
			[logical, logicalToPhysical(logical, zoomed)],
			[{ x: 200, y: 100 }, physical],
		);
	});

	test('physicalRectToImage maps element bounds into image space', () => {
		const rect = { x: 1512, y: 1000, width: 302, height: 196 };
		const inImage = physicalRectToImage(rect, retina);
		assert.deepStrictEqual(
			[
				Math.round(inImage.x),
				Math.round(inImage.y),
				Math.round(inImage.width),
				Math.round(inImage.height),
			],
			[540, 357, 108, 70],
		);
	});

	test('rectCenter finds the middle', () => {
		assert.deepStrictEqual(rectCenter({ x: 10, y: 20, width: 100, height: 50 }), {
			x: 60,
			y: 45,
		});
	});

	test('clampToDisplay keeps a point inside bounds without leaking onto a neighbour', () => {
		const secondary: ComputerUseCoordinateSpace = { ...retina, originX: 3024 };
		assert.deepStrictEqual(
			[
				clampToDisplay({ x: -50, y: -50 }, retina),
				clampToDisplay({ x: 99999, y: 99999 }, retina),
				clampToDisplay({ x: 3000, y: 10 }, secondary),
			],
			[
				{ x: 0, y: 0 },
				{ x: 3023, y: 1963 },
				{ x: 3024, y: 10 },
			],
		);
	});

	test('isPointOnDisplay respects the origin and the exclusive far edge', () => {
		assert.deepStrictEqual(
			[
				isPointOnDisplay({ x: 0, y: 0 }, retina),
				isPointOnDisplay({ x: 3023, y: 1963 }, retina),
				isPointOnDisplay({ x: 3024, y: 0 }, retina),
			],
			[true, true, false],
		);
	});

	test('displayContainingPoint resolves across displays and reports gaps', () => {
		const displays = [
			{ displayId: 1, bounds: { x: 0, y: 0, width: 3024, height: 1964 } },
			{ displayId: 2, bounds: { x: 3024, y: 0, width: 2560, height: 1440 } },
		];
		assert.deepStrictEqual(
			[
				displayContainingPoint({ x: 10, y: 10 }, displays)?.displayId,
				displayContainingPoint({ x: 4000, y: 10 }, displays)?.displayId,
				displayContainingPoint({ x: 4000, y: 1800 }, displays)?.displayId,
			],
			[1, 2, undefined],
		);
	});

	test('createCoordinateSpace carries the display origin', () => {
		const space = createCoordinateSpace(
			{ width: 1080, height: 701 },
			{ displayId: 2, bounds: { x: 3024, y: 120, width: 3024, height: 1964 } },
			{ devicePixelRatio: 2, zoomFactor: 1 },
		);
		assert.deepStrictEqual(space, {
			imageWidth: 1080,
			imageHeight: 701,
			physicalWidth: 3024,
			physicalHeight: 1964,
			originX: 3024,
			originY: 120,
			devicePixelRatio: 2,
			zoomFactor: 1,
		});
	});
});
