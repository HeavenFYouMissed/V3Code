# Retrieval eval harness

Offline recall/MRR measurement for the semantic-index retrieval pipeline. It
drives the REAL production code — `treeSitterChunker.ts`, `hybridRetriever.ts`,
`dependencyGraph.ts` and `embedText.ts` are esbuild-bundled from source at
runtime — over a repo checkout as the corpus, so ranking changes measured here
are the same code that ships. No editor, no services, no network (in the
default configuration).

## Per-lane measurement (which lane produced the win)

V3Code retrieves through six lanes. An overall MRR cannot tell you which one
moved, so a lane that is dead weight — or actively hurting — stays invisible.
Three pieces close that:

```bash
# 1. Build the lane-separating golden set (120 queries, 20 per lane).
#    Ground truth comes from the REPO (symbol definitions, git history, import
#    edges), never from the engine — see the header of mine-lane-goldset.mjs.
node scripts/retrieval-eval/mine-lane-goldset.mjs

# 2. TS-side attribution: adds a per-lane table + winning channel
#    (lex / vec / graph / beast / neighbor) read out of Hit.signals.
node scripts/retrieval-eval/run-eval.mjs \
  --goldset scripts/retrieval-eval/sets/golden-lanes.jsonl

# 3. Beast-side attribution: run-eval sees beast as ONE collapsed signal, so
#    per-engine numbers have to come from beast itself.
node scripts/retrieval-eval/lane-report-beast.mjs
```

`lane` is an optional extra field. Golden sets without it — including
`golden-vselite.jsonl` — score exactly as before and print no lane table.

**Determinism check.** A corpus that silently loses files does not move MRR, so
no eval score can catch it (this is a real bug that shipped: a symlinked file
was dropped by the walk and every metric stayed flat). `beast verify` indexes
the same corpus twice and asserts the corpus fingerprint AND the tag multiset
match:

```bash
./beast/target/release/beast verify . --exclude node_modules --exclude .git
```

`cargo test` runs the same invariants on fixtures, so the check is automatic.

## Usage

```bash
node scripts/retrieval-eval/mine-goldset.mjs   # once (or after significant history)
node scripts/retrieval-eval/run-eval.mjs       # potion embedder, mined goldset

# B0 scorekeeper — the golden set + SHARED scoring rule used to gate every
# ranking change (and to compare against the beast engine's numbers):
node scripts/retrieval-eval/run-eval.mjs \
  --goldset docs/v3index-beast-packet/eval/golden-vselite.jsonl --configs +headers

# The gate for a ranking change: run once before the change, once after,
# comparing per-query first ranks. Ship only on PASS (no per-query
# regressions + net win):
node scripts/retrieval-eval/run-eval.mjs \
  --goldset docs/v3index-beast-packet/eval/golden-vselite.jsonl --configs +headers \
  --baseline scripts/retrieval-eval/results/<before>.json

# Quality path (Qwen3-Embedding-0.6B GGUF; slow — cap the corpus, gold files
# are always kept; compare only runs with the SAME --max-files):
node scripts/retrieval-eval/run-eval.mjs --embedder qwen --max-files 800 \
  --goldset docs/v3index-beast-packet/eval/golden-vselite.jsonl

# Beast sidecar as a 4th RRF channel (the Phase B gate): builds a fresh beast
# index in .scratch/ (needs ~/.v3code/bin/beast or BEAST_BIN) and injects
# per-query trigram hits into the REAL production fusion:
node scripts/retrieval-eval/run-eval.mjs --beast --beast-weight 0.4 \
  --goldset docs/v3index-beast-packet/eval/golden-vselite.jsonl --configs +headers \
  --baseline scripts/retrieval-eval/baselines/<blessed-no-beast-run>.json

# Strict release gate. Refuses hash/stub embeddings, goldsets below 30 queries,
# non-shared scoring, a missing baseline, or a corpus-content/model/topK mismatch:
node scripts/retrieval-eval/run-eval.mjs --embedder qwen --max-files 800 \
  --goldset docs/v3index-beast-packet/eval/golden-vselite-v2.jsonl --configs +headers \
  --baseline scripts/retrieval-eval/baselines/<candidate-parent>.json --release-gate
```

### Local cross-encoder rerank (`--rerank`)

Runs the REAL production `LlamaReranker` (Qwen3-Reranker-0.6B GGUF through
node-llama-cpp) over each query's fused head, the same way `_localRerank` does it.
It hard-fails if the GGUF is missing, so a green run also proves the model loads.

```bash
node scripts/retrieval-eval/run-eval.mjs --embedder potion --max-files 800 \
  --goldset docs/v3index-beast-packet/eval/golden-vselite-v2.jsonl --configs +headers \
  --rerank --output scripts/retrieval-eval/results/<before>.json
```

Measured on `golden-vselite-v2` (35 queries, potion, `--max-files 800`; all rows
below were produced on ONE corpus fingerprint, so they are mutually comparable):

