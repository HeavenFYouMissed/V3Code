/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Contract between a tool presenter and the chat's diff card.
 *
 * `IToolResultInputOutputDetails.input` is a plain string, so an edit ships its before/after
 * text as JSON under this private language tag. The renderer computes the diff itself — see
 * docs/CHAT-DIFF-SPEC.md for why it needs both texts rather than a unified-diff blob.
 */

export const SLIM_DIFF_LANGUAGE_ID = 'v3-slim-diff';

export interface SlimDiffCardPayload {
	original: string;
	modified: string;
	/** File path, used to pick the grammar for syntax highlighting. */
	path?: string;
	/**
	 * Snapshot resources for the two sides, when the tool that made the edit created them.
	 * The card's "open changes" button hands these straight to the editor. They must be
	 * URIs whose scheme has a registered text model content provider — creating models for
	 * an unbacked scheme makes every later resolve of them fail.
	 */
	originalUri?: string;
	modifiedUri?: string;
}

export function parseSlimDiffPayload(input: string): SlimDiffCardPayload | undefined {
	try {
		const parsed = JSON.parse(input) as Partial<SlimDiffCardPayload>;
		if (typeof parsed?.original !== 'string' || typeof parsed?.modified !== 'string') { return undefined; }
		const str = (v: unknown) => typeof v === 'string' ? v : undefined;
		return {
			original: parsed.original,
			modified: parsed.modified,
			path: str(parsed.path),
			originalUri: str(parsed.originalUri),
			modifiedUri: str(parsed.modifiedUri),
		};
	} catch {
		return undefined;
	}
}

/**
 * Adds snapshot resources to an already-built diff card. The tool adapter only knows the
 * snapshot URIs after the edit has run, which is later than when the card is presented.
 */
export function withSlimDiffResources(input: string, originalUri: string, modifiedUri: string): string {
	const payload = parseSlimDiffPayload(input);
	if (!payload) { return input; }
	return JSON.stringify({ ...payload, originalUri, modifiedUri } satisfies SlimDiffCardPayload);
}
