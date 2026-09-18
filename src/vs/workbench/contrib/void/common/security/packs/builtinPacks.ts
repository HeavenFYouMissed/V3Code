/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Sentinel — built-in vulnerability packs (the shipped rule library).
 *
 * Each pack is PURE DATA (a {@link VulnPack}) the taint engine runs — no code. This is where
 * the scanner's knowledge lives and grows: adding coverage means adding specs here (or in a
 * user pack), never touching the engine. Every pack targets a vulnerability class that shows up
 * repeatedly in AI-generated / "vibe-coded" web apps — the overlooked, chargeable-over,
 * exploitable stuff the user asked us to hunt.
 *
 * AUTHORING RULES (learned the hard way in Phase 2):
 *   • Source matchers MUST be specific — `^(req|request)\.(query|body|params)`, never a bare
 *     `*.query`, or a sink's own receiver (e.g. `db.query`) gets mis-matched as a source.
 *   • Sinks match the dotted callee the lifter produces (`child_process.exec`, `res.send`).
 *   • Prefer a sanitizer entry over dropping a source — sanitizers cut false positives without
 *     losing recall.
 *
 * Common source set (attacker-controlled entry points) is factored into COMMON_WEB_SOURCES and
 * reused, so every flow pack agrees on what "user input" means.
 */

import { SourceSpec, VulnPack } from '../taintSpec.js';

/**
 * The canonical attacker-controlled entry points for a Node/Express/Next web app. Reused by
 * every data-flow pack so "user input" means the same thing everywhere. `req`/`request`/`ctx`
 * cover Express, Koa, and Next API handlers; `process.argv`/`process.env` cover CLI/config
 * injection; browser sources (`location`, `document`) cover DOM-XSS packs.
 */
export const COMMON_WEB_SOURCES: readonly SourceSpec[] = [
	{ match: { kind: 'member', namePattern: '^(req|request)\\.(body|query|params|headers|cookies|url|originalUrl|hostname)' }, labels: ['USER_INPUT'] },
	{ match: { kind: 'member', namePattern: '^ctx\\.(request|query|params|body)' }, labels: ['USER_INPUT'] },
	{ match: { kind: 'member', namePattern: '^process\\.(argv|env)' }, labels: ['USER_INPUT'] },
	{ match: { kind: 'member', namePattern: '^(location|document\\.location|window\\.location)\\.(hash|search|href|pathname)' }, labels: ['USER_INPUT', 'DOM'] },
	{ match: { kind: 'member', namePattern: '^document\\.(URL|referrer|cookie)' }, labels: ['USER_INPUT', 'DOM'] },
];

/** CWE-89 — SQL/NoSQL injection: user input concatenated into a query. */
const SQL_INJECTION: VulnPack = {
	id: 'sql-injection',
	title: 'SQL / NoSQL Injection',
	version: 1,
	severity: 'critical',
	cwe: 'CWE-89',
	owasp: 'A03:2021-Injection',
	description: 'User-controlled data reaches a database query without parameterization, letting an attacker rewrite the query — read, modify, or destroy data that is not theirs.',
	remediation: 'Use parameterized queries / prepared statements (e.g. db.query(sql, [params])) or an ORM. Never build SQL by string concatenation with request data.',
	sources: COMMON_WEB_SOURCES,
	propagators: [
		{ match: { kind: 'call', namePattern: '\\.(concat|replace|toString|trim|join)$' } },
		{ match: { kind: 'call', name: 'String' } },
	],
	sanitizers: [
		{ match: { kind: 'call', namePattern: '(escape|escapeId|sanitize|parameterize)$' } },
		{ match: { kind: 'call', name: 'Number' } },
		{ match: { kind: 'call', name: 'parseInt' } },
	],
	sinks: [
		{ match: { kind: 'call', namePattern: '\\.(query|execute|raw|exec)$' } },
		{ match: { kind: 'call', namePattern: '\\.(find|findOne|aggregate|where)$' } },
	],
};

