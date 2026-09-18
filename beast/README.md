# Beast local indexer

Beast is V3Code's optional Rust sidecar for fast local trigram, symbol, reference,
impact and memory retrieval. Files remain the source of truth: every result resolves
to a file and line, and the editor re-reads that location before using it.

The editor works without the sidecar. When Beast is unavailable, its service goes
inactive for the session and the normal semantic and lexical search paths continue.
Beast fusion is disabled by default until its retrieval evaluation gate passes.

## Build and test

From the repository root:

```bash
cargo build --manifest-path beast/Cargo.toml
cargo test --manifest-path beast/Cargo.toml
```

`./scripts/build-beast.sh` builds a release binary and installs it in the local
V3Code binary directory used by the editor. Build output under `beast/target/` is
ignored.

## Commands

The `beast` binary can index a workspace, search text, find symbols and references,
trace file impact, and store or recall anchored local notes. Run `beast --help` for
the current command list.

## Source and licenses

V3Code's Beast contributions are licensed under Apache License 2.0; see `LICENSE`.
Parts of the implementation adapt permissively licensed upstream work, and several
tree-sitter query files are copied data. `PROVENANCE.md`,
`THIRD_PARTY_NOTICES.md`, and `queries/PROVENANCE.md` identify the exact sources,
versions, paths and licenses. Preserve those records when changing an adapted file
or query.

The private development research packet is not part of the public source snapshot.
Public provenance is carried by the focused records above.
