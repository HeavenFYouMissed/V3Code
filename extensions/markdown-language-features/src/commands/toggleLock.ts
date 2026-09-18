/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Command } from '../commandManager';
import { MarkdownPreviewManager } from '../preview/previewManager';

export class ToggleLockCommand implements Command {
	public readonly id = 'markdown.preview.toggleLock';

	readonly #previewManager: MarkdownPreviewManager;

	public constructor(
		previewManager: MarkdownPreviewManager
	) {
		this.#previewManager = previewManager;
	}

	public execute() {
		this.#previewManager.toggleLock();
	}
}
