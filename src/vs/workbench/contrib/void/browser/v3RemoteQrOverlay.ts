/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import './media/v3RemoteQr.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import * as nls from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IV3CodeRemoteState, V3CODE_REMOTE_DEFAULT_WEBAPP_URL } from '../common/remoteTypes.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';

/** Rendered size of one QR module, in device-independent pixels. */
const QR_MODULE_PX = 6;
/** Quiet zone the spec asks for, in modules. Scanners need it to find the code. */
const QR_QUIET_MODULES = 4;

/**
 * Turn the CLI's block-character rows into a square boolean matrix.
 *
 * The CLI emits full blocks, so every module is exactly two characters wide and one
 * row tall. Sampling every second character recovers the true matrix, which is what
 * lets us draw square modules instead of inheriting a font's aspect ratio - the
 * distortion that stopped cameras locking onto the text-rendered version.
 */
function decodeQrModules(rows: string[]): boolean[][] {
	// Half-block characters, each carrying two vertically stacked modules:
	// U+2588 full (both dark), U+2580 upper (top dark), U+2584 lower (bottom dark),
	// space (both light). Written as escapes so the source stays ASCII.
	const FULL = '\u2588';
	const UPPER = '\u2580';
	const LOWER = '\u2584';

	const matrix: boolean[][] = [];
	for (const row of rows) {
		if (!row.length) {
			continue;
		}
		const top: boolean[] = [];
		const bottom: boolean[] = [];
		for (const ch of row) {
			top.push(ch === FULL || ch === UPPER);
			bottom.push(ch === FULL || ch === LOWER);
		}
		matrix.push(top, bottom);
	}

	// The last text row may only carry a top module; drop light-only tail rows so the
	// quiet zone we paint is the only padding around the code.
	while (matrix.length && matrix[matrix.length - 1].every(m => !m)) {
		matrix.pop();
	}
	return matrix;
}

function drawQr(canvas: HTMLCanvasElement, matrix: boolean[][]): void {
	const cols = Math.max(...matrix.map(r => r.length));
	const rows = matrix.length;
	const size = QR_QUIET_MODULES * 2;
	const width = (cols + size) * QR_MODULE_PX;
	const height = (rows + size) * QR_MODULE_PX;

	// Render at device resolution: a half-pixel-blurred QR is markedly harder to scan.
	const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
	canvas.width = Math.round(width * dpr);
	canvas.height = Math.round(height * dpr);
	canvas.style.width = `${width}px`;
	canvas.style.height = `${height}px`;

	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return;
	}
	ctx.scale(dpr, dpr);
	// Always pure black on pure white regardless of theme - scanners want the contrast,
	// and a themed QR is a QR that sometimes does not read.
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = '#000000';
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < matrix[y].length; x++) {
			if (matrix[y][x]) {
				ctx.fillRect(
					(x + QR_QUIET_MODULES) * QR_MODULE_PX,
					(y + QR_QUIET_MODULES) * QR_MODULE_PX,
					QR_MODULE_PX,
					QR_MODULE_PX
				);
			}
		}
	}
}

/**
 * The "Connect V3Code to your phone" panel.
 *
 * The QR is drawn from the rows the CLI's own encoder produced, so what a phone
 * scans came from the same path that already works in a terminal. It renders as
 * square modules painted to a canvas, so nothing about the code depends on a font.
 */
export class V3CodeRemoteQrOverlay extends Disposable {

	private readonly overlayDisposables = this._register(new DisposableStore());
	private element: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	/** Browser views this overlay hid on open, to restore on close. */
	private suppressedBrowserViews: IBrowserViewModel[] = [];

	constructor(
		private readonly host: HTMLElement,
		private readonly clipboardService: IClipboardService,
		private readonly browserViewService?: IBrowserViewWorkbenchService,
	) {
		super();
	}

	/**
	 * The integrated browser is a native Electron WebContentsView, which composites ABOVE the
	 * entire DOM — no z-index can put this overlay in front of it, so the QR code was simply
	 * covered. Hide any visible browser view while the overlay is up, and restore exactly the
	 * ones we hid.
	 */
	private suppressBrowserViews(): void {
		if (!this.browserViewService) { return; }
		for (const input of this.browserViewService.getKnownBrowserViews().values()) {
			const model = input.model;
			if (model?.visible) {
				this.suppressedBrowserViews.push(model);
				void model.setVisible(false);
			}
		}
	}

	private restoreBrowserViews(): void {
		const models = this.suppressedBrowserViews;
		this.suppressedBrowserViews = [];
		for (const model of models) {
			void model.setVisible(true);
		}
	}

	get isOpen(): boolean {
		return !!this.element;
	}

