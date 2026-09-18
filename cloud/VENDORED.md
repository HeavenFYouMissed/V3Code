# cloud/ — vendored Cloudflare workers

The editor's cloud services, vendored so ONE repo holds everything that runs
and develops V3Code (same single-repo story as `/beast`).

- **Vendored from:** `V3Index` repo @ `df04c8b` (2026-07-06). This copy is now
  the source of truth; V3Index is archival.
- **`v3index/`** — the cloud code index: Cloudflare Worker + per-workspace
  Durable Object (SQLite + FTS5 + symbol graph), Vectorize (potion-256 fast
  path + qwen3-1024 quality tier), R2 chunk blobs, embed queue. The editor's
  `v3code.cloudIndex.*` settings point at a deployment of this.
- **`v3update/`** — the editor update server (release channel metadata).

## Working on them

```bash
cd cloud/v3index && npm install     # first time
npx vitest                          # tests (fusion, ingest, graph, keys, potion fixtures)
npx wrangler deploy                 # deploy (needs CLOUDFLARE_API_TOKEN in env)
```

**Certified 2026-07-06: 17 test files, 85/85 pass** from this vendored copy.
Two gotchas, both handled:
- Each worker has its own `.npmrc` that BLANKS the repo-root Electron npm
  pins (`runtime`, `disturl`, `build_from_source`) — without it, wrangler's
  `sharp` tries a from-source build and dies ("Please add node-gyp"). Values
  must be EMPTY, not `false` (install scripts treat any non-empty
  `npm_config_build_from_source` as truthy).
- If the DO tests fail with `SQLITE_CANTOPEN` under a sandboxed/locked-down
  shell, point TMPDIR somewhere writable: `TMPDIR=$PWD/.tmp npx vitest run`.

## Rules

- **No secrets in this tree — ever.** `wrangler.jsonc` holds only infra ids;
  real credentials go through `wrangler secret put` and live locally in
  `~/.v3code/secrets/cloudflare.env` (never committed). The shipped editor has
  NO baked-in endpoint or token: `v3code.cloudIndex.endpoint`/`token` default
  empty and `enabled` defaults false — every user (and Daniel) configures
  their own deployment or gets a hosted one via the paid tier.
- `node_modules/` and `.wrangler/` are gitignored per worker.
- The known "/chunks → Durable Object exceeded CPU" saga: request caps +
  bounded transactions live in `v3index/src/index.ts` and
  `v3index/src/do/workspaceDO.ts`; the editor client also batches 25/post
  with pacing (`cloudIndexSyncer.ts`). If 500s persist at scale, the next
  levers are server-side: smaller `CHUNK_TXN_SIZE`, moving FTS/graph denorm
  into the embed queue, or replacing DO ingest with a beast-based service.

Still separate by design: `superclaw` (paid backend / hosted inference).
