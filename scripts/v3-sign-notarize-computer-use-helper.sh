#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# V3Code — Developer ID sign (+ optionally notarize) the STANDALONE macOS
# computer-use helper.
#
# WHAT THIS IS FOR
#   Two things, and neither of them is "ship the app":
#
#   1. PRE-FLIGHT. computerUseHelperInstaller.ts refuses to run the helper unless
#      it satisfies, exactly:
#          identifier "<COMPUTER_USE_HELPER_BUNDLE_ID>"
#            and anchor apple generic
#            and certificate leaf[subject.OU] = "<COMPUTER_USE_HELPER_TEAM_OU>"
#      Both halves are easy to get wrong and the failure is total and silent
#      until a user tries the feature. A bare Mach-O has no bound Info.plist, so
#      codesign derives the identifier from the FILE NAME unless it is passed
#      explicitly; and the team OU pinned in the installer must be the real
#      Apple Team ID of the signing certificate. This script asserts both against
#      a real signature in about ten seconds, without packaging an app.
#
#   2. NOTARIZING THE LOOSE BINARY. The shipped helper lives inside the .app and
#      is signed and notarized as part of it (build/darwin/sign.ts picks its
#      entitlements and identifier automatically). But at runtime the installer
#      COPIES it out to ~/.v3code/bin — the OS keys Accessibility and Screen
#      Recording grants to a stable path, so it cannot be launched from inside a
#      bundle that an app update will replace. Outside the .app the stapled
#      ticket no longer applies, and the installer's `spctl` assessment may need
#      a network round-trip to resolve one by cdhash. Notarizing the helper on
#      its own makes that lookup resolvable.
#
# WHAT THIS CANNOT DO — READ THIS BEFORE TRUSTING IT
#   * It CANNOT staple. `xcrun stapler` supports app bundles, disk images and
#     installer packages; it does not support a loose executable. The ticket
#     exists only in Apple's database, so the installer's `spctl` check on the
#     copied-out helper still depends on the network. Notarizing here reduces
#     that to a lookup that can succeed; it does not make it offline-safe.
#   * It is NOT a substitute for signing the app. The bytes that ship are the
#     ones inside the .app, signed by build/darwin/sign.ts and notarized by
#     scripts/v3-sign-notarize-mac.sh. Re-signing the intermediate here does not
#     change them.
#   * It does NOT run a release. No packaging, no upload, no manifest, no git.
#     Per docs/V3CODE-AGENT-WORKTREE-RULES.md section 5, merging, version bumps,
#     packaging, signing, notarizing and publishing are the lead's job.
#
# PREREQUISITES
#   - A built helper: scripts/build-computer-use-helper-darwin.sh   (universal)
#   - Xcode command line tools (codesign, notarytool, ditto).
#   - Apple credentials. Without them this script stops at the first gate; it
#     cannot be usefully dry-run. See --check for the credential-free subset.
#
# ENV CONTRACT (identical to scripts/v3-sign-notarize-mac.sh, so one
# .secrets/signing.env serves both):
#   V3_SIGN_IDENTITY        "Developer ID Application: Your Name (TEAMID)"
#   V3_SIGN_P12             path to an exported Developer ID cert+key (.p12)
#   V3_SIGN_P12_PASSWORD    password for that .p12
#   Notarization — EITHER a stored profile:
#     V3_NOTARY_PROFILE     name from `xcrun notarytool store-credentials`
#   OR explicit Apple creds:
#     V3_APPLE_ID / V3_TEAM_ID / V3_APPLE_PASSWORD
#   Alternative to the .p12: V3_SIGN_KEYCHAIN (+ V3_SIGN_KEYCHAIN_PASSWORD).
#
# Usage:
#   scripts/v3-sign-notarize-computer-use-helper.sh              # sign + notarize
#   scripts/v3-sign-notarize-computer-use-helper.sh --sign-only  # sign + verify only
#   scripts/v3-sign-notarize-computer-use-helper.sh --check      # no credentials: inspect only
#   scripts/v3-sign-notarize-computer-use-helper.sh --helper PATH
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_PATH="$REPO_ROOT/src/vs/workbench/contrib/computerUse/helper/darwin/.build/v3code-computer-use"
INSTALLER_TS="$REPO_ROOT/src/vs/workbench/contrib/computerUse/electron-main/computerUseHelperInstaller.ts"
ENTITLEMENTS="$REPO_ROOT/build/azure-pipelines/darwin/helper-computeruse-entitlements.plist"
DIST_DIR="$REPO_ROOT/.build/dist"

