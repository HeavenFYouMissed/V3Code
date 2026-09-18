#!/usr/bin/env bash
#---------------------------------------------------------------------------------------
#  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
#  Licensed under the Apache License, Version 2.0.
#---------------------------------------------------------------------------------------
#
# Builds the macOS computer-use helper as a universal (arm64 + x86_64) release binary.
#
# Output:
#   .build/V3Code Computer Use.app/Contents/MacOS/v3code-computer-use-helper
#
# The bare .build/v3code-computer-use-helper written mid-build is MOVED into that signed
# bundle, so it does not survive the run — a dev helper's Accessibility and Screen Recording
# grants are keyed to a bundle identity and would be lost on every rebuild otherwise.
# Per-architecture builds under .build/<triple>/release are intermediates.
#
# This header is load-bearing: it advertised the bare SwiftPM product name long after the
# script stopped writing it, build/gulpfile.vscode.ts believed the header, and packaging
# therefore looked for a file that was never written — warned, shipped without the helper,
# and every computer_* tool reported "was not contributed" as a result. Keep it in sync with
# getComputerUseHelperSourcePath in the gulpfile whenever this script's output moves.
#
# NOT DONE HERE: code signing and notarization. The helper triggers the standard TCC prompts for
# Accessibility and Screen Recording, and macOS keys those grants to the signing identity — an
# ad-hoc or unsigned binary loses its grants on every rebuild. Signing and notarizing with the
# team identity is the lead's job, run separately after this script, deliberately kept out of here
# so a developer build never touches the release identity.
#
# Usage:
#   scripts/build-computer-use-helper-darwin.sh            # universal
#   scripts/build-computer-use-helper-darwin.sh --host     # host arch only, for a fast local loop
#   scripts/build-computer-use-helper-darwin.sh --no-sign  # never use a release identity

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$REPO_ROOT/src/vs/workbench/contrib/computerUse/helper/darwin"
BUILD_DIR="$PACKAGE_DIR/.build"
PRODUCT="v3code-computer-use"
# The artifact is named for what the installer looks for, which is NOT the SwiftPM product name.
# computerUseHelperInstaller.ts resolves `v3code-computer-use-helper` (`.exe` on Windows) in the
# bundled locations; emitting the bare product name here meant the packaged build would silently
# never find its own helper and the feature would degrade dark with nothing in the log to explain it.
HELPER_FILE_NAME="v3code-computer-use-helper"
OUTPUT="$BUILD_DIR/$HELPER_FILE_NAME"

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "error: the darwin computer-use helper can only be built on macOS (found $(uname -s))" >&2
	exit 1
fi

if ! command -v swift >/dev/null 2>&1; then
	echo "error: 'swift' was not found on PATH; install the Xcode command line tools" >&2
	exit 1
fi

HOST_ONLY=0
NO_SIGN=0
for argument in "$@"; do
	case "$argument" in
		--host) HOST_ONLY=1 ;;
		--no-sign) NO_SIGN=1 ;;
		*)
			echo "error: unknown argument '$argument'" >&2
			exit 1
			;;
	esac
done

if [[ "$HOST_ONLY" -eq 1 ]]; then
	ARCHITECTURES=("$(uname -m)")
else
	ARCHITECTURES=(arm64 x86_64)
fi

echo "==> building $PRODUCT (${ARCHITECTURES[*]}) in $PACKAGE_DIR"

SLICES=()
for architecture in "${ARCHITECTURES[@]}"; do
	# A scratch path per architecture. SwiftPM caches one build manifest per scratch directory and does
	# not key it on --arch, so reusing a single directory across architectures fails on the second pass
	# with "No target named ...exe".
	scratch="$BUILD_DIR/$architecture"
	echo "--> swift build --arch $architecture"
	swift build \
		--package-path "$PACKAGE_DIR" \
		--scratch-path "$scratch" \
		--configuration release \
		--arch "$architecture" \
		--product "$PRODUCT"

	slice="$(swift build --package-path "$PACKAGE_DIR" --scratch-path "$scratch" --configuration release --arch "$architecture" --show-bin-path)/$PRODUCT"
	if [[ ! -f "$slice" ]]; then
		echo "error: expected a built binary for $architecture at $slice but found none" >&2
		exit 1
	fi
	SLICES+=("$slice")
