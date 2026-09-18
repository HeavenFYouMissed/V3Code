#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# V3Code — macOS packaging pipeline (arm64 by default, --arch=x64 for Intel)
#
# Builds a *downloadable* V3Code.app (not a dev launch) and a distributable
# .zip, then prints the version, artifact path, size, and SHA-256.
#
# This mirrors the canonical VS Code CI client build (see
# build/azure-pipelines/darwin/steps/product-build-darwin-compile.yml):
#
#     npm run gulp core-ci                         # transpile + minified bundle
#     npm run gulp compile-copilot-extension-build # built-in copilot from source
#     npm run gulp vscode-darwin-$ARCH-min-ci      # wrap Electron + package .app
#
# Output app:  <repo>/.build/releases/<commit>/VSCode-darwin-$ARCH/V3Code.app
# Output zip:  <repo>/.build/releases/<commit>/dist/V3Code-darwin-$ARCH-<version>.zip
#
# Free tier is BYOK — no auth is baked into the artifact.
#
# Usage:
#   scripts/v3-package-mac.sh                 # full compile + package
#   scripts/v3-package-mac.sh --arch=x64 --unsigned  # Intel unsigned candidate
#   scripts/v3-package-mac.sh --skip-compile  # re-package only (reuse out-vscode-min)
#   scripts/v3-package-mac.sh --no-zip        # build the .app, skip zipping
#   scripts/v3-package-mac.sh --release-root PATH  # explicit isolated output root
#
# Source maps (*.js.map / *.css.map) are ALWAYS stripped from packaged builds
# (build/gulpfile.vscode.ts) — they embed the full TypeScript sources.
#
# Ad-hoc signing is applied for local testing. For public distribution, a real
# Apple Developer ID + notarization is required (see docs/V3CODE-MAC-PACKAGE.md).
# ---------------------------------------------------------------------------
set -euo pipefail

ARCH="arm64"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT"

# Homebrew tooling on PATH (native module rebuilds), while preserving the pinned Node 22 runtime
# used by the source gate. Prepending generic Homebrew first silently switched packaging back to
# Node 26 even when v3-ship had selected Node 22, so the gate and artifact were built by different
# runtimes.
if [ -d /opt/homebrew/opt/node@22/bin ]; then
	export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
else
	export PATH="/opt/homebrew/bin:$PATH"
fi
EXPECTED_NODE_MAJOR="$(tr -d '[:space:]v' < .nvmrc | cut -d. -f1)"
ACTUAL_NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$ACTUAL_NODE_MAJOR" != "$EXPECTED_NODE_MAJOR" ]; then
	echo "v3-package-mac: Node $EXPECTED_NODE_MAJOR is required; active runtime is $(node --version)." >&2
	exit 1
fi
# Clear the Electron-as-node env leak that agent/integrated terminals inject and crashes Electron.
unset ELECTRON_RUN_AS_NODE || true

SKIP_COMPILE=0
DO_ZIP=1
SIGN_MODE="adhoc"
RELEASE_ROOT_ARG=""
while [ $# -gt 0 ]; do
	case "$1" in
		--skip-compile) SKIP_COMPILE=1 ;;
		--no-zip) DO_ZIP=0 ;;
		--unsigned) SIGN_MODE="none" ;;
		--arch=*) ARCH="${1#--arch=}" ;;
		--release-root) RELEASE_ROOT_ARG="${2:?--release-root requires a path}"; shift ;;
		-h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "v3-package-mac: unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

case "$ARCH" in
	arm64|x64) ;;
	*) echo "v3-package-mac: --arch must be arm64 or x64 (got '$ARCH')." >&2; exit 2 ;;
esac

DIRTY_SOURCE="$(git status --porcelain=v1 --untracked-files=all)"
if [ -n "$DIRTY_SOURCE" ]; then
	echo "v3-package-mac: source worktree is dirty; refusing to create a provenance-ambiguous artifact." >&2
	printf '%s\n' "$DIRTY_SOURCE" >&2
	exit 1
fi

HOST_ARCH="$(uname -m)"
[ "$HOST_ARCH" = "arm64" ] || HOST_ARCH="x64"
if [ "$HOST_ARCH" != "arm64" ] && [ "$ARCH" != "$HOST_ARCH" ]; then
	echo "v3-package-mac: cannot build $ARCH on an $HOST_ARCH host; only Apple Silicon hosts cross-build." >&2
	exit 1
