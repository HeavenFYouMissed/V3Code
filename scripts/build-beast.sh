#!/usr/bin/env bash
# Build the vendored beast sidecar (beast/) and install it where the editor
# looks for it (~/.v3code/bin/beast). Safe to run any time; the editor works
# without beast (the sidecar channel just stays dark), so this script is the
# ONLY step between a fresh clone and beast-powered search.
#
# Usage:  ./scripts/build-beast.sh
# Needs:  Rust toolchain (https://rustup.rs). Everything else is vendored.
set -euo pipefail

cd "$(dirname "$0")/../beast"

if ! command -v cargo >/dev/null 2>&1; then
	echo "[build-beast] cargo not found — install Rust from https://rustup.rs (the editor runs fine without beast; search just loses the sidecar channel)." >&2
	exit 1
fi

echo "[build-beast] cargo build --release (first build takes a few minutes)…"
cargo build --release

BIN_DIR="$HOME/.v3code/bin"
mkdir -p "$BIN_DIR"
cp target/release/beast "$BIN_DIR/beast"
chmod +x "$BIN_DIR/beast"

echo "[build-beast] installed: $BIN_DIR/beast ($("$BIN_DIR/beast" --version))"
echo "[build-beast] the editor picks it up on next launch (or Rebuild Codebase Index)."
