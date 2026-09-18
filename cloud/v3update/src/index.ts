/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  v3update Worker — auto-update server for the V3Code editor. Serves the IUpdate
 *  manifest the electron-main update services expect (see abstractUpdateService.ts /
 *  updateService.darwin.ts / updateService.win32.ts in VSElite) and streams release
 *  artifacts out of R2. No Durable Objects — this is a stateless read path over a
 *  bucket CI writes to.
 *--------------------------------------------------------------------------------------*/

import type { Env, ReleaseManifest } from './env.js';

// The client (AbstractUpdateService#isLatestVersion / doCheckForUpdates in both
// updateService.darwin.ts and updateService.win32.ts) treats HTTP 204 as "no update
// available" and, for 200 responses, requires update.url/version/productVersion to
// all be present or it silently discards the payload as "no update" anyway. So a 200
// response from this worker must always carry a complete IUpdate-shaped body.
const NO_UPDATE = 204;

// Client-side cache hint only: Workers responses are NOT stored in Cloudflare's edge
// cache (we never touch caches.default), so every poll is one R2 class-B read. The
// short max-age just keeps a single HTTP-caching client from hammering the endpoint,
// and bounds how stale a just-published manifest can look to such clients.
const MANIFEST_CACHE = 'public, max-age=60';
// Download filenames are content-addressed by the publish script (commit + sha in the
// name), so once published a given URL's bytes never change — safe for CLIENTS to
// cache "forever" (again: no edge caching happens here; immutability protects browser
// caches from a reused filename serving stale bytes).
const DOWNLOAD_CACHE = 'public, max-age=31536000, immutable';

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...extraHeaders },
	});
}

/** Translate the CI-produced R2 manifest into the shape BOTH consumers of the feed
 *  URL parse: the IUpdate reader (common/update.ts: url/version/productVersion/
 *  sha256hash/timestamp) and Squirrel.Mac itself, which electron.autoUpdater points
 *  at this URL. Squirrel reads { url, name, notes, pub_date }, and the darwin service
 *  maps its update-downloaded event args (releaseNotes, releaseName) to (version,
 *  productVersion) — so `notes` MUST carry the commit and `name` the productVersion,
 *  or the post-download update object has version undefined and the overwrite-update
 *  machinery dies silently. */
function toIUpdate(manifest: ReleaseManifest) {
	return {
		url: manifest.url,
		name: manifest.name,
		notes: manifest.version,
		pub_date: new Date(manifest.timestamp).toISOString(),
		version: manifest.version,
		productVersion: manifest.productVersion,
		sha256hash: manifest.sha256hash,
		timestamp: manifest.timestamp,
	};
}

async function readManifest(env: Env, quality: string, platform: string): Promise<ReleaseManifest | null> {
	const obj = await env.RELEASES.get(`manifests/${quality}/${platform}/latest.json`);
	if (!obj) return null;
	try {
		return await obj.json<ReleaseManifest>();
	} catch (e) {
		// A corrupt manifest must degrade to "no update" (204/404), not turn every
		// fleet update check into a 500 until someone re-publishes.
		console.error(`readManifest: corrupt JSON at manifests/${quality}/${platform}/latest.json`, e);
		return null;
	}
}

/** GET /api/update/:platform/:quality/:commit — the electron-main update feed URL.
 *
 * `commit` and manifest.version are opaque Git SHAs: inequality proves only "different", never
 * "older". The publisher therefore records the known predecessor commits in `supersedes`, and an
 * update is served only to those commits. Unknown/manual/newer builds fail closed with 204. */
async function handleUpdateCheck(env: Env, platform: string, quality: string, commit: string): Promise<Response> {
	const manifest = await readManifest(env, quality, platform);
	if (!manifest) return new Response(null, { status: NO_UPDATE, headers: { 'cache-control': MANIFEST_CACHE } });

	if (manifest.version === commit) {
		// Already on the latest build — this is the common-case response on every
		// hourly poll, so it rides the same short cache as a real manifest hit.
		return new Response(null, { status: NO_UPDATE, headers: { 'cache-control': MANIFEST_CACHE } });
	}
	if (!Array.isArray(manifest.supersedes) || !manifest.supersedes.includes(commit)) {
		// A legacy manifest with no ordering metadata and an unknown/newer client are the same safety
		// question: we cannot prove this artifact is an upgrade. Never turn inequality into downgrade.
		return new Response(null, { status: NO_UPDATE, headers: { 'cache-control': MANIFEST_CACHE } });
	}

	return json(toIUpdate(manifest), 200, { 'cache-control': MANIFEST_CACHE });
}

/** GET /api/latest/:platform/:quality — manifest as-is, for the website's download
 *  buttons (no commit to compare against, no 204 branch). */
async function handleLatest(env: Env, platform: string, quality: string): Promise<Response> {
	const manifest = await readManifest(env, quality, platform);
	if (!manifest) return json({ error: 'not found' }, 404);
	return json(manifest, 200, { 'cache-control': MANIFEST_CACHE });
}

/** GET|HEAD /download/:quality/:platform/:filename — streams the artifact bytes
 *  straight from R2, forwarding Range so resumable/segmented downloads work without
 *  buffering the whole object in the Worker. */
