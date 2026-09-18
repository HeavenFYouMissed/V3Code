#!/usr/bin/env bash
# Structural and sidecar smoke for a packaged macOS app. This script never
# opens the Electron GUI and never touches an installed V3Code profile.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="arm64"
APP_PATH=""
METADATA=""
EXPECTED_COMMIT=""
EXPECT_UNSIGNED=0
EXPECT_SIGNED=0

while [ $# -gt 0 ]; do
	case "$1" in
		--arch=*) ARCH="${1#--arch=}" ;;
		--app) APP_PATH="${2:?--app requires a path}"; shift ;;
		--metadata) METADATA="${2:?--metadata requires a path}"; shift ;;
		--expected-commit) EXPECTED_COMMIT="${2:?--expected-commit requires a SHA}"; shift ;;
		--expect-unsigned) EXPECT_UNSIGNED=1 ;;
		--expect-signed) EXPECT_SIGNED=1 ;;
		*) echo "v3-smoke-mac-cli: unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

[ "$EXPECT_UNSIGNED" -eq 0 ] || [ "$EXPECT_SIGNED" -eq 0 ] || {
	echo "v3-smoke-mac-cli: --expect-unsigned and --expect-signed are mutually exclusive" >&2
	exit 2
}

case "$ARCH" in arm64|x64) ;; *) echo "v3-smoke-mac-cli: --arch must be arm64 or x64" >&2; exit 2 ;; esac
[ "$(uname -s)" = "Darwin" ] || { echo "v3-smoke-mac-cli: macOS only" >&2; exit 1; }
[ -n "$APP_PATH" ] && [ -d "$APP_PATH" ] || { echo "v3-smoke-mac-cli: app not found: $APP_PATH" >&2; exit 1; }
APP_PATH="$(cd "$(dirname "$APP_PATH")" && pwd)/$(basename "$APP_PATH")"
if [ -n "$METADATA" ]; then
	[ -f "$METADATA" ] || { echo "v3-smoke-mac-cli: metadata not found: $METADATA" >&2; exit 1; }
	METADATA="$(cd "$(dirname "$METADATA")" && pwd)/$(basename "$METADATA")"
fi

cd "$REPO_ROOT"
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

BUNDLE_PRODUCT="$APP_PATH/Contents/Resources/app/product.json"
[ -f "$BUNDLE_PRODUCT" ] || { echo "v3-smoke-mac-cli: bundle product.json missing" >&2; exit 1; }
BUNDLE_COMMIT="$(node -p "require('$BUNDLE_PRODUCT').commit ?? ''")"
printf '%s' "$BUNDLE_COMMIT" | grep -qE '^[0-9a-f]{40}$' || {
	echo "v3-smoke-mac-cli: bundle commit is invalid: $BUNDLE_COMMIT" >&2
	exit 1
}
if [ -n "$EXPECTED_COMMIT" ] && [ "$BUNDLE_COMMIT" != "$EXPECTED_COMMIT" ]; then
	echo "v3-smoke-mac-cli: bundle commit $BUNDLE_COMMIT != expected $EXPECTED_COMMIT" >&2
	exit 1
fi

if [ -n "$METADATA" ]; then
	[ -f "$METADATA" ] || { echo "v3-smoke-mac-cli: metadata not found: $METADATA" >&2; exit 1; }
	META_COMMIT="$(node -p "require('$METADATA').commit ?? ''")"
	META_ARCH="$(node -p "require('$METADATA').arch ?? ''")"
	ARTIFACT="$(node -p "require('$METADATA').artifact ?? ''")"
	META_SHA="$(node -p "require('$METADATA').sha256 ?? ''")"
	META_SIZE="$(node -p "require('$METADATA').size ?? 0")"
	[ "$META_COMMIT" = "$BUNDLE_COMMIT" ] || { echo "v3-smoke-mac-cli: metadata commit mismatch" >&2; exit 1; }
	[ "$META_ARCH" = "$ARCH" ] || { echo "v3-smoke-mac-cli: metadata arch mismatch" >&2; exit 1; }
	[ -f "$ARTIFACT" ] || { echo "v3-smoke-mac-cli: recorded artifact missing: $ARTIFACT" >&2; exit 1; }
	[ "$(stat -f%z "$ARTIFACT")" = "$META_SIZE" ] || { echo "v3-smoke-mac-cli: artifact size mismatch" >&2; exit 1; }
	[ "$(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)" = "$META_SHA" ] || { echo "v3-smoke-mac-cli: artifact SHA mismatch" >&2; exit 1; }
	echo "    immutable artifact metadata OK: $(basename "$ARTIFACT")"
fi

log "Manifest package gate"
node build/verify/verify-package.mjs --platform "darwin-$ARCH" --root "$APP_PATH"

