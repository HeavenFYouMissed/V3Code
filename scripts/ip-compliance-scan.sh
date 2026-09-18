#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# V3Code — IP / license hygiene scan (pre-ship gate)
#
# Two layers:
#   1) Brand fingerprint scan (always on) — ripgrep for retired vendor fingerprints
#      residue in ship paths. Exit 1 on hits.
#   2) Optional ScanCode license scan — if `scancode` is on PATH, deep-scan
#      void/ + theme-v3code for non-permissive license text. Install with:
#        python3 -m venv .tools/scancode-venv
#        .tools/scancode-venv/bin/pip install scancode-toolkit
#        export PATH="$PWD/.tools/scancode-venv/bin:$PATH"
#
# Usage:
#   scripts/ip-compliance-scan.sh                 # brand scan (default)
#   scripts/ip-compliance-scan.sh --with-scancode
#   scripts/ip-compliance-scan.sh --json out/ip-scan.json
#   scripts/ip-compliance-scan.sh --root /path/to/worktree
#
# Internal plans are excluded; product source and packaged theme content are scanned.
#
# Pass to merge/ship agents: run this before packaging updates; resolve any
# brand hits atomically with CSS+TS (v3-* gates must stay in sync).
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATTERNS_FILE="$SCRIPT_DIR/ip-compliance/brand-patterns.txt"
FILTER_PY="$SCRIPT_DIR/ip-compliance/filter-scancode.py"
WITH_SCANCODE=0
JSON_OUT=""
FAIL=0

# Prefer local venv if present (created once via the install instructions).
if [[ -x "$ROOT/.tools/scancode-venv/bin/scancode" ]]; then
	export PATH="$ROOT/.tools/scancode-venv/bin:$PATH"
fi
# macOS Homebrew libmagic — required by typecode/scancode.
if [[ -z "${TYPECODE_LIBMAGIC_PATH:-}" && -f /opt/homebrew/opt/libmagic/lib/libmagic.dylib ]]; then
	export TYPECODE_LIBMAGIC_PATH="/opt/homebrew/opt/libmagic/lib/libmagic.dylib"
	export TYPECODE_LIBMAGIC_DB_PATH="/opt/homebrew/opt/libmagic/share/misc/magic.mgc"
elif [[ -z "${TYPECODE_LIBMAGIC_PATH:-}" && -f /usr/local/opt/libmagic/lib/libmagic.dylib ]]; then
	export TYPECODE_LIBMAGIC_PATH="/usr/local/opt/libmagic/lib/libmagic.dylib"
	export TYPECODE_LIBMAGIC_DB_PATH="/usr/local/opt/libmagic/share/misc/magic.mgc"
fi

while [[ $# -gt 0 ]]; do
	case "$1" in
		--with-scancode) WITH_SCANCODE=1; shift ;;
		--json)
			JSON_OUT="${2:-}"
			if [[ -z "$JSON_OUT" ]]; then echo "--json needs a path" >&2; exit 2; fi
			shift 2
			;;
		--root)
			ROOT="$(cd "${2:-}" && pwd)"
			shift 2
			;;
		-h|--help)
			sed -n '2,28p' "$0"
			exit 0
			;;
		*)
			echo "Unknown arg: $1" >&2
			exit 2
			;;
	esac
done

# Patterns always live next to this script (not under --root), so the scan
# tool works against other worktrees that may not have the script yet.
if [[ ! -f "$PATTERNS_FILE" ]]; then
	echo "Missing patterns file: $PATTERNS_FILE" >&2
	exit 2
fi

SCAN_PATHS=(
	"src/vs/workbench/contrib/void"
	"extensions/theme-v3code"
	"product.json"
)

RG_GLOBS=(
	--glob '!**/node_modules/**'
	--glob '!**/out/**'
	--glob '!**/.git/**'
	--glob '!docs/plans/**'
	--glob '!**/test/**/fixtures/**'
)

build_pattern() {
	local pats=()
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
		pats+=("$line")
	done < "$PATTERNS_FILE"
	local IFS='|'
	echo "${pats[*]}"
}

PATTERN="$(build_pattern)"
if [[ -z "$PATTERN" ]]; then
	echo "No patterns in $PATTERNS_FILE" >&2
	exit 2
fi

