/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
// Post-deploy smoke for the ghost-vector fix: prune + reset must drain their
// queued Vectorize deletions against the REAL index (the local test harness
// cannot reach Vectorize — miniflare's plugin is remote-proxy only).
//   node scripts/smoke-vector-deletes.mjs <endpoint> <writeToken> [workspaceId]
// PASS = both /prune/kick flushes report vectorDeletesRemaining 0 with no
// vectorError: deleteByIds succeeded (rows are cleared only on success).
const [endpoint, token, wsId = 'vdel-smoke'] = process.argv.slice(2);
if (!endpoint || !token) {
	console.error('usage: node scripts/smoke-vector-deletes.mjs <endpoint> <writeToken> [workspaceId]');
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
const chunk = (id, file) => ({
	id, casKey: `cas-${id}`, file, startLine: 1, endLine: 3, kind: 'function',
	name: id, language: 'typescript', scored: true, content: `function ${id.replace(/-/g, '_')}() { return 1; }`,
});

// Fresh slate (also exercises reset's vector-delete collection at the end).
// Drain anything a previous aborted run left queued so the exact-count
// assertions below start from zero.
await call('/reset', {});
await call('/init', { privacyMode: 'full' });
await call('/prune/kick', {});

// Two files in, one pruned out.
const b1 = await call('/sync/begin', { files: { 'src/keep.ts': 'hk', 'src/drop.ts': 'hd' }, embedIdentity: '' });
await call('/chunks', {
	syncId: b1.syncId,
	chunks: [chunk('vdel-smoke-keep', 'src/keep.ts'), chunk('vdel-smoke-drop-1', 'src/drop.ts'), chunk('vdel-smoke-drop-2', 'src/drop.ts')],
	fileHashes: { 'src/keep.ts': 'hk', 'src/drop.ts': 'hd' }, done: true,
});
const b2 = await call('/sync/begin', { files: { 'src/keep.ts': 'hk' }, embedIdentity: '' });
if (b2.removedFiles.length !== 1) throw new Error(`expected 1 removed file, got ${JSON.stringify(b2.removedFiles)}`);
await call('/chunks', { syncId: b2.syncId, chunks: [], fileHashes: { 'src/keep.ts': 'hk' }, done: true });

const staged = await call('/status', undefined, 'GET');
console.log('after prune: pendingVectorDeletes =', staged.pendingVectorDeletes, '(expect 2)');
if (staged.pendingVectorDeletes !== 2) throw new Error('prune did not stage vector deletions');

// Force the flush (same work the alarm chain does, synchronously observable).
const kick = await call('/prune/kick', {});
console.log('kick:', JSON.stringify(kick));
if (kick.vectorError) throw new Error(`flush failed against real Vectorize: ${kick.vectorError}`);
if (kick.vectorDeletesRemaining !== 0) throw new Error(`queue did not drain: ${kick.vectorDeletesRemaining} remaining`);

// Reset path: every remaining chunk id must be queued, then drain.
const reset = await call('/reset', {});
console.log('reset:', JSON.stringify(reset));
if (reset.vectorDeletesQueued !== 1) throw new Error(`reset queued ${reset.vectorDeletesQueued}, expected 1 (keep.ts chunk)`);
await call('/init', { privacyMode: 'full' });
const kick2 = await call('/prune/kick', {});
console.log('kick after reset:', JSON.stringify(kick2));
if (kick2.vectorError) throw new Error(`reset flush failed: ${kick2.vectorError}`);
if (kick2.vectorDeletesRemaining !== 0) throw new Error(`reset queue did not drain: ${kick2.vectorDeletesRemaining} remaining`);

console.log('VECTOR-DELETE SMOKE OK');
