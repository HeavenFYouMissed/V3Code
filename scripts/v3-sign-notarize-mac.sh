#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# V3Code — Developer ID sign + notarize + staple a packaged macOS build.
#
# WHY THIS IS A SHIP BLOCKER FOR AUTO-UPDATE:
#   electron.autoUpdater (Squirrel.Mac) only accepts an update when the running
#   app is properly Developer-ID signed. DarwinUpdateService.buildUpdateFeedUrl
#   catches the setFeedURL() throw for an unsigned app and disables updates
#   (updateService.darwin.ts). So a real signed+notarized build is REQUIRED for
#   the update route to work end-to-end — the ad-hoc signature from
#   v3-package-mac.sh is dev-only and will be Gatekeeper-blocked on download.
#
# WHAT IT DOES (reusing the repo's real signer — build/darwin/sign.ts, which
# drives @electron/osx-sign with hardened-runtime + the correct per-helper
# entitlements; do NOT hand-roll `codesign --deep`, Apple deprecates it and it
# mis-signs the nested Electron helpers):
#   1. Import the Developer ID cert into a throwaway keychain (CI-equivalent).
#   2. node build/darwin/sign.ts <buildDir>   (inside-out hardened-runtime sign)
#   3. notarytool submit --wait                (Apple notarization)
#   4. stapler staple                          (attach the ticket, offline-verify)
#   5. re-zip the stapled .app as the distributable to publish.
#
# BLOCKED ON DANIEL: real Apple credentials. This script is the exact path; it
# fails fast with instructions for each missing prerequisite. Run ONE signed
# build, then scripts/v3-publish-release.sh --apply, to satisfy the update E2E.
#
# PREREQUISITES
#   - A packaged app from scripts/v3-package-mac.sh at
#       .build/releases/<commit>/VSCode-darwin-<arch>/V3Code.app
#   - Signing deps (CI-only, live in build/, not the root install):
#       cd build && npm ci
#   - Xcode command line tools (codesign, notarytool, stapler, ditto) — already
#     present if you can build.
#
# ENV CONTRACT (export before running, or put in a gitignored .secrets file):
#   V3_SIGN_IDENTITY        "Developer ID Application: Your Name (TEAMID)"
#   V3_SIGN_P12             path to an exported Developer ID cert+key (.p12)
#   V3_SIGN_P12_PASSWORD    password for that .p12
#   Notarization — EITHER a stored profile:
#     V3_NOTARY_PROFILE     name from `xcrun notarytool store-credentials`
#   OR explicit Apple creds:
#     V3_APPLE_ID           Apple ID email
#     V3_TEAM_ID            10-char Apple Team ID
#     V3_APPLE_PASSWORD     app-specific password (appleid.apple.com)
#
#   Alternative to the .p12 import: set V3_SIGN_KEYCHAIN to a keychain that
#   already holds the identity (e.g. ~/Library/Keychains/login.keychain-db) and
#   it is copied into the build keychain instead.
#
# Usage:
#   scripts/v3-sign-notarize-mac.sh                # sign + notarize + staple + zip
#   scripts/v3-sign-notarize-mac.sh --arch=x64     # Intel candidate
#   scripts/v3-sign-notarize-mac.sh --sign-only    # sign only (skip notarize/staple)
#   scripts/v3-sign-notarize-mac.sh --app PATH      # sign a specific .app
#   scripts/v3-sign-notarize-mac.sh --expected-commit SHA --dist-dir PATH
#   scripts/v3-sign-notarize-mac.sh --preflight-paths-only # validate confinement; never sign
# ---------------------------------------------------------------------------
set -euo pipefail

ARCH="arm64"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
EXPECTED_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
RELEASE_ROOT=""
APP_PATH=""
DIST_DIR=""

SIGN_ONLY=0
PREFLIGHT_PATHS_ONLY=0
while [ $# -gt 0 ]; do
	case "$1" in
		--sign-only) SIGN_ONLY=1 ;;
		--preflight-paths-only) PREFLIGHT_PATHS_ONLY=1 ;;
		--arch=*) ARCH="${1#--arch=}" ;;
		--app) APP_PATH="${2:?--app requires a path}"; shift ;;
		--dist-dir) DIST_DIR="${2:?--dist-dir requires a path}"; shift ;;
		--release-root) RELEASE_ROOT="${2:?--release-root requires a path}"; shift ;;
		--expected-commit) EXPECTED_COMMIT="${2:?--expected-commit requires a SHA}"; shift ;;
		-h|--help) sed -n '2,55p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "v3-sign-notarize-mac: unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