| variant | R@5 | R@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- |
| fused only | 74.3% | 88.6% | 0.5305 | 0.5070 |
| **pure rerank (ships)** | **85.7%** | 88.6% | **0.5838** | **0.5534** |
| `--rerank-guard 1` (blanket pin) | 85.7% | 88.6% | 0.5590 | 0.5180 |
| `--rerank-guard 1 --rerank-guard-lead 1.06` | 85.7% | 88.6% | 0.5638 | 0.5237 |
| `--rerank-guard 1 --rerank-guard-lead 1.20` | 85.7% | 88.6% | 0.5590 | 0.5262 |

The rerank moves 15 queries up and 5 down, so it FAILS the plain `--baseline` gate
despite winning on every aggregate metric — that gate demands zero per-query
first-rank regressions. All 5 regressions are fused-rank-1 answers being overtaken;
4 of them stay inside the top 5 and only one (1→6) actually costs recall.

**Rejected: the rerank head-protection guard.** `--rerank-guard N` pins the first N
fused positions so the cross-encoder cannot demote them; `--rerank-guard-lead R`
narrows the pin to confident fused winners (pin only when the fused rank-1 leads
rank-2 by a factor of at least `R`). Both forms were measured and both LOSE. The
blanket pin restores those 5 rank-1 answers but reverts 14 promotions the
cross-encoder got right (mostly 1→2), and every lead threshold tried (1.001, 1.02,
1.06, 1.20) still finishes below pure rerank on MRR and nDCG while buying nothing
on R@5: each variant gains only the handful of queries where fusion already had
rank 1 right, and loses strictly more than it gains. The knobs are kept, off by
default (`protectHead: 0`), so the trade can be re-measured in one flag if the
reranker model or the gold set changes.

**Editing the retriever source mid-sweep invalidates the sweep.** The code under
test is itself part of the corpus, so every edit shifts the corpus fingerprint and
makes the runs non-comparable (`--baseline` will correctly refuse them). Finish a
sweep before touching `src/`, or drop the file with `--corpus-exclude`. Result
files can be re-grouped after the fact by `(goldset, corpus fingerprint)`.

### Package-resolved evaluation

An ordinary source run resolves runtime assets from workspace `node_modules`.
That is useful for algorithm work but is not proof that a shipped app can execute
the same path. Point the evaluator at an extracted package to gate and load assets
from the app's actual `resources/app` tree:

```bash
node scripts/retrieval-eval/run-eval.mjs \
  --goldset docs/v3index-beast-packet/eval/golden-vselite-v3.jsonl \
  --embedder potion --configs +headers --max-files 800 \
  --package-root /path/to/V3Code.app --package-platform darwin-arm64
```

Windows extracted trees use `--package-platform win32-x64`. The run fails before
chunking if any runtime asset required by the selected feature groups is absent.
`--diagnose-missing-runtime-assets` exists only to quantify a known-bad package's
fallback behavior; it is forbidden with `--release-gate` and the result records the
override, so it cannot be presented as release evidence. Reports also include
per-language structural/fallback counts—a global "Tree-sitter loaded" message is
not evidence that each language grammar actually loaded.

Use `--output <new-path>` to create an explicit candidate-parent baseline. It
refuses to overwrite an existing file, so replacing a blessed baseline always
requires a visible review/delete step. Release baselines are schema-versioned;
legacy result files without the corpus fingerprint and per-query nDCG fields
are intentionally refused instead of being treated as comparable.

`mine-goldset.mjs` turns the last N (default 200) non-merge commits into
`sets/goldset.json`: each surviving commit contributes
`{ query: <commit subject>, files: <changed code files that still exist> }`.
Filters: trivial subjects (wip / typo / version bumps / < 15 chars), mega
commits (> 20 files), churn files that appear in a large fraction of commits
(lockfiles, changelogs), duplicate subjects. Capped at 100 queries.

`run-eval.mjs` chunks every git-tracked code file with the production chunker
(tree-sitter structural parent/child chunking; if the wasm runtime cannot load
in-script it falls back to the production line-window chunker and says so in
the output), embeds the scored chunks, and runs every gold query through the
production `hybridSearch` in two configs:

| config        | embed text                                                        |
| ------------- | ----------------------------------------------------------------- |
| `baseline`    | chunk content (pre-contextual-headers behavior)                    |
| `+headers`    | `embedTextFor(chunk)` — the SHIPPED scheme (hdr2: `// basename :: parent :: name` + content) |
| `last3`/`last2` | header with the file segment cut to the last 3 / 2 path segments |
| `basename`    | header with the file segment cut to the basename (== hdr2)        |
| `parent-name` | header with the file segment dropped entirely                     |