/** CWE-78 — OS command injection: user input reaches a shell/exec call. */
const COMMAND_INJECTION: VulnPack = {
	id: 'command-injection',
	title: 'OS Command Injection',
	version: 1,
	severity: 'critical',
	cwe: 'CWE-78',
	owasp: 'A03:2021-Injection',
	description: 'User-controlled data reaches a shell command, letting an attacker run arbitrary commands on your server.',
	remediation: 'Avoid the shell. Use execFile/spawn with an argument array (never a concatenated command string), and validate input against a strict allow-list.',
	sources: COMMON_WEB_SOURCES,
	propagators: [
		{ match: { kind: 'call', namePattern: '\\.(concat|replace|trim|join)$' } },
		{ match: { kind: 'call', name: 'String' } },
	],
	sanitizers: [
		{ match: { kind: 'call', namePattern: '(shellEscape|shellQuote|sanitize)$' } },
	],
	sinks: [
		{ match: { kind: 'call', namePattern: '(child_process\\.)?(exec|execSync|spawn|spawnSync|execFile|execFileSync)$' } },
		{ match: { kind: 'call', name: 'eval' } },
	],
};

/** CWE-79 — Cross-Site Scripting: user input reaches an HTML sink without encoding. */
const XSS: VulnPack = {
	id: 'xss',
	title: 'Cross-Site Scripting (XSS)',
	version: 1,
	severity: 'high',
	cwe: 'CWE-79',
	owasp: 'A03:2021-Injection',
	description: 'User-controlled data reaches the page/HTML without encoding, letting an attacker run JavaScript in your users\u2019 browsers (steal sessions, keystrokes, act as them).',
	remediation: 'Encode output for its context (textContent, not innerHTML). In React avoid dangerouslySetInnerHTML; sanitize any HTML with DOMPurify before rendering.',
	sources: COMMON_WEB_SOURCES,
	propagators: [
		{ match: { kind: 'call', namePattern: '\\.(concat|replace|trim|join)$' } },
	],
	sanitizers: [
		{ match: { kind: 'call', namePattern: '(DOMPurify\\.sanitize|sanitizeHtml|escapeHtml|encodeURIComponent)$' } },
	],
	sinks: [
		{ match: { kind: 'call', namePattern: '\\.(send|write|end|render)$' } },
		{ match: { kind: 'assign', namePattern: '(innerHTML|outerHTML)$' } },
		{ match: { kind: 'member', nameEndsWith: 'innerHTML' } },
		{ match: { kind: 'call', namePattern: 'dangerouslySetInnerHTML$' } },
		{ match: { kind: 'call', name: 'document.write' } },
	],
};

/** CWE-918 — Server-Side Request Forgery: user input controls an outbound request URL. */
const SSRF: VulnPack = {
	id: 'ssrf',
	title: 'Server-Side Request Forgery (SSRF)',
	version: 1,
	severity: 'high',
	cwe: 'CWE-918',
	owasp: 'A10:2021-SSRF',
	description: 'User-controlled data decides the URL your server fetches, letting an attacker reach internal services, cloud metadata endpoints, or scan your private network.',
	remediation: 'Validate the target against a strict host allow-list, resolve and check the IP is public, and block redirects to internal ranges. Never fetch a raw user-supplied URL.',
	sources: COMMON_WEB_SOURCES,
	propagators: [
		{ match: { kind: 'call', namePattern: '\\.(concat|replace|trim)$' } },
	],
	sanitizers: [
		{ match: { kind: 'call', namePattern: '(isAllowedHost|assertPublicUrl|validateUrl)$' } },
	],
	sinks: [
		// Bare unqualified request functions.
		{ match: { kind: 'call', namePattern: '^(fetch|axios|got|request|superagent|needle|phin)$' } },
		// Node http/https client.
		{ match: { kind: 'call', namePattern: '(http|https)\\.(get|request)$' } },
		// Named HTTP clients only. NOTE: we deliberately do NOT match a bare `\\.(get|post|put)$`
		// method suffix — on real code that is dominated by Map.get / URLSearchParams.get /
		// router.get (route DEFINITION) / headers.get, which are not outbound requests. The FP
		// corpus run (V3Code src/vs) confirmed all SSRF false positives came from `_routes.get`,
		// `searchParams.get`, `validWebviewFilePaths.get` — never a real outbound call. Requiring a
		// recognizable HTTP-client receiver trades a little recall (a request via an unusually named
		// variable) for eliminating that entire noise class. Interprocedural receiver typing (Phase 8
		// framework models) can widen this back safely.
		{ match: { kind: 'call', namePattern: '(axios|got|superagent|needle|client|httpClient|api)\\.(get|post|put|patch|delete|head|request)$' } },
	],
};