fi
CROSS=0
[ "$ARCH" = "$HOST_ARCH" ] || CROSS=1
# Extension build scripts choose their native runtime using VSCODE_ARCH rather
# than the gulp task name. Without this, x64 packaging can retain arm64 assets.
export VSCODE_ARCH="$ARCH"

# --- preflight: sharp must be self-contained ---------------------------------
# sharp compiled against Homebrew vips dlopens /opt/homebrew paths users don't
# have (and hardened-runtime signing rejects anyway: different Team IDs), which
# silently degrades the semantic index to lexical-only FLEET-WIDE (found live
# 2026-07-11). The vendored build links @rpath dylibs that ship inside the app.
export SHARP_IGNORE_GLOBAL_LIBVIPS=1
SHARP_DIR="node_modules/@xenova/transformers/node_modules/sharp"
[ "$ARCH" = "arm64" ] && SHARP_LIB="sharp-darwin-arm64v8.node" || SHARP_LIB="sharp-darwin-x64.node"
SHARP_NODE="$SHARP_DIR/build/Release/$SHARP_LIB"
if [ "$CROSS" -eq 0 ] && [ -f "$SHARP_NODE" ] && otool -L "$SHARP_NODE" | grep -q "/opt/homebrew"; then
	echo "v3-package-mac: sharp links Homebrew libvips — this ships a broken semantic index." >&2
	echo "  Fix: rm -rf node_modules/@xenova/transformers/node_modules/sharp/{build,vendor} \\" >&2
	echo "       && SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm rebuild sharp" >&2
	exit 1
fi

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
START_TS=$(date +%s)

# --- version metadata -------------------------------------------------------
APP_VERSION=$(node -p "require('./package.json').version")
V3_VERSION=$(node -p "const p=require('./product.json'); (p.voidVersion||p.version||'')+'-'+(p.voidRelease||'')")
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
SHORT_COMMIT=${COMMIT:0:10}
RELEASE_TAG="${V3_VERSION}"