SIGN_ONLY=0
CHECK_ONLY=0
while [ $# -gt 0 ]; do
	case "$1" in
		--sign-only) SIGN_ONLY=1 ;;
		--check) CHECK_ONLY=1 ;;
		--helper) HELPER_PATH="$2"; shift ;;
		-h|--help) sed -n '2,72p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "v3-sign-notarize-computer-use-helper: unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
die() { err "$*"; exit 1; }

cd "$REPO_ROOT"

[ -f "$REPO_ROOT/.secrets/signing.env" ] && { set -a; . "$REPO_ROOT/.secrets/signing.env"; set +a; }

[ "$(uname)" = "Darwin" ] || die "v3-sign-notarize-computer-use-helper: macOS only."
[ -f "$HELPER_PATH" ] || die "helper not found: $HELPER_PATH (run scripts/build-computer-use-helper-darwin.sh first)."
[ -f "$ENTITLEMENTS" ] || die "entitlements not found: $ENTITLEMENTS"
[ -f "$INSTALLER_TS" ] || die "installer source not found: $INSTALLER_TS"

# --- 0. read the pinned values out of the client, never retype them ---------
# These two strings ARE the contract. Hard-coding them here would let the build
# half and the verifying half drift apart silently, which is the one failure mode
# that produces a helper that is perfectly signed and still never runs.
read_installer_const() {
	sed -n "s/^export const $1 = '\\([^']*\\)';.*/\\1/p" "$INSTALLER_TS" | head -n 1
}
HELPER_BUNDLE_ID="$(read_installer_const COMPUTER_USE_HELPER_BUNDLE_ID)"
HELPER_TEAM_OU="$(read_installer_const COMPUTER_USE_HELPER_TEAM_OU)"
[ -n "$HELPER_BUNDLE_ID" ] || die "could not read COMPUTER_USE_HELPER_BUNDLE_ID from $INSTALLER_TS — the declaration changed shape; fix this parser rather than hard-coding the value."
[ -n "$HELPER_TEAM_OU" ] || die "could not read COMPUTER_USE_HELPER_TEAM_OU from $INSTALLER_TS — see above."

# build/darwin/sign.ts must sign the in-bundle copy under the same identifier.
grep -q "'$HELPER_BUNDLE_ID'" "$REPO_ROOT/build/darwin/sign.ts" \
	|| die "build/darwin/sign.ts does not mention '$HELPER_BUNDLE_ID'. The app-bundle signer and the client's designated requirement have drifted; the shipped helper would be rejected at runtime."

REQUIREMENT="identifier \"$HELPER_BUNDLE_ID\" and anchor apple generic and certificate leaf[subject.OU] = \"$HELPER_TEAM_OU\""

log "Contract read from the client"
echo "    bundle identifier : $HELPER_BUNDLE_ID"
echo "    team OU pinned    : $HELPER_TEAM_OU"
echo "    requirement       : $REQUIREMENT"

# --- 1. credential-free inspection -----------------------------------------
log "Inspecting $HELPER_PATH"
lipo -info "$HELPER_PATH"
ARCH_LINE="$(lipo -info "$HELPER_PATH")"
case "$ARCH_LINE" in
	*"Non-fat"*)
		err "WARNING: this helper is THIN, not universal."
		err "  build/darwin/verify-macho.ts rejects a thin binary in a universal app, and"
		err "  build/darwin/create-universal-app.ts needs byte-identical trees. Ship a fat"
		err "  helper: scripts/build-computer-use-helper-darwin.sh with no arguments."
		;;
esac

# Mirrors the guard in scripts/build-computer-use-helper-darwin.sh. A load command
# pointing outside /System or /usr/lib is a build-machine-only dylib: it will not
# exist on a user's Mac, and under hardened runtime library validation rejects a
# dylib signed by a different Team ID even if it did. This is the sharp/libvips
# failure that silently degraded the semantic index fleet-wide on 2026-07-11.
FOREIGN_LIBS="$(otool -L "$HELPER_PATH" | tail -n +2 | grep -vE '^[[:space:]]+(/System/|/usr/lib/)' || true)"
if [ -n "$FOREIGN_LIBS" ]; then
	err "the helper links libraries outside /System and /usr/lib:"
	printf '%s\n' "$FOREIGN_LIBS" >&2
	die "hardened runtime will reject these on a user's machine. Fix the link before signing."
fi
echo "    links only OS-shipped libraries"

