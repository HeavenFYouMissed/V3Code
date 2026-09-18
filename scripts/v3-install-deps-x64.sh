#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Prepare macOS Intel (x64) dependencies from an Apple Silicon build host.
#
# Host build tooling remains arm64 so Node can execute it. Native modules that
# ship in the app are rebuilt for x64, while lockfile-pinned platform packages
# are fetched into an isolated staging directory for v3-package-mac.sh.
#
# Run only from an isolated worktree with a real, worktree-local node_modules.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -d /opt/homebrew/opt/node@22/bin ]; then
	export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
else
	export PATH="/opt/homebrew/bin:$PATH"
fi
unset ELECTRON_RUN_AS_NODE || true

EXPECTED_NODE_MAJOR="$(tr -d '[:space:]v' < .nvmrc | cut -d. -f1)"
ACTUAL_NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$ACTUAL_NODE_MAJOR" != "$EXPECTED_NODE_MAJOR" ]; then
	echo "v3-install-deps-x64: Node $EXPECTED_NODE_MAJOR is required; active runtime is $(node --version)." >&2
	exit 1
fi

export npm_config_arch=x64 npm_config_target_arch=x64
export npm_config_platform=darwin npm_config_target_platform=darwin
export VSCODE_ARCH=x64
export SHARP_IGNORE_GLOBAL_LIBVIPS=1

STAGE_DIR="$REPO_ROOT/.build/native-darwin-x64"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [ -L node_modules ]; then
	echo "v3-install-deps-x64: node_modules is a symlink; refusing to mutate a shared dependency tree." >&2
	exit 1
fi

# The root preinstall expects the repository's vendored node-gyp. It is pure JS,
# so linking the release factory's copy is architecture-safe and read-only.
GYP="build/npm/gyp/node_modules"
if [ ! -e "$GYP/.bin/node-gyp" ]; then
	FACTORY_GYP="/Users/daniel/dev/VSElite-update-route/$GYP"
	if [ -e "$FACTORY_GYP/.bin/node-gyp" ]; then
		log "0/5 — linking vendored node-gyp from the release factory"
		mkdir -p "$(dirname "$GYP")"
		ln -sfn "$FACTORY_GYP" "$GYP"
	else
		echo "v3-install-deps-x64: vendored node-gyp is missing in both lane and factory." >&2
		exit 1
	fi
fi

log "1/5 — installing host build tooling without lifecycle scripts"
# Do not pass --cpu=x64: rollup/esbuild/tsgo must match the arm64 host. The
# npm_config_arch values still direct explicit node-gyp rebuilds to x64.
npm ci --ignore-scripts --no-audit --no-fund

log "2/5 — rebuilding nested sharp against vendored darwin-x64 libvips"
XEN="node_modules/@xenova/transformers/node_modules"
if [ -d "$XEN/sharp" ]; then
	rm -rf "$XEN/sharp/build" "$XEN/sharp/vendor"
	( cd "$XEN/sharp" && node install/libvips )
	ln -sfn "$REPO_ROOT/$XEN/sharp/vendor" "$XEN/vendor"
	( cd "$XEN/sharp" && npm run install )
else
	echo "v3-install-deps-x64: required nested @xenova sharp package is missing." >&2
	exit 1
fi

REBUILD_PKGS=(
	"@parcel/watcher" "@vscode/deviceid" "@vscode/native-watchdog"
	"@vscode/policy-watcher" "@vscode/spdlog" "@vscode/sqlite3"
	fsevents kerberos native-is-elevated native-keymap node-pty
)
log "3/5 — rebuilding shipped native modules for x64"
npm rebuild "${REBUILD_PKGS[@]}"

log "4/5 — running the repository postinstall"
node build/npm/postinstall.ts

# npm resolves optional platform packages from the running process architecture.
# Fetch foreign-architecture tarballs directly at versions pinned in the lockfile.
log "5/5 — staging lockfile-pinned x64 platform packages"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
STAGE_PKGS=(
	"@img/sharp-darwin-x64"
	"@img/sharp-libvips-darwin-x64"
	"@reflink/reflink-darwin-x64"
	"@anthropic-ai/claude-agent-sdk-darwin-x64"
	"@node-llama-cpp/mac-x64"
	"sqlite-vec-darwin-x64"
)
for pkg in "${STAGE_PKGS[@]}"; do
	ver="$(node -e "const l=require('./package-lock.json');const p=l.packages['node_modules/$pkg'];process.stdout.write(p?p.version:'')" 2>/dev/null || true)"
	if [ -z "$ver" ]; then
		echo "v3-install-deps-x64: $pkg is absent from package-lock.json; refusing an unpinned package." >&2
		exit 1
	fi
	dest="$STAGE_DIR/node_modules/$pkg"
	mkdir -p "$dest"
	echo "    $pkg@$ver"
	tgz="$(cd "$STAGE_DIR" && npm pack --silent "$pkg@$ver")"
	tar -xzf "$STAGE_DIR/$tgz" -C "$dest" --strip-components=1
	rm -f "$STAGE_DIR/$tgz"
done

log "Verifying x64 dependencies selected for the bundle"
BAD=0
check_x64() {
	local label="$1" file="$2" archs
	if [ ! -e "$file" ]; then
		echo "    MISSING: $label"
		BAD=1
		return
	fi
	archs="$(lipo -archs "$file" 2>/dev/null || true)"
	case "$archs" in
		*x86_64*) ;;
		*) echo "    NOT x64: $label ($archs)"; BAD=1 ;;
	esac
}
for pkg in "${REBUILD_PKGS[@]}"; do
	while IFS= read -r -d '' file; do
		check_x64 "${file#node_modules/}" "$file"
	done < <(find "node_modules/$pkg" -name '*.node' -not -path '*/prebuilds/*' -print0 2>/dev/null)
done
check_x64 "nested xenova sharp" "$XEN/sharp/build/Release/sharp-darwin-x64.node"
check_x64 "staged sharp" "$STAGE_DIR/node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node"
check_x64 "staged claude binary" "$STAGE_DIR/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude"
if [ "$BAD" -ne 0 ]; then
	echo "v3-install-deps-x64: one or more shipped dependencies are not x86_64." >&2
	exit 1
fi

log "x64 dependency preparation complete"
