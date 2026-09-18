#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/beast"

# Explicitly ignored in normal `cargo test` because this is a release-quality
# differential gate, not a millisecond unit test. The test itself hard-codes
# 128 seeded scripts and refuses to weaken coverage through an environment flag.
cargo test --test incremental_oracle -- --ignored --nocapture
