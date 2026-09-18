# Beast source provenance

The Beast crate entered this repository from the private V3Index tree at
`df04c8bf41bc784aa35c6ce94a212ce88f837cd7`. This map records the upstream
material incorporated into the current implementation. "Adapted" means local Rust
code was written from the identified permissive source and then changed for V3Code;
"independent" means the local implementation uses a documented behavior or public
crate API without copying that source file.

| Local paths | Classification | Pinned source | Upstream paths | License |
|---|---|---|---|---|
| `src/quality.rs`, `src/id.rs`, `src/lang.rs`, `src/tags.rs`, `src/tokenize.rs`, parts of `src/chunk.rs` | Adapted | `TabbyML/tabby@21b29048d7bcf6b94f9f482f2d0fd05efadfd19f` | `crates/tabby-index/src/code/index.rs`, `intelligence.rs`, `intelligence/id.rs`, `languages.rs`; `crates/tabby-common/src/index/code/tokenizer.rs` | Apache-2.0 |
| `src/index/schema.rs`, `src/index/ranking.rs`, `src/search.rs`, parts of `src/chunk.rs` and `src/index/mod.rs` | Adapted | `BloopAI/bloop@431e9e82c5a293c40f22aadb3615c3aa387af82e` | `server/bleep/src/indexes/schema.rs`, `server/bleep/src/query/ranking.rs`, `server/bleep/src/query/execute.rs`, `server/bleep/src/semantic/chunk.rs`, `server/bleep/src/indexes/file.rs` | Apache-2.0 |
| `src/walk.rs` | Independent Rust implementation of recorded ignore and hidden-file behavior | `opencode-ai/opencode@73ee493265acf15fcd8caab2bc8cd3bd375b63cb` | `internal/fileutil/fileutil.go`, `internal/llm/tools/grep.go` | MIT |
| `src/trace.rs`, graph-pull portions of `src/minindex/memory.rs` | Adapted to Beast's tag graph | GitLab project `gitlab-ai-hackathon/participants/35368827@14cb5d985fa40970e4f31735f69f23635bb404de` | `graphdev/backend/app/services/analysis/impact.py`, `graphdev/backend/app/services/enrichment.py` | MIT |
| confidence and reinforcement policy in `src/minindex/memory.rs` | Independent V3Code implementation informed by the public memory-service model | `letta-ai/letta@b76da9092518cbaa2d09042e52fdcbde69243e18` | `letta/services/memory_repo/` | Apache-2.0 |
| `src/resolve.rs`, `src/minindex/resolved.rs` | V3Code graph construction using the published crate API | `stack-graphs` crate `0.14.1`, checksum `d369305747128ef353193fa34350c26fbc545ac70d2f97eb7321f72afd077109` | crate API; dependency source is not vendored here | MIT OR Apache-2.0 |
| `queries/csharp.scm` through `queries/tsx.scm` | Exact copies | Tabby commit above | `crates/tabby-index/queries/*.scm` | Apache-2.0 |
| `queries/tags-typescript-combined.scm` | Exact concatenation with a provenance header | tree-sitter JavaScript `v0.21.4` and TypeScript `v0.21.1`; see `queries/PROVENANCE.md` | each repository's `queries/tags.scm` | MIT |

The remaining crate glue, CLI, evaluation, router, RRF, local index interfaces,
tests and V3Code-specific modifications were developed in the V3Index/V3Code history.
That statement does not erase the upstream rights identified above.

Historical research notes mention additional projects that were evaluated but not
incorporated into the current Beast implementation. Those notes are excluded from the
public snapshot; they are not a license source for shipped code.