case "$ARCH" in
	arm64|x64) ;;
	*) echo "v3-sign-notarize-mac: --arch must be arm64 or x64 (got '$ARCH')." >&2; exit 2 ;;
esac

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
die() { err "$*"; exit 1; }

verify_computer_use_helper_signature() {
	local app="$1" expected_team="$2" helper info
	helper="$app/Contents/Resources/computerUse/darwin/v3code-computer-use-helper"
	[ -x "$helper" ] || die "computer-use helper is missing from signed app: $helper"
	codesign --verify --strict --verbose=2 "$helper" \
		|| die "computer-use helper signature verification failed: $helper"
	info="$(codesign -dv --verbose=4 "$helper" 2>&1)"
	printf '%s\n' "$info" | grep -q '^Identifier=dev.v3code.computerUseHelper$' \
		|| die "computer-use helper has the wrong signing identifier."
	printf '%s\n' "$info" | grep -q '^Authority=Developer ID Application:' \
		|| die "computer-use helper is not signed by a Developer ID Application identity."
	printf '%s\n' "$info" | grep -q "^TeamIdentifier=$expected_team$" \
		|| die "computer-use helper TeamIdentifier does not match the app ($expected_team)."
	echo "    computer-use helper signature OK: identifier + Developer ID team $expected_team"
}

# Signing/notarization mutates the app and writes ZIPs. Resolve and confine all
# caller-controlled paths before sourcing credentials, creating a keychain,
# editing Info.plist, or touching dist. The accepted layout is deliberately one
# exact tree owned by this checkout:
#   <repo>/.build/releases/<40-hex>/VSCode-darwin-<arch>/V3Code.app
# This also prevents sign.ts from signing one tree while the script notarizes a
# lookalike --app elsewhere.
printf '%s' "$EXPECTED_COMMIT" | grep -qE '^[0-9a-f]{40}$' \
	|| die "v3-sign-notarize-mac: --expected-commit is not a 40-hex SHA ('$EXPECTED_COMMIT')."

