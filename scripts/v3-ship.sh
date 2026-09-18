#!/usr/bin/env bash
# ============================================================================
# V3Code — ONE-COMMAND RELEASE CANDIDATE. Builds mac (local) + Windows (CI)
# together, but deliberately does NOT publish either live feed.
#
#   scripts/v3-ship.sh --bump 0074   # set voidRelease, commit+push, ship BOTH
#   scripts/v3-ship.sh               # ship current product.json voidRelease to both
#   scripts/v3-ship.sh --mac-only    # just mac (local)
#   scripts/v3-ship.sh --win-only    # just Windows (CI dispatch)
#
# Windows builds+signs on GitHub Actions. Mac builds+signs+notarizes locally.
# The two run in parallel and stop at immutable candidate artifacts. Publishing
# happens only after those exact hashes pass smoke tests on real machines.
#
# References: build-ship-runbook + mac-build-sharp-deps-fix (memory).
# ============================================================================
set -euo pipefail
if [ -d /opt/homebrew/opt/node@22/bin ]; then
	export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
else
	export PATH="/opt/homebrew/bin:$PATH"
fi
unset ELECTRON_RUN_AS_NODE 2>/dev/null || true
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REPO="HeavenFYouMissed/VSElite"
MAC=1; WIN=1; BUMP=""
while [ $# -gt 0 ]; do
	case "$1" in
		--mac-only) WIN=0 ;;
		--win-only) MAC=0 ;;
		--bump) BUMP="${2:-}"; shift ;;
		*) echo "v3-ship: unknown arg '$1'" >&2; exit 2 ;;
	esac
	shift
done

DIRTY_SOURCE="$(git status --porcelain=v1 --untracked-files=all)"
if [ -n "$DIRTY_SOURCE" ]; then
	echo "v3-ship: worktree is dirty (including untracked files). Release candidates require an exact clean source tree." >&2
	printf '%s\n' "$DIRTY_SOURCE" >&2
	exit 1
fi

# Release orchestration is intentionally main-only. A worktree branch may build
# locally for diagnosis, but it must never bump or dispatch a fleet candidate.
CURRENT_BRANCH=$(git symbolic-ref --quiet --short HEAD || true)
if [ "$CURRENT_BRANCH" != "main" ]; then
	echo "v3-ship: release candidates must be cut from branch main (current: ${CURRENT_BRANCH:-detached})." >&2
	exit 1
fi
git fetch origin main -q
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
	echo "v3-ship: main is not exactly origin/main. Resolve local/remote drift before shipping." >&2
	exit 1
fi

# --- optional version bump + commit + push --------------------------------
if [ -n "$BUMP" ]; then
	if ! printf '%s' "$BUMP" | grep -qE '^[0-9]{4}$'; then
		echo "v3-ship: --bump must be a four-digit release number (for example 0087)." >&2
		exit 2
	fi
	echo "==> bumping voidRelease -> $BUMP"
	V3_BUMP="$BUMP" node -e 'const f="product.json",fs=require("fs");fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/("voidRelease":\s*")[^"]+(")/,(m,a,b)=>a+process.env.V3_BUMP+b))'
	git add product.json
	git commit -q -m "release: bump to $BUMP"
	git push origin main
	if [ -n "$(git status --porcelain=v1 --untracked-files=all)" ]; then
		echo "v3-ship: version bump did not leave a clean source tree. Refusing to continue." >&2
		exit 1
	fi
fi

REL=$(node -p "require('./product.json').voidRelease")
SHORT=$(git rev-parse --short=10 HEAD)
echo "==> Building V3Code candidate 1.4.9-$REL ($SHORT)  [mac=$MAC win=$WIN]"

# Both platforms build from origin/main — refuse to ship un-pushed code.
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
	echo "v3-ship: HEAD != origin/main. Commit + push the release first (or pass --bump)." >&2
	exit 1
fi
COMMIT=$(git rev-parse HEAD)
RELEASE_ROOT="$(pwd)/.build/releases/$COMMIT"

# One shared source gate for both platforms. Run it before dispatching Windows
# or starting macOS packaging so neither signer can bless a source revision
# whose MCP discovery, typed tool schemas, or provider conversion is broken.
echo "==> release source gate"
bash scripts/v3-release-source-gate.sh

# --- Windows first: dispatch CI so it builds in parallel with the mac build --
if [ "$WIN" = "1" ]; then
	echo "==> [win] dispatching Windows CI (build + sign only; publish=false)"
	gh workflow run v3-build-windows.yml --repo "$REPO" --ref main
	echo "==> [win] dispatched — it will upload signed candidates only (~45 min)."
	echo "    Watch: gh run list --repo $REPO --workflow v3-build-windows.yml"
fi

# --- Mac local pipeline -----------------------------------------------------
if [ "$MAC" = "1" ]; then
	# sharp MUST be self-contained (vendored libvips, not Homebrew) or
	# v3-package-mac.sh refuses to package (a Homebrew-linked sharp ships a broken
	# semantic index). Auto-heal it here. See mac-build-sharp-deps-fix.
	XEN="node_modules/@xenova/transformers/node_modules"
	SN="$XEN/sharp/build/Release/sharp-darwin-arm64v8.node"
	if [ ! -f "$SN" ] || otool -L "$SN" 2>/dev/null | grep -q "/opt/homebrew"; then
		echo "==> [mac] sharp is Homebrew-linked or missing — rebuilding self-contained"
		rm -rf "$XEN/sharp/build" "$XEN/sharp/vendor"
		SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install --prefix node_modules/@xenova/transformers >/dev/null 2>&1
		ln -sfn "$(pwd)/$XEN/sharp/vendor" "$XEN/vendor"
		SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm rebuild sharp >/dev/null 2>&1
		if [ ! -f "$SN" ] || otool -L "$SN" | grep -q "/opt/homebrew"; then
			echo "v3-ship: sharp still not self-contained — see mac-build-sharp-deps-fix memory." >&2
			exit 1
		fi
	fi

	echo "==> [mac] package"
	bash scripts/v3-package-mac.sh --release-root "$RELEASE_ROOT"
	echo "==> [mac] sign + notarize (Apple round-trip ~5 min)"
	bash scripts/v3-sign-notarize-mac.sh \
		--app "$RELEASE_ROOT/VSCode-darwin-arm64/V3Code.app" \
		--dist-dir "$RELEASE_ROOT/dist" \
		--expected-commit "$COMMIT"
fi

echo ""
echo "==> CANDIDATE BUILD STARTED/COMPLETE — NOTHING PUBLISHED."
[ "$MAC" = "1" ] && echo "    mac    : signed candidate at $RELEASE_ROOT/dist (smoke this exact zip)."
[ "$WIN" = "1" ] && echo "    windows: signed candidates will be GitHub artifacts (smoke the exact installer)."
echo "    Publish only the approved artifact summaries with scripts/v3-publish-release.sh --build-json <exact-last-build.json> --apply."
