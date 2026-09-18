#!/usr/bin/env bash
# Focused, non-destructive confinement tests for v3-sign-notarize-mac.sh.
# Requires an unsigned package for the current HEAD; never loads credentials,
# creates a keychain, signs, notarizes, or mutates the candidate.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SIGNER="$REPO_ROOT/scripts/v3-sign-notarize-mac.sh"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
RELEASE_ROOT="$REPO_ROOT/.build/releases/$COMMIT"
APP_PATH="$RELEASE_ROOT/VSCode-darwin-x64/V3Code.app"
DIST_DIR="$RELEASE_ROOT/dist"

[ -d "$APP_PATH" ] || {
	echo "test-v3-sign-notarize-paths: package current HEAD first: $APP_PATH" >&2
	exit 1
}

PASS_COUNT=0

expect_pass() {
	local label="$1"
	shift
	"$SIGNER" --preflight-paths-only "$@" >/dev/null
	PASS_COUNT=$((PASS_COUNT + 1))
	echo "[PASS] $label"
}

expect_fail() {
	local label="$1"
	local expected="$2"
	shift 2
	local output
	local status
	set +e
	output="$("$SIGNER" --preflight-paths-only "$@" 2>&1)"
	status=$?
	set -e
	if [ "$status" -eq 0 ]; then
		echo "[FAIL] $label: unexpectedly accepted" >&2
		exit 1
	fi
	if ! printf '%s\n' "$output" | grep -Fq -- "$expected"; then
		echo "[FAIL] $label: wrong rejection" >&2
		printf '%s\n' "$output" >&2
		exit 1
	fi
	PASS_COUNT=$((PASS_COUNT + 1))
	echo "[PASS] $label"
}

expect_pass "default exact Intel paths" \
	--arch=x64 --expected-commit "$COMMIT"
expect_pass "explicit exact Intel paths" \
	--arch=x64 --expected-commit "$COMMIT" \
	--release-root "$RELEASE_ROOT" --app "$APP_PATH" --dist-dir "$DIST_DIR"
expect_fail "reject broad repo release root" "--release-root must be exactly" \
	--arch=x64 --expected-commit "$COMMIT" --release-root "$REPO_ROOT"
expect_fail "reject app lookalike outside exact bundle path" "--app must be exactly" \
	--arch=x64 --expected-commit "$COMMIT" --app "$RELEASE_ROOT/VSCode-darwin-x64"
expect_fail "reject dist outside the release root" "--dist-dir must be exactly" \
	--arch=x64 --expected-commit "$COMMIT" --dist-dir "$REPO_ROOT/.build"
expect_fail "reject non-SHA release key" "not a 40-hex SHA" \
	--arch=x64 --expected-commit "${COMMIT:0:12}"

# Prove an exact-looking release entry cannot be a symlink to another tree.
FAKE_COMMIT="0000000000000000000000000000000000000001"
FAKE_RELEASE="$REPO_ROOT/.build/releases/$FAKE_COMMIT"
TEST_DIR="$(mktemp -d "$REPO_ROOT/.build/sign-path-safety.XXXXXX")"
cleanup() {
	rm -f "$FAKE_RELEASE"
	rm -rf "$TEST_DIR"
}
trap cleanup EXIT
[ ! -e "$FAKE_RELEASE" ] && [ ! -L "$FAKE_RELEASE" ] || {
	echo "test-v3-sign-notarize-paths: reserved fake release path already exists: $FAKE_RELEASE" >&2
	exit 1
}
mkdir -p "$TEST_DIR/outside/VSCode-darwin-x64/V3Code.app"
ln -s "$TEST_DIR/outside" "$FAKE_RELEASE"
expect_fail "reject release-root symlink escape" "release root escapes through a symlink" \
	--arch=x64 --expected-commit "$FAKE_COMMIT"

echo "test-v3-sign-notarize-paths: $PASS_COUNT passed, 0 failed"
