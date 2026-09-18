# V3Code index measurement

This directory measures the index without changing retrieval behavior. The locked
goldset is `docs/v3index-beast-packet/eval/golden-vselite-v3.jsonl`: 120 unique
queries, exactly 20 for each measured retrieval lane (`trigram`, `symbol`, `resolved`,
`semantic`, `graph`, `memory`). Memory fixtures are also balanced 5/5/5/5 across
chat, workspace, editorial, and archive-page history.

## Sampling contract

The answer keys are selected before retrieval runs:

- trigram queries are rare, exact strings sampled across Rust, browser, React,
  configuration, and evaluator code; the validator proves the literal exists in an
  answer-key file;
- symbol queries are a seeded stratified sample of class, interface, component, and
  service-token definitions;
- resolved and graph queries are sampled from the source-derived tree-sitter def/ref
  inventory, with cross-file references required for resolved samples;
- semantic questions are independently worded product or architecture questions,
  not copied from a search result list;
- memory entries are synthetic fixed fixtures, balanced across the four memory
  tiers, so ranking is reproducible and contains no private user history.

The seed and strata are locked in the JSONL. Do not regenerate answer keys from the
retriever being evaluated. Source paths may be repaired only through review, with a
new goldset fingerprint.

Validate structure and current source anchors:

```bash
node scripts/index-measurement/validate-goldset.mjs
```

Also validate structural samples against a Beast `tags.json` built from the same
corpus:

```bash
node scripts/index-measurement/validate-goldset.mjs \
  --tags scripts/retrieval-eval/.scratch/goldset-mining-db/tags.json
```

The existing semantic evaluator accepts `--lane semantic` for a focused production
ranking run and records signal attribution for the first relevant hit. Omitting
`--lane` evaluates the complete stratified set.

## Cross-lane attribution

Collect Beast candidates once and score all available lanes:

```bash
node scripts/index-measurement/run-lane-eval.mjs \
  --beast-db scripts/retrieval-eval/.scratch/goldset-mining-db
```

The orchestrator always invokes the real Beast index command before candidate
collection. Its corpus fingerprint makes an unchanged run cheap and forces a
rebuild when the checkout is stale. Imported candidate/result files are rejected
unless their query IDs, text, answer keys, and query count match the locked set.
The goldset, report, and measurement-only code are excluded from both corpora so
the evaluator cannot retrieve its own questions or conclusions.

Add the real production semantic lane in the same report:

```bash
node scripts/index-measurement/run-lane-eval.mjs \
  --beast-db scripts/retrieval-eval/.scratch/goldset-mining-db \
  --run-semantic --semantic-embedder potion --semantic-max-files 800
```

For shipped-runtime evidence, add an extracted app rather than allowing the
semantic evaluator to resolve assets from workspace `node_modules`:

```bash
node scripts/index-measurement/run-lane-eval.mjs \
  --beast-db scripts/retrieval-eval/.scratch/goldset-mining-db \
  --run-semantic --semantic-embedder potion --semantic-max-files 800 \
  --package-root /path/to/V3Code.app --package-platform darwin-arm64
```

The generic runtime contract in `build/verify/artifact-manifest.json` covers
structural indexing, Potion, Qwen loader/native bindings, Beast, computer use,
native workspace services, and bundled agent content. Downloaded GGUF model weights
are explicitly external per-user assets; their package loaders are still gated.

The report names the winning lane for every query, intended-lane MRR/Recall,
unique wins, candidate-without-gold calls, and an equal-weight diagnostic RRF
leave-one-out delta. That fusion is explicitly diagnostic; it does not claim the
product currently fuses all six tools into one ranking.

## Incremental differential gate

```bash
./scripts/v3index-beast-incremental-gate.sh
```

The gate executes 128 deterministically seeded randomized scripts covering edit,
delete, rename, truncate, and branch-switch replacement. After every operation it
compares the reused candidate database with a clean rebuild across fixed trigram,
symbol, resolved, and graph queries. The test is ignored by ordinary `cargo test`
because it is a release gate, not a unit test.
