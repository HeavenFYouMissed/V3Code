/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Closes the editor <-> v3code.dev auth loop on the editor side.
 *
 * After the user signs in on the web, the hub handoff page deep-links back into the
 * desktop app via the `v3code://` protocol (product.json `urlProtocol: "v3code"`):
 *
 *   v3code://auth/callback?code=<one-time-code>   — sign-in handoff
 *   v3code://billing/complete                     — checkout finished; reconcile entitlement now
 *
 * VS Code's IURLService routes those URLs to every registered IURLHandler. This handler
 * claims the two routes above; any other `v3code://` URL is left for other handlers
 * (return false).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenURLOptions, IURLHandler, IURLService } from '../../../../platform/url/common/url.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IV3CodeAccountService } from '../common/v3codeAccountService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { Action } from '../../../../base/common/actions.js';

/** The hub exchange has no timeout of its own; a hung request left the user staring at
 *  nothing indefinitely with the sign-in silently stuck. */
const SIGN_IN_EXCHANGE_TIMEOUT_MS = 20_000;

class V3CodeAuthUrlHandler extends Disposable implements IWorkbenchContribution, IURLHandler {
	static readonly ID = 'workbench.contrib.v3codeAuthUrlHandler';

	private _lastFocusRefresh = 0;

	constructor(
		@IURLService urlService: IURLService,
		@IV3CodeAccountService private readonly accountService: IV3CodeAccountService,
		@INotificationService private readonly notificationService: INotificationService,
		@IHostService hostService: IHostService,
	) {
		super();
		this._register(urlService.registerHandler(this));

		// Entitlement refresh on window focus: purchases and plan changes happen in the browser,
		// and coming back to the editor is the natural "did it take?" moment. Throttled so tab
		// flipping doesn't hammer the hub.
		this._register(hostService.onDidChangeFocus(focused => {
			if (!focused) { return; }
			if (this.accountService.state.status !== 'signedIn') { return; }
			const now = Date.now();
			if (now - this._lastFocusRefresh < 5 * 60_000) { return; }
			this._lastFocusRefresh = now;
			void this.accountService.refreshFromHub();
		}));

		// A lapsed/cancelled plan used to flip the badge to "Free" with zero notice — the user
		// found out via a failing send. The account service only downgrades on an AUTHORITATIVE
		// billing answer (network failures carry the plan forward), so a paid→free transition
		// here is real and worth one notification with a way back.
		let wasPaid = this.accountService.state.status === 'signedIn' && this.accountService.state.isPaid;
		let lastLapseNoticeAt = 0;
		this._register(this.accountService.onDidChangeState(() => {
			const s = this.accountService.state;
			const isPaidNow = s.status === 'signedIn' && s.isPaid;
			// Throttled: a flapping hub answer (authoritative false, then true, then false…) would
			// otherwise post a fresh warning on every downward edge, in every open window.
			if (wasPaid && !isPaidNow && s.status === 'signedIn' && Date.now() - lastLapseNoticeAt > 60 * 60_000) {
				lastLapseNoticeAt = Date.now();
				this.notificationService.notify({
					severity: Severity.Warning,
					message: localize('v3code.plan.lapsed', "Your V3Code plan has ended — hosted plan models are paused. Your own provider models (BYOK) keep working."),
					actions: {
						primary: [new Action('v3code.plan.reactivate', localize('v3code.plan.reactivate', "Reactivate plan"), undefined, true, () => {
							this.accountService.openPlans();
						})],
					},
				});
			}
			wasPaid = isPaidNow;
		}));
	}

	async handleURL(uri: URI, _options?: IOpenURLOptions): Promise<boolean> {
		// v3code://billing/complete — the website redirects here after a successful checkout so
		// the editor learns about the purchase immediately instead of waiting for the routine
		// reconcile (up to 10 minutes of the app claiming "Free" after the customer paid).
		if (uri.authority === 'billing' && uri.path === '/complete') {
			void this.accountService.refreshFromHub();
			this.accountService.beginPurchaseActivationWatch();
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize('v3code.billing.activating', "Thanks for upgrading! Activating your V3Code plan…"),
			});
			return true;
		}

		// Match v3code://auth/callback (authority 'auth', path '/callback').
		if (uri.authority !== 'auth' || uri.path !== '/callback') {
			return false;
		}

		const code = new URLSearchParams(uri.query).get('code');
		if (!code) {
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize('v3code.auth.noCode', "V3Code sign-in link was missing its one-time code. Please try signing in again."),
				actions: { primary: [this._retrySignInAction()] },
			});
			return true; // We claimed the route even though it was malformed.
		}

		await this._completeSignInWithFeedback(code);
		return true;
	}

	private async _completeSignInWithFeedback(code: string): Promise<void> {
		// Bound the exchange and give failure a retry path — the one-time code may already be
		// spent on a retry, so the recovery action restarts the sign-in flow, not the exchange.
		const exchange = this.accountService.completeSignIn(code);
		const raced = await raceTimeout(exchange, SIGN_IN_EXCHANGE_TIMEOUT_MS);
		if (raced === true) {
			this._notifySignedIn();
			return;
		}
		if (raced === undefined) {
			// TIMED OUT, not failed: raceTimeout abandons the promise but the exchange keeps
			// running (completeSignIn takes no cancellation token) and routinely lands late.
			// Without this continuation the user reads "could not be completed" while the app
			// quietly signs them in — and the Retry button re-opens login for a live session.
			void exchange.then(late => { if (late) { this._notifySignedIn(); } });
		}
		this.notificationService.notify({
			severity: Severity.Error,
			message: localize('v3code.auth.failed', "V3Code sign-in could not be completed (the sign-in server didn't respond in time, or the link expired)."),
			actions: { primary: [this._retrySignInAction()] },
		});
	}

	private _notifySignedIn(): void {
		this.notificationService.notify({
			severity: Severity.Info,
			message: localize('v3code.auth.signedIn', "Signed in to V3Code as {0}.", this.accountService.state.displayName),
		});
	}

	private _retrySignInAction(): Action {
		return new Action('v3code.auth.retry', localize('v3code.auth.retry', "Retry sign-in"), undefined, true, () => {
			this.accountService.signIn();
		});
	}
}

registerWorkbenchContribution2(V3CodeAuthUrlHandler.ID, V3CodeAuthUrlHandler, WorkbenchPhase.AfterRestored);
