/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { LayoutPriority } from '../../../base/browser/ui/splitview/splitview.js';
import { mainWindow } from '../../../base/browser/window.js';
import { MainEditorPart as MainEditorPartBase } from '../../../workbench/browser/parts/editor/editorPart.js';
import { Parts } from '../../../workbench/services/layout/browser/layoutService.js';

export class MainEditorPart extends MainEditorPartBase {
	// Zero margins: the editor is part of the seamless right region sheet;
	// dividers are 1px CSS box-shadow hairlines that take no layout space.
	static readonly MARGIN_TOP = 0;
	static readonly MARGIN_BOTTOM = 0;
	static readonly MARGIN_LEFT = 0;
	static readonly MARGIN_RIGHT = 0;

	override get minimumWidth() {
		// Leave enough room for the selected file/terminal while still
		// allowing the attached Files/Changes rail on compact windows.
		return Math.max(260, super.minimumWidth);
	}

	override priority = LayoutPriority.High;

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.EDITOR_PART, mainWindow)) {
			return;
		}

		// Margins and borders are zero — the editor fills its grid cell exactly.
		// The 1px dividers around it are CSS box-shadows (no layout space).
		super.layout(width, height, top, left);
	}
}