/** CWE-22 — Path Traversal: user input reaches a filesystem path. */
const PATH_TRAVERSAL: VulnPack = {
	id: 'path-traversal',
	title: 'Path Traversal',
	version: 1,
	severity: 'high',
	cwe: 'CWE-22',
	owasp: 'A01:2021-Broken Access Control',
	description: 'User-controlled data becomes a file path, letting an attacker use ../ sequences to read or write files outside the intended directory (e.g. /etc/passwd, source, secrets).',
	remediation: 'Resolve the path and verify it stays inside an allowed base directory (path.resolve + startsWith check). Strip/deny ".." and absolute paths; prefer an id → known-path map.',
	sources: COMMON_WEB_SOURCES,
	propagators: [
		{ match: { kind: 'call', namePattern: '(path\\.)?(join|resolve|normalize)$' } },
		{ match: { kind: 'call', namePattern: '\\.(concat|replace)$' } },
	],
	sanitizers: [
		{ match: { kind: 'call', namePattern: '(basename|sanitizePath|assertInside)$' } },
	],
	sinks: [
		{ match: { kind: 'call', namePattern: '(fs\\.)?(readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|open|appendFile)$' } },
		{ match: { kind: 'call', namePattern: '\\.(sendFile|download)$' } },
	],
};

/** CWE-1321 — Prototype Pollution: user-controlled key/merge reaches an object write. */
const PROTOTYPE_POLLUTION: VulnPack = {
	id: 'proto-pollution',
	title: 'Prototype Pollution',
	version: 1,
	severity: 'high',
	cwe: 'CWE-1321',
	owasp: 'A08:2021-Software and Data Integrity Failures',
	description: 'User-controlled data flows into a recursive merge or a computed object-key write, letting an attacker set __proto__/constructor and corrupt every object in the app — often escalating to RCE or auth bypass.',
	remediation: 'Reject keys of __proto__/constructor/prototype, use a null-prototype object (Object.create(null)) or Map, and use a merge utility that guards prototype keys.',
	sources: COMMON_WEB_SOURCES,
	sanitizers: [
		{ match: { kind: 'call', namePattern: '(guardProto|isSafeKey|hasOwnProperty)$' } },
	],
	sinks: [
		// Recursive-merge / deep-set utilities: the classic prototype-pollution gateway — a tainted
		// key like __proto__ walks into Object.prototype.
		{ match: { kind: 'call', namePattern: '(_\\.|lodash\\.)?(merge|mergeWith|defaultsDeep|set|setWith)$' } },
		{ match: { kind: 'call', name: 'Object.assign' } },
		// A computed write whose key text mentions a prototype-chain key. This is a TEXT-level guard,
		// not the full "tainted computed-key assignment" (which needs the engine to know an index node
		// is an assignment TARGET — a NodeMatcher sees only one node, not its parent; tracked for the
		// Phase 6 index-write CPG marker). REMOVED the previous bare `{ kind: 'index' }` sink: the FP
		// corpus run showed it produced 338 of 387 findings (87% of ALL noise) because every a[b] in a
		// codebase that also reads process.env became a flow-gated hit. Matching on the dangerous key
		// text keeps the real bug and drops the flood.
		{ match: { kind: 'index', textPattern: '\\[[\'"`]?(__proto__|constructor|prototype)[\'"`]?\\]' } },
	],
};

/** CWE-502 — Insecure Deserialization: user input reaches an unsafe deserializer. */
const INSECURE_DESERIALIZATION: VulnPack = {
	id: 'insecure-deserialization',
	title: 'Insecure Deserialization',
	version: 1,
	severity: 'high',
	cwe: 'CWE-502',
	owasp: 'A08:2021-Software and Data Integrity Failures',
	description: 'User-controlled data is deserialized by a mechanism that can instantiate arbitrary objects or run code (node-serialize, vm, YAML with custom types), leading to remote code execution.',
	remediation: 'Deserialize only with safe parsers (JSON.parse for JSON; yaml.load with the SAFE schema). Never use node-serialize.unserialize or vm.runInThisContext on untrusted data.',
	sources: COMMON_WEB_SOURCES,
	sinks: [
		{ match: { kind: 'call', namePattern: '(unserialize|deserialize)$' } },
		{ match: { kind: 'call', namePattern: '(vm\\.)?(runInThisContext|runInNewContext|compileFunction)$' } },
		{ match: { kind: 'call', name: 'Function' } },
		{ match: { kind: 'new', name: 'Function' } },
	],
};