async function handleDownload(env: Env, quality: string, platform: string, filename: string, request: Request): Promise<Response> {
	// The publish script writes filenames using URL-unreserved characters only, but
	// decode defensively so a client that percent-encodes (e.g. %2D for '-') still
	// hits the same R2 key.
	const key = `builds/${quality}/${platform}/${decodeURIComponent(filename)}`;

	// HEAD answers from object metadata only — a get() would read the whole
	// multi-hundred-MB artifact out of R2 just for the runtime to drop the body.
	if (request.method === 'HEAD') {
		const head = await env.RELEASES.head(key);
		if (!head) return json({ error: 'not found' }, 404);
		const headers = new Headers();
		head.writeHttpMetadata(headers);
		headers.set('etag', head.httpEtag);
		headers.set('cache-control', DOWNLOAD_CACHE);
		headers.set('accept-ranges', 'bytes');
		if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
		headers.set('content-length', String(head.size));
		return new Response(null, { status: 200, headers });
	}

	const rangeHeader = request.headers.get('range');
	const parsedRange = rangeHeader ? parseRangeHeader(rangeHeader) : undefined;

	let obj: R2ObjectBody | null;
	try {
		obj = parsedRange
			? await env.RELEASES.get(key, { range: parsedRange })
			: await env.RELEASES.get(key);
	} catch {
		// R2 throws on unsatisfiable ranges (typically a download manager resuming
		// an already-complete file with offset === size). Answer 416 like a proper
		// HTTP server instead of bubbling an uncaught 500 at the fleet.
		const head = await env.RELEASES.head(key);
		if (!head) return json({ error: 'not found' }, 404);
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${head.size}`, 'cache-control': DOWNLOAD_CACHE },
		});
	}

	if (!obj) return json({ error: 'not found' }, 404);

	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set('etag', obj.httpEtag);
	headers.set('cache-control', DOWNLOAD_CACHE);
	headers.set('accept-ranges', 'bytes');
	if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');

	// 206 only when WE parsed a range AND R2 honored it (R2Object carries `range`
	// only for honored range gets). Gating on our parse means an unparseable header
	// (suffix ranges, multi-range) degrades to a clean 200 full-object response on
	// every runtime, instead of a 206 mislabeled with the full body.
	const servedRange = (obj as R2ObjectBody & { range?: R2Range }).range;
	if (parsedRange && servedRange && 'offset' in servedRange && 'length' in servedRange) {
		const start = servedRange.offset ?? 0;
		const end = start + (servedRange.length ?? 0) - 1;
		headers.set('content-range', `bytes ${start}-${end}/${obj.size}`);
		headers.set('content-length', String(servedRange.length));
		return new Response(obj.body, { status: 206, headers });
	}

	headers.set('content-length', String(obj.size));
	return new Response(obj.body, { status: 200, headers });
}

/** Parses a single-range `Range: bytes=start-end` header into R2's {offset, length}
 *  form. Multi-range requests and malformed headers fall back to `undefined`, which
 *  makes R2Bucket#get() return the full object (safe default — worst case we ignore
 *  the range instead of erroring). */
function parseRangeHeader(header: string): R2Range | undefined {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return undefined;
	const [, startStr, endStr] = match;
	if (startStr === '' && endStr === '') return undefined;

	if (startStr === '') {
		// Suffix range, e.g. "bytes=-500" — last 500 bytes. R2 has no native suffix
		// form, so this needs the object size to resolve; the 206 branch above is
		// gated on this parse, so suffix requests get an honest 200 full object.
		return undefined;
	}

	const offset = Number(startStr);
	if (endStr === '') return { offset };
	const end = Number(endStr);
	if (!Number.isFinite(offset) || !Number.isFinite(end) || end < offset) return undefined;
	return { offset, length: end - offset + 1 };
}

// ---- analytics: download + install tracking (all non-blocking; NEVER throws into
// the request path — a D1 hiccup must never affect serving bytes or an update check) ----

/** Record one successful download byte-serve (GET 200/206). Resumes/segments land as
 *  is_range=1 rows; dedup to real downloads with COUNT(DISTINCT ip||filename||day). */
async function logDownload(env: Env, request: Request, url: URL, meta: { quality: string; platform: string; filename: string; isRange: boolean }): Promise<void> {
	if (!env.ANALYTICS) { return; }
	try {
		const cf = request.cf as IncomingRequestCfProperties | undefined;
		await env.ANALYTICS.prepare(
			`INSERT INTO downloads (ts, ip, country, city, platform, quality, filename, src, referer, ua, is_range)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(
			Date.now(),
			request.headers.get('cf-connecting-ip'),
			cf?.country ?? null,
			cf?.city ?? null,
			meta.platform,
			meta.quality,
			decodeURIComponent(meta.filename),
			url.searchParams.get('src'),
			request.headers.get('referer'),
			request.headers.get('user-agent'),
			meta.isRange ? 1 : 0,
		).run();
	} catch (e) {
		console.error('logDownload failed', e);
	}
}

/** Upsert the running install's ping (per update poll) so we can count active installs
 *  without unbounded growth — hourly polls just bump last_seen/hits in place. */
async function logInstallPing(env: Env, request: Request, platform: string, quality: string, commit: string): Promise<void> {
	if (!env.ANALYTICS) { return; }
	try {
		const cf = request.cf as IncomingRequestCfProperties | undefined;
		const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
		const now = Date.now();
		await env.ANALYTICS.prepare(
			`INSERT INTO install_pings (ip, platform, quality, commit_id, country, first_seen, last_seen, hits)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1)
			 ON CONFLICT(ip, platform, commit_id) DO UPDATE SET
			   last_seen = excluded.last_seen,
			   quality = excluded.quality,
			   country = excluded.country,
			   hits = hits + 1`
		).bind(ip, platform, quality, commit, cf?.country ?? null, now, now).run();
	} catch (e) {
		console.error('logInstallPing failed', e);
	}
}

