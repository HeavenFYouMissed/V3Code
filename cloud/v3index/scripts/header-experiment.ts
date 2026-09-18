/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  HEADER EXPERIMENT — does a rich, agent-written header on each code block actually
 *  improve retrieval? Loads the REAL potion-code-16M model and measures Recall@k / MRR
 *  over a goldset in two conditions:
 *    baseline  = embed `${name}\n${content}`            (raw code, what everyone does)
 *    +header   = embed `${richHeader}\n${name}\n${content}`  (the owner's hypothesis)
 *  Run: npx tsx scripts/header-experiment.ts
 *--------------------------------------------------------------------------------------*/
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { encodeIds, embedVector, parseStaticModel } from '../src/embed/staticEmbedder.js';

const blob = readFileSync('/tmp/potion-code-16M-int8-v1.bin');
const model = parseStaticModel(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
const tk = JSON.parse(readFileSync(join(homedir(), '.v3code/models/minishlab/potion-code-16M/tokenizer.json'), 'utf8'));
const vocab = new Map<string, number>(Object.entries(tk.model.vocab as Record<string, number>));
const unkId = vocab.get('[UNK]')!;
const embed = (t: string) => embedVector(encodeIds(t, vocab, unkId), model);
const cos = (a: Float32Array, b: Float32Array) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

// HARD/REALISTIC goldset: opaque names + bodies that DON'T contain the query terms,
// and INTENT queries with a vocabulary gap — the case where headers should matter.
interface Chunk { id: string; name: string; content: string; header: string; }
const CHUNKS: Chunk[] = [
	{ id: 'rateLimit', name: 'handle', content: 'async handle(req){ const id=req.ip; if(!this.tb.take(id)) return reply(429); return this.next(req); }',
	  header: 'Throttles abusive clients: rate-limits incoming requests per client IP using a token bucket, replying 429 Too Many Requests when the limit is exceeded.' },
	{ id: 'idempotency', name: 'process', content: 'async process(job){ if(await this.seen.has(job.key)) return; await this.seen.add(job.key); await this.run(job); }',
	  header: 'Prevents a customer from being charged twice: makes job processing idempotent by recording each job key and skipping any job already seen.' },
	{ id: 'pwCheck', name: 'check', content: 'check(u){ return timingSafeEqual(u.h, digest(u.p)); }',
	  header: 'Verifies a login password by constant-time comparing its hash to the stored value, guarding against timing attacks during authentication.' },
	{ id: 'lru', name: 'Store', content: 'class Store{ m=new Map(); read(k){ const v=this.m.get(k); this.m.delete(k); this.m.set(k,v); return v; } }',
	  header: 'Keeps frequently used values in memory and evicts the least-recently-used entry when full — an LRU cache that avoids repeated expensive lookups.' },
	{ id: 'retry', name: 'run', content: 'async run(f){ for(let i=0;i<5;i++){ try{ return await f(); }catch(e){ await wait(2**i*100); } } throw new Error("gave up"); }',
	  header: 'Retries a flaky operation up to five times with exponential backoff between attempts, to survive transient network failures.' },
	{ id: 'mintToken', name: 'mk', content: 'mk(id){ return enc({sub:id, exp:now()+3600}, KEY); }',
	  header: 'Mints a signed, one-hour access token for a user id — the login token used to authenticate later requests.' },
	{ id: 'fingerprint', name: 'fp', content: 'fp(s){ return h("sha256").update(s).digest("hex"); }',
	  header: 'Computes a stable content fingerprint by SHA-256 hashing the input to a hex digest; used to dedupe and detect when content changes.' },
	{ id: 'enqueue', name: 'push', content: 'push(j){ return this.q.send(j); }',
	  header: 'Schedules background work by placing a job on the async queue, moving it off the request path.' },
	{ id: 'refund', name: 'undo', content: 'async undo(id){ return this.gw.reverse(id); }',
	  header: 'Reverses a completed payment by refunding the original charge through the gateway when an order is cancelled or disputed.' },
	{ id: 'verifyToken', name: 'chk', content: 'chk(t){ return dec(t, KEY); }',
	  header: 'Authenticates an incoming request by decoding and verifying its access token, rejecting expired or forged tokens.' },
	{ id: 'debounce', name: 'wrap', content: 'wrap(f,ms){ let t; return(...a)=>{ clearTimeout(t); t=setTimeout(()=>f(...a),ms); }; }',
	  header: 'Debounces a function so it only fires after activity settles — coalesces rapid repeated calls into one, e.g. for search-as-you-type.' },
	{ id: 'paginate', name: 'page', content: 'page(rows,c){ const s=c?dec(c):0; return { items: rows.slice(s,s+20), next: enc(s+20) }; }',
	  header: 'Paginates a result set using an opaque cursor, returning the next 20 items and a cursor for the following page.' },
];
const QUERIES: Array<{ q: string; want: string }> = [
	{ q: 'how do we stop clients from hammering the api', want: 'rateLimit' },
	{ q: 'avoid double billing a customer', want: 'idempotency' },
	{ q: 'make sure the user typed the right password', want: 'pwCheck' },
	{ q: 'keep hot data fast and drop the coldest', want: 'lru' },
	{ q: 'keep trying when the network flakes out', want: 'retry' },
	{ q: 'create a login token that expires', want: 'mintToken' },
	{ q: 'detect when a file changed by its contents', want: 'fingerprint' },
	{ q: 'run this task later in the background', want: 'enqueue' },
	{ q: 'give the customer their money back', want: 'refund' },
	{ q: 'authenticate a request from its bearer token', want: 'verifyToken' },
	{ q: 'coalesce rapid search-as-you-type keystrokes', want: 'debounce' },
	{ q: 'return the next page of results', want: 'paginate' },
];

// Gemma's ACTUAL output (phone model, in-editor). Thin/terse; lru is wrong ("lazy
// loading"), refund lost the payment concept, retry was skipped entirely.
const GEMMA: Record<string, string> = {
	rateLimit: 'This function handles rate limiting.',
	idempotency: 'This function ensures idempotency by repeatedly processing an item',
	pwCheck: 'This function checks password accuracy',
	lru: 'This class manages lazy loading.',
	retry: '', // Gemma skipped it → falls back to raw
	mintToken: 'This function creates an embedded key',
	fingerprint: 'This function returns an hexadecimal fingerprint',
	enqueue: 'This function sends data.',
	refund: 'This function undoes an action.',
	verifyToken: 'This function verifies an token',
	debounce: 'This function wraps an async function.',
	paginate: 'This function provides pagination.',
};

function run(mode: 'raw' | 'gemma' | 'rich') {
	const vecs = new Map<string, Float32Array>();
	for (const c of CHUNKS) {
		const h = mode === 'raw' ? '' : mode === 'gemma' ? (GEMMA[c.id] ?? '') : c.header;
		vecs.set(c.id, embed(h ? `${h}\n${c.name}\n${c.content}` : `${c.name}\n${c.content}`));
	}
	let mrr = 0, h1 = 0, h5 = 0, h10 = 0;
	const ranks: number[] = [];
	for (const { q, want } of QUERIES) {
		const qv = embed(q);
		const ranked = CHUNKS.map(c => ({ id: c.id, s: cos(qv, vecs.get(c.id)!) })).sort((a, b) => b.s - a.s);
		const rank = ranked.findIndex(r => r.id === want) + 1;
		if (rank > 0) { mrr += 1 / rank; if (rank <= 1) h1++; if (rank <= 5) h5++; if (rank <= 10) h10++; }
		ranks.push(rank);
	}
	const n = QUERIES.length;
	return { r1: h1 / n, r5: h5 / n, r10: h10 / n, mrr: mrr / n, ranks };
}

const base = run('raw');
const gem = run('gemma');
const rich = run('rich');
const pct = (x: number) => (x * 100).toFixed(1) + '%';
console.log('\n=== HEADER EXPERIMENT (real potion-code-16M vectors, n=' + QUERIES.length + ') ===');
console.log('                   Recall@1   Recall@5   MRR');
for (const [label, r] of [['baseline (raw)   ', base], ['Gemma headers    ', gem], ['rich headers     ', rich]] as const)
	console.log(`${label} ${pct(r.r1).padEnd(10)} ${pct(r.r5).padEnd(10)} ${r.mrr.toFixed(3)}`);
console.log('\nper-query rank (raw → Gemma → rich):');
for (let i = 0; i < QUERIES.length; i++)
	console.log(`  #${base.ranks[i] || '—'} → #${gem.ranks[i] || '—'} → #${rich.ranks[i] || '—'}   ${QUERIES[i].want}`);