/** CWE-1333 — ReDoS: user input reaches a RegExp constructor (attacker-authored pattern). */
const REDOS: VulnPack = {
	id: 'redos',
	title: 'Regular Expression Denial of Service (ReDoS)',
	version: 1,
	severity: 'medium',
	cwe: 'CWE-1333',
	owasp: 'A06:2021-Vulnerable and Outdated Components',
	description: 'User-controlled data becomes a regular-expression pattern (or is tested against a catastrophic-backtracking regex), letting an attacker hang the event loop with a crafted string and take the service down.',
	remediation: 'Never build a RegExp from user input. For fixed patterns, avoid nested quantifiers like (a+)+; use a linear-time matcher (RE2) or a timeout.',
	sources: COMMON_WEB_SOURCES,
	sinks: [
		{ match: { kind: 'new', name: 'RegExp' } },
		{ match: { kind: 'call', name: 'RegExp' } },
	],
};

/** CWE-798 — Hardcoded secrets: high-signal literal patterns. Sink-only (no flow needed). */
const HARDCODED_SECRETS: VulnPack = {
	id: 'hardcoded-secrets',
	title: 'Hardcoded Secret / API Key',
	version: 1,
	severity: 'high',
	cwe: 'CWE-798',
	owasp: 'A07:2021-Identification and Authentication Failures',
	description: 'A credential, API key, or private key is committed directly in source. Anyone with repo access (or a leaked bundle) gets it, and rotating it means a code change.',
	remediation: 'Move secrets to environment variables / a secrets manager and load them at runtime. Rotate any key that was ever committed — treat it as compromised.',
	sinkOnly: true,
	sources: [],
	sinks: [
		// AWS access key id, private key blocks, Slack/GitHub/Google tokens, generic long hex/base64
		{ match: { kind: 'literal', textPattern: 'AKIA[0-9A-Z]{16}' } },
		{ match: { kind: 'literal', textPattern: '-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----' } },
		{ match: { kind: 'literal', textPattern: 'xox[baprs]-[0-9A-Za-z-]{10,}' } },
		{ match: { kind: 'literal', textPattern: 'gh[pousr]_[0-9A-Za-z]{36,}' } },
		{ match: { kind: 'literal', textPattern: 'AIza[0-9A-Za-z_\\-]{35}' } },
		{ match: { kind: 'literal', textPattern: 'sk_(live|test)_[0-9A-Za-z]{20,}' } },
		{ match: { kind: 'literal', textPattern: 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}' } }, // JWT
	],
};

/** CWE-327 / CWE-942 — Weak crypto & wildcard CORS. Sink-only (dangerous node, not a flow). */
const WEAK_CRYPTO_CORS: VulnPack = {
	id: 'weak-crypto-cors',
	title: 'Weak Cryptography & Permissive CORS',
	version: 1,
	severity: 'medium',
	cwe: 'CWE-327',
	owasp: 'A02:2021-Cryptographic Failures',
	description: 'The code uses a broken hash/cipher (MD5, SHA1, DES) or allows any origin (CORS *). Weak crypto is trivially reversible; wildcard CORS lets any site call your authenticated API.',
	remediation: 'Use SHA-256+/bcrypt/scrypt/argon2 for hashing and AES-GCM for encryption. Set CORS to an explicit allow-list of origins, never "*", when credentials are involved.',
	sinkOnly: true,
	sources: [],
	sinks: [
		{ match: { kind: 'call', textPattern: 'createHash\\(\\s*[\'"](md5|sha1)[\'"]' } },
		{ match: { kind: 'call', textPattern: 'createCipher(iv)?\\(\\s*[\'"](des|rc4|des-ede)' } },
		// (Removed a placeholder that matched EVERY bare '*' string literal — the three
		// Access-Control-Allow-Origin matchers below are the real, specific wildcard-CORS detectors.)
		{ match: { kind: 'assign', textPattern: 'Access-Control-Allow-Origin[\'"]\\s*,\\s*[\'"]\\*' } },
		{ match: { kind: 'call', textPattern: 'Access-Control-Allow-Origin[\'"]\\s*,\\s*[\'"]\\*' } },
		{ match: { kind: 'property', textPattern: 'origin\\s*:\\s*[\'"]\\*[\'"]' } },
	],
};

/** Every built-in pack, in report order (critical → lower). */
export const BUILTIN_PACKS: readonly VulnPack[] = [
	SQL_INJECTION,
	COMMAND_INJECTION,
	XSS,
	SSRF,
	PATH_TRAVERSAL,
	PROTOTYPE_POLLUTION,
	INSECURE_DESERIALIZATION,
	REDOS,
	HARDCODED_SECRETS,
	WEAK_CRYPTO_CORS,
];

/** Look up a built-in pack by id (for selective scans / journal cross-reference). */
export function builtinPackById(id: string): VulnPack | undefined {
	return BUILTIN_PACKS.find(p => p.id === id);
}
