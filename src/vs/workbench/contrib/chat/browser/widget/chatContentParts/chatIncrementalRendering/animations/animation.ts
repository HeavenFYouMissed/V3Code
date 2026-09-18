/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Animation strategy for incremental rendering. Applied as a post-processing
 * decoration after the markdown has been correctly rendered.
 *
 * Animation is separate from buffering — it controls *how* rendered
 * content appears, while buffering controls *when* we render.
 */
export interface IIncrementalRenderingAnimation {
	/**
	 * Apply entrance animation to newly appeared DOM children.
	 *
	 * @param children The live HTMLCollection of the container's children.
	 * @param fromIndex Index of the first new child to animate.
	 * @param currentCount Total number of children currently in the DOM.
	 * @param elapsed Milliseconds since the animation batch started.
	 */
	animate(children: HTMLCollection, fromIndex: number, currentCount: number, elapsed: number): void;
}