# Every candidate is immutable by location. The old parent-directory output was shared by every
# worktree under /Users/daniel/dev, which let a different lane replace an already signed app between
# packaging, smoke, and publish. Gulp honors V3_BUILD_ROOT (build/gulpfile.vscode.ts); dist metadata
# lives beside that exact tree so last-build.json cannot accidentally attest another commit's zip.
RELEASE_ROOT="${RELEASE_ROOT_ARG:-$REPO_ROOT/.build/releases/$COMMIT}"
case "$RELEASE_ROOT" in
	/*) ;;
	*) RELEASE_ROOT="$REPO_ROOT/$RELEASE_ROOT" ;;
esac
BUILD_ROOT="$RELEASE_ROOT"
APP_OUT_DIR="$BUILD_ROOT/VSCode-darwin-$ARCH"
DIST_DIR="$RELEASE_ROOT/dist"
export V3_BUILD_ROOT="$BUILD_ROOT"

# Bake the commit into the packaged product.json deterministically. gulp's
# getVersion() prefers BUILD_SOURCEVERSION and otherwise reads .git/HEAD directly
# (build/lib/git.ts) — which returns NOTHING in a git *worktree* (.git is a
# pointer file there), silently producing an app with no product.commit whose
# update service is permanently Disabled. Auto-update depends on this value.
# Copilot extension build (.esbuild.mts) requires VSCODE_QUALITY for versioning.
export VSCODE_QUALITY="$(node -p "require('./product.json').quality || 'stable'")"

if printf '%s' "$COMMIT" | grep -qE '^[0-9a-f]{40}$'; then
	export BUILD_SOURCEVERSION="$COMMIT"
else
	echo "v3-package-mac: cannot resolve a 40-hex git commit (got '$COMMIT') — refusing to package an update-dead build." >&2
	exit 1
fi

# Computer-use helper. Nothing else in the release path built it, so every build to
# date shipped without it: the packaging step warned and carried on, `isAvailable`
# stayed false, and all sixteen computer_* tools silently failed to register. The
# only symptom anyone saw was "was not contributed", which reads as "this feature
# does not exist" rather than "this build forgot a binary". Build it here so the
# packaging guard never has to fire.
COMPUTER_USE_HELPER="src/vs/workbench/contrib/computerUse/helper/darwin/.build/V3Code Computer Use.app/Contents/MacOS/v3code-computer-use-helper"
# Always reconstruct the helper bundle without a release identity. A normal ARM
# package previously reused a months-old Developer-ID-signed helper when its
# source was unchanged; later app packaging modified/copied its bundle context
# and the OS rejected it with "invalid Info.plist". The final inside-out app
# signer is the only code path allowed to apply the release identity.
log "Building computer-use helper (universal, unsigned for final app signing)"
./scripts/build-computer-use-helper-darwin.sh --no-sign
COMPUTER_USE_HELPER_APP="$(dirname "$(dirname "$(dirname "$COMPUTER_USE_HELPER")")")"
if [ -e "$COMPUTER_USE_HELPER_APP/Contents/_CodeSignature" ] || [ -e "$COMPUTER_USE_HELPER_APP/Contents/CodeResources" ]; then
	echo "v3-package-mac: computer-use helper contains stale _CodeSignature/CodeResources." >&2
	exit 1
fi
COMPUTER_USE_SIGN_INFO="$(codesign -dv --verbose=4 "$COMPUTER_USE_HELPER_APP" 2>&1 || true)"
if printf '%s\n' "$COMPUTER_USE_SIGN_INFO" | grep -q '^Authority=Developer ID Application:' ||
	{ printf '%s\n' "$COMPUTER_USE_SIGN_INFO" | grep -q '^TeamIdentifier=' &&
		! printf '%s\n' "$COMPUTER_USE_SIGN_INFO" | grep -q '^TeamIdentifier=not set$'; }; then
	echo "v3-package-mac: computer-use helper still carries a Developer ID identity before final signing." >&2
	exit 1
fi
# Having built it, insist packaging actually includes it.
export V3_REQUIRE_COMPUTER_USE_HELPER=1

# Beast sidecar. Until now this was NEVER packaged on any platform: build-beast.sh
# installs it to ~/.v3code/bin on a developer's machine, and beastChannel looked
# only there. So it worked on the machine that cut the release and was missing for
# every single user, while beastEnabled defaults to true — a feature switched on
# fleet-wide whose binary was not in the download. Build it here so the bundle can
# carry it (copied into Contents/Resources/beast after packaging, below).
if [ "$ARCH" = "x64" ]; then
	BEAST_TARGET="x86_64-apple-darwin"
	BEAST_BIN="beast/target/$BEAST_TARGET/release/beast"
else
	BEAST_TARGET=""
	BEAST_BIN="beast/target/release/beast"
fi
NEED_BEAST_BUILD=0
if [ ! -x "$BEAST_BIN" ]; then
	NEED_BEAST_BUILD=1
elif [ -n "$(find beast/src beast/Cargo.toml beast/Cargo.lock -type f -newer "$BEAST_BIN" -print -quit 2>/dev/null)" ]; then
	NEED_BEAST_BUILD=1
fi
if [ "$NEED_BEAST_BUILD" -eq 1 ]; then
	if ! command -v cargo >/dev/null 2>&1; then
		echo "v3-package-mac: cargo not found — cannot build the beast sidecar." >&2
		echo "  Install Rust (https://rustup.rs). Shipping without beast leaves the sidecar" >&2
		echo "  channel dark for every user while the feature is enabled by default." >&2
		exit 1
	fi
	if [ -n "$BEAST_TARGET" ]; then
		log "Building beast sidecar (cargo build --release --target $BEAST_TARGET)"
		( cd beast && cargo build --release --target "$BEAST_TARGET" )
	else
		log "Building beast sidecar (cargo build --release)"
		( cd beast && cargo build --release )
	fi
fi

log "V3Code macOS packaging — $ARCH$([ "$CROSS" -eq 1 ] && echo " (cross-built on $HOST_ARCH)")"
echo "    app version   : $APP_VERSION"
echo "    v3code version: $V3_VERSION"
echo "    commit        : $SHORT_COMMIT"
echo "    repo root     : $REPO_ROOT"
echo "    release root  : $RELEASE_ROOT"
echo "    app output    : $APP_OUT_DIR"

# --- 1. compile core (transpile + minified bundle) --------------------------
if [ "$SKIP_COMPILE" -eq 0 ]; then
	log "React hosts — npm run buildreact"
	npm run buildreact

	log "Step 1/3 — npm run gulp core-ci (transpile + minify client/server)"
	npm run gulp core-ci
	node build/verify/react-bundle-freshness.mjs --record

	# V3Code ships WITHOUT the built-in GitHub Copilot extension: its license
	# ("SEE LICENSE IN LICENSE.txt" — GitHub proprietary) does not permit
	# redistribution inside a third-party product. We intentionally skip
	# compile-copilot-extension-build here (Step 2 upstream).
	log "Step 2/3 — skipped (Copilot extension is not shipped)"
else
	log "Skipping compile (--skip-compile); reusing out-vscode-min + .build/extensions"
	if [ ! -d "$REPO_ROOT/out-vscode-min" ]; then
		echo "v3-package-mac: out-vscode-min missing — run without --skip-compile first." >&2
		exit 1
	fi
	node build/verify/react-bundle-freshness.mjs --check
fi

# --- 2. package (wrap Electron, produce the .app) ---------------------------
# Purge any stale compiled Copilot extension from previous builds: packaging
# globs .build/extensions/** wholesale, so a leftover copilot dir would ship.
rm -rf .build/extensions/copilot

log "Step 3/3 — npm run gulp vscode-darwin-$ARCH-min-ci (package .app)"
rm -rf "$APP_OUT_DIR"
PACKAGE_EVIDENCE_DIR="$RELEASE_ROOT/evidence"
mkdir -p "$PACKAGE_EVIDENCE_DIR"

run_package_gulp() {
	local attempt="$1"
	local attempt_log="$PACKAGE_EVIDENCE_DIR/package-gulp-attempt-$attempt.log"
	echo "    package attempt: $attempt (log: $attempt_log)"
	npm run gulp "vscode-darwin-$ARCH-min-ci" 2>&1 | tee "$attempt_log"
}

# Gulp's merged vinyl stream has a known intermittent completion failure where every input has
# already been staged but the wrapper exits with only "Did you forget to signal async completion?".
# A clean rerun of the package-only task succeeds against the same compiled inputs. Retry exactly
# that signature once, from an empty destination, then let the exhaustive package gate below decide
# whether the result is complete. Other failures are never retried or hidden.
if ! run_package_gulp 1; then
	if ! grep -Fq "Did you forget to signal async completion?" "$PACKAGE_EVIDENCE_DIR/package-gulp-attempt-1.log"; then
		echo "v3-package-mac: package task failed; not a recognized transient completion fault. Aborting." >&2
		exit 1
	fi
	log "Packaging stream ended early — one clean bounded retry"
	rm -rf "$APP_OUT_DIR"
	if ! run_package_gulp 2; then
		echo "v3-package-mac: package task failed again after the one allowed retry. Aborting." >&2
		exit 1
	fi
fi

# --- 3. locate the .app -----------------------------------------------------
APP_NAME="$(ls "$APP_OUT_DIR" | head -n 1)"
APP_PATH="$APP_OUT_DIR/$APP_NAME"
if [ ! -d "$APP_PATH" ]; then
	echo "v3-package-mac: expected .app not found under $APP_OUT_DIR" >&2
	exit 1
fi
EXEC_NAME=$(node -p "require('$APP_PATH/Contents/Resources/app/product.json').nameShort")
BUNDLE_MODULES="$APP_PATH/Contents/Resources/app/node_modules"

# Native modules compiled from source were rebuilt for x64 by
# v3-install-deps-x64.sh. Packages distributed as platform tarballs are still
# resolved for the arm64 host, so replace them with the lockfile-pinned x64
# copies staged by that preparation step.
if [ "$CROSS" -eq 1 ]; then
	STAGE_DIR="$REPO_ROOT/.build/native-darwin-$ARCH"
	if [ ! -d "$STAGE_DIR/node_modules" ]; then
		echo "v3-package-mac: no staged $ARCH packages at $STAGE_DIR." >&2
		echo "  Run: scripts/v3-install-deps-x64.sh" >&2
		exit 1
	fi
	log "Injecting staged $ARCH platform packages"
	INJECTED=0
	while IFS= read -r src; do
		pkg="${src#$STAGE_DIR/node_modules/}"
		host_pkg="$(printf '%s' "$pkg" | sed -e 's/-darwin-x64$/-darwin-arm64/' -e 's|/mac-x64$|/mac-arm64-metal|')"
		rm -rf "${BUNDLE_MODULES:?}/$pkg" "${BUNDLE_MODULES:?}/$host_pkg"
		mkdir -p "$(dirname "$BUNDLE_MODULES/$pkg")"
		cp -R "$src" "$BUNDLE_MODULES/$pkg"
		echo "    + $pkg (removed $host_pkg)"
		INJECTED=$((INJECTED + 1))
	done < <(find "$STAGE_DIR/node_modules" -mindepth 1 -maxdepth 2 -type d -name '*x64*' -not -path '*/@*/*/*' | sort -u)
	[ "$INJECTED" -gt 0 ] || {
		echo "v3-package-mac: staged directory held nothing to inject." >&2
		exit 1
	}

	# The locked mxc-sdk and isolated-vm packages expose arm64-only optional
	# assets. Remove unusable executables instead of shipping wrong-arch files.
	MXC_ARM64="$BUNDLE_MODULES/@microsoft/mxc-sdk/bin/arm64/mxc-exec-mac"
	MXC_X64="$BUNDLE_MODULES/@microsoft/mxc-sdk/bin/x64/mxc-exec-mac"
	if [ -e "$MXC_ARM64" ] && [ ! -e "$MXC_X64" ]; then
		rm -f "$MXC_ARM64"
		echo "    NOTE: removed arm64-only mxc-exec-mac; seatbelt shell sandbox is unavailable on Intel"
	fi
	while IFS= read -r -d '' unsupported; do
		rm -rf "$unsupported"
		echo "    NOTE: removed arm64-only ${unsupported#$APP_PATH/}; bundle reconstruction is unavailable on Intel"
	done < <(find "$BUNDLE_MODULES" -type d -path '*/isolated-vm/prebuilds/darwin-arm64*' -print0)
