#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# V3Code — Linux x64 release-candidate packaging pipeline
#
# Produces a commit-scoped, content-addressed tar.gz and last-build.json. This
# script deliberately has no publish mode: a candidate must be downloaded and
# tested on real Linux machines before a separate release decision is made.
#
# Computer use is not included on Linux. The source tree has native helpers for
# darwin and win32 only, and the runtime does not register computer_* tools when
# no supported helper is available. Shipping a placeholder would turn an honest
# unsupported feature into a broken advertised one.
#
# Usage:
#   scripts/v3-package-linux.sh
#   scripts/v3-package-linux.sh --skip-compile
#   scripts/v3-package-linux.sh --release-root .build/releases/TASK-SPECIFIC-NAME
# ---------------------------------------------------------------------------
set -euo pipefail

ARCH="x64"
PLATFORM="linux-$ARCH"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_COMPILE=0
RELEASE_ROOT_ARG=""
while [ $# -gt 0 ]; do
	case "$1" in
		--skip-compile) SKIP_COMPILE=1 ;;
		--release-root) RELEASE_ROOT_ARG="${2:?--release-root requires a path}"; shift ;;
		-h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "v3-package-linux: unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

case "$(uname -s)" in
	Linux) ;;
	*) echo "v3-package-linux: this script targets Linux; host is $(uname -s)." >&2; exit 1 ;;
esac
case "$(uname -m)" in
	x86_64|amd64) ;;
	*) echo "v3-package-linux: this script targets x64; host is $(uname -m)." >&2; exit 1 ;;
esac

EXPECTED_NODE_MAJOR="$(tr -d '[:space:]v' < .nvmrc | cut -d. -f1)"
ACTUAL_NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$ACTUAL_NODE_MAJOR" != "$EXPECTED_NODE_MAJOR" ]; then
	echo "v3-package-linux: Node $EXPECTED_NODE_MAJOR is required; active runtime is $(node --version)." >&2
	exit 1
fi
unset ELECTRON_RUN_AS_NODE || true

DIRTY_SOURCE="$(git status --porcelain=v1 --untracked-files=all)"
if [ -n "$DIRTY_SOURCE" ]; then
	echo "v3-package-linux: source worktree is dirty; refusing to create a provenance-ambiguous artifact." >&2
	printf '%s\n' "$DIRTY_SOURCE" >&2
	exit 1
fi

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
sha256() { sha256sum "$1" | cut -d' ' -f1; }
fsize() { stat -c%s "$1"; }
START_TS="$(date +%s)"

APP_VERSION="$(node -p "require('./package.json').version")"
V3_VERSION="$(node -p "const p=require('./product.json'); (p.voidVersion||p.version||'')+'-'+(p.voidRelease||'')")"
COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
if ! printf '%s' "$COMMIT" | grep -qE '^[0-9a-f]{40}$'; then
	echo "v3-package-linux: cannot resolve a 40-hex git commit (got '$COMMIT')." >&2
	exit 1
fi
SHORT_COMMIT="${COMMIT:0:10}"
SOURCE_DATE_EPOCH="$(git show -s --format=%ct "$COMMIT")"

source "$REPO_ROOT/scripts/v3-linux-release-paths.sh"
v3_linux_release_paths "$REPO_ROOT" "$RELEASE_ROOT_ARG" "$ARCH" "$COMMIT"
DIST_DIR="$RELEASE_ROOT/dist"
EVIDENCE_DIR="$RELEASE_ROOT/evidence"
export V3_BUILD_ROOT="$RELEASE_ROOT"
export BUILD_SOURCEVERSION="$COMMIT"
export VSCODE_QUALITY="$(node -p "require('./product.json').quality || 'stable'")"
if [ -f "$DIST_DIR/last-build.json" ] || compgen -G "$DIST_DIR/V3Code-linux-$ARCH-*.tar.gz" >/dev/null; then
	echo "v3-package-linux: immutable candidate output already exists under $DIST_DIR." >&2
	echo "  Inspect that evidence, or pass --release-root with a new isolated path." >&2
	exit 1
fi

log "V3Code Linux release candidate — $PLATFORM"
echo "    app version   : $APP_VERSION"
echo "    v3code version: $V3_VERSION"
echo "    commit        : $COMMIT"
echo "    release root  : $RELEASE_ROOT"
echo "    publish       : DISABLED"
echo "    computer use  : unsupported (no Linux native helper in source)"

log "Package contract parity"
node build/verify/verify-package.mjs --parity

if [ "$SKIP_COMPILE" -eq 0 ]; then
	log "Generated React hosts — npm run buildreact"
	npm run buildreact

	log "Compile minified client — npm run gulp core-ci-client"
	npm run gulp core-ci-client
	node build/verify/react-bundle-freshness.mjs --record
