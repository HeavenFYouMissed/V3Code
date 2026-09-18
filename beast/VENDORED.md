# beast — vendored source

The beast sidecar (Rust trigram + symbol code index) that `semantic_search`
can use as an extra retrieval channel and that Phase C agent tools
(symbol / trace / recall) will build on.

- **Vendored from:** private `V3Index`, `engine-c/beast-index` at
  `df04c8bf41bc784aa35c6ce94a212ce88f837cd7` (2026-07-06).
- **This copy is now the source of truth.** Beast development happens HERE;
  the V3Index copy is archival. No second repo checkout is needed for dev
  or for search to work.
- **Build + install:** `./scripts/build-beast.sh` (from the repo root) —
  builds `--release` and installs to `~/.v3code/bin/beast`, which is where
  the editor's `beastChannel` looks by default
  (`v3code.semanticIndex.beastBinaryPath` overrides).
- `beast/target/` is gitignored (build output, ~2GB).
- The editor works fine WITHOUT the binary: `IBeastService` goes dark for
  the session on any failure and `semantic_search` is unaffected.
- Fusion into ranking (`v3code.semanticIndex.beastFusion`) stays **default
  OFF** until the golden-set gate passes (see
  `scripts/retrieval-eval/README.md`).

Docs in this directory:
- `README.md` — public build and runtime overview.
- `PROVENANCE.md` — file-level origin and adaptation map.
- `THIRD_PARTY_NOTICES.md` — retained third-party notices and license terms.
- `queries/PROVENANCE.md` — exact tree-sitter query sources and hashes.

`PORT-PACKET.md` is a historical private research record. It is retained in the
shipping repository but excluded from the public source snapshot.