if [ "$CHECK_ONLY" -eq 1 ]; then
	log "CHECK ONLY — nothing was signed. Current signature:"
	codesign -dv --verbose=4 "$HELPER_PATH" 2>&1 | grep -iE "Identifier|Signature|TeamIdentifier|flags" || true
	echo
	echo "    Everything past this point needs Apple credentials; see the ENV CONTRACT above."
	exit 0
fi

: "${V3_SIGN_IDENTITY:?set V3_SIGN_IDENTITY to your Developer ID Application identity}"

# Pre-flight the team OU against the identity's own name before spending a
# signature on it. `security find-identity` renders a Developer ID identity as
# "Developer ID Application: Name (TEAMID)"; TEAMID is the leaf subject.OU the
# requirement pins.
IDENTITY_TEAM="$(printf '%s' "$V3_SIGN_IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))[[:space:]]*$/\1/p')"
if [ -n "$IDENTITY_TEAM" ] && [ "$IDENTITY_TEAM" != "$HELPER_TEAM_OU" ]; then
	err "TEAM OU MISMATCH — this will make every install fail verification."
	err "  V3_SIGN_IDENTITY team          : $IDENTITY_TEAM"
	err "  COMPUTER_USE_HELPER_TEAM_OU    : $HELPER_TEAM_OU  ($INSTALLER_TS)"
	die "reconcile the two before signing. If '$IDENTITY_TEAM' is correct, the CLIENT constant is what must change — that is a code review, not a build flag."
fi
[ -n "$IDENTITY_TEAM" ] || err "note: could not parse a 10-character team ID out of V3_SIGN_IDENTITY; relying on the post-sign check below."

# --- 2. throwaway keychain holding the signing identity ---------------------
# Same shape as scripts/v3-sign-notarize-mac.sh so one secrets file drives both.
KEYCHAIN_DIR="$(mktemp -d)"
KEYCHAIN="$KEYCHAIN_DIR/buildagent.keychain"
KP="v3code-build"
ORIG_KEYCHAINS="$(security list-keychains -d user | sed 's/[">]//g' | xargs)"

