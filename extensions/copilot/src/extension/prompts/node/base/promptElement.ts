/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { BasePromptElementProps, PromptElement, PromptElementCtor as PromptElementCtor2 } from '@vscode/prompt-tsx';

export interface PromptElementCtor<P extends BasePromptElementProps = BasePromptElementProps, S = void> extends PromptElementCtor2<P, S> {
	new(props: P, ...args: any[]): PromptElement<P, S>;
}

export interface EmbeddedInsideUserMessage {
	/**
	 * Upcoming deprecation: Wrap with UserMessage instead.
	 */
	readonly embeddedInsideUserMessage?: false;
}

export const embeddedInsideUserMessageDefault = true;
