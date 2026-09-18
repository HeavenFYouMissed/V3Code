# V3Index

Multi-tenant cloud code indexing on Cloudflare. Editors, CLIs, CI jobs, and AI
agents push content-addressed code chunks; V3Index maintains a hybrid
lexical + vector + dependency-graph index per workspace and serves retrieval
over a REST API and a **per-workspace MCP endpoint** any agent can connect to.

The retrieval core is the V3Code editor's measured semantic-index pipeline
(tree-sitter parent/child chunking, hdr2 contextual embed headers, RRF hybrid
fusion, graph propagation, recency boost, adaptive knee) ported verbatim where
possible — see `docs/ARCHITECTURE.md`, `docs/RESEARCH.md`, and `src/core/`.

## Index profiles

- **Standard** (`vectors-only`): the editor uploads tokens, structure, graph
  signals, and a quantized local Qwen3 vector. Source never crosses the wire.
- **Advanced** (`ephemeral`): Power/Max sessions upload a chunk over TLS for
  Voyage Code 3 embedding. The DO keeps derived embed text only until the
  vector lands, writes no source to R2, and purges failed staging after one
  hour. The affected file manifest is invalidated so the next normal sync
  retries instead of leaving a permanent semantic hole.

The two profiles use separate Durable Object workspace ids and separate
Vectorize indexes. Equal dimensions do not make embedding spaces compatible;
Qwen and Voyage vectors are never mixed.

## Deploy

```sh
npm install                       # SHARP_IGNORE_GLOBAL_LIBVIPS=1 if sharp fights you
wrangler login
wrangler vectorize create v3index-chunks --dimensions=1024 --metric=cosine
wrangler vectorize create v3index-voyage-code3-1024 --dimensions=1024 --metric=cosine
wrangler r2 bucket create v3index-blobs
wrangler queues create v3index-embed
wrangler secret put MASTER_KEY_SECRET
wrangler secret put SESSION_KEY_SECRET
wrangler secret put VOYAGE_API_KEY
npm run deploy
```

## Tokens (P0)

Stateless: `base64url(HMAC-SHA256(MASTER_KEY_SECRET, "<workspaceId>:<scope>"))`
with scope `read` | `write` | `admin`. Derive with `deriveToken()` from
`src/index.ts` (or any HMAC tool). P1 replaces this with a key registry.

## API sketch

```
POST /v1/ws/:id/init             {privacyMode: 'full'|'vectors-only'|'ephemeral'}
POST /v1/ws/:id/sync/begin       {files: {path: contentHash}}      → {changedFiles, removedFiles}
POST /v1/ws/:id/chunks/check     {casKeys: []}                     → {known: []}
POST /v1/ws/:id/chunks           {syncId, chunks: WireChunk[], fileHashes, done}
POST /v1/ws/:id/signals/edits    {ranks: {file: rank}}             (recency boost input)
POST /v1/ws/:id/graph/lsp-edges  {files: [{file, defines, refs}]}  (editor LSP enricher data)
POST /v1/ws/:id/retrieve         {query, topK?}                    → {hits, vectorCoverage, tookMs}
GET  /v1/ws/:id/status
POST /v1/ws/:id/mcp              (MCP streamable-HTTP, JSON mode)
```

Wire shapes: `src/sync/protocol.ts`.
