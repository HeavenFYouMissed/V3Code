/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * v3codeBroadcastService — broadcast notifications to every install without shipping an update.
 *
 * Polls `product.json`'s `v3codeBroadcastUrl` (the v3update Worker, `/api/notifications`) for a
 * JSON feed of announcements and shows each unseen item exactly once per machine:
 *  - text-only items land in the notification bell/center via INotificationService (toasts are
 *    already suppressed globally by v3codeNotificationsContribution, so this is quiet by design);
 *  - items with an `imageUrl` show as a workbench banner (markdown images render there), which
 *    is the right surface for "look at this" announcements.
 *
 * Publishing a broadcast = uploading a new feed JSON to the Worker (see cloud/v3update). No app
 * update, no store re-sign. Modeled on workbench/contrib/emergencyAlert.
 */

import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IntervalTimer, timeout } from '../../../../base/common/async.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IBannerService } from '../../../services/banner/browser/bannerService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { platform } from '../../../../base/common/process.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { SEEN_BROADCASTS_KEY } from '../common/storageKeys.js';
import { isAllowedV3CodeActionUrl, IV3CodeBroadcast, IV3CodeStatusBoard, parseV3CodeBroadcastFeed } from '../common/v3codeBroadcast.js';

const INITIAL_DELAY = 5_000;
const POLLING_INTERVAL = 30 * 60 * 1000; // 30 minutes
const MAX_SEEN_IDS = 300;
const BANNER_ID_PREFIX = 'v3code.broadcast.';

export class V3CodeBroadcastService extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.v3codeBroadcastService';

	private _activeBannerId: string | undefined;
	private _statusBoard: IV3CodeStatusBoard = { state: 'loading', updates: [] };

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IProductService private readonly productService: IProductService,
		@IBannerService private readonly bannerService: IBannerService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStorageService private readonly storageService: IStorageService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const url = (this.productService as unknown as { v3codeBroadcastUrl?: string }).v3codeBroadcastUrl;
		this._register(CommandsRegistry.registerCommand('v3code.getStatusBoard', async () => {
			if (!url) {
				this._statusBoard = { state: 'unavailable', checkedAt: Date.now(), updates: [] };
				return this._statusBoard;
			}
			await this._poll(url);
			return this._statusBoard;
		}));
		this._register(CommandsRegistry.registerCommand('v3code.openStatusUpdate', (_accessor, href: unknown) => {
			if (typeof href !== 'string' || !isAllowedV3CodeActionUrl(href)) {
				return false;
			}
			void this.openerService.open(URI.parse(href));
			return true;
		}));
		if (!url) {
			return; // not configured for this build
		}

		timeout(INITIAL_DELAY).then(() => {
			if (this._store.isDisposed) { return; }
			this._poll(url);
			const pollingTimer = this._register(new IntervalTimer());
			pollingTimer.cancelAndSet(() => this._poll(url), POLLING_INTERVAL, mainWindow);
		});
	}

	private async _poll(url: string): Promise<void> {
		try {
			await this._doPoll(url);
		} catch (e) {
			this._statusBoard = { state: 'unavailable', checkedAt: Date.now(), updates: this._statusBoard.updates };
			// Network/parse failures are routine (offline, captive portal) — log at trace only.
			this.logService.trace('[v3code-broadcast] poll failed', e);
		}
	}

	private async _doPoll(url: string): Promise<void> {
		const result = await this.requestService.request(
			{ type: 'GET', url, disableCache: true, timeout: 20_000, callSite: 'v3codeBroadcast.poll' },
			CancellationToken.None,
		);
		if (result.res.statusCode !== 200) {
			throw new Error(`broadcast feed HTTP ${result.res.statusCode}`);
		}
		const liveFeed = parseV3CodeBroadcastFeed(await asJson<unknown>(result));

		const now = Date.now();
		const currentUpdates = liveFeed.filter(n =>
			(!n.startsAt || n.startsAt <= now)
			&& (!n.endsAt || n.endsAt >= now)
			&& (!n.platform || n.platform === platform)
		);
		this._statusBoard = { state: 'ready', checkedAt: now, updates: currentUpdates };
		const seen = this._readSeen();
		const live = currentUpdates.filter(n =>
			!seen.includes(n.id)
		);
		if (!live.length) {
			return;
		}

		const newlySeen: string[] = [];
		let bannerShown = this._activeBannerId !== undefined;
		for (const item of live) {
			try {
				if ((item.imageUrl || item.display === 'banner') && !bannerShown) {
					// One banner at a time; further image items wait for the next poll cycle
					// after this one is closed (its id is only marked seen on close/action).
					this._showBanner(item);
					bannerShown = true;
				} else {
					this._showNotification(item);
					newlySeen.push(item.id);
				}
			} catch (e) {
				this.logService.error('[v3code-broadcast] failed to show broadcast', item.id, e);
			}
		}
		if (newlySeen.length) {
			this._markSeen(newlySeen);
		}
	}

	private _showNotification(item: IV3CodeBroadcast): void {
		const severity = item.severity === 'error' ? Severity.Error : item.severity === 'warning' ? Severity.Warning : Severity.Info;
		const sender = item.sender?.trim() || 'Daniel — V3Code';
		const message = item.title ? `${sender}: ${item.title} — ${item.body}` : `${sender}: ${item.body}`;
		const primary = (item.actions ?? []).map(a =>
			new Action(`v3code.broadcast.action.${item.id}.${a.label}`, a.label, undefined, true,
				() => this.openerService.open(URI.parse(a.href))));
		this.notificationService.notify({
			severity,
			message,
			sticky: severity !== Severity.Info,
			actions: primary.length ? { primary } : undefined,
		});
	}

	private _showBanner(item: IV3CodeBroadcast): void {
		const bannerId = `${BANNER_ID_PREFIX}${item.id}`;
		const md = new MarkdownString(undefined, { supportThemeIcons: false });
		if (item.imageUrl) { md.appendMarkdown(`![](${item.imageUrl}) `); }
		md.appendMarkdown('**');
		md.appendText(item.sender?.trim() || 'Daniel — V3Code');
		md.appendMarkdown('** — ');
		if (item.title) { md.appendText(`${item.title} — `); }
		md.appendText(item.body);
		this._activeBannerId = bannerId;
		const dismiss = () => {
			this._markSeen([item.id]);
			if (this._activeBannerId === bannerId) { this._activeBannerId = undefined; }
			this.bannerService.hide(bannerId);
		};
		this.bannerService.show({
			id: bannerId,
			icon: Codicon.megaphone,
			message: md,
			actions: (item.actions ?? []).map(a => ({ label: a.label, href: a.href })),
			onClose: dismiss,
		});
	}

	private _readSeen(): string[] {
		try {
			const raw = this.storageService.get(SEEN_BROADCASTS_KEY, StorageScope.APPLICATION);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
		} catch {
			return [];
		}
	}

	private _markSeen(ids: string[]): void {
		const merged = [...new Set([...this._readSeen(), ...ids])].slice(-MAX_SEEN_IDS);
		this.storageService.store(SEEN_BROADCASTS_KEY, JSON.stringify(merged), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}

registerWorkbenchContribution2(V3CodeBroadcastService.ID, V3CodeBroadcastService, WorkbenchPhase.Eventually);
