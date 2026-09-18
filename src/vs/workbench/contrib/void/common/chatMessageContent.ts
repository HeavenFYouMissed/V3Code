/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/** Shown in old threads when tool-only turns were sent to the model with a visible placeholder. */
export const LEGACY_EMPTY_DISPLAY_TEXT = '(empty message)'

/** Non-empty string for LLM APIs; must not be user-visible or model-echoed. */
export const LLM_EMPTY_TEXT_PLACEHOLDER = '\u2060'

export function isEffectivelyEmptyAssistantText(text: string | null | undefined): boolean {
	const t = (text ?? '').trim()
	return !t || t === LEGACY_EMPTY_DISPLAY_TEXT
}

export function shouldPersistAssistantTurn(displayContent: string | null | undefined, reasoning: string | null | undefined): boolean {
	return !isEffectivelyEmptyAssistantText(displayContent) || !!(reasoning ?? '').trim()
}