done

mkdir -p "$BUILD_DIR"
rm -f "$OUTPUT"

if [[ "${#SLICES[@]}" -eq 1 ]]; then
	cp "${SLICES[0]}" "$OUTPUT"
else
	echo "--> lipo -create -> $OUTPUT"
	lipo -create "${SLICES[@]}" -output "$OUTPUT"
fi

chmod +x "$OUTPUT"

echo "==> verifying"
lipo -info "$OUTPUT"

# ScreenCaptureKit must be a *weak* load command. If it ever becomes a strong one the binary refuses
# to launch on macOS 12.0-12.2, where the framework does not exist — a failure that only shows up on
# the oldest supported system, i.e. never in development.
for architecture in "${ARCHITECTURES[@]}"; do
	# `otool -L` annotates a weak load command with ", weak)"; checked per slice because otool reports
	# only the first architecture of a fat binary unless told which one to read.
	if ! otool -arch "$architecture" -L "$OUTPUT" | grep "ScreenCaptureKit" | grep -q "weak)"; then
		echo "error: ScreenCaptureKit is not weakly linked in the $architecture slice;" \
			"the helper would not launch on macOS 12.0-12.2" >&2
		exit 1
	fi
	echo "    ScreenCaptureKit is weakly linked ($architecture)"
done

# Wrap the executable in a minimal .app bundle.
#
# This is not cosmetic. TCC treats a bare Mach-O as a second-class client: it cannot raise a usage
# prompt for it, it does not list it by name in System Settings, and a grant added by hand does not
# reliably stick. A bundle gives the helper a stable identity (CFBundleIdentifier) and the usage
# strings TCC requires before it will even ask — which is why Codex ships its sidecar the same way,
# as `Codex Computer Use.app` with its own bundle id rather than a loose binary.
#
# Executing Contents/MacOS/<exe> directly still resolves NSBundle.main to the enclosing .app, so the
# spawn path in computerUseChannel.ts does not change — only which file it points at.
APP_BUNDLE="$BUILD_DIR/V3Code Computer Use.app"
echo "==> bundling: $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mv "$OUTPUT" "$APP_BUNDLE/Contents/MacOS/$HELPER_FILE_NAME"
cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>dev.v3code.computerUseHelper</string>
	<key>CFBundleName</key>
	<string>V3Code Computer Use</string>
	<key>CFBundleExecutable</key>
	<string>$HELPER_FILE_NAME</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.2.0</string>
	<key>CFBundleVersion</key>
	<string>1.2.0</string>
	<!-- No Dock icon and no menu bar: this is a background service, not something the user launches. -->
	<key>LSUIElement</key>
	<true/>
	<!-- TCC refuses to prompt without these, and the text is what the user reads in the dialog. -->
	<key>NSScreenCaptureUsageDescription</key>
	<string>V3Code needs to capture the screen so the agent can see what you see.</string>
	<key>NSAccessibilityUsageDescription</key>
	<string>V3Code needs accessibility access so the agent can read windows and control applications.</string>
	<key>NSAppleEventsUsageDescription</key>
	<string>V3Code needs to send events to other applications so the agent can control them.</string>
</dict>
</plist>
PLIST
OUTPUT="$APP_BUNDLE/Contents/MacOS/$HELPER_FILE_NAME"
chmod +x "$OUTPUT"

# Sign with a stable identity when one is available.
#
# macOS keys TCC grants (Accessibility, Screen Recording) to the signing identity, and an ad-hoc
# signature changes on every rebuild — so the developer re-grants Screen Recording after every
# compile, which in practice means the feature looks broken. Signing with a real Developer ID and a
# fixed identifier makes the grant survive rebuilds.
#
# The identifier must match the designated requirement pinned in computerUseHelperInstaller.ts, or a
# non-override install will refuse to run the binary it just built.
HELPER_SIGN_IDENTIFIER="dev.v3code.computerUseHelper"
if [[ "$NO_SIGN" -eq 1 ]]; then
	SIGN_IDENTITY=""