cleanup() {
	# shellcheck disable=SC2086
	security list-keychains -d user -s $ORIG_KEYCHAINS >/dev/null 2>&1 || true
	security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
	rm -rf "$KEYCHAIN_DIR"
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
	security unlock-keychain -p "${V3_SIGN_KEYCHAIN_PASSWORD:-$KP}" "$KEYCHAIN" \
		|| die "could not unlock the copied keychain (check V3_SIGN_KEYCHAIN_PASSWORD)."
	security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${V3_SIGN_KEYCHAIN_PASSWORD:-$KP}" "$KEYCHAIN" >/dev/null 2>&1 \
		|| err "WARNING: set-key-partition-list failed on the copied keychain — codesign may prompt or fail with errSecInternalComponent."
else
	: "${V3_SIGN_P12:?set V3_SIGN_P12 (exported Developer ID .p12) or V3_SIGN_KEYCHAIN}"
	: "${V3_SIGN_P12_PASSWORD:?set V3_SIGN_P12_PASSWORD}"
	[ -f "$V3_SIGN_P12" ] || die "V3_SIGN_P12 not found: $V3_SIGN_P12"
	log "Importing $V3_SIGN_P12"
	security import "$V3_SIGN_P12" -k "$KEYCHAIN" -P "$V3_SIGN_P12_PASSWORD" \
		-T /usr/bin/codesign -T /usr/bin/security
	security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KP" "$KEYCHAIN" >/dev/null
fi

# shellcheck disable=SC2086
security list-keychains -d user -s "$KEYCHAIN" $ORIG_KEYCHAINS >/dev/null

security find-identity -p codesigning -v "$KEYCHAIN" | grep -q "$V3_SIGN_IDENTITY" \
	|| die "identity '$V3_SIGN_IDENTITY' not found in the signing keychain. Check V3_SIGN_IDENTITY / the .p12."

# --- 3. sign ----------------------------------------------------------------
# Hand-rolled rather than reusing build/darwin/sign-server.ts: that template does
# NOT pass --identifier, which for a bare Mach-O means codesign falls back to the
# file name and the designated requirement below can never be satisfied.
# --force so a re-run replaces the ad-hoc linker signature instead of erroring.
log "Signing the helper (hardened runtime, Developer ID)"
codesign \
	--sign "$V3_SIGN_IDENTITY" \
	--keychain "$KEYCHAIN" \
	--identifier "$HELPER_BUNDLE_ID" \
	--options runtime \
	--timestamp \
	--force \
	--entitlements "$ENTITLEMENTS" \
	"$HELPER_PATH"

# --- 4. the gates -----------------------------------------------------------
log "Verifying signature"
codesign --verify --strict --verbose=2 "$HELPER_PATH"

SIGN_INFO="$(codesign -dv --verbose=4 "$HELPER_PATH" 2>&1)"
printf '%s\n' "$SIGN_INFO" | grep -iE "Authority|TeamIdentifier|Identifier=|flags" || true

# A Developer ID signature carries a TeamIdentifier; "not set" means an ad-hoc
# (or no) identity actually signed. Hard-fail rather than notarize garbage.
printf '%s\n' "$SIGN_INFO" | grep -q "TeamIdentifier=not set" \
	&& die "helper is not Developer-ID signed (TeamIdentifier not set) — check the identity/keychain."

# Hardened runtime is a notarization prerequisite; without it Apple rejects the
# submission minutes later with a generic message.
printf '%s\n' "$SIGN_INFO" | grep -q "runtime" \
	|| die "hardened runtime flag missing from the signature — notarization would be rejected."

# The identifier is the half of the requirement that codesign silently gets wrong.
SIGNED_ID="$(printf '%s\n' "$SIGN_INFO" | sed -n 's/^Identifier=\(.*\)$/\1/p' | head -n 1)"
[ "$SIGNED_ID" = "$HELPER_BUNDLE_ID" ] \
	|| die "signed identifier is '$SIGNED_ID', expected '$HELPER_BUNDLE_ID' — the client would refuse to run this helper."

SIGNED_TEAM="$(printf '%s\n' "$SIGN_INFO" | sed -n 's/^TeamIdentifier=\(.*\)$/\1/p' | head -n 1)"
[ "$SIGNED_TEAM" = "$HELPER_TEAM_OU" ] \
	|| die "signed TeamIdentifier is '$SIGNED_TEAM', but the client pins COMPUTER_USE_HELPER_TEAM_OU='$HELPER_TEAM_OU'. One of them is wrong; changing the client constant is a code review, not a build flag."

# THE gate: byte-for-byte the check computerUseHelperInstaller._verifyDarwin runs.
log "Checking the client's designated requirement"
codesign --verify --strict -R="$REQUIREMENT" "$HELPER_PATH" \
	|| die "the signed helper does NOT satisfy the requirement the client enforces. It would be refused at runtime."
echo "    satisfied: $REQUIREMENT"

if [ "$SIGN_ONLY" -eq 1 ]; then
	log "SIGN ONLY — skipping notarization."
	echo "    helper: $HELPER_PATH"
	exit 0
fi

# --- 5. notarize ------------------------------------------------------------
# notarytool accepts only .zip, .dmg and .pkg — never a bare Mach-O, hence ditto.
mkdir -p "$DIST_DIR"
NOTARIZE_ZIP="$DIST_DIR/v3code-computer-use-helper-notarize.zip"
log "Zipping for notarization -> $NOTARIZE_ZIP"
rm -f "$NOTARIZE_ZIP"
ditto -c -k "$HELPER_PATH" "$NOTARIZE_ZIP"

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

# --- 6. Gatekeeper, with the honest caveat ----------------------------------
# NO STAPLE STEP. `xcrun stapler` cannot attach a ticket to a loose executable —
# it handles .app, .dmg and .pkg only. The ticket now exists in Apple's database
# and nowhere on this disk, so the assessment below (and the one the installer
# runs on the copied-out helper) can need the network.
log "Gatekeeper assessment (needs the network; not stapleable)"
if spctl --assess --type execute --verbose=4 "$HELPER_PATH" 2>&1; then
	echo "    accepted"
else
	err "spctl did not accept the helper. If this machine is offline or Apple's"
	err "  service is slow, that is expected for an unstapled loose binary — retry"
	err "  online before concluding the signature is wrong."
fi

rm -f "$NOTARIZE_ZIP"

log "SIGNED + NOTARIZED (not stapled — impossible for a loose Mach-O)"
echo "    helper     : $HELPER_PATH"
echo "    identifier : $SIGNED_ID"
echo "    team       : $SIGNED_TEAM"
echo
echo "    This did NOT produce a release. The bytes users get are the copy inside"
echo "    the .app; package with scripts/v3-package-mac.sh, then sign and notarize"
echo "    the bundle with scripts/v3-sign-notarize-mac.sh. Release is the lead's"
echo "    job — docs/V3CODE-AGENT-WORKTREE-RULES.md section 5."
