#!/usr/bin/env python3
"""Filter a ScanCode JSON report for non-permissive license hits.

Prints the hit count to stdout. Writes TSV lines to the hits path arg:
  path<TAB>license<TAB>category<TAB>score=N
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

DENY = re.compile(
	r"(Copyleft|Proprietary|Commercial|Source-available|Patent License|Free Restricted)",
	re.I,
)
ALLOW = {
	"mit",
	"apache-2.0",
	"apache-1.1",
	"bsd-2-clause",
	"bsd-3-clause",
	"bsd-new",
	"bsd-simplified",
	"isc",
	"cc0-1.0",
	"unlicense",
	"0bsd",
	"wtfpl",
	"python",
	"psf-2.0",
	"zlib",
	"boost-1.0",
	"mpl-2.0",
	"unicode",
	"unicode-dfs-2016",
	"cc-by-4.0",  # docs/data often; review manually if in runtime code
}


def allowed(key: str) -> bool:
	k = (key or "").lower().strip()
	if not k:
		return False
	if k in ALLOW:
		return True
	# expressions like "mit AND apache-2.0"
	parts = re.split(r"\s+(?:and|or|with)\s+|[()]", k)
	parts = [p.strip() for p in parts if p and p.strip()]
	if parts and all(p in ALLOW for p in parts):
		return True
	return False


def main() -> int:
	if len(sys.argv) != 3:
		print("usage: filter-scancode.py <scancode.json> <hits.tsv>", file=sys.stderr)
		return 2
	out_path = Path(sys.argv[1])
	hits_path = Path(sys.argv[2])
	data = json.loads(out_path.read_text(encoding="utf-8"))

	hits: list[tuple[str, str, str, float]] = []
	for f in data.get("files") or []:
		path = f.get("path") or "?"
		# ScanCode 32+ shape
		for lic in f.get("license_detections") or []:
			for m in lic.get("matches") or []:
				key = (m.get("license_expression") or m.get("key") or "").lower()
				score = float(m.get("score") or 0)
				cat = m.get("category") or ""
				for rule in m.get("rule_licenses") or []:
					cat = rule.get("category") or cat
				if allowed(key):
					continue
				if DENY.search(str(cat)) or DENY.search(key):
					if score and score < 50:
						continue
					hits.append((path, key, str(cat), score))
		# Older shape
		for lic in f.get("licenses") or []:
			key = (lic.get("key") or lic.get("spdx_license_key") or "").lower()
			cat = lic.get("category") or ""
			score = float(lic.get("score") or 0)
			if allowed(key):
				continue
			if DENY.search(str(cat)) or DENY.search(key):
				if score and score < 50:
					continue
				hits.append((path, key, str(cat), score))

	seen: set[tuple[str, str]] = set()
	uniq: list[tuple[str, str, str, float]] = []
	for h in hits:
		k = (h[0], h[1])
		if k in seen:
			continue
		seen.add(k)
		uniq.append(h)

	hits_path.write_text(
		"".join(f"{p}\t{lic}\t{cat}\tscore={score}\n" for p, lic, cat, score in uniq),
		encoding="utf-8",
	)
	print(len(uniq))
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
