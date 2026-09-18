/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Remote / mobile pairing shared between the renderer and the main process.
 *
 * The editor never speaks the pairing protocol itself: the `vgo` CLI owns the relay,
 * the key exchange and the credential store. The editor spawns it, shows the pairing
 * URL it prints, and reflects its lifecycle.
 */

export const V3CODE_REMOTE_CHANNEL = 'void-channel-remote';

export type V3CodeRemoteStatus =
	/** No CLI running. */
	| 'idle'
	/** CLI is up and waiting for a phone to scan and approve. */
	| 'pairing'
	/**
	 * The phone approved, and the machine daemon is registering with the relay. Pairing
	 * alone only stores credentials: without the daemon the phone lists this machine as
	 * offline forever, so `connected` is deliberately withheld until it has started.
	 */
	| 'registering'
	/** A phone is paired, and the daemon is keeping this machine online on the relay. */
	| 'connected'
	/** The CLI exited or could not be started. `message` says why. */
	| 'error';

export interface IV3CodeRemoteState {
	readonly status: V3CodeRemoteStatus;
	/**
	 * Present only while `pairing`. The URL a phone approves by scanning. Kept alongside
	 * the QR so the panel can also offer it as copyable text when a camera will not
	 * cooperate.
	 */
	readonly pairingUrl?: string;
	/**
	 * The web app the pairing run was started against. The panel shows it as the
	 * "create your account here first" link, so it must be the URL actually in use -
	 * not a constant the renderer guesses - or a self-hosted relay would pair against
	 * one app while the panel advertises another.
	 */
	readonly webappUrl?: string;
	/**
	 * The QR as rows of block characters, straight from the CLI's encoder. Rendering
	 * these rather than re-encoding the URL means the code on screen came from the same
	 * path that already works in a terminal.
	 */
	readonly qrRows?: string[];
	/** Human-readable failure reason; present only when `status === 'error'`. */
	readonly message?: string;
}

/**
 * The one line the CLI prints for a machine caller. Kept in sync with
 * `PAIRING_URL_STDOUT_PREFIX` in the v-go CLI (`src/ui/auth.ts`).
 */
export const VGO_PAIRING_URL_PREFIX = 'VGO_PAIRING_URL ';

/** Printed by the CLI instead of a URL when this machine is already paired. */
export const VGO_ALREADY_PAIRED_MARKER = 'VGO_ALREADY_PAIRED';

/** Fences the QR rows in the CLI's stdout. */
export const VGO_QR_BLOCK_BEGIN = 'VGO_PAIRING_QR_BEGIN';
export const VGO_QR_BLOCK_END = 'VGO_PAIRING_QR_END';

/** Defaults point at the hosted relay; both are overridable for self-host. */
export const V3CODE_REMOTE_DEFAULT_SERVER_URL = 'https://vgo-relay-production.up.railway.app';
export const V3CODE_REMOTE_DEFAULT_WEBAPP_URL = 'https://vgo-webapp-production.up.railway.app';

export interface IV3CodeRemoteStartOptions {
	/** Relay URL (`HAPPY_SERVER_URL`). */
	readonly serverUrl?: string;
	/** Web app the QR points at (`HAPPY_WEBAPP_URL`). */
	readonly webappUrl?: string;
	/** Absolute path to a `vgo` binary, when it is not on PATH. */
	readonly cliPath?: string;
}
