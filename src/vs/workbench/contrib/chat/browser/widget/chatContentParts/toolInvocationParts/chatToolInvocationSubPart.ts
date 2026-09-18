/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Codicon } from '../../../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../../base/common/themables.js';
import { IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../common/chatService/chatService.js';
import { isToolResultInputOutputDetails } from '../../../../common/tools/languageModelToolsService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';

export abstract class BaseChatToolInvocationSubPart extends Disposable {
	protected static idPool = 0;
	public abstract readonly domNode: HTMLElement;

	protected _onNeedsRerender = this._register(new Emitter<void>());
	public readonly onNeedsRerender = this._onNeedsRerender.event;

	public abstract codeblocks: IChatCodeBlockInfo[];

	private readonly _codeBlocksPartId = 'tool-' + (BaseChatToolInvocationSubPart.idPool++);

	public get codeblocksPartId() {
		return this._codeBlocksPartId;
	}

	constructor(
		protected readonly toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
	) {
		super();
	}

	/**
	 * @param showFailure when true, a completed call whose result details carry `isError`
	 * renders the error icon instead of a check (Debug transcripts: no success receipt for a
	 * failed operation). Other callers keep the historical check.
	 */
	protected getIcon(showFailure = false) {
		const toolInvocation = this.toolInvocation;
		const confirmState = IChatToolInvocation.executionConfirmedOrDenied(toolInvocation);
		const isSkipped = confirmState?.type === ToolConfirmKind.Skipped;
		if (isSkipped) {
			return Codicon.circleSlash;
		}

		if (confirmState?.type === ToolConfirmKind.Denied) {
			return Codicon.error;
		}
		if (!IChatToolInvocation.isComplete(toolInvocation)) {
			return ThemeIcon.modify(Codicon.loading, 'spin');
		}
		if (showFailure) {
			const details = IChatToolInvocation.resultDetails(toolInvocation);
			if (isToolResultInputOutputDetails(details) && details.isError) {
				return Codicon.error;
			}
		}
		return Codicon.check;
	}
}
