/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import './media/agentsComingSoonCard.css';
import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { localize } from '../../../../../nls.js';

/**
 * V3Code: the glass Agents workspace opens for exploration, but the agent backend
 * is not wired for end users yet. Show a one-tap "coming soon" glass card before the
 * window opens so nobody mistakes the preview for a finished feature. Resolves once
 * the user acknowledges (OK button, Enter, or Escape), after which the window opens.
 */
export function showAgentsComingSoonCard(container: HTMLElement): Promise<void> {
	const targetWindow = getWindow(container);

	return new Promise<void>(resolve => {
		const overlay = append(container, $('div.agents-coming-soon-overlay'));
		const card = append(overlay, $('div.agents-coming-soon-card'));

		const badge = append(card, $('div.agents-coming-soon-badge'));
		badge.textContent = localize('agentsComingSoon.badge', "Coming Soon");

		const title = append(card, $('div.agents-coming-soon-title'));
		title.textContent = localize('agentsComingSoon.title', "Agents Workspace");

		const body = append(card, $('div.agents-coming-soon-body'));
		body.textContent = localize('agentsComingSoon.body', "Landing this month: run multiple agents side-by-side in a live glass workspace, each isolated in its own git worktree. This is an early preview, so feel free to look around.");

		const okButton = append(card, $('button.agents-coming-soon-ok')) as HTMLButtonElement;
		okButton.textContent = localize('agentsComingSoon.ok', "OK");

		let done = false;
		const dismiss = () => {
			if (done) {
				return;
			}
			done = true;
			targetWindow.removeEventListener('keydown', onKeyDown, true);
			overlay.remove();
			resolve();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape' || e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				dismiss();
			}
		};

		okButton.addEventListener('click', dismiss);
		targetWindow.addEventListener('keydown', onKeyDown, true);
		okButton.focus();
	});
}
