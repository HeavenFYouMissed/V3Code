/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Remote / Mobile header button.
 *
 * Adds a phone icon to the title-bar command center (next to the folder + search).
 * Clicking it opens a small "drive V3Code from your phone" dropdown — the entry
 * point for v-go remote pairing. The QR/pairing flow lands in a later phase; this
 * is the discoverable surface that ships now and merges cleanly.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IV3CodeRemoteService } from './v3RemoteService.js';
import { V3CodeRemoteQrOverlay } from './v3RemoteQrOverlay.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { V3CODE_REMOTE_DEFAULT_WEBAPP_URL } from '../common/remoteTypes.js';

export const V3CODE_REMOTE_ACTION_ID = 'v3code.remote.open';
/** Goes straight to the QR, for surfaces whose whole purpose is pairing. */
export const V3CODE_REMOTE_SHOW_QR_ACTION_ID = 'v3code.remote.showQr';

// "How it works" opens the hosted phone/web app — the same one the pairing panel
// tells the user to create their account on. (v-go.dev has no DNS yet; a marketing
// site can take over this URL once it exists.)
const V3CODE_REMOTE_URL = V3CODE_REMOTE_DEFAULT_WEBAPP_URL;

class V3CodeRemoteAction extends Action2 {
	constructor() {
		super({
			id: V3CODE_REMOTE_ACTION_ID,
			title: localize2('v3code.remote.open', "Remote — Drive from Your Phone"),
			tooltip: localize('v3code.remote.tooltip', "Drive V3Code from your phone — scan to connect"),
			icon: Codicon.deviceMobile,
			f1: true,
			menu: [{ id: MenuId.CommandCenter, group: 'navigation', order: 100 }],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Resolve every service BEFORE the first await: `accessor` is only valid while
		// this method is on the stack, and reaching for it after the quick pick resolves
		// throws - which is how the button silently did nothing.
		const quickInputService = accessor.get(IQuickInputService);
		const openerService = accessor.get(IOpenerService);
		const remoteService = accessor.get(IV3CodeRemoteService);
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const notificationService = accessor.get(INotificationService);
		const clipboardService = accessor.get(IClipboardService);
		const browserViewService = accessor.get(IBrowserViewWorkbenchService);

		const showQr: IQuickPickItem = {
			label: localize('v3code.remote.showQr', "$(device-mobile) Show pairing QR"),
			description: localize('v3code.remote.showQrDesc', "Connect your phone to this editor"),
		};
		const learn: IQuickPickItem = {
			label: localize('v3code.remote.learn', "$(info) How it works"),
			description: localize('v3code.remote.learnDesc', "Drive your agent from anywhere"),
		};

		const picked = await quickInputService.pick([showQr, learn], {
			title: localize('v3code.remote.title', "Remote · Drive V3Code from your phone"),
			placeHolder: localize('v3code.remote.placeholder', "Scan here for remote / mobile"),
		});

		if (!picked) {
			return;
		}

		if (picked === learn) {
			await openerService.open(URI.parse(V3CODE_REMOTE_URL));
			return;
		}

		await showPairingQr(remoteService, layoutService, notificationService, clipboardService, browserViewService);
	}
}

/**
 * Open the pairing panel and drive it to completion.
 *
 * Shared rather than inlined because pairing is reachable from several surfaces -
 * the header button, the Mobile row in the agents sidebar, and the account menu -
 * and they should all get the same panel rather than their own half of it.
 */
export async function showPairingQr(
	remoteService: IV3CodeRemoteService,
	layoutService: IWorkbenchLayoutService,
	notificationService: INotificationService,
	clipboardService: IClipboardService,
	browserViewService?: IBrowserViewWorkbenchService,
): Promise<void> {
	// Open immediately in a "starting" state: spawning the CLI and reaching the relay
	// takes a beat, and a control that appears to do nothing for a second reads broken.
	const overlay = new V3CodeRemoteQrOverlay(layoutService.mainContainer, clipboardService, browserViewService);
	const listener = remoteService.onDidChangeState(state => overlay.renderState(state));
	overlay.open(() => {
		listener.dispose();
		overlay.dispose();
		// Only worth keeping the CLI alive while someone might still scan.
		void remoteService.stop();
	});

	try {
		overlay.renderState(await remoteService.start());
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		overlay.renderState({ status: 'error', message });
		// Also surface it outside the panel: a failure that only paints inside the thing
		// you just opened is easy to mistake for a dead button.
		notificationService.error(localize('v3code.remote.startFailed', "Remote pairing could not start: {0}", message));
	}
}

/** Straight to the QR, for surfaces whose only purpose is pairing. */
class V3CodeRemoteShowQrAction extends Action2 {
	constructor() {
		super({
			id: V3CODE_REMOTE_SHOW_QR_ACTION_ID,
			title: localize2('v3code.remote.showQrAction', "Remote — Show Pairing QR"),
			icon: Codicon.deviceMobile,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await showPairingQr(
			accessor.get(IV3CodeRemoteService),
			accessor.get(IWorkbenchLayoutService),
			accessor.get(INotificationService),
			accessor.get(IClipboardService),
			accessor.get(IBrowserViewWorkbenchService),
		);
	}
}

registerAction2(V3CodeRemoteAction);
registerAction2(V3CodeRemoteShowQrAction);