type ProductVoteAggregateRow = {
	choice: string;
	n: number;
	last_vote_at: number | null;
};

type AgentsBetaVoteTally = {
	available: boolean;
	total: number;
	yes: number;
	no: number;
	last_vote_at: number | null;
	note?: string;
};

type RuntimeAdoptionBuildRow = {
	commit_id: string;
	product_version: string;
	installs_seen: number;
	launched: number;
	runtime_ready: number;
	ai_attempted: number;
	ai_succeeded: number;
	never_attempted: number;
	attempted_without_success: number;
	failed_without_success: number;
	last_event_at: number | null;
};

type RuntimeAdoptionSummary = {
	available: boolean;
	window_days: number;
	installs_seen: number;
	launched: number;
	runtime_ready: number;
	ai_attempted: number;
	ai_succeeded: number;
	never_attempted: number;
	attempted_without_success: number;
	failed_without_success: number;
	last_event_at: number | null;
	builds: RuntimeAdoptionBuildRow[];
	note?: string;
};

function numberValue(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumberValue(value: unknown): number | null {
	if (value == null) { return null; }
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Aggregate only fleet-health counts. Installation hashes never leave D1. */
async function readRuntimeAdoption(db: D1Database, since: number, days: number): Promise<RuntimeAdoptionSummary> {
	try {
		const aggregateSql = `
			COUNT(*) AS installs_seen,
			SUM(CASE WHEN launched_at IS NOT NULL THEN 1 ELSE 0 END) AS launched,
			SUM(CASE WHEN runtime_ready_at IS NOT NULL THEN 1 ELSE 0 END) AS runtime_ready,
			SUM(CASE WHEN ai_first_attempt_at IS NOT NULL THEN 1 ELSE 0 END) AS ai_attempted,
			SUM(CASE WHEN ai_first_success_at IS NOT NULL THEN 1 ELSE 0 END) AS ai_succeeded,
			SUM(CASE WHEN runtime_ready_at IS NOT NULL AND ai_first_attempt_at IS NULL THEN 1 ELSE 0 END) AS never_attempted,
			SUM(CASE WHEN ai_first_attempt_at IS NOT NULL AND ai_first_success_at IS NULL THEN 1 ELSE 0 END) AS attempted_without_success,
			SUM(CASE WHEN ai_last_failure_at IS NOT NULL AND ai_first_success_at IS NULL THEN 1 ELSE 0 END) AS failed_without_success,
			MAX(last_seen) AS last_event_at`;

		const [total, builds] = await Promise.all([
			db.prepare(`SELECT ${aggregateSql} FROM runtime_install_state WHERE last_seen >= ?`).bind(since).first(),
			db.prepare(
				`SELECT commit_id, product_version, ${aggregateSql}
				 FROM runtime_install_state
				 WHERE last_seen >= ?
				 GROUP BY commit_id, product_version
				 ORDER BY last_event_at DESC
				 LIMIT 20`
			).bind(since).all<RuntimeAdoptionBuildRow>(),
		]);

		const normalizedBuilds = builds.results.map(row => ({
			commit_id: String(row.commit_id),
			product_version: String(row.product_version),
			installs_seen: numberValue(row.installs_seen),
			launched: numberValue(row.launched),
			runtime_ready: numberValue(row.runtime_ready),
			ai_attempted: numberValue(row.ai_attempted),
			ai_succeeded: numberValue(row.ai_succeeded),
			never_attempted: numberValue(row.never_attempted),
			attempted_without_success: numberValue(row.attempted_without_success),
			failed_without_success: numberValue(row.failed_without_success),
			last_event_at: nullableNumberValue(row.last_event_at),
		}));

		return {
			available: true,
			window_days: days,
			installs_seen: numberValue(total?.installs_seen),
			launched: numberValue(total?.launched),
			runtime_ready: numberValue(total?.runtime_ready),
			ai_attempted: numberValue(total?.ai_attempted),
			ai_succeeded: numberValue(total?.ai_succeeded),
			never_attempted: numberValue(total?.never_attempted),
			attempted_without_success: numberValue(total?.attempted_without_success),
			failed_without_success: numberValue(total?.failed_without_success),
			last_event_at: nullableNumberValue(total?.last_event_at),
			builds: normalizedBuilds,
		};
	} catch (error) {
		console.error('readRuntimeAdoption failed', error);
		return {
			available: false,
			window_days: days,
			installs_seen: 0,
			launched: 0,
			runtime_ready: 0,
			ai_attempted: 0,
			ai_succeeded: 0,
			never_attempted: 0,
			attempted_without_success: 0,
			failed_without_success: 0,
			last_event_at: null,
			builds: [],
			note: 'Runtime adoption storage is not available yet.',
		};
	}
}

/** Read only the aggregate product signal needed by the owner dashboard. The
 *  installation hash never leaves D1. Missing migration/schema state must not
 *  make the existing download analytics panel disappear. */
async function readAgentsBetaVoteTally(db: D1Database): Promise<AgentsBetaVoteTally> {
	try {
		const rows = await db.prepare(
			`SELECT choice, COUNT(*) AS n, MAX(updated_at) AS last_vote_at
			 FROM product_votes
			 WHERE survey_id = ?
			 GROUP BY choice`
		).bind(AGENTS_BETA_SURVEY_ID).all<ProductVoteAggregateRow>();

		let yes = 0;
		let no = 0;
		let lastVoteAt: number | null = null;
		for (const row of rows.results) {
			const count = Number(row.n) || 0;
			if (row.choice === 'yes') { yes = count; }
			if (row.choice === 'no') { no = count; }
			const updatedAt = row.last_vote_at == null ? null : Number(row.last_vote_at);
			if (updatedAt != null && Number.isFinite(updatedAt)) {
				lastVoteAt = Math.max(lastVoteAt ?? 0, updatedAt);
			}
		}

		return { available: true, total: yes + no, yes, no, last_vote_at: lastVoteAt };
	} catch (error) {
		console.error('readAgentsBetaVoteTally failed', error);
		return {
			available: false,
			total: 0,
			yes: 0,
			no: 0,
			last_vote_at: null,
			note: 'Product vote storage is not available yet.',
		};
	}
}

/** GET /api/stats?days=30 — download, install, runtime-health, and anonymous
 *  product-vote rollups for the admin view. Gated by the x-admin-token header
 *  because the legacy download readout exposes IPs. New runtime milestones and
 *  product votes expose aggregate counts only. */
async function handleStats(env: Env, request: Request, url: URL): Promise<Response> {
	if (!env.ANALYTICS) { return json({ error: 'analytics not configured' }, 503); }
	// Header auth keeps the secret out of URLs, request histories, and access logs.
	// Query auth remains temporarily supported for older internal callers.
	const token = request.headers.get('x-admin-token') ?? url.searchParams.get('token') ?? '';
	if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) { return json({ error: 'unauthorized' }, 401); }

	const daysParam = Number(url.searchParams.get('days') ?? '30');
	const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : 30;
	const since = Date.now() - days * 86_400_000;
	const db = env.ANALYTICS;

	const [totals, byPlatform, bySrc, byCountry, byDay, recent, installs, agentsBetaVotes, runtimeAdoption] = await Promise.all([
		db.prepare(`SELECT COUNT(*) AS rows, COUNT(DISTINCT ip) AS ips, COUNT(DISTINCT ip || '|' || filename || '|' || (ts/86400000)) AS downloads FROM downloads WHERE ts >= ?`).bind(since).first(),
		db.prepare(`SELECT platform, COUNT(*) AS n, COUNT(DISTINCT ip) AS ips FROM downloads WHERE ts >= ? GROUP BY platform ORDER BY n DESC`).bind(since).all(),
		db.prepare(`SELECT COALESCE(src,'(direct)') AS src, COUNT(*) AS n, COUNT(DISTINCT ip) AS ips FROM downloads WHERE ts >= ? GROUP BY src ORDER BY n DESC`).bind(since).all(),
		db.prepare(`SELECT COALESCE(country,'??') AS country, COUNT(*) AS n, COUNT(DISTINCT ip) AS ips FROM downloads WHERE ts >= ? GROUP BY country ORDER BY n DESC LIMIT 30`).bind(since).all(),
		db.prepare(`SELECT date(ts/1000,'unixepoch') AS day, COUNT(*) AS n, COUNT(DISTINCT ip) AS ips FROM downloads WHERE ts >= ? GROUP BY day ORDER BY day DESC LIMIT 60`).bind(since).all(),
		db.prepare(`SELECT ts, ip, country, city, platform, quality, filename, COALESCE(src,'(direct)') AS src, referer FROM downloads ORDER BY ts DESC LIMIT 50`).all(),
		db.prepare(`SELECT COUNT(*) AS unique_installs, COUNT(DISTINCT ip) AS ips, SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END) AS active_7d FROM install_pings`).bind(Date.now() - 7 * 86_400_000).first(),
		readAgentsBetaVoteTally(db),
		readRuntimeAdoption(db, since, days),
	]);

	return json({
		window_days: days,
		generated_at: new Date().toISOString(),
		downloads: {
			total_rows: totals?.rows ?? 0,
			estimated_downloads: totals?.downloads ?? 0, // distinct ip+file+day
			unique_ips: totals?.ips ?? 0,
			by_platform: byPlatform.results,
			by_source: bySrc.results,
			by_country: byCountry.results,
			by_day: byDay.results,
			recent: recent.results,
		},
		installs: {
			unique_installs: installs?.unique_installs ?? 0,
			unique_ips: installs?.ips ?? 0,
			active_last_7d: installs?.active_7d ?? 0,
		},
		product_votes: {
			agents_beta: agentsBetaVotes,
		},
		runtime_adoption: runtimeAdoption,
	});
}

/** Broadcast-notifications feed (see v3codeBroadcastService.ts in VSElite).
 *  GET  /api/notifications             → the feed JSON ({ notifications: [...] })
 *  PUT  /api/notifications             → replace the feed (x-admin-token gated)
 *  GET  /api/notifications/asset/:name → an image referenced by a broadcast
 *  PUT  /api/notifications/asset/:name → upload an image (x-admin-token gated)
 *  Publishing a broadcast is one curl (or one R2 upload) — no app update involved. */
const BROADCASTS_KEY = 'broadcasts/broadcasts.json';
const MAX_BROADCAST_FEED_BYTES = 128 * 1024;
const MAX_BROADCAST_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_BROADCAST_NOTIFICATIONS = 100;
const MAX_BROADCAST_BODY_LENGTH = 1_000;
const MAX_BROADCAST_TITLE_LENGTH = 160;
const MAX_BROADCAST_SENDER_LENGTH = 80;
const MAX_BROADCAST_ACTIONS = 3;
const MAX_BROADCAST_ACTION_LABEL_LENGTH = 64;
const BROADCAST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const BROADCAST_ASSET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const BROADCAST_NOTIFICATION_KEYS = new Set(['id', 'severity', 'sender', 'display', 'title', 'body', 'imageUrl', 'actions', 'startsAt', 'endsAt', 'platform']);
const BROADCAST_ACTION_KEYS = new Set(['label', 'href']);
const BROADCAST_SEVERITIES = new Set(['info', 'warning', 'error']);
const BROADCAST_DISPLAYS = new Set(['banner', 'notification']);
const BROADCAST_PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const BROADCAST_IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const BROADCAST_CORS_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'access-control-max-age': '86400',
} as const;

function withBroadcastCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(BROADCAST_CORS_HEADERS)) {
		headers.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function broadcastCorsPreflight(): Response {
	return new Response(null, { status: 204, headers: BROADCAST_CORS_HEADERS });
}

function adminAuthorized(env: Env, request: Request): boolean {
	const token = request.headers.get('x-admin-token') ?? '';
	return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every(key => allowed.has(key));
}

function isAllowedV3CodeHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:'
			&& !url.username
			&& !url.password
			&& !url.port
			&& (url.hostname === 'v3code.dev' || url.hostname.endsWith('.v3code.dev'));
	} catch {
		return false;
	}
}

function isAllowedBroadcastImageUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return isAllowedV3CodeHttpsUrl(value)
			&& url.hostname === 'update.v3code.dev'
			&& BROADCAST_ASSET_NAME_PATTERN.test(url.pathname.replace('/api/notifications/asset/', ''))
			&& url.pathname.startsWith('/api/notifications/asset/')
			&& !url.search
			&& !url.hash;
	} catch {
		return false;
	}
}

function validateBroadcastFeed(value: unknown): string | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, new Set(['notifications'])) || !Array.isArray(value.notifications)) {
		return 'body must be exactly { "notifications": [...] }';
	}
	if (value.notifications.length > MAX_BROADCAST_NOTIFICATIONS) {
		return `notifications cannot exceed ${MAX_BROADCAST_NOTIFICATIONS} items`;
	}

	const ids = new Set<string>();
	for (const notification of value.notifications) {
		if (!isRecord(notification) || !hasOnlyKeys(notification, BROADCAST_NOTIFICATION_KEYS)) {
			return 'every notification must use only documented fields';
		}
		const { id, severity, sender, display, title, body, imageUrl, actions, startsAt, endsAt, platform } = notification;
		if (typeof id !== 'string' || !BROADCAST_ID_PATTERN.test(id) || ids.has(id)) {
			return 'every notification needs a unique, safe id (1-80 characters)';
		}
		ids.add(id);
		if (typeof body !== 'string' || !body.trim() || body.length > MAX_BROADCAST_BODY_LENGTH) {
			return `every notification needs non-empty body text up to ${MAX_BROADCAST_BODY_LENGTH} characters`;
		}
		if (severity !== undefined && (typeof severity !== 'string' || !BROADCAST_SEVERITIES.has(severity))) {
			return 'severity must be info, warning, or error';
		}
		if (sender !== undefined && (typeof sender !== 'string' || !sender.trim() || sender.length > MAX_BROADCAST_SENDER_LENGTH)) {
			return `sender must be non-empty text up to ${MAX_BROADCAST_SENDER_LENGTH} characters`;
		}
		if (display !== undefined && (typeof display !== 'string' || !BROADCAST_DISPLAYS.has(display))) {
			return 'display must be banner or notification';
		}
		if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > MAX_BROADCAST_TITLE_LENGTH)) {
			return `title must be non-empty text up to ${MAX_BROADCAST_TITLE_LENGTH} characters`;
		}
		if (platform !== undefined && (typeof platform !== 'string' || !BROADCAST_PLATFORMS.has(platform))) {
			return 'platform must be win32, darwin, or linux';
		}
		if (startsAt !== undefined && (!Number.isSafeInteger(startsAt) || (startsAt as number) < 0)) {
			return 'startsAt must be a non-negative integer timestamp';
		}
		if (endsAt !== undefined && (!Number.isSafeInteger(endsAt) || (endsAt as number) < 0)) {
			return 'endsAt must be a non-negative integer timestamp';
		}
		if (typeof startsAt === 'number' && typeof endsAt === 'number' && endsAt < startsAt) {
			return 'endsAt must not be earlier than startsAt';
		}
		if (imageUrl !== undefined && (typeof imageUrl !== 'string' || !isAllowedBroadcastImageUrl(imageUrl))) {
			return 'imageUrl must use the V3Code broadcast asset endpoint';
		}
		if (actions !== undefined) {
			if (!Array.isArray(actions) || actions.length > MAX_BROADCAST_ACTIONS) {
				return `actions must contain no more than ${MAX_BROADCAST_ACTIONS} items`;
			}
			for (const action of actions) {
				if (!isRecord(action) || !hasOnlyKeys(action, BROADCAST_ACTION_KEYS)) {
					return 'every action must contain only label and href';
				}
				if (typeof action.label !== 'string' || !action.label.trim() || action.label.length > MAX_BROADCAST_ACTION_LABEL_LENGTH) {
					return `action labels must be non-empty text up to ${MAX_BROADCAST_ACTION_LABEL_LENGTH} characters`;
				}
				if (typeof action.href !== 'string' || !isAllowedV3CodeHttpsUrl(action.href)) {
					return 'action hrefs must be HTTPS URLs owned by v3code.dev';
				}
			}
		}
	}
	return undefined;
}