fi

# Source archives are not runtime assets. On either Mac architecture Apple scans
# their nested unsigned prebuilds, which the app signer cannot reach.
while IFS= read -r -d '' archive; do
	rm -f "$archive"
	echo "    NOTE: removed non-runtime ${archive#$APP_PATH/}; nested prebuilds cannot enter notarization"
done < <(find "$BUNDLE_MODULES/isolated-vm" -maxdepth 1 -type f -name 'isolated-vm-*.tgz' -print0 2>/dev/null)
if find "$BUNDLE_MODULES/isolated-vm" -maxdepth 1 -type f -name 'isolated-vm-*.tgz' -print -quit 2>/dev/null | grep -q .; then
	echo "v3-package-mac: an isolated-vm source archive remains in the Mac bundle. Aborting." >&2
	exit 1
fi

# The update route lives or dies on the bundle's product.json: commit must equal
# what we think we packaged (it becomes the manifest version), and quality +
# updateUrl must be present or the update service is Disabled(MissingConfiguration).
BUNDLE_META=$(node -p "const p=require('$APP_PATH/Contents/Resources/app/product.json');[p.commit||'',p.quality||'',p.updateUrl||''].join('|')")
BUNDLE_COMMIT=${BUNDLE_META%%|*}
BUNDLE_REST=${BUNDLE_META#*|}
BUNDLE_QUALITY=${BUNDLE_REST%%|*}
BUNDLE_UPDATE_URL=${BUNDLE_REST#*|}
if [ "$BUNDLE_COMMIT" != "$COMMIT" ]; then
	echo "v3-package-mac: bundle product.commit ('$BUNDLE_COMMIT') != repo HEAD ('$COMMIT') — update loop would never converge. Aborting." >&2
	exit 1
fi
if [ -z "$BUNDLE_QUALITY" ] || [ -z "$BUNDLE_UPDATE_URL" ]; then
	echo "v3-package-mac: bundle product.json is missing quality/updateUrl — this build's update service would be permanently Disabled. Aborting." >&2
	exit 1
fi
echo "    bundle update config OK: commit=$SHORT_COMMIT quality=$BUNDLE_QUALITY updateUrl=$BUNDLE_UPDATE_URL"

# V3Code must ship ZERO GitHub Copilot bits (proprietary license). Fail the
# build if the extension or the @github/copilot* node modules leaked in.
if [ -d "$APP_PATH/Contents/Resources/app/extensions/copilot" ]; then
	echo "v3-package-mac: bundle contains extensions/copilot — Copilot must not ship. Aborting." >&2
	exit 1
fi
if compgen -G "$APP_PATH/Contents/Resources/app/node_modules/@github/copilot*" >/dev/null 2>&1; then
	echo "v3-package-mac: bundle contains @github/copilot* node modules — Copilot must not ship. Aborting." >&2
	exit 1
fi
echo "    bundle copilot check OK: no extensions/copilot, no @github/copilot*"

# The Agents panel requires the bundled Claude Agent SDK + its native binary
# (production dependency since D1; arch-specific so a cross-built bundle with
# the wrong platform package fails here, not on a user's machine).
if [ ! -f "$APP_PATH/Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" ]; then
	echo "v3-package-mac: bundle is missing @anthropic-ai/claude-agent-sdk — the Agents panel would ship dead. Aborting." >&2
	exit 1
fi
if [ ! -x "$APP_PATH/Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-$ARCH/claude" ]; then
	echo "v3-package-mac: bundle is missing the claude native binary (darwin-$ARCH) — the SDK cannot spawn. Aborting." >&2
	exit 1
fi
echo "    bundle claude-agent-sdk check OK: sdk.mjs + darwin-$ARCH native binary present"

# Ship beast INSIDE the app. beastChannel looks at Contents/Resources/beast first
# and only then at ~/.v3code/bin, so this is what makes the sidecar exist for a
# user who never ran build-beast.sh — i.e. everyone.
BEAST_DEST="$APP_PATH/Contents/Resources/beast"
mkdir -p "$BEAST_DEST"
cp "$BEAST_BIN" "$BEAST_DEST/beast"
chmod +x "$BEAST_DEST/beast"
if [ ! -x "$BEAST_DEST/beast" ]; then
	echo "v3-package-mac: beast is not in the bundle — the sidecar would ship dark. Aborting." >&2
	exit 1
fi
BEAST_ARCHS="$(lipo -archs "$BEAST_DEST/beast" 2>/dev/null || echo unknown)"
case "$ARCH:$BEAST_ARCHS" in
	arm64:*arm64*|x64:*x86_64*) ;;
	*)
		echo "v3-package-mac: beast is '$BEAST_ARCHS' but this is an $ARCH build — it would fail to exec. Aborting." >&2
		echo "  Rebuild it for this target: (cd beast && cargo build --release --target <triple>)" >&2
		exit 1
		;;