MAIN_NAME="$(node -p "require('$BUNDLE_PRODUCT').nameShort")"
MAIN_EXEC="$APP_PATH/Contents/MacOS/$MAIN_NAME"
HELPER="$APP_PATH/Contents/Resources/computerUse/darwin/v3code-computer-use-helper"
BEAST="$APP_PATH/Contents/Resources/beast/beast"

expected_slice="arm64"
[ "$ARCH" = "x64" ] && expected_slice="x86_64"
check_slice() {
	local label="$1" path="$2" slices
	[ -x "$path" ] || { echo "v3-smoke-mac-cli: missing executable $label: $path" >&2; exit 1; }
	slices="$(lipo -archs "$path" 2>/dev/null || true)"
	case "$slices" in *"$expected_slice"*) echo "    $label: $slices" ;; *) echo "v3-smoke-mac-cli: $label lacks $expected_slice ($slices)" >&2; exit 1 ;; esac
}

log "Architecture and provenance"
check_slice "Electron" "$MAIN_EXEC"
check_slice "computer-use helper" "$HELPER"
check_slice "Beast" "$BEAST"
echo "    bundle commit: $BUNDLE_COMMIT"

if [ "$EXPECT_UNSIGNED" -eq 1 ]; then
	for candidate in "$APP_PATH" "$HELPER"; do
		SIGN_INFO="$(codesign -dv --verbose=4 "$candidate" 2>&1 || true)"
		if printf '%s\n' "$SIGN_INFO" | grep -qE '^Authority=Developer ID Application:|^TeamIdentifier=[A-Z0-9]{10}$'; then
			echo "v3-smoke-mac-cli: expected unsigned candidate but found a Developer ID signature: $candidate" >&2
			exit 1
		fi
	done
	echo "    no Developer ID signature detected on app/helper"
fi

if [ "$EXPECT_SIGNED" -eq 1 ]; then
	codesign --verify --deep --strict --verbose=2 "$APP_PATH"
	codesign --verify --strict --verbose=2 "$HELPER"
	APP_SIGN_INFO="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)"
	HELPER_SIGN_INFO="$(codesign -dv --verbose=4 "$HELPER" 2>&1)"
	APP_TEAM="$(printf '%s\n' "$APP_SIGN_INFO" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
	printf '%s' "$APP_TEAM" | grep -qE '^[A-Z0-9]{10}$' || {
		echo "v3-smoke-mac-cli: signed app has no valid Developer ID team" >&2
		exit 1
	}
	printf '%s\n' "$HELPER_SIGN_INFO" | grep -q '^Identifier=dev.v3code.computerUseHelper$' || {
		echo "v3-smoke-mac-cli: computer-use helper signing identifier is wrong" >&2
		exit 1
	}
	printf '%s\n' "$HELPER_SIGN_INFO" | grep -q '^Authority=Developer ID Application:' || {
		echo "v3-smoke-mac-cli: computer-use helper is not Developer ID signed" >&2
		exit 1
	}
	printf '%s\n' "$HELPER_SIGN_INFO" | grep -q "^TeamIdentifier=$APP_TEAM$" || {
		echo "v3-smoke-mac-cli: computer-use helper team does not match app team" >&2
		exit 1
	}
	echo "    Developer ID signatures OK: app + computer-use helper (team $APP_TEAM)"
fi

log "Rosetta-safe sidecar probes (no GUI launch)"
if [ "$ARCH" = "x64" ] && [ "$(uname -m)" = "arm64" ]; then
	RUN_ARCH=(/usr/bin/arch -x86_64)
else
	RUN_ARCH=()
fi
run_for_arch() {
	if [ "${#RUN_ARCH[@]}" -gt 0 ]; then
		"${RUN_ARCH[@]}" "$@"
	else
		"$@"
	fi
}
PING_OUTPUT="$(printf '{"id":1,"method":"ping"}\n' | run_for_arch "$HELPER" 2>/dev/null | head -n 1)"
if [[ "$PING_OUTPUT" != *'"ok":true'* || "$PING_OUTPUT" != *'"platform":"darwin"'* ]]; then
	echo "v3-smoke-mac-cli: computer-use helper ping failed: $PING_OUTPUT" >&2
	exit 1
fi
BEAST_VERSION="$(run_for_arch "$BEAST" --version 2>&1 | head -n 1)"
[[ "$BEAST_VERSION" == beast* ]] || { echo "v3-smoke-mac-cli: Beast --version failed: $BEAST_VERSION" >&2; exit 1; }
echo "    helper: $PING_OUTPUT"
echo "    Beast: $BEAST_VERSION"

log "Packaged MCP bridge round trip (isolated, no GUI launch)"
node build/verify/mcp-bridge-smoke.mjs --root "$APP_PATH"

log "CLI-only smoke PASS"
echo "    Electron GUI was not launched."