	open(onClose?: () => void): void {
		if (this.element) {
			return;
		}

		this.suppressBrowserViews();

		const overlay = append(this.host, $('.v3-remote-overlay'));
		this.element = overlay;

		const panel = append(overlay, $('.v3-remote-panel'));
		const close = append(panel, $('button.v3-remote-close')) as HTMLButtonElement;
		close.type = 'button';
		close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		close.setAttribute('aria-label', nls.localize('v3code.remote.close', "Close"));

		append(panel, $('.v3-remote-title')).textContent =
			nls.localize('v3code.remote.panelTitle', "Connect V3Code to your phone");

		this.body = append(panel, $('.v3-remote-body'));
		this.renderState({ status: 'pairing' });

		const dismiss = () => {
			this.close();
			onClose?.();
		};
		this.overlayDisposables.add(addDisposableListener(close, EventType.CLICK, dismiss));
		// Clicking the backdrop dismisses; clicking inside the panel must not.
		this.overlayDisposables.add(addDisposableListener(overlay, EventType.CLICK, e => {
			if (e.target === overlay) { dismiss(); }
		}));
		this.overlayDisposables.add(addDisposableListener(overlay.ownerDocument, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') { dismiss(); }
		}));
	}

	/**
	 * A monospace chip that copies its text on click. Both URLs in this panel need the
	 * same affordance, and neither can be a plain hyperlink: the account URL must reach
	 * the PHONE (opening it in a desktop browser pairs nothing), and the pairing URL is
	 * a vgo:// deep link no desktop handles.
	 */
	private appendCopyableUrl(parent: HTMLElement, text: string): void {
		const url = append(parent, $('.v3-remote-url')) as HTMLElement;
		url.textContent = text;
		url.title = nls.localize('v3code.remote.copyHint', "Click to copy");
		this.overlayDisposables.add(addDisposableListener(url, EventType.CLICK, () => {
			// The raw navigator clipboard is denied in the workbench's origin; the
			// workbench service is the supported path.
			void this.clipboardService.writeText(text);
			url.classList.add('is-copied');
		}));
	}

	/** Reflect the latest pairing state. Safe to call when the panel is closed. */
	renderState(state: IV3CodeRemoteState): void {
		const body = this.body;
		if (!body) {
			return;
		}
		clearNode(body);

		if (state.status === 'connected') {
			append(body, $('.v3-remote-status.is-connected')).textContent =
				nls.localize('v3code.remote.connected', "Your phone is connected and this machine is online.");
			append(body, $('.v3-remote-hint')).textContent =
				nls.localize('v3code.remote.connectedHint', "Open Terminals in the V3Code app on your phone to drive this editor.");
			return;
		}

		if (state.status === 'registering') {
			append(body, $('.v3-remote-status')).textContent =
				nls.localize('v3code.remote.registering', "Phone approved — bringing this machine online…");
			append(body, $('.v3-remote-hint')).textContent =
				nls.localize('v3code.remote.registeringHint', "Registering this machine so your phone can see it.");
			return;
		}

		if (state.status === 'error') {
			append(body, $('.v3-remote-status.is-error')).textContent =
				nls.localize('v3code.remote.failed', "Could not start pairing.");
			append(body, $('.v3-remote-hint')).textContent = state.message
				?? nls.localize('v3code.remote.failedHint', "Check that the V-Go CLI is installed.");
			return;
		}

		// A bare QR dead-ends a new user: the phone can only approve a pairing from an
		// account that already exists, so the account step must be step 1, in the panel,
		// with the URL visible — not knowledge the user is assumed to have.
		const steps = append(body, $('.v3-remote-steps'));
		append(steps, $('.v3-remote-step')).textContent =
			nls.localize('v3code.remote.stepAccount', "1. On your phone, open this site and create an account (or sign in):");
		this.appendCopyableUrl(steps, state.webappUrl ?? V3CODE_REMOTE_DEFAULT_WEBAPP_URL);
		append(steps, $('.v3-remote-step')).textContent =
			nls.localize('v3code.remote.stepScan', "2. Then go to Terminals and scan this code — or paste the link below.");

		const modules = state.qrRows?.length ? decodeQrModules(state.qrRows) : undefined;
		if (modules?.length) {
			const canvas = append(body, $('canvas.v3-remote-qr')) as HTMLCanvasElement;
			drawQr(canvas, modules);
			canvas.setAttribute('role', 'img');
			canvas.setAttribute('aria-label', nls.localize('v3code.remote.qrAlt', "Pairing QR code"));
		} else {
			append(body, $('.v3-remote-status')).textContent =
				nls.localize('v3code.remote.starting', "Starting pairing…");
		}

		// A camera does not always cooperate; the URL is the fallback, and it is the same
		// one encoded above.
		if (state.pairingUrl) {
			this.appendCopyableUrl(body, state.pairingUrl);
		}
	}

	close(): void {
		this.overlayDisposables.clear();
		this.element?.remove();
		this.element = undefined;
		this.body = undefined;
		// Always restore, even if the overlay was torn down by dispose rather than the close
		// button — otherwise the browser stays invisible with no way to get it back.
		this.restoreBrowserViews();
	}

	override dispose(): void {
		this.close();
		super.dispose();
	}
}