async function readBodyWithLimit(request: Request, maxBytes: number): Promise<Uint8Array | undefined> {
	const declaredLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		return undefined;
	}
	if (!request.body) {
		return new Uint8Array();
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) { break; }
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}

	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

async function handleBroadcastsFeed(env: Env, request: Request): Promise<Response> {
	if (request.method === 'GET') {
		const obj = await env.RELEASES.get(BROADCASTS_KEY);
		if (!obj) { return json({ notifications: [] }, 200, { 'cache-control': 'no-store' }); }
		try {
			const stored = JSON.parse(await obj.text()) as unknown;
			const validationError = validateBroadcastFeed(stored);
			if (validationError) {
				console.error('stored broadcast feed failed validation', validationError);
				return json({ notifications: [] }, 200, { 'cache-control': 'no-store' });
			}
			return json(stored, 200, { 'cache-control': 'no-store' });
		} catch (e) {
			console.error('stored broadcast feed is not valid JSON', e);
			return json({ notifications: [] }, 200, { 'cache-control': 'no-store' });
		}
	}
	if (request.method === 'PUT') {
		if (!adminAuthorized(env, request)) { return json({ error: 'unauthorized' }, 401); }
		const body = await readBodyWithLimit(request, MAX_BROADCAST_FEED_BYTES);
		if (!body) { return json({ error: `body exceeds ${MAX_BROADCAST_FEED_BYTES} bytes` }, 413); }
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(body));
		} catch {
			return json({ error: 'body is not valid JSON' }, 400);
		}
		const validationError = validateBroadcastFeed(parsed);
		if (validationError) { return json({ error: validationError }, 400); }
		await env.RELEASES.put(BROADCASTS_KEY, JSON.stringify(parsed), {
			httpMetadata: { contentType: 'application/json' },
		});
		return json({ ok: true, count: (parsed as { notifications: unknown[] }).notifications.length });
	}
	return json({ error: 'method not allowed' }, 405);
}

