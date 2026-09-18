/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Report Issue / Feedback commands (ship-prep Component 4).
 *
 * `v3code.reportIssue` and `v3code.sendFeedback` mount the React modal
 * (react/src/report-issue-tsx/ReportIssue.tsx) into a workbench-owned overlay.
 * Submit composes a prefilled mailto: URL opened through IOpenerService —
 * version + OS get appended when the user leaves the system-info boxes checked.
 * The secondary path opens product.reportIssueUrl (GitHub issues).
 */

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import * as nls from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IV3CodeAccountService } from '../common/v3codeAccountService.js';
import { PRODUCT_VOTE_INSTALL_ID_KEY } from '../common/storageKeys.js';
import { isMacintosh, isWindows, isLinux } from '../../../../base/common/platform.js';
import { mountReportIssue } from './react/out/report-issue-tsx/index.js';

export const V3CODE_REPORT_ISSUE_COMMAND_ID = 'v3code.reportIssue';
export const V3CODE_SEND_FEEDBACK_COMMAND_ID = 'v3code.sendFeedback';
export const V3CODE_VOTE_AGENTS_BETA_COMMAND_ID = 'v3code.voteAgentsBeta';

const FALLBACK_REPORT_ISSUE_URL = 'https://github.com/HeavenFYouMissed/V3Code/issues/new';

const osDisplayName = isMacintosh ? 'macOS' : isWindows ? 'Windows' : isLinux ? 'Linux' : 'Unknown';

// Only one modal at a time — reopening (or switching issue<->feedback) tears the
// previous one down first.
let currentModal: { dispose: () => void } | undefined;

function closeCurrentModal(): void {
	currentModal?.dispose();
	currentModal = undefined;
}

function openModal(accessor: ServicesAccessor, mode: 'issue' | 'feedback'): void {
	closeCurrentModal();

	const instantiationService = accessor.get(IInstantiationService);
	const openerService = accessor.get(IOpenerService);
	const productService = accessor.get(IProductService);
	const accountService = accessor.get(IV3CodeAccountService);
	const notificationService = accessor.get(INotificationService);

	const targetWindow = getActiveWindow();
	const workbench = targetWindow.document.querySelector('.monaco-workbench');
	if (!workbench) { return; }

	const container = targetWindow.document.createElement('div');
	container.className = 'v3-report-issue-container';
	workbench.appendChild(container);

	const reportIssueUrl = productService.reportIssueUrl ?? FALLBACK_REPORT_ISSUE_URL;

	let reactRoot: { dispose: () => void } | undefined;

	const disposeModal = () => {
		reactRoot?.dispose();
		reactRoot = undefined;
		container.remove();
	};

	instantiationService.invokeFunction(reactAccessor => {
		const mounted = mountReportIssue(container, reactAccessor, {
			mode,
			version: productService.version,
			osName: osDisplayName,
			onClose: () => {
				closeCurrentModal();
			},
			onSubmitMailto: (mailtoUrl: string) => {
				void openerService.open(URI.parse(mailtoUrl));
			},
			// Signed-in users' feedback POSTs straight to the hub inbox (admin panel); guests fall
			// back to mailto. Returns whether it landed so the modal knows to close vs. fall back.
			isSignedIn: accountService.state.status === 'signedIn',
			onSubmitApi: async (payload: { category?: string; severity?: string; message: string; context?: Record<string, unknown> }) => {
				const ok = await accountService.submitFeedback(payload);
				if (ok) {
					notificationService.info(mode === 'issue'
						? nls.localize('v3code.reportIssue.sent', "Thanks — your issue was sent to the V3Code team.")
						: nls.localize('v3code.sendFeedback.sent', "Thanks — your feedback was sent to the V3Code team."));
				}
				return ok;
			},
			onOpenGitHub: () => {
				void openerService.open(URI.parse(reportIssueUrl));
			},
		});
		if (mounted) {
			reactRoot = { dispose: mounted.dispose };
		}
	});

	currentModal = { dispose: disposeModal };
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: V3CODE_REPORT_ISSUE_COMMAND_ID,
			title: nls.localize2('v3codeReportIssue', "V3Code: Report Issue"),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		openModal(accessor, 'issue');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: V3CODE_VOTE_AGENTS_BETA_COMMAND_ID,
			title: nls.localize2('v3codeVoteAgentsBeta', "V3Code: Vote on Agents Beta"),
		});
	}

	async run(accessor: ServicesAccessor, choice: unknown): Promise<boolean> {
		const notificationService = accessor.get(INotificationService);
		if (choice !== 'yes' && choice !== 'no') {
			notificationService.error(nls.localize('v3codeVoteAgentsBeta.invalid', "Choose Yes or No before sending the vote."));
			return false;
		}

		const productService = accessor.get(IProductService);
		const voteUrl = (productService as unknown as { v3codeAgentsBetaVoteUrl?: string }).v3codeAgentsBetaVoteUrl;
		if (!voteUrl) {
			notificationService.error(nls.localize('v3codeVoteAgentsBeta.unavailable', "Voting is not configured in this build."));
			return false;
		}

		const storageService = accessor.get(IStorageService);
		let voterId = storageService.get(PRODUCT_VOTE_INSTALL_ID_KEY, StorageScope.APPLICATION);
		if (!voterId) {
			voterId = generateUuid();
			storageService.store(PRODUCT_VOTE_INSTALL_ID_KEY, voterId, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}

		try {
			const context = await accessor.get(IRequestService).request({
				type: 'POST',
				url: voteUrl,
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({ choice, voterId }),
				timeout: 20_000,
				callSite: 'v3code.feedback.agentsBetaVote',
			}, CancellationToken.None);
			const status = context.res.statusCode ?? 0;
			if (status < 200 || status >= 300) {
				throw new Error(`vote endpoint returned ${status}`);
			}
			notificationService.info(nls.localize('v3codeVoteAgentsBeta.sent', "Thanks — your vote was sent."));
			return true;
		} catch {
			notificationService.error(nls.localize('v3codeVoteAgentsBeta.failed', "Your vote could not be sent. Please try again later."));
			return false;
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: V3CODE_SEND_FEEDBACK_COMMAND_ID,
			title: nls.localize2('v3codeSendFeedback', "V3Code: Send Feedback"),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		openModal(accessor, 'feedback');
	}
});