elif [[ -n "${V3CODE_HELPER_SIGN_IDENTITY:-}" ]]; then
	SIGN_IDENTITY="$V3CODE_HELPER_SIGN_IDENTITY"
else
	# Whatever Developer ID is in the keychain. Contributors without one fall through to ad-hoc, which
	# still runs — it just cannot hold a TCC grant across rebuilds.
	SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -n 1 | tr -d '"')"
fi
if [[ -n "$SIGN_IDENTITY" ]]; then
	echo "==> signing: $SIGN_IDENTITY"
	codesign --force --options runtime --timestamp -s "$SIGN_IDENTITY" -i "$HELPER_SIGN_IDENTIFIER" "$APP_BUNDLE"
	codesign -dv --verbose=2 "$APP_BUNDLE" 2>&1 | grep -E "^Identifier|^TeamIdentifier" | sed 's/^/    /'
else
	if [[ "$NO_SIGN" -eq 1 ]]; then
		# The bundle directory was removed above before it was rebuilt. Assert that
		# the unsigned lane did not inherit a resource seal or Developer ID from a
		# previous release build. Linker-generated ad-hoc signatures on the Mach-O
		# slices are expected and do not carry a TeamIdentifier.
		if [[ -e "$APP_BUNDLE/Contents/_CodeSignature" || -e "$APP_BUNDLE/Contents/CodeResources" ]]; then
			echo "error: --no-sign helper contains stale code-signature resources" >&2
			exit 1
		fi
		UNSIGNED_SIGN_INFO="$(codesign -dv --verbose=4 "$APP_BUNDLE" 2>&1 || true)"
		if printf '%s\n' "$UNSIGNED_SIGN_INFO" | grep -q '^Authority=Developer ID Application:' ||
			{ printf '%s\n' "$UNSIGNED_SIGN_INFO" | grep -q '^TeamIdentifier=' &&
				! printf '%s\n' "$UNSIGNED_SIGN_INFO" | grep -q '^TeamIdentifier=not set$'; }; then
			echo "error: --no-sign helper still carries a Developer ID identity" >&2
			exit 1
		fi
		echo "==> signing disabled (--no-sign); helper remains an unsigned candidate."
	else
		echo "==> WARNING: no Developer ID found; leaving the helper unsigned."
		echo "    Screen Recording and Accessibility grants will be lost on every rebuild."
		echo "    Set V3CODE_HELPER_SIGN_IDENTITY to override."
	fi
fi

# A response written to stdout by anything other than the protocol writer corrupts the stream, so the
# smoke test asserts the very first line of stdout is a well-formed ping response.
echo "==> smoke test: ping"
# The protocol version must track COMPUTER_USE_PROTOCOL_VERSION in common/computerUseTypes.ts: the
# helper rejects a mismatched caller with `helperVersionMismatch`, so a stale literal here fails the
# smoke test on a perfectly good binary.
# `protocolVersion` is deliberately omitted: the helper accepts a request without it, so the smoke
# test does not have to be edited every time the protocol is bumped. Hardcoding it here meant a
# version bump made the build fail with "the ping smoke test did not return a valid response",
# which points at the build rather than at the one-line constant that actually changed.
PING_OUTPUT="$(printf '{"id":1,"method":"ping"}\n' | "$OUTPUT" 2>/dev/null | head -n 1)"
echo "    $PING_OUTPUT"
if [[ "$PING_OUTPUT" != *'"ok":true'* || "$PING_OUTPUT" != *'"platform":"darwin"'* ]]; then
	echo "error: the ping smoke test did not return a valid response" >&2
	exit 1
fi

echo "==> done: $OUTPUT"