async function handleBroadcastAsset(env: Env, request: Request, url: URL, name: string): Promise<Response> {
	// Basename only — no path traversal into the release artifacts.
	if (!BROADCAST_ASSET_NAME_PATTERN.test(name)) { return json({ error: 'bad asset name' }, 400); }
	const key = `broadcasts/assets/${name}`;
	if (request.method === 'GET') {
		const obj = await env.RELEASES.get(key);
		if (!obj) { return json({ error: 'not found' }, 404); }
		return new Response(obj.body, {
			status: 200,
			headers: {
				'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
				'cache-control': DOWNLOAD_CACHE,
			},
		});
	}
	if (request.method === 'PUT') {
		if (!adminAuthorized(env, request)) { return json({ error: 'unauthorized' }, 401); }
		const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
		if (!BROADCAST_IMAGE_CONTENT_TYPES.has(contentType)) {
			return json({ error: 'content-type must be image/png, image/jpeg, or image/webp' }, 415);
		}
		const body = await readBodyWithLimit(request, MAX_BROADCAST_ASSET_BYTES);
		if (!body) { return json({ error: `asset exceeds ${MAX_BROADCAST_ASSET_BYTES} bytes` }, 413); }
		if (!body.byteLength) { return json({ error: 'asset body is empty' }, 400); }
		await env.RELEASES.put(key, body, {
			httpMetadata: { contentType },
		});
		return json({ ok: true, url: `${url.origin}/api/notifications/asset/${name}` });
	}
	return json({ error: 'method not allowed' }, 405);
}

// ---- anonymous product vote: whether users want a redesigned Agents experience ----
// The editor creates a random machine-local UUID. The Worker hashes it before storage,
// so D1 contains only one replaceable vote per installation — no account, prompt,
// filename, IP address, or other editor data is recorded by this route.
const AGENTS_BETA_SURVEY_ID = 'agents-beta-return';
const MAX_PRODUCT_VOTE_BYTES = 512;
const PRODUCT_VOTE_CHOICES = new Set(['yes', 'no']);
const PRODUCT_VOTE_KEYS = new Set(['choice', 'voterId']);
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_VOTE_CORS_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers': 'content-type',
	'access-control-max-age': '86400',
} as const;

function withProductVoteCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(PRODUCT_VOTE_CORS_HEADERS)) {
		headers.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function productVoteCorsPreflight(): Response {
	return new Response(null, { status: 204, headers: PRODUCT_VOTE_CORS_HEADERS });
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function handleAgentsBetaVote(env: Env, request: Request): Promise<Response> {
	if (request.method !== 'POST') {
		return json({ error: 'method not allowed' }, 405);
	}
	if (!env.ANALYTICS) {
		return json({ error: 'voting not configured' }, 503);
	}
	const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (contentType !== 'application/json') {
		return json({ error: 'content-type must be application/json' }, 415);
	}
	const body = await readBodyWithLimit(request, MAX_PRODUCT_VOTE_BYTES);
	if (!body) {
		return json({ error: `body exceeds ${MAX_PRODUCT_VOTE_BYTES} bytes` }, 413);
	}

	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return json({ error: 'body is not valid JSON' }, 400);
	}
	if (!isRecord(value) || !hasOnlyKeys(value, PRODUCT_VOTE_KEYS)) {
		return json({ error: 'body must be exactly { "choice": "yes|no", "voterId": "uuid" }' }, 400);
	}
	const { choice, voterId } = value;
	if (typeof choice !== 'string' || !PRODUCT_VOTE_CHOICES.has(choice)) {
		return json({ error: 'choice must be yes or no' }, 400);
	}
	if (typeof voterId !== 'string' || !INSTALLATION_ID_PATTERN.test(voterId)) {
		return json({ error: 'voterId must be a UUID' }, 400);
	}

	try {
		const voterHash = await sha256Hex(`${AGENTS_BETA_SURVEY_ID}\0${voterId.toLowerCase()}`);
		await env.ANALYTICS.prepare(
			`INSERT INTO product_votes (survey_id, voter_hash, choice, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(survey_id, voter_hash) DO UPDATE SET
			   choice = excluded.choice,
			   updated_at = excluded.updated_at`
		).bind(AGENTS_BETA_SURVEY_ID, voterHash, choice, Date.now()).run();
		return json({ ok: true });
	} catch (error) {
		console.error('handleAgentsBetaVote failed', error);
		return json({ error: 'voting temporarily unavailable' }, 503);
	}
}

// ---- privacy-safe runtime adoption milestones ----
// Accepts only a fixed, bounded schema. The installation UUID is hashed before
// storage and the request cannot carry prompts, code, paths, account identity,
// provider/model names, keys, response content, or arbitrary error strings.
const RUNTIME_EVENT_SCHEMA_VERSION = 1;
const MAX_RUNTIME_EVENT_BYTES = 1_024;
const RUNTIME_EVENT_KEYS = new Set([
	'schemaVersion',
	'installationId',
	'event',
	'commit',
	'productVersion',
	'platform',
	'quality',
	'failureCode',
]);
const RUNTIME_EVENTS = new Set([
	'app_launched',
	'runtime_ready',
	'ai_request_started',
	'ai_response_succeeded',
	'ai_request_failed',
]);
const RUNTIME_FAILURE_CODES = new Set([
	'provider_auth',
	'provider_unavailable',
	'model_unavailable',
	'network',
	'rate_limited',
	'runtime_not_ready',
	'unknown',
]);
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const PLATFORM_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const QUALITY_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
const RUNTIME_EVENT_CORS_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers': 'content-type',
	'access-control-max-age': '86400',
} as const;

function withRuntimeEventCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(RUNTIME_EVENT_CORS_HEADERS)) {
		headers.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function runtimeEventCorsPreflight(): Response {
	return new Response(null, { status: 204, headers: RUNTIME_EVENT_CORS_HEADERS });
}

type RuntimeEventName = 'app_launched' | 'runtime_ready' | 'ai_request_started' | 'ai_response_succeeded' | 'ai_request_failed';

async function handleRuntimeEvent(env: Env, request: Request): Promise<Response> {
	if (request.method !== 'POST') { return json({ error: 'method not allowed' }, 405); }
	if (!env.ANALYTICS) { return json({ error: 'runtime analytics not configured' }, 503); }
	const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (contentType !== 'application/json') { return json({ error: 'content-type must be application/json' }, 415); }

	const body = await readBodyWithLimit(request, MAX_RUNTIME_EVENT_BYTES);
	if (!body) { return json({ error: `body exceeds ${MAX_RUNTIME_EVENT_BYTES} bytes` }, 413); }
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return json({ error: 'body is not valid JSON' }, 400);
	}
	if (!isRecord(value) || !hasOnlyKeys(value, RUNTIME_EVENT_KEYS)) {
		return json({ error: 'body contains unsupported fields' }, 400);
	}

	const { schemaVersion, installationId, event, commit, productVersion, platform, quality, failureCode } = value;
	if (schemaVersion !== RUNTIME_EVENT_SCHEMA_VERSION) { return json({ error: 'unsupported schemaVersion' }, 400); }
	if (typeof installationId !== 'string' || !INSTALLATION_ID_PATTERN.test(installationId)) { return json({ error: 'installationId must be a UUID' }, 400); }
	if (typeof event !== 'string' || !RUNTIME_EVENTS.has(event)) { return json({ error: 'unsupported event' }, 400); }
	if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) { return json({ error: 'commit must be a hexadecimal build commit' }, 400); }
	if (typeof productVersion !== 'string' || !VERSION_PATTERN.test(productVersion)) { return json({ error: 'invalid productVersion' }, 400); }
	if (typeof platform !== 'string' || !PLATFORM_PATTERN.test(platform)) { return json({ error: 'invalid platform' }, 400); }
	if (typeof quality !== 'string' || !QUALITY_PATTERN.test(quality)) { return json({ error: 'invalid quality' }, 400); }
	if (event === 'ai_request_failed') {
		if (typeof failureCode !== 'string' || !RUNTIME_FAILURE_CODES.has(failureCode)) { return json({ error: 'failureCode is required for ai_request_failed' }, 400); }
	} else if (failureCode !== undefined) {
		return json({ error: 'failureCode is allowed only for ai_request_failed' }, 400);
	}

	const now = Date.now();
	const eventName = event as RuntimeEventName;
	// Every accepted milestone proves the desktop process launched, even if an
	// earlier app_launched request was dropped while the network was unavailable.
	const launchedAt = now;
	const runtimeReadyAt = eventName === 'runtime_ready' || eventName.startsWith('ai_') ? now : null;
	const aiAttemptAt = eventName === 'ai_request_started' || eventName === 'ai_request_failed' || eventName === 'ai_response_succeeded' ? now : null;
	const aiSuccessAt = eventName === 'ai_response_succeeded' ? now : null;
	const aiFailureAt = eventName === 'ai_request_failed' ? now : null;

	try {
		const installationHash = await sha256Hex(`runtime-adoption-v1\0${installationId.toLowerCase()}`);
		await env.ANALYTICS.prepare(
			`INSERT INTO runtime_install_state (
			   installation_hash, commit_id, product_version, platform, quality,
			   first_seen, last_seen, launched_at, runtime_ready_at,
			   ai_first_attempt_at, ai_first_success_at, ai_last_failure_at,
			   last_failure_code, event_count
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
			 ON CONFLICT(installation_hash, commit_id) DO UPDATE SET
			   product_version = excluded.product_version,
			   platform = excluded.platform,
			   quality = excluded.quality,
			   last_seen = excluded.last_seen,
			   launched_at = COALESCE(runtime_install_state.launched_at, excluded.launched_at),
			   runtime_ready_at = COALESCE(runtime_install_state.runtime_ready_at, excluded.runtime_ready_at),
			   ai_first_attempt_at = COALESCE(runtime_install_state.ai_first_attempt_at, excluded.ai_first_attempt_at),
			   ai_first_success_at = COALESCE(runtime_install_state.ai_first_success_at, excluded.ai_first_success_at),
			   ai_last_failure_at = COALESCE(excluded.ai_last_failure_at, runtime_install_state.ai_last_failure_at),
			   last_failure_code = COALESCE(excluded.last_failure_code, runtime_install_state.last_failure_code),
			   event_count = runtime_install_state.event_count + 1`
		).bind(
			installationHash,
			commit.toLowerCase(),
			productVersion,
			platform,
			quality,
			now,
			now,
			launchedAt,
			runtimeReadyAt,
			aiAttemptAt,
			aiSuccessAt,
			aiFailureAt,
			eventName === 'ai_request_failed' ? failureCode : null,
		).run();
		return json({ ok: true }, 202);
	} catch (error) {
		console.error('handleRuntimeEvent failed', error);
		return json({ error: 'runtime analytics temporarily unavailable' }, 503);
	}
}

