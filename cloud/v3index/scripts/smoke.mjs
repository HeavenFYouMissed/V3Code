/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// Post-deploy smoke test: init → upload two chunks → retrieve → status.
//   node scripts/smoke.mjs <endpoint> <writeToken> [workspaceId]
// Retrieval works lexically right away; vector coverage climbs within ~a minute
// (Queues → Workers AI → Vectorize is async).
const [endpoint, token, wsId = 'smoke-test'] = process.argv.slice(2);
if (!endpoint || !token) {
	console.error('usage: node scripts/smoke.mjs <endpoint> <writeToken> [workspaceId]');
	process.exit(1);
}
const base = `${endpoint.replace(/\/+$/, '')}/v1/ws/${wsId}`;
const call = async (path, body, method = 'POST') => {
	const res = await fetch(`${base}${path}`, {
		method, body: body === undefined ? undefined : JSON.stringify(body),
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(json)}`);
	return json;
};

await call('/init', { privacyMode: 'full' });
const begin = await call('/sync/begin', { files: { 'src/hello.ts': 'h1' }, embedIdentity: '' });
await call('/chunks', {
	syncId: begin.syncId,
	chunks: [{
		id: 'smoke-1', casKey: 'cas-smoke-1', file: 'src/hello.ts', startLine: 1, endLine: 5,
		kind: 'function', name: 'greetUser', language: 'typescript', scored: true,
		content: 'export function greetUser(name: string) { return `hello ${name}`; }',
		defines: ['greetUser'],
	}],
	fileHashes: { 'src/hello.ts': 'h1' }, done: true,
});
const ret = await call('/retrieve', { query: 'where do we greet the user' });
console.log('hits:', ret.hits.map(h => `${h.file}:${h.startLine} ${h.name} (${h.score.toFixed(4)})`));
console.log('vectorCoverage:', ret.vectorCoverage, '(re-run in ~1min to watch it reach 1)');
console.log('status:', await call('/status', undefined, 'GET'));
console.log('SMOKE OK');
