/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

// The runner script for the Debug session's runtime-evidence sink.
//
// WHY IT LIVES IN A TS MODULE AS A STRING:
// A packaged build only carries what the build step copies. Shipping this as a sibling
// .cjs file means it works on the machine that built the release and is absent for every
// user — the exact failure the beast sidecar shipped with. Keeping the source here means
// the channel can materialize it on any machine, on any platform, with no packaging
// change and nothing to install.
//
// The channel writes it to a user-data path keyed by a content hash, so an upgraded build
// replaces it automatically and an unchanged build does not rewrite it.
//
// SOURCE RULES — the collector source below must contain NO backticks, NO dollar-brace
// interpolation, and NO backslash escape sequences. Templates are banned because a stray
// one silently truncates the literal; escapes are banned because the bytes in THIS file
// would then differ from the bytes that ship, so the file could not be verified by reading
// it. Newlines are therefore written as NL (String.fromCharCode(10)) rather than '\n'.

/** Changes whenever the collector source below changes — the materialization key. */
export const V3_DEBUG_COLLECTOR_SOURCE_VERSION = 3;

/**
 * Zero-dependency loopback sink. Binds 127.0.0.1 only, writes NDJSON, and refuses to start
 * on a session id that could traverse a path. Exits on its own after two idle hours so a
 * forgotten debug session cannot keep a port held forever.
 */