esac
echo "    bundle beast check OK: $BEAST_ARCHS sidecar at Contents/Resources/beast"

# The repo's own .v3code gets swept into the app payload by the gulp file
# collection, and it is a MIX of two things — stripping the whole directory
# (as this first did) silently removed shipped product content:
#   SHIP   skills/  — skillsService._getBundledSkillsDirs() reads appRoot/.v3code/skills
#   SHIP   rules/   — workspaceRulesService._getBundledRulesDirs() reads appRoot/.v3code/rules
#   SHIP   mcp/     — v3codeMcpServerChannel launches the stable stdio bridge here
#   STRIP  everything else — workspace-id, PROJECT_STATUS.md, active-plan.json,
#          theme-preview.html, scripts/, agents/ (nothing resolves that at appRoot),
#          and any browser-sessions/ or .context-bridge/ that ever reappears.
# Remove the leak, keep the product. Deleting a named allowlist would silently
# ship anything new that lands in .v3code, so invert it: delete everything EXCEPT
# the three directories the running code actually resolves.
V3CODE_BUNDLED="$APP_PATH/Contents/Resources/app/.v3code"
if [ -d "$V3CODE_BUNDLED" ]; then
	find "$V3CODE_BUNDLED" -mindepth 1 -maxdepth 1 ! -name skills ! -name rules ! -name mcp -exec rm -rf {} +
	[ -d "$V3CODE_BUNDLED/skills" ] || {
		echo "v3-package-mac: bundled .v3code/skills is missing — the shipped skill library would be empty. Aborting." >&2
		exit 1
	}
	[ -d "$V3CODE_BUNDLED/rules" ] || {
		echo "v3-package-mac: bundled .v3code/rules is missing — the shipped agent rules would be empty. Aborting." >&2
		exit 1
	}
	echo "    bundle .v3code check OK: kept skills ($(find "$V3CODE_BUNDLED/skills" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ') skills) + rules + MCP bridge, stripped dev state"