else
	log "Skipping compile; verifying generated React freshness"
	if [ ! -d "$REPO_ROOT/out-vscode-min" ]; then
		echo "v3-package-linux: out-vscode-min missing — run without --skip-compile first." >&2
		exit 1
	fi
	node build/verify/react-bundle-freshness.mjs --check
fi

# The proprietary built-in Copilot extension is intentionally not distributed.
rm -rf .build/extensions/copilot

if ! command -v cargo >/dev/null 2>&1; then
	echo "v3-package-linux: cargo not found — cannot build the Beast sidecar." >&2
	exit 1
fi
log "Build Beast sidecar"
( cd beast && cargo build --release --locked )
BEAST_BIN="$REPO_ROOT/beast/target/release/beast"
if [ ! -x "$BEAST_BIN" ]; then
	echo "v3-package-linux: Beast build completed but $BEAST_BIN is not executable." >&2
	exit 1
fi

log "Package Linux x64 client"
rm -rf "$TREE_DIR"
mkdir -p "$EVIDENCE_DIR"
npm run gulp "vscode-linux-$ARCH-min-ci" 2>&1 | tee "$EVIDENCE_DIR/package-gulp.log"

TREE_PRODUCT_JSON="$TREE_DIR/resources/app/product.json"
if [ ! -f "$TREE_PRODUCT_JSON" ]; then
	echo "v3-package-linux: packaged tree has no resources/app/product.json." >&2
	exit 1
fi
BUNDLE_META="$(node -p "const p=require(process.argv[1]);[p.commit||'',p.quality||'',p.updateUrl||''].join('|')" "$TREE_PRODUCT_JSON")"
BUNDLE_COMMIT="${BUNDLE_META%%|*}"
BUNDLE_REST="${BUNDLE_META#*|}"
BUNDLE_QUALITY="${BUNDLE_REST%%|*}"
BUNDLE_UPDATE_URL="${BUNDLE_REST#*|}"
EXPECTED_UPDATE_URL="$(node -p "require('./product.json').updateUrl || ''")"
if [ "$BUNDLE_COMMIT" != "$COMMIT" ]; then
	echo "v3-package-linux: bundle commit '$BUNDLE_COMMIT' != source '$COMMIT'; updater identity is invalid." >&2
	exit 1
fi
if [ -z "$BUNDLE_QUALITY" ] || [ "$BUNDLE_QUALITY" != "$VSCODE_QUALITY" ]; then
	echo "v3-package-linux: bundle quality '$BUNDLE_QUALITY' != expected '$VSCODE_QUALITY'." >&2
	exit 1
fi
if [ -z "$EXPECTED_UPDATE_URL" ] || [ "$BUNDLE_UPDATE_URL" != "$EXPECTED_UPDATE_URL" ]; then
	echo "v3-package-linux: bundle update URL '$BUNDLE_UPDATE_URL' != expected '$EXPECTED_UPDATE_URL'." >&2
	exit 1
fi

mkdir -p "$TREE_DIR/resources/beast"
cp "$BEAST_BIN" "$TREE_DIR/resources/beast/beast"
chmod 0755 "$TREE_DIR/resources/beast/beast"

if find "$TREE_DIR" -iname '*computer-use-helper*' -print -quit | grep -q .; then
	echo "v3-package-linux: an unsupported computer-use helper leaked into the Linux package." >&2
	exit 1
fi

V3CODE_BUNDLED="$TREE_DIR/resources/app/.v3code"
if [ -d "$V3CODE_BUNDLED" ]; then
	find "$V3CODE_BUNDLED" -mindepth 1 -maxdepth 1 ! -name skills ! -name rules ! -name mcp -exec rm -rf {} +
fi
if [ ! -d "$V3CODE_BUNDLED/skills" ] || [ ! -d "$V3CODE_BUNDLED/rules" ]; then
	echo "v3-package-linux: bundled skills/rules are missing after package cleanup." >&2
	exit 1
fi

log "Verify packaged runtime and native assets"
node build/verify/verify-package.mjs --platform "$PLATFORM" --root "$TREE_DIR"

log "Headless Linux boot smoke"
for command in ldd xvfb-run; do
	command -v "$command" >/dev/null 2>&1 || { echo "v3-package-linux: $command is required for smoke." >&2; exit 1; }
done
APP_NAME="$(node -p "require('./product.json').applicationName")"
MAIN_BINARY="$TREE_DIR/$APP_NAME"
if [ ! -x "$MAIN_BINARY" ]; then
	echo "v3-package-linux: main binary is missing or not executable: $MAIN_BINARY" >&2
	exit 1