normalize_repo_path() {
	local path="$1"
	case "$path" in
		/*) ;;
		*) path="$REPO_ROOT/$path" ;;
	esac
	node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$path"
}

canonical_existing_dir() {
	local path="$1"
	[ -d "$path" ] || return 1
	( cd "$path" && pwd -P )
}

RELEASES_DIR="$REPO_ROOT/.build/releases"
[ -d "$RELEASES_DIR" ] \
	|| die "v3-sign-notarize-mac: release directory not found: $RELEASES_DIR (package first)."
CANONICAL_RELEASES_DIR="$(canonical_existing_dir "$RELEASES_DIR")" \
	|| die "v3-sign-notarize-mac: cannot canonicalize release directory: $RELEASES_DIR"
[ "$CANONICAL_RELEASES_DIR" = "$RELEASES_DIR" ] \
	|| die "v3-sign-notarize-mac: release directory is symlinked outside the repo tree: $RELEASES_DIR -> $CANONICAL_RELEASES_DIR"

EXACT_RELEASE_ROOT="$RELEASES_DIR/$EXPECTED_COMMIT"
[ -n "$RELEASE_ROOT" ] || RELEASE_ROOT="$EXACT_RELEASE_ROOT"
RELEASE_ROOT="$(normalize_repo_path "$RELEASE_ROOT")"
[ "$RELEASE_ROOT" = "$EXACT_RELEASE_ROOT" ] \
	|| die "v3-sign-notarize-mac: --release-root must be exactly $EXACT_RELEASE_ROOT (got $RELEASE_ROOT)."
[ -d "$RELEASE_ROOT" ] \
	|| die "v3-sign-notarize-mac: release root not found: $RELEASE_ROOT (package first)."
CANONICAL_RELEASE_ROOT="$(canonical_existing_dir "$RELEASE_ROOT")" \
	|| die "v3-sign-notarize-mac: cannot canonicalize release root: $RELEASE_ROOT"
[ "$CANONICAL_RELEASE_ROOT" = "$EXACT_RELEASE_ROOT" ] \
	|| die "v3-sign-notarize-mac: release root escapes through a symlink: $RELEASE_ROOT -> $CANONICAL_RELEASE_ROOT"
RELEASE_ROOT="$CANONICAL_RELEASE_ROOT"

EXACT_APP_PATH="$RELEASE_ROOT/VSCode-darwin-$ARCH/V3Code.app"
[ -n "$APP_PATH" ] || APP_PATH="$EXACT_APP_PATH"
APP_PATH="$(normalize_repo_path "$APP_PATH")"
[ "$APP_PATH" = "$EXACT_APP_PATH" ] \
	|| die "v3-sign-notarize-mac: --app must be exactly $EXACT_APP_PATH (got $APP_PATH)."
[ -d "$APP_PATH" ] \
	|| die "v3-sign-notarize-mac: app not found: $APP_PATH (run scripts/v3-package-mac.sh first)."
CANONICAL_APP_PATH="$(canonical_existing_dir "$APP_PATH")" \
	|| die "v3-sign-notarize-mac: cannot canonicalize app: $APP_PATH"
[ "$CANONICAL_APP_PATH" = "$EXACT_APP_PATH" ] \
	|| die "v3-sign-notarize-mac: app escapes through a symlink: $APP_PATH -> $CANONICAL_APP_PATH"
APP_PATH="$CANONICAL_APP_PATH"

EXACT_DIST_DIR="$RELEASE_ROOT/dist"
[ -n "$DIST_DIR" ] || DIST_DIR="$EXACT_DIST_DIR"
DIST_DIR="$(normalize_repo_path "$DIST_DIR")"
[ "$DIST_DIR" = "$EXACT_DIST_DIR" ] \
	|| die "v3-sign-notarize-mac: --dist-dir must be exactly $EXACT_DIST_DIR (got $DIST_DIR)."
if [ -e "$DIST_DIR" ] || [ -L "$DIST_DIR" ]; then
	[ -d "$DIST_DIR" ] || die "v3-sign-notarize-mac: dist path exists but is not a directory: $DIST_DIR"
	CANONICAL_DIST_DIR="$(canonical_existing_dir "$DIST_DIR")" \
		|| die "v3-sign-notarize-mac: cannot canonicalize dist directory: $DIST_DIR"
	[ "$CANONICAL_DIST_DIR" = "$EXACT_DIST_DIR" ] \
		|| die "v3-sign-notarize-mac: dist directory escapes through a symlink: $DIST_DIR -> $CANONICAL_DIST_DIR"
fi

if [ "$PREFLIGHT_PATHS_ONLY" -eq 1 ]; then
	echo "v3-sign-notarize-mac: path preflight passed"
	echo "    release : $RELEASE_ROOT"
	echo "    app     : $APP_PATH"
	echo "    dist    : $DIST_DIR"
	exit 0
fi

# Everything below (node build/darwin/sign.ts, product.json reads) is
# repo-relative — pin the cwd so running from elsewhere can't silently pick up
# a sibling checkout's signer.
cd "$REPO_ROOT"

# Load a gitignored secrets file if present (keeps Apple creds out of the shell history).
[ -f "$REPO_ROOT/.secrets/signing.env" ] && { set -a; . "$REPO_ROOT/.secrets/signing.env"; set +a; }

[ "$(uname)" = "Darwin" ] || die "v3-sign-notarize-mac: macOS only."
: "${V3_SIGN_IDENTITY:?set V3_SIGN_IDENTITY to your Developer ID Application identity}"

# sign.ts signs path.join(buildDir, 'VSCode-darwin-<arch>', product.nameLong+'.app')
# — it does NOT take an app path. Derive buildDir from APP_PATH and refuse
# layouts sign.ts would silently ignore (it would sign the DEFAULT app while we
# notarize/zip the --app one).
APP_PARENT="$(dirname "$APP_PATH")"
SIGN_BUILD_DIR="$(dirname "$APP_PARENT")"
NAME_LONG=$(node -p "require('$APP_PATH/Contents/Resources/app/product.json').nameLong")
[ "$(basename "$APP_PARENT")" = "VSCode-darwin-$ARCH" ] || die "v3-sign-notarize-mac: app must live under .../VSCode-darwin-$ARCH/ (sign.ts hardcodes that layout); got: $APP_PATH"
[ "$(basename "$APP_PATH")" = "$NAME_LONG.app" ] || die "v3-sign-notarize-mac: app bundle name '$(basename "$APP_PATH")' != product nameLong '$NAME_LONG.app' — sign.ts would sign a different bundle."

# The bundle is the source of truth for release metadata: its product.commit is
# what the running app sends to the update server, so last-build.json (and the
# manifest built from it) MUST carry that value — never sign-time git HEAD,
# which may have moved since packaging (that mismatch = infinite update loop).
COMMIT=$(node -p "require('$APP_PATH/Contents/Resources/app/product.json').commit ?? ''")
printf '%s' "$COMMIT" | grep -qE '^[0-9a-f]{40}$' \
	|| die "v3-sign-notarize-mac: bundle product.json has no valid commit ('$COMMIT') — repackage with scripts/v3-package-mac.sh (it bakes BUILD_SOURCEVERSION)."
[ "$COMMIT" = "$EXPECTED_COMMIT" ] \
	|| die "v3-sign-notarize-mac: bundle commit ($COMMIT) != expected release commit ($EXPECTED_COMMIT). Refusing to sign a stale or replaced candidate."
# Refuse update-dead bundles BEFORE burning a notarization round-trip — the
# publish script would reject them anyway (quality/updateUrl are what keep the
# update service out of Disabled(MissingConfiguration)).
BUNDLE_UPDATE_OK=$(node -p "const p=require('$APP_PATH/Contents/Resources/app/product.json'); String(Boolean(p.quality && p.updateUrl))")
[ "$BUNDLE_UPDATE_OK" = "true" ] \
	|| die "v3-sign-notarize-mac: bundle product.json lacks quality/updateUrl — this build's auto-update is permanently Disabled. Repackage from a commit that has them."
APP_VERSION=$(node -p "require('$APP_PATH/Contents/Resources/app/package.json').version")
V3_VERSION=$(node -p "const p=require('$APP_PATH/Contents/Resources/app/product.json'); (p.voidVersion||p.version||'')+'-'+(p.voidRelease||'')")
HEAD_NOW=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
[ "$HEAD_NOW" = "$EXPECTED_COMMIT" ] \
	|| die "v3-sign-notarize-mac: repo HEAD ($HEAD_NOW) moved from expected release commit ($EXPECTED_COMMIT). Use the matching worktree; signer configuration comes from its source."

# The real signer + its deps live in build/ (CI-only devDeps, not the root install).
node -e "require.resolve('@electron/osx-sign', { paths: ['$REPO_ROOT/build/darwin'] })" >/dev/null 2>&1 \
	|| die "@electron/osx-sign not resolvable from build/. Run: cd build && npm ci"

# --- 1. build a throwaway keychain holding the signing identity -------------
KEYCHAIN_DIR="$(mktemp -d)"
KEYCHAIN="$KEYCHAIN_DIR/buildagent.keychain"   # sign.ts hardcodes this filename under $AGENT_TEMPDIRECTORY
KP="v3code-build"                              # ephemeral keychain password
ORIG_KEYCHAINS="$(security list-keychains -d user | sed 's/[">]//g' | xargs)"

cleanup() {
	# Restore the original keychain search list and delete the throwaway.
	# shellcheck disable=SC2086
	security list-keychains -d user -s $ORIG_KEYCHAINS >/dev/null 2>&1 || true
	security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
	rm -rf "$KEYCHAIN_DIR"
	if [ -n "${EXACT_ZIP_SMOKE_DIR:-}" ] && [ -d "$EXACT_ZIP_SMOKE_DIR" ]; then
		rm -rf -- "$EXACT_ZIP_SMOKE_DIR"
	fi
}
trap cleanup EXIT

log "Preparing signing keychain"
security create-keychain -p "$KP" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KP" "$KEYCHAIN"

if [ -n "${V3_SIGN_KEYCHAIN:-}" ]; then
	[ -f "$V3_SIGN_KEYCHAIN" ] || die "V3_SIGN_KEYCHAIN not found: $V3_SIGN_KEYCHAIN"
	log "Copying identity from $V3_SIGN_KEYCHAIN"
	cp "$V3_SIGN_KEYCHAIN" "$KEYCHAIN"
	# Fail fast on a wrong password — a locked keychain otherwise dies much later
	# inside osx-sign with an opaque keychain error.
	security unlock-keychain -p "${V3_SIGN_KEYCHAIN_PASSWORD:-$KP}" "$KEYCHAIN" \
		|| die "could not unlock the copied keychain (check V3_SIGN_KEYCHAIN_PASSWORD)."
	# Grant codesign non-interactive access to the copied private key; tolerate
	# failure (some key ACLs can't be rewritten) but say so — a mid-sign UI
	# prompt or errSecInternalComponent traces back to this.
	security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${V3_SIGN_KEYCHAIN_PASSWORD:-$KP}" "$KEYCHAIN" >/dev/null 2>&1 \
		|| err "WARNING: set-key-partition-list failed on the copied keychain — codesign may prompt or fail with errSecInternalComponent."
else
	: "${V3_SIGN_P12:?set V3_SIGN_P12 (exported Developer ID .p12) or V3_SIGN_KEYCHAIN}"
	: "${V3_SIGN_P12_PASSWORD:?set V3_SIGN_P12_PASSWORD}"
	[ -f "$V3_SIGN_P12" ] || die "V3_SIGN_P12 not found: $V3_SIGN_P12"
	log "Importing $V3_SIGN_P12"
	security import "$V3_SIGN_P12" -k "$KEYCHAIN" -P "$V3_SIGN_P12_PASSWORD" \
		-T /usr/bin/codesign -T /usr/bin/security
	# Let codesign use the private key non-interactively (no UI password prompt).
	security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KP" "$KEYCHAIN" >/dev/null
fi

# Put the build keychain first on the search list so find-identity resolves it.
# shellcheck disable=SC2086
security list-keychains -d user -s "$KEYCHAIN" $ORIG_KEYCHAINS >/dev/null

security find-identity -p codesigning -v "$KEYCHAIN" | grep -q "$V3_SIGN_IDENTITY" \
	|| die "identity '$V3_SIGN_IDENTITY' not found in the signing keychain. Check V3_SIGN_IDENTITY / the .p12."

# --- 2. sign (inside-out, hardened runtime) via the repo's signer -----------
# sign.ts plutil -inserts these two keys and -insert FAILS if the key exists —
# pre-remove them so a re-sign (e.g. after a notarization failure) is idempotent.
for k in NSAppleEventsUsageDescription NSLocalNetworkUsageDescription; do
	plutil -remove "$k" "$APP_PATH/Contents/Info.plist" >/dev/null 2>&1 || true
done

log "Signing $APP_PATH (hardened runtime, Developer ID)"
AGENT_TEMPDIRECTORY="$KEYCHAIN_DIR" VSCODE_ARCH="$ARCH" CODESIGN_IDENTITY="$V3_SIGN_IDENTITY" \
	DEBUG=electron-osx-sign* node build/darwin/sign.ts "$SIGN_BUILD_DIR"

log "Verifying signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
# A Developer ID signature carries a TeamIdentifier; "not set" means the ad-hoc
# (or no) identity actually signed — hard-fail rather than notarize garbage.
SIGN_INFO=$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)
printf '%s\n' "$SIGN_INFO" | grep -iE "Authority|TeamIdentifier|Runtime|Identifier" || true
printf '%s\n' "$SIGN_INFO" | grep -q "TeamIdentifier=not set" \
	&& die "app is not Developer-ID signed (TeamIdentifier not set) — check the identity/keychain."
APP_TEAM="$(printf '%s\n' "$SIGN_INFO" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
printf '%s' "$APP_TEAM" | grep -qE '^[A-Z0-9]{10}$' \
	|| die "app Developer ID TeamIdentifier is missing or invalid ('$APP_TEAM')."
verify_computer_use_helper_signature "$APP_PATH" "$APP_TEAM"

log "Post-sign package verification"
node build/verify/verify-package.mjs --platform "darwin-$ARCH" --root "$APP_PATH" || \
	die "v3-sign-notarize-mac: signed package verification failed; do not distribute this artifact."

if [ "$SIGN_ONLY" -eq 1 ]; then
	log "SIGN ONLY — skipping notarization/staple."
	exit 0
fi

# --- 3. notarize ------------------------------------------------------------
mkdir -p "$DIST_DIR"
NOTARIZE_ZIP="$DIST_DIR/V3Code-notarize-$ARCH.zip"
log "Zipping for notarization -> $NOTARIZE_ZIP"
rm -f "$NOTARIZE_ZIP"
ditto -c -k --keepParent "$APP_PATH" "$NOTARIZE_ZIP"

log "Submitting to Apple notary (this can take minutes)"
if [ -n "${V3_NOTARY_PROFILE:-}" ]; then
	xcrun notarytool submit "$NOTARIZE_ZIP" --keychain-profile "$V3_NOTARY_PROFILE" --wait
else
	: "${V3_APPLE_ID:?set V3_NOTARY_PROFILE or V3_APPLE_ID + V3_TEAM_ID + V3_APPLE_PASSWORD}"
	: "${V3_TEAM_ID:?set V3_TEAM_ID}"
	: "${V3_APPLE_PASSWORD:?set V3_APPLE_PASSWORD (app-specific password)}"
	xcrun notarytool submit "$NOTARIZE_ZIP" \
		--apple-id "$V3_APPLE_ID" --team-id "$V3_TEAM_ID" --password "$V3_APPLE_PASSWORD" --wait
fi

# --- 4. staple + re-zip the distributable -----------------------------------
log "Stapling the notarization ticket"
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH" || err "spctl assessment warning (review above)"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
verify_computer_use_helper_signature "$APP_PATH" "$APP_TEAM"

log "Post-staple package verification"
node build/verify/verify-package.mjs --platform "darwin-$ARCH" --root "$APP_PATH" || \
	die "v3-sign-notarize-mac: stapled package verification failed; do not distribute this artifact."

FINAL_ZIP="$DIST_DIR/V3Code-darwin-${ARCH}-${V3_VERSION}.zip"
log "Re-zipping stapled app -> $FINAL_ZIP"
rm -f "$FINAL_ZIP" "$NOTARIZE_ZIP"
( cd "$(dirname "$APP_PATH")" && zip -Xry -q "$FINAL_ZIP" "$(basename "$APP_PATH")" )
ZIP_SHA=$(shasum -a 256 "$FINAL_ZIP" | cut -d' ' -f1)
ZIP_SIZE=$(stat -f%z "$FINAL_ZIP")

# Refresh last-build.json so v3-publish-release.sh publishes the SIGNED artifact.
# COMMIT/APP_VERSION/V3_VERSION were read from the BUNDLE up top — the values the
# shipped app actually reports — never from current repo state.
if [ "$ARCH" = "x64" ]; then
	SUMMARY_JSON="$DIST_DIR/last-build-x64-signed.json"
	node build/verify/write-build-metadata.mjs \
		--output "$SUMMARY_JSON" \
		--app-version "$APP_VERSION" \
		--v3code-version "$V3_VERSION" \
		--commit "$COMMIT" \
		--arch "$ARCH" \
		--platform darwin \
		--state signed-notarized \
		--artifact "$FINAL_ZIP" \
		--size "$ZIP_SIZE" \
		--sha256 "$ZIP_SHA" \
		--signed true \
		--notarized true
else
	SUMMARY_JSON="$DIST_DIR/last-build.json"
	node -e "const fs=require('fs');const[o,av,vv,c,a,s,h]=process.argv.slice(1);fs.writeFileSync(o,JSON.stringify({appVersion:av,v3codeVersion:vv,commit:c,arch:'arm64',platform:'darwin',artifact:a,size:Number(s),sha256:h,signed:true,notarized:true},null,2)+'\n');" \
		"$SUMMARY_JSON" "$APP_VERSION" "$V3_VERSION" "$COMMIT" "$FINAL_ZIP" "$ZIP_SIZE" "$ZIP_SHA"
fi

# The published object is the ZIP, not the mutable build tree. Extract that
# exact ZIP and repeat the signature, notarization and helper execution smoke so
# archive creation cannot silently damage the loose helper signature.
EXACT_ZIP_SMOKE_DIR="$(mktemp -d)"
log "Smoking the exact signed ZIP"
ditto -x -k "$FINAL_ZIP" "$EXACT_ZIP_SMOKE_DIR"
EXACT_ZIP_APP="$EXACT_ZIP_SMOKE_DIR/$(basename "$APP_PATH")"
[ -d "$EXACT_ZIP_APP" ] || die "signed ZIP did not extract the expected app bundle."
scripts/v3-smoke-mac-cli.sh \
	--arch="$ARCH" \
	--app "$EXACT_ZIP_APP" \
	--metadata "$SUMMARY_JSON" \
	--expected-commit "$COMMIT" \
	--expect-signed
xcrun stapler validate "$EXACT_ZIP_APP"
rm -rf -- "$EXACT_ZIP_SMOKE_DIR"

log "SIGNED + NOTARIZED + STAPLED"
echo "    app     : $APP_PATH"
echo "    zip     : $FINAL_ZIP"
echo "    sha256  : $ZIP_SHA"
echo "    commit  : $COMMIT"
echo
if [ "$ARCH" = "x64" ]; then
	echo "    Private Intel candidate ready. Publishing requires a separate release decision."
else
	echo "    Next:  scripts/v3-publish-release.sh --apply   # upload signed zip + manifest to R2"
fi