echo "==> Brand fingerprint scan"
echo "    root: $ROOT"
echo "    paths: ${SCAN_PATHS[*]}"

EXISTING_PATHS=()
for p in "${SCAN_PATHS[@]}"; do
	if [[ -e "$ROOT/$p" ]]; then
		EXISTING_PATHS+=("$ROOT/$p")
	else
		echo "    (skip missing) $p"
	fi
done

if [[ ${#EXISTING_PATHS[@]} -eq 0 ]]; then
	echo "No scan paths found under $ROOT" >&2
	exit 2
fi

HITS_FILE="$(mktemp -t v3-ip-brand.XXXXXX)"
SCANCODE_OUT=""
LICENSE_HITS_FILE=""
cleanup() {
	rm -f "$HITS_FILE"
	[[ -n "$LICENSE_HITS_FILE" ]] && rm -f "$LICENSE_HITS_FILE"
	# keep scancode json if user asked for --json; otherwise drop temp
	if [[ -n "$SCANCODE_OUT" && -z "$JSON_OUT" ]]; then
		rm -f "$SCANCODE_OUT"
	fi
}
trap cleanup EXIT

RAW_HITS="$(mktemp -t v3-ip-brand-raw.XXXXXX)"
set +e
rg -n -i --no-heading "${RG_GLOBS[@]}" -e "$PATTERN" "${EXISTING_PATHS[@]}" >"$RAW_HITS" 2>/dev/null
RG_RC=$?
set -e

if [[ $RG_RC -eq 2 ]]; then
	echo "rg failed" >&2
	exit 2
fi

# Collapse minified one-liners: keep path:line + truncated snippet (max 160 chars).
python3 - "$RAW_HITS" "$HITS_FILE" <<'PY'
import sys
from pathlib import Path
raw, out = Path(sys.argv[1]), Path(sys.argv[2])
lines = []
for line in raw.read_text(encoding="utf-8", errors="replace").splitlines():
	# path:lineno:rest
	parts = line.split(":", 2)
	if len(parts) < 3:
		lines.append(line[:200])
		continue
	path, lineno, rest = parts[0], parts[1], parts[2]
	snip = rest.strip().replace("\t", " ")
	if len(snip) > 160:
		snip = snip[:157] + "..."
	lines.append(f"{path}:{lineno}: {snip}")
out.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
PY
rm -f "$RAW_HITS"

HIT_COUNT=0
if [[ -s "$HITS_FILE" ]]; then
	HIT_COUNT="$(wc -l <"$HITS_FILE" | tr -d ' ')"
fi

if [[ "$HIT_COUNT" -gt 0 ]]; then
	FAIL=1
	echo "FAIL: $HIT_COUNT brand/fingerprint hit(s):"
	# Group by file for readable console output
	python3 - "$HITS_FILE" <<'PY'
from pathlib import Path
import sys
from collections import defaultdict
rows = Path(sys.argv[1]).read_text().splitlines()
by = defaultdict(list)
for r in rows:
	parts = r.split(":", 2)
	if len(parts) >= 2:
		by[parts[0]].append(r)
	else:
		by["?"].append(r)
for path, items in sorted(by.items(), key=lambda kv: (-len(kv[1]), kv[0])):
	print(f"  {path}  ({len(items)} hit(s))")
	for item in items[:5]:
		print(f"    {item}")
	if len(items) > 5:
		print(f"    ... +{len(items)-5} more in this file")
PY
	echo ""
	echo "Hint: branch chore/rebrand-icube-to-v3 strips icube→v3. Keep CSS+TS atomic."
else
	echo "OK: 0 brand fingerprint hits in ship paths."
fi

LICENSE_SUMMARY="skipped"
LICENSE_HIT_COUNT=0

if [[ "$WITH_SCANCODE" -eq 1 ]]; then
	echo ""
	if ! command -v scancode >/dev/null 2>&1; then
		echo "WARN: --with-scancode set but scancode not on PATH."
		echo "Install:"
		echo "  python3 -m venv .tools/scancode-venv"
		echo "  .tools/scancode-venv/bin/pip install 'scancode-toolkit'"
		echo "  export PATH=\"\$PWD/.tools/scancode-venv/bin:\$PATH\""
		FAIL=1
		LICENSE_SUMMARY="missing-scancode"
	elif [[ ! -f "$FILTER_PY" ]]; then
		echo "Missing $FILTER_PY" >&2
		exit 2
	else
		echo "==> ScanCode license scan (void + theme-v3code)"
		if [[ -n "$JSON_OUT" ]]; then
			mkdir -p "$(dirname "$JSON_OUT")"
			SCANCODE_OUT="${JSON_OUT%.json}.scancode.json"
		else
			SCANCODE_OUT="$(mktemp -t v3-scancode.XXXXXX).json"
		fi
		LICENSE_HITS_FILE="$(mktemp -t v3-license-hits.XXXXXX)"

		# ScanCode expands a multi-path common-root to the whole worktree, so run
		# one rooted path at a time and merge.
		SCAN_PARTS=()
		PART_IDX=0
		for rel in src/vs/workbench/contrib/void extensions/theme-v3code; do
			[[ -d "$ROOT/$rel" ]] || continue
			PART_OUT="${SCANCODE_OUT%.json}.part${PART_IDX}.json"
			PART_IDX=$((PART_IDX + 1))
			echo "    scancode $rel ..."
			(
				cd "$ROOT"
				scancode \
					--license --copyright --info --package \
					--license-text \
					--json-pp "$PART_OUT" \
					--ignore '**/node_modules/**' \
					--ignore '**/out/**' \
					--ignore '*.min.js' \
					"$rel"
			)
			SCAN_PARTS+=("$PART_OUT")
		done

		python3 - "$SCANCODE_OUT" "${SCAN_PARTS[@]}" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
files = []
headers = {}
for p in sys.argv[2:]:
	d = json.loads(Path(p).read_text(encoding="utf-8"))
	if not headers:
		headers = {k: v for k, v in d.items() if k != "files"}
	files.extend(d.get("files") or [])
headers["files"] = files
out.write_text(json.dumps(headers, indent=2) + "\n", encoding="utf-8")
for p in sys.argv[2:]:
	Path(p).unlink(missing_ok=True)
print(f"merged {len(files)} scancode file records -> {out}")
PY

		LICENSE_HIT_COUNT="$(python3 "$FILTER_PY" "$SCANCODE_OUT" "$LICENSE_HITS_FILE")"
		LICENSE_SUMMARY="scanned"

		if [[ "$LICENSE_HIT_COUNT" -gt 0 ]]; then
			FAIL=1
			echo "FAIL: $LICENSE_HIT_COUNT non-permissive license finding(s) (score>=50):"
			head -n 60 "$LICENSE_HITS_FILE"
			if [[ "$LICENSE_HIT_COUNT" -gt 60 ]]; then
				echo "... ($((LICENSE_HIT_COUNT - 60)) more)"
			fi
			echo "Full ScanCode JSON: $SCANCODE_OUT"
		else
			echo "OK: no high-confidence non-permissive licenses in scanned paths."
			echo "Full ScanCode JSON: $SCANCODE_OUT"
		fi
	fi
fi

if [[ -n "$JSON_OUT" ]]; then
	mkdir -p "$(dirname "$JSON_OUT")"
	python3 - "$JSON_OUT" "$HIT_COUNT" "$LICENSE_SUMMARY" "$LICENSE_HIT_COUNT" "$HITS_FILE" "$LICENSE_HITS_FILE" "$ROOT" <<'PY'
import json, sys, pathlib
out, brand_n, lic_sum, lic_n, brand_path, lic_path, root = sys.argv[1:8]
brand_hits = pathlib.Path(brand_path).read_text().splitlines() if int(brand_n) else []
lic_hits = []
if lic_path and pathlib.Path(lic_path).exists():
	lic_hits = pathlib.Path(lic_path).read_text().splitlines()
payload = {
	"root": root,
	"brand_hit_count": int(brand_n),
	"brand_hits": brand_hits[:500],
	"license_summary": lic_sum,
	"license_hit_count": int(lic_n),
	"license_hits": lic_hits[:500],
	"ok": int(brand_n) == 0 and lic_sum in ("skipped", "scanned") and int(lic_n) == 0,
}
pathlib.Path(out).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {out}")
PY
fi

echo ""
if [[ "$FAIL" -ne 0 ]]; then
	echo "RESULT: FAIL (see above)"
	exit 1
fi
echo "RESULT: PASS"
exit 0