const RUNTIME_RETENTION_MS = 180 * 86_400_000;

async function cleanupRuntimeAdoption(env: Env): Promise<void> {
	if (!env.ANALYTICS) { return; }
	try {
		await env.ANALYTICS.prepare('DELETE FROM runtime_install_state WHERE last_seen < ?')
			.bind(Date.now() - RUNTIME_RETENTION_MS)
			.run();
	} catch (error) {
		// A cleanup failure never affects update delivery or event ingestion.
		console.error('cleanupRuntimeAdoption failed', error);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const parts = url.pathname.split('/').filter(Boolean);

		// /api/notifications and /api/notifications/asset/:name — broadcast feed
		if (parts[0] === 'api' && parts[1] === 'notifications') {
			if (request.method === 'OPTIONS') { return broadcastCorsPreflight(); }
			if (parts.length === 2) { return withBroadcastCors(await handleBroadcastsFeed(env, request)); }
			if (parts.length === 4 && parts[2] === 'asset') { return withBroadcastCors(await handleBroadcastAsset(env, request, url, parts[3])); }
		}

		// POST /api/votes/agents-beta — anonymous, one replaceable vote per install.
		if (parts[0] === 'api' && parts[1] === 'votes' && parts[2] === 'agents-beta' && parts.length === 3) {
			if (request.method === 'OPTIONS') { return productVoteCorsPreflight(); }
			return withProductVoteCors(await handleAgentsBetaVote(env, request));
		}

		// POST /api/runtime-events — anonymous, privacy-safe release milestones.
		if (parts[0] === 'api' && parts[1] === 'runtime-events' && parts.length === 2) {
			if (request.method === 'OPTIONS') { return runtimeEventCorsPreflight(); }
			return withRuntimeEventCors(await handleRuntimeEvent(env, request));
		}

		// /api/update/:platform/:quality/:commit
		if (parts[0] === 'api' && parts[1] === 'update' && parts.length === 5) {
			const [, , platform, quality, commit] = parts;
			// Count this poll as an install ping (deduped by ip+platform+commit).
			ctx.waitUntil(logInstallPing(env, request, platform, quality, commit));
			return handleUpdateCheck(env, platform, quality, commit);
		}

		// /api/latest/:platform/:quality
		if (parts[0] === 'api' && parts[1] === 'latest' && parts.length === 4) {
			const [, , platform, quality] = parts;
			return handleLatest(env, platform, quality);
		}

		// /api/stats — protected analytics readout (IP-bearing; ADMIN_TOKEN gated).
		if (parts[0] === 'api' && parts[1] === 'stats' && parts.length === 2) {
			return handleStats(env, request, url);
		}

		// /download/:quality/:platform/:filename
		if (parts[0] === 'download' && parts.length === 4) {
			const [, quality, platform, filename] = parts;
			const res = await handleDownload(env, quality, platform, filename, request);
			// Log only a real byte-serve (GET 200/206), never HEAD probes or 404s.
			if (request.method === 'GET' && (res.status === 200 || res.status === 206)) {
				ctx.waitUntil(logDownload(env, request, url, { quality, platform, filename, isRange: res.status === 206 }));
			}
			return res;
		}

		return json({ error: 'not found' }, 404);
	},

	scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(cleanupRuntimeAdoption(env));
	},
};