export const V3_DEBUG_COLLECTOR_SOURCE = `#!/usr/bin/env node
/*
 * V3Code Debug Collector — disposable runtime-evidence sink.
 *
 * Started and stopped by the editor for the lifetime of a Debug chat, and spawned OUTSIDE
 * the editor process so evidence survives an editor crash or reload.
 *
 * Usage:
 *   node debug-collector.cjs [--port PORT] [--log-dir DIR] [--session-id ID]
 *
 * Endpoints (bound to 127.0.0.1 ONLY — never 0.0.0.0):
 *   GET    /health              liveness + session info
 *   GET    /status[?tail=N]     log line count + content (last N lines if tail given)
 *   POST   /ingest/<uuid>       NDJSON log ingestion
 *   DELETE /logs/<sessionId>    clear the log file (serialized behind pending writes)
 *   POST   /shutdown            graceful exit (marks the config file status: "stopped")
 */

'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var args = process.argv.slice(2);
function getArg(name, defaultVal) {
	var idx = args.indexOf('--' + name);
	return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

var SESSION_ID = getArg('session-id', crypto.randomBytes(4).toString('hex'));
// The session id becomes part of a filename. Reject anything that could traverse a path
// before the string ever reaches fs. Mirrors V3_DEBUG_SESSION_ID_PATTERN in the editor.
if (!/^[a-zA-Z0-9-]{1,64}$/.test(SESSION_ID)) {
	console.error('[collector] fatal: --session-id must be 1-64 chars of [a-zA-Z0-9-]');
	process.exit(1);
}

// Newlines without an escape sequence — see SOURCE RULES above.
var NL = String.fromCharCode(10);

var LOG_DIR = path.resolve(getArg('log-dir', '.v3code'));
var REQUESTED_PORT = parseInt(getArg('port', '7642'), 10);
var IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
var MAX_BODY_BYTES = 1024 * 1024; // 1 MB per ingest request
var INGEST_PATH_ID = crypto.randomUUID();
var STARTED_AT = new Date().toISOString();

// Our own allocation range. Offset from the range another editor on this machine uses so
// two running editors do not compete for the same ports.
var PORT_RANGE_START = 7642;
var PORT_RANGE_END = 8342;

if (!fs.existsSync(LOG_DIR)) {
	fs.mkdirSync(LOG_DIR, { recursive: true });
}

var LOG_FILE = path.join(LOG_DIR, 'debug-' + SESSION_ID + '.log');
var CONFIG_FILE = path.join(LOG_DIR, 'collector-' + SESSION_ID + '.json');

// --- Serialized log I/O -------------------------------------------------
// ALL mutations of the log file (appends AND clears) go through one promise chain, so a
// clear can never race an in-flight append and leave a half-written line behind.

var writeChain = Promise.resolve();

function chainLogOp(fn) {
	writeChain = writeChain.then(fn).catch(function (err) {
		console.error('[collector] log op error: ' + err.message);
	});
	return writeChain;
}

function appendLog(data) {
	return chainLogOp(function () {
		return new Promise(function (resolve, reject) {
			var line = typeof data === 'string' ? data : JSON.stringify(data);
			// Guarantee a trailing newline so the file stays valid NDJSON even when a client
			// POSTs a bare object with none.
			var entry = line.charAt(line.length - 1) === NL ? line : line + NL;
			fs.appendFile(LOG_FILE, entry, 'utf8', function (err) { return err ? reject(err) : resolve(); });
		});
	});
}

function clearLog() {
	return chainLogOp(function () {
		return new Promise(function (resolve, reject) {
			fs.writeFile(LOG_FILE, '', 'utf8', function (err) { return err ? reject(err) : resolve(); });
		});
	});
}

// --- Idle shutdown ------------------------------------------------------
// Only ingest resets the timer: "idle" means "no evidence arriving", so health polling
// cannot keep a forgotten collector alive forever.

var idleTimer = null;

function resetIdleTimer() {
	if (idleTimer) { clearTimeout(idleTimer); }
	idleTimer = setTimeout(function () {
		shutdown('idle for ' + (IDLE_TIMEOUT_MS / 1000 / 60) + ' minutes');
	}, IDLE_TIMEOUT_MS);
}

resetIdleTimer();

// --- Graceful shutdown ---------------------------------------------------
// Marks the config file stopped so crash recovery (which scans for collector-*.json) can
// tell a live collector from a dead one.

function shutdown(reason) {
	console.log('[collector] shutting down (' + reason + ')');
	try {
		if (fs.existsSync(CONFIG_FILE)) {
			var config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
			config.status = 'stopped';
			config.stoppedAt = new Date().toISOString();
			fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
		}
	} catch (e) {
		console.error('[collector] could not mark config stopped: ' + e.message);
	}
	try { server.close(); } catch (e) { /* already closed */ }
	process.exit(0);
}

// --- HTTP server ---------------------------------------------------------

var server = http.createServer(function (req, res) {
	// The caller may be a page on any origin (that is the point — a browser tab has no
	// filesystem), so CORS is open. Isolation comes from the loopback bind plus the
	// unguessable path id, not from this header.
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Debug-Session-Id');

	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	var url = new URL(req.url, 'http://127.0.0.1');

	if (req.method === 'GET' && url.pathname === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			status: 'ok',
			sessionId: SESSION_ID,
			logFile: LOG_FILE,
			startedAt: STARTED_AT,
			uptime: process.uptime(),
			pid: process.pid
		}));
		return;
	}

	if (req.method === 'GET' && url.pathname === '/status') {
		var logContent = '';
		try {
			if (fs.existsSync(LOG_FILE)) { logContent = fs.readFileSync(LOG_FILE, 'utf8'); }
		} catch (e) {
			logContent = '[error reading log: ' + e.message + ']';
		}
		var allLines = logContent.split(NL).filter(Boolean);
		var tail = parseInt(url.searchParams.get('tail') || '', 10);
		var returned = Number.isFinite(tail) && tail > 0 ? allLines.slice(-tail) : allLines;
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			sessionId: SESSION_ID,
			logFile: LOG_FILE,
			lines: allLines.length,
			returnedLines: returned.length,
			content: returned.join(NL)
		}));
		return;
	}

	if (req.method === 'DELETE' && url.pathname === '/logs/' + SESSION_ID) {
		clearLog().then(function () {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ cleared: true, file: LOG_FILE }));
		}).catch(function (e) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: e.message }));
		});
		return;
	}

	if (req.method === 'POST' && url.pathname === '/ingest/' + INGEST_PATH_ID) {
		var headerSessionId = req.headers['x-debug-session-id'];
		if (headerSessionId && !/^[a-zA-Z0-9-]+$/.test(headerSessionId)) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid session id format' }));
			return;
		}

		var body = '';
		var bytes = 0;
		var tooLarge = false;
		req.on('data', function (chunk) {
			if (tooLarge) { return; }
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				tooLarge = true;
				res.writeHead(413, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'body too large', maxBytes: MAX_BODY_BYTES }));
				req.destroy();
				return;
			}
			body += chunk;
		});
		req.on('end', function () {
			if (tooLarge) { return; }
			resetIdleTimer();

			var lines;
			try {
				lines = body.split(NL).map(function (l) { return l.trim(); }).filter(Boolean);
			} catch (e) {
				lines = [body];
			}

			var chain = Promise.resolve();
			lines.forEach(function (line) {
				chain = chain.then(function () {
					var parsed;
					try {
						parsed = JSON.parse(line);
						if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
							parsed = { raw: line };
						}
					} catch (e) {
						// A malformed line is still evidence. Keep it, marked, rather than 400ing
						// the caller — a client bug must not silently cost the model its data.
						parsed = { raw: line, error: e.message };
					}
					if (!parsed.timestamp) { parsed.timestamp = Date.now(); }
					return appendLog(parsed);
				});
			});

			chain.then(function () {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: true, lines: lines.length }));
			}).catch(function (e) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: e.message }));
			});
		});
		return;
	}

	if (req.method === 'POST' && url.pathname === '/shutdown') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ shutting_down: true }));
		setTimeout(function () { shutdown('shutdown endpoint'); }, 100);
		return;
	}

	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'not found', hint: 'POST to /ingest/' + INGEST_PATH_ID }));
});

// --- Port allocation ------------------------------------------------------
// Pinned port first; then a RANDOM offset into our range, probed linearly with wraparound.
// The random start (rather than scanning from the bottom) is what keeps concurrent
// workspaces from all piling onto the first free port.

function tryListen(port) {
	return new Promise(function (resolve, reject) {
		var onError = function (err) { reject(err); };
		server.once('error', onError);
		server.listen(port, '127.0.0.1', function () {
			server.removeListener('error', onError);
			resolve(port);
		});
	});
}

function startServer() {
	return tryListen(REQUESTED_PORT).catch(function () {
		console.log('[collector] port ' + REQUESTED_PORT + ' busy, auto-allocating...');
		var span = PORT_RANGE_END - PORT_RANGE_START + 1;
		var offset = Math.floor(Math.random() * span);
		var attempt = 0;
		function next() {
			if (attempt >= span) {
				return Promise.reject(new Error('no available port in range ' + PORT_RANGE_START + '-' + PORT_RANGE_END));
			}
			var candidate = PORT_RANGE_START + ((offset + attempt) % span);
			attempt++;
			return tryListen(candidate).catch(next);
		}
		return next();
	});
}

startServer().then(function (port) {
	var ingestUrl = 'http://127.0.0.1:' + port + '/ingest/' + INGEST_PATH_ID;

	// The one-line instrumentation template the model is told to paste in. Built here so
	// the URL and the session header can never drift from the live server.
	var fetchTemplate = [
		"fetch('" + ingestUrl + "', {",
		"  method: 'POST',",
		"  headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '" + SESSION_ID + "' },",
		"  body: JSON.stringify({",
		"    sessionId: '" + SESSION_ID + "',",
		"    location: 'FILE:LINE',",
		"    message: 'what you observed',",
		"    data: { /* values */ },",
		"    timestamp: Date.now()",
		"  })",
		"}).catch(function () {});"
	].join(NL);

	var config = {
		status: 'running',
		pid: process.pid,
		port: port,
		sessionId: SESSION_ID,
		startedAt: STARTED_AT,
		ingestUrl: ingestUrl,
		logFile: LOG_FILE,
		healthUrl: 'http://127.0.0.1:' + port + '/health',
		statusUrl: 'http://127.0.0.1:' + port + '/status',
		shutdownUrl: 'http://127.0.0.1:' + port + '/shutdown',
		clearUrl: 'http://127.0.0.1:' + port + '/logs/' + SESSION_ID,
		fetchTemplate: fetchTemplate
	};

	// Stdout is the handshake: the channel parses this line to learn the port and the
	// unguessable ingest path. One JSON object, nothing else on the line.
	console.log('V3DEBUG_READY ' + JSON.stringify(config));

	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

	process.on('SIGINT', function () { shutdown('SIGINT'); });
	process.on('SIGTERM', function () { shutdown('SIGTERM'); });

}).catch(function (err) {
	console.error('[collector] fatal: ' + err.message);
	process.exit(1);
});
`;