The variant configs exist because of the hdr1→hdr2 experiment (2026-07-02) and
are kept for re-measuring when the embedder changes. With the full relative
path (hdr1) the header was a net REGRESSION on potion-code-16M (Recall@5
20.7%→19.9%, MRR 0.252→0.229) while a strong win on the hash embedder —
potion mean-pools token vectors, and the path prefix shared by most chunks
(`src/vs/workbench/contrib/...`) homogenizes them. Truncating the file segment
recovers monotonically as the prefix shrinks; basename won every potion metric
(Recall@5 22.4%, R@10 28.1%, MRR 0.254; per-query R@5 7 wins / 3 losses) while
keeping most of the hash-channel value, so hdr2 ships the basename.

Queries are embedded raw in both configs (contextual-retrieval convention:
documents get context, queries do not).

## What the numbers mean

Two goldset formats select two scoring modes — **never compare numbers across
modes**:

**`.json` (mined, `sets/goldset.json`)** — FILE-level: a hit is relevant iff
`hit.chunk.file` is one of the commit's gold files. Hits are collapsed to
distinct files in rank order, then averaged over queries:

- **Recall@5 / Recall@10** — fraction of a query's gold files present in the
  top 5 / top 10 distinct result files.
- **MRR** — mean of 1/rank of the FIRST relevant file (0 if none ranked).
- **nDCG@10** — graded position quality when a query has more than one relevant file.
- **empty** — fraction of queries for which the retriever returned no candidate.
- **p50/p95 ms** — `hybridSearch` wall time distribution at this corpus size.

**`.jsonl` (golden, `docs/v3index-beast-packet/eval/*.jsonl`)** — the SHARED
rule, mirroring the beast engine's `eval.rs` exactly so both engines score
comparably on the same set: a hit is relevant iff its file path SUFFIX-matches
a golden `relevant` entry (span overlap too when the entry carries `:start-end`).
The engine is asked `topk*3` deep, hits collapse to unique files in rank order,
truncated to `topk`; rank = first relevant unique file.

- **Recall@5 / Recall@10** — fraction of QUERIES whose first relevant file
  ranks ≤ 5 / ≤ 10 (binary per query — not fraction-of-gold-files).
- **MRR** — mean of 1/rank (0 on miss).
- **nDCG@10**, **empty**, and **p50/p95 ms** use the same definitions as above.

The current release scorekeeper is `golden-vselite-v2.jsonl` (35 hand-authored
queries). Reference points on the older `golden-vselite.jsonl` (11 queries): beast trigram-only
scored MRR 0.205 / R@5 0.364 / R@10 0.455 (2026-07-06, full VSElite corpus).
The gate for ranking changes: `--baseline <before>.json` must print PASS —
no per-query regressions + net win. The final `--release-gate` also accepts an
unchanged result as release-safe, but refuses any first-rank, per-query nDCG,
empty-result, corpus, model, top-k, goldset, or query-set regression/mismatch.

Which channels can move between configs (the run prints this too): chunk
lexical tokens come from chunking, never from embed text, so the lexical
channel is identical in both configs — headers can only shift the VECTOR
channel.

Results land in `results/<timestamp>.json` with per-query detail for digging
into wins/regressions. Each result records a SHA-256 fingerprint over the exact
ordered corpus paths and contents. `--release-gate` requires that fingerprint,
the embedder identity, top-k, and goldset to match the baseline; equal file
counts are not treated as comparable evidence.

Real-Qwen document vectors are content-addressed and checkpointed atomically
during long runs. An interrupted run can resume from the last checkpoint
without blessing a partial result file as a baseline.

## Honest limitations

- **Gold sets mined from commit history are noisy proxies.** A commit subject
  is not a search query a user would type, and changed-files is both an over-
  approximation (drive-by edits, mechanical renames) and an under-approximation
  (the file you needed to READ to make the change is not in the diff) of
  "relevant". Absolute numbers are weak; treat them only as A/B signal between
  configs on the same gold set.
- **The default hash embedder under-measures semantic gains.** It is a
  deterministic FNV bag-of-tokens vectorizer, so `+headers` only measures the
  value of the header's TOKENS (path words, parent symbol) reaching the vector
  channel. A real embedder also gets disambiguation ("this loop is inside
  `walkWorkspace`"), which the hash embedder cannot represent. Use
  `--embedder potion` (needs the model assets cached under `~/.v3code/models`,
  or network to fetch them once) for the production static embedder.
- **Corpus = worktree HEAD, gold = recent history.** Files deleted since a
  mined commit are excluded by the miner; heavily-refactored files can still
  make a gold entry stale.
- **Chunk-id / tokenization plumbing is mirrored, not imported** — the small
  private helpers of `semanticIndexBrowserImpl.chunkFile` (hash64Hex, tokenize,
  stopwords, language map) are copied into the script and must be kept in sync
  manually. The chunker and ranking code themselves are the real thing.
- No neighbor/recency inputs: `recentFiles` is null (no edit journal offline),
  so the recency boost never fires; graph neighbor expansion IS active.