fi
if ldd "$MAIN_BINARY" | tee "$EVIDENCE_DIR/ldd.log" | grep -F 'not found'; then
	echo "v3-package-linux: packaged binary has unresolved shared libraries." >&2
	exit 1
fi
"$MAIN_BINARY" --version --no-sandbox | tee "$EVIDENCE_DIR/version.log"

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/v3code-linux-smoke.XXXXXX")"
BOOT_PID=""
cleanup_smoke() {
	if [ -n "$BOOT_PID" ] && kill -0 "$BOOT_PID" 2>/dev/null; then kill "$BOOT_PID" 2>/dev/null || true; fi
	rm -rf "$SMOKE_ROOT"
}
trap cleanup_smoke EXIT
xvfb-run -a "$MAIN_BINARY" \
	--no-sandbox --disable-gpu --disable-updates \
	--user-data-dir="$SMOKE_ROOT/user-data" \
	--shared-data-dir="$SMOKE_ROOT/shared-data" \
	--extensions-dir="$SMOKE_ROOT/extensions" \
	>"$EVIDENCE_DIR/boot.log" 2>&1 &
BOOT_PID=$!
for second in $(seq 1 20); do
	sleep 1
	if ! kill -0 "$BOOT_PID" 2>/dev/null; then
		echo "v3-package-linux: editor exited during headless boot at ${second}s." >&2
		tail -80 "$EVIDENCE_DIR/boot.log" >&2
		exit 1
	fi
done
kill "$BOOT_PID" 2>/dev/null || true
wait "$BOOT_PID" 2>/dev/null || true
BOOT_PID=""
if grep -Eiq 'uncaught exception|uncaught \(in promise\)|content security policy.*(refused|violation)|failed to fetch dynamically imported module' "$EVIDENCE_DIR/boot.log"; then
	echo "v3-package-linux: fatal renderer/runtime signature found in boot log." >&2
	tail -80 "$EVIDENCE_DIR/boot.log" >&2
	exit 1
fi
cleanup_smoke
trap - EXIT

log "Create immutable archive and metadata"
mkdir -p "$DIST_DIR"
ARCHIVE_STEM="V3Code-linux-$ARCH-$V3_VERSION-$SHORT_COMMIT"
TEMP_ARCHIVE="$DIST_DIR/$ARCHIVE_STEM.tmp.tar.gz"
rm -f "$TEMP_ARCHIVE"
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
	-C "$RELEASE_ROOT" -cf - "VSCode-linux-$ARCH" | gzip -n > "$TEMP_ARCHIVE"
ARCHIVE_SHA="$(sha256 "$TEMP_ARCHIVE")"
ARCHIVE_PATH="$DIST_DIR/$ARCHIVE_STEM-${ARCHIVE_SHA:0:12}.tar.gz"
mv "$TEMP_ARCHIVE" "$ARCHIVE_PATH"
ARCHIVE_SIZE="$(fsize "$ARCHIVE_PATH")"

END_TS="$(date +%s)"
ELAPSED="$((END_TS - START_TS))"
SUMMARY_JSON="$DIST_DIR/last-build.json"
node -e '
	const fs = require("fs");
	const [out, appVersion, v3codeVersion, commit, quality, updateUrl, artifact, size, hash, tree, elapsed] = process.argv.slice(1);
	fs.writeFileSync(out, JSON.stringify({
		appVersion,
		v3codeVersion,
		commit,
		platform: "linux-x64",
		arch: "x64",
		quality,
		updateUrl,
		artifact,
		size: Number(size),
		sha256: hash,
		packageRoot: tree,
		signed: false,
		signing: "not-required",
		published: false,
		computerUse: "unsupported-no-linux-helper",
		smoke: { headlessXvfb: true, seconds: 20, ldd: true },
		elapsedSeconds: Number(elapsed),
	}, null, 2) + "\n");
' "$SUMMARY_JSON" "$APP_VERSION" "$V3_VERSION" "$COMMIT" "$BUNDLE_QUALITY" "$BUNDLE_UPDATE_URL" "$ARCHIVE_PATH" "$ARCHIVE_SIZE" "$ARCHIVE_SHA" "$TREE_DIR" "$ELAPSED"

log "LINUX RELEASE CANDIDATE COMPLETE"
echo "    tree          : $TREE_DIR"
echo "    artifact      : $ARCHIVE_PATH"
echo "    size          : $ARCHIVE_SIZE bytes"
echo "    sha256        : $ARCHIVE_SHA"
echo "    summary       : $SUMMARY_JSON"
echo "    publish       : DISABLED"