fi

# Production dependency collection can follow a workspace node_modules symlink
# outside this checkout and copy the external repo back under Resources/<repo>.
# That happened with Resources/VSElite/node_modules and silently added Intel-only
# ONNX binaries to an arm64 app. Only Resources/app is a valid top-level Node
# payload. Remove a copied external root from this newly-created package, then
# fail closed if any such root survives.
RESOURCES_ROOT="$APP_PATH/Contents/Resources"
while IFS= read -r -d '' external_node_modules; do
	external_root="$(dirname "$external_node_modules")"
	[ "$(basename "$external_root")" = "app" ] && continue
	if [ "$(dirname "$external_root")" != "$RESOURCES_ROOT" ]; then
		echo "v3-package-mac: unsafe external dependency cleanup target: $external_root" >&2
		exit 1
	fi
	case "$external_root" in
		"$RESOURCES_ROOT"/*) ;;
		*) echo "v3-package-mac: external dependency root escaped package Resources: $external_root" >&2; exit 1 ;;
	esac
	echo "    removing copied external dependency root: ${external_root#$APP_PATH/}"
	rm -rf -- "$external_root"
	done < <(find "$RESOURCES_ROOT" -mindepth 2 -maxdepth 2 -name node_modules -print0)

if find "$RESOURCES_ROOT" -mindepth 2 -maxdepth 2 -name node_modules ! -path "$RESOURCES_ROOT/app/node_modules" -print -quit | grep -q .; then
	echo "v3-package-mac: copied external dependency roots remain under Contents/Resources. Aborting." >&2
	exit 1
fi
echo "    bundle external dependency check OK: only Contents/Resources/app/node_modules may ship"

# A cross-build can compile successfully while retaining a native binary for
# only the other CPU architecture. Audit both ARM and Intel packages after all
# staging is complete. Platform-specific sibling directories are permitted only
# when a matching sibling for this target actually exists.
EXPECTED_SLICE="arm64"
[ "$ARCH" = "x64" ] && EXPECTED_SLICE="x86_64"
ARCH_FAILURES=""
MACH_COUNT=0
while IFS= read -r -d '' f; do
	archs="$(lipo -archs "$f" 2>/dev/null || true)"
	[ -n "$archs" ] || continue
	MACH_COUNT=$((MACH_COUNT + 1))
	case "$archs" in
		*"$EXPECTED_SLICE"*) continue ;;
	esac
	if [ "$ARCH" = "x64" ]; then
		sibling="$(printf '%s' "$f" | sed -e 's|/darwin/arm64/|/darwin/x64/|' -e 's|/darwin-arm64/|/darwin-x64/|' -e 's|-darwin-arm64/|-darwin-x64/|')"
	else
		sibling="$(printf '%s' "$f" | sed -e 's|/darwin/x64/|/darwin/arm64/|' -e 's|/darwin-x64/|/darwin-arm64/|' -e 's|-darwin-x64/|-darwin-arm64/|')"
	fi
	if [ "$sibling" != "$f" ] && [ -e "$sibling" ] && lipo -archs "$sibling" 2>/dev/null | grep -q "$EXPECTED_SLICE"; then
		continue
	fi
	ARCH_FAILURES="$ARCH_FAILURES  $archs  ${f#$APP_PATH/}"$'\n'
done < <(find "$APP_PATH" -type f \( -perm -111 -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)
[ "$MACH_COUNT" -gt 0 ] || {
	echo "v3-package-mac: architecture audit found no Mach-O files; refusing an unverified package." >&2
	exit 1
}
if [ -n "$ARCH_FAILURES" ]; then
	echo "v3-package-mac: binaries without the required $EXPECTED_SLICE slice remain in the $ARCH bundle:" >&2
	printf '%s' "$ARCH_FAILURES" >&2
	exit 1
fi
echo "    bundle architecture check OK: $MACH_COUNT Mach-O files have an $EXPECTED_SLICE slice (platform siblings accounted for)"

# Manifest-driven artifact gate: every required binary/module present and sane,
# every forbidden path absent — or this build never reaches signing. The manifest
# paths come from walked real packages, not memory (build/verify/artifact-manifest.json).
node build/verify/verify-package.mjs --platform darwin-$ARCH --root "$APP_PATH" || {
	echo "v3-package-mac: package verify gate FAILED — this tree must not ship. See [FAIL] rows above." >&2
	exit 1
}

# Electron backward-compat symlink (Contents/MacOS/Electron -> <nameShort>),
# matching the CI step; harmless if the real exec is already named Electron.
if [ "$EXEC_NAME" != "Electron" ] && [ ! -L "$APP_PATH/Contents/MacOS/Electron" ]; then
	ln -s "$EXEC_NAME" "$APP_PATH/Contents/MacOS/Electron"
fi

# --- 4. optional ad-hoc codesign (local testing only) -----------------------
if [ "$SIGN_MODE" = "none" ]; then
	log "Signing disabled — preserving an unsigned candidate"
	echo "    No codesign command was run. This artifact is not distributable."
else
	log "Ad-hoc signing $APP_NAME (local test signature)"
	if codesign --force --deep --sign - --timestamp=none "$APP_PATH" 2>/tmp/v3-codesign.log; then
		codesign -dv "$APP_PATH" 2>&1 | grep -iE "Signature|Identifier|adhoc" || true
		echo "    ad-hoc signature applied."
	else
		echo "    WARNING: ad-hoc codesign failed (non-fatal for local runs):"
		sed 's/^/      /' /tmp/v3-codesign.log || true
	fi
fi

APP_SIZE=$(du -sh "$APP_PATH" | cut -f1)

# --- 5. zip the distributable ----------------------------------------------
ZIP_PATH=""
ZIP_SHA=""
ZIP_SIZE=""
if [ "$DO_ZIP" -eq 1 ]; then
	mkdir -p "$DIST_DIR"
	if [ "$SIGN_MODE" = "none" ]; then
		ZIP_PATH="$DIST_DIR/V3Code-darwin-${ARCH}-${RELEASE_TAG}-unsigned.zip"
	else
		ZIP_PATH="$DIST_DIR/V3Code-darwin-${ARCH}-${RELEASE_TAG}.zip"
	fi
	rm -f "$ZIP_PATH"
	log "Zipping -> $ZIP_PATH"
	# -Xry from inside the output dir preserves the .app structure + symlinks.
	( cd "$APP_OUT_DIR" && zip -Xry -q "$ZIP_PATH" "$APP_NAME" )
	ZIP_SHA=$(shasum -a 256 "$ZIP_PATH" | cut -d' ' -f1)
	ZIP_SIZE_BYTES=$(stat -f%z "$ZIP_PATH")
	ZIP_SIZE=$(du -h "$ZIP_PATH" | cut -f1)
fi

# --- 6. summary -------------------------------------------------------------
END_TS=$(date +%s)
ELAPSED=$(( END_TS - START_TS ))
MINS=$(( ELAPSED / 60 )); SECS=$(( ELAPSED % 60 ))

log "BUILD COMPLETE"
echo "    app version   : $APP_VERSION"
echo "    v3code version: $V3_VERSION"
echo "    commit        : $SHORT_COMMIT"
echo "    app bundle    : $APP_PATH"
echo "    app size      : $APP_SIZE"
if [ "$DO_ZIP" -eq 1 ]; then
	echo "    zip artifact  : $ZIP_PATH"
	echo "    zip size      : $ZIP_SIZE (${ZIP_SIZE_BYTES} bytes)"
	echo "    zip sha256    : $ZIP_SHA"
fi
echo "    build time    : ${MINS}m ${SECS}s"
echo
echo "    CLI-only smoke: scripts/v3-smoke-mac-cli.sh --arch=$ARCH --app \"$APP_PATH\""

# Emit a machine-readable summary for release automation.
if [ "$DO_ZIP" -eq 1 ]; then
	if [ "$ARCH" = "x64" ]; then
		SUMMARY_JSON="$DIST_DIR/last-build-x64-unsigned.json"
		node build/verify/write-build-metadata.mjs \
			--output "$SUMMARY_JSON" \
			--app-version "$APP_VERSION" \
			--v3code-version "$V3_VERSION" \
			--commit "$COMMIT" \
			--arch "$ARCH" \
			--platform darwin \
			--state unsigned \
			--artifact "$ZIP_PATH" \
			--size "${ZIP_SIZE_BYTES:-0}" \
			--sha256 "$ZIP_SHA" \
			--signed false \
			--notarized false
	else
		# Preserve the existing arm64 automation contract. The Intel lane uses
		# phase-specific immutable records so it cannot replace this pointer.
		SUMMARY_JSON="$DIST_DIR/last-build.json"
		node -e "const fs=require('fs');const[o,av,vv,c,a,s,h]=process.argv.slice(1);fs.writeFileSync(o,JSON.stringify({appVersion:av,v3codeVersion:vv,commit:c,arch:'arm64',platform:'darwin',artifact:a,size:Number(s),sha256:h},null,2)+'\n');" "$SUMMARY_JSON" "$APP_VERSION" "$V3_VERSION" "$COMMIT" "$ZIP_PATH" "${ZIP_SIZE_BYTES:-0}" "$ZIP_SHA"
	fi
	echo "    summary json  : $SUMMARY_JSON"
fi
