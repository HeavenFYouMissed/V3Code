/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { URI } from '../../../../base/common/uri.js';

export interface IV3CodeBroadcast {
	readonly id: string;
	readonly severity?: 'info' | 'warning' | 'error';
	/** Human-readable author shown in the editor; defaults to Daniel — V3Code. */
	readonly sender?: string;
	/** Banner is the large, immediately visible surface; notification stays in the bell. */
	readonly display?: 'banner' | 'notification';
	readonly title?: string;
	readonly body: string;
	readonly imageUrl?: string;
	readonly actions?: ReadonlyArray<{ readonly label: string; readonly href: string }>;
	readonly startsAt?: number;
	readonly endsAt?: number;
	readonly platform?: 'win32' | 'darwin' | 'linux';
}

export interface IV3CodeStatusBoard {
	readonly state: 'loading' | 'ready' | 'unavailable';
	readonly checkedAt?: number;
	readonly updates: readonly IV3CodeBroadcast[];
}

const MAX_NOTIFICATIONS = 100;
const MAX_BODY_LENGTH = 1_000;
const MAX_TITLE_LENGTH = 160;
const MAX_SENDER_LENGTH = 80;
const MAX_ACTIONS = 3;
const MAX_ACTION_LABEL_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const NOTIFICATION_KEYS = new Set(['id', 'severity', 'sender', 'display', 'title', 'body', 'imageUrl', 'actions', 'startsAt', 'endsAt', 'platform']);
const ACTION_KEYS = new Set(['label', 'href']);
const SEVERITIES = new Set(['info', 'warning', 'error']);
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const DISPLAYS = new Set(['banner', 'notification']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every(key => allowed.has(key));
}

function parseSafeHttpsUrl(value: string): URI | undefined {
	try {
		const uri = URI.parse(value);
		const authority = uri.authority.toLowerCase();
		if (uri.scheme !== 'https' || !authority || authority.includes('@') || authority.includes(':')) {
			return undefined;
		}
		if (authority !== 'v3code.dev' && !authority.endsWith('.v3code.dev')) {
			return undefined;
		}
		return uri;
	} catch {
		return undefined;
	}
}

export function isAllowedV3CodeActionUrl(value: string): boolean {
	return parseSafeHttpsUrl(value) !== undefined;
}

export function isAllowedV3CodeBroadcastImageUrl(value: string): boolean {
	const uri = parseSafeHttpsUrl(value);
	return !!uri
		&& uri.authority.toLowerCase() === 'update.v3code.dev'
		&& /^\/api\/notifications\/asset\/[A-Za-z0-9_.-]+$/.test(uri.path)
		&& !uri.query
		&& !uri.fragment;
}

function parseAction(value: unknown): { readonly label: string; readonly href: string } | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ACTION_KEYS)) {
		return undefined;
	}
	const { label, href } = value;
	if (typeof label !== 'string' || !label.trim() || label.length > MAX_ACTION_LABEL_LENGTH) {
		return undefined;
	}
	if (typeof href !== 'string' || !isAllowedV3CodeActionUrl(href)) {
		return undefined;
	}
	return { label, href };
}

function parseNotification(value: unknown): IV3CodeBroadcast | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, NOTIFICATION_KEYS)) {
		return undefined;
	}

	const { id, severity, sender, display, title, body, imageUrl, actions, startsAt, endsAt, platform } = value;
	if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
		return undefined;
	}
	if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY_LENGTH) {
		return undefined;
	}
	if (severity !== undefined && (typeof severity !== 'string' || !SEVERITIES.has(severity))) {
		return undefined;
	}
	if (sender !== undefined && (typeof sender !== 'string' || !sender.trim() || sender.length > MAX_SENDER_LENGTH)) {
		return undefined;
	}
	if (display !== undefined && (typeof display !== 'string' || !DISPLAYS.has(display))) {
		return undefined;
	}
	if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH)) {
		return undefined;
	}
	if (platform !== undefined && (typeof platform !== 'string' || !PLATFORMS.has(platform))) {
		return undefined;
	}
	if (startsAt !== undefined && (!Number.isSafeInteger(startsAt) || (startsAt as number) < 0)) {
		return undefined;
	}
	if (endsAt !== undefined && (!Number.isSafeInteger(endsAt) || (endsAt as number) < 0)) {
		return undefined;
	}
	if (typeof startsAt === 'number' && typeof endsAt === 'number' && endsAt < startsAt) {
		return undefined;
	}
	if (imageUrl !== undefined && (typeof imageUrl !== 'string' || !isAllowedV3CodeBroadcastImageUrl(imageUrl))) {
		return undefined;
	}

	let parsedActions: ReadonlyArray<{ readonly label: string; readonly href: string }> | undefined;
	if (actions !== undefined) {
		if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) {
			return undefined;
		}
		const validated = actions.map(parseAction);
		if (validated.some(action => action === undefined)) {
			return undefined;
		}
		parsedActions = validated as ReadonlyArray<{ readonly label: string; readonly href: string }>;
	}

	return {
		id,
		body,
		severity: severity as IV3CodeBroadcast['severity'],
		sender: sender as string | undefined,
		display: display as IV3CodeBroadcast['display'],
		title: title as string | undefined,
		imageUrl: imageUrl as string | undefined,
		actions: parsedActions,
		startsAt: startsAt as number | undefined,
		endsAt: endsAt as number | undefined,
		platform: platform as IV3CodeBroadcast['platform'],
	};
}

/**
 * Treat the remote feed as untrusted input. One malformed item invalidates only that item;
 * an invalid root or oversized feed is rejected completely.
 */
export function parseV3CodeBroadcastFeed(value: unknown): readonly IV3CodeBroadcast[] {
	if (!isRecord(value) || !hasOnlyKeys(value, new Set(['notifications'])) || !Array.isArray(value.notifications) || value.notifications.length > MAX_NOTIFICATIONS) {
		return [];
	}
	return value.notifications.map(parseNotification).filter((item): item is IV3CodeBroadcast => item !== undefined);
}
