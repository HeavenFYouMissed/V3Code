#!/usr/bin/env bash

# V3Index feature-branch release gate.
#
# This validates source, Worker behavior, focused editor integration, and the
# immutable real-Qwen quality baseline. It deliberately does not launch V3Code,
# deploy Cloudflare resources, apply Supabase migrations, merge, push, package,
# sign, or publish.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

printf '%s\n' '[v3index-gate] Worker typecheck'
npm --prefix cloud/v3index run typecheck

printf '%s\n' '[v3index-gate] Worker integration suite'
# CI also makes accidental credential prompts fatal/non-interactive. The Worker
# suite itself uses wrangler.test.jsonc, which has no account or remote bindings.
CI=1 npm --prefix cloud/v3index test -- --reporter=dot

printf '%s\n' '[v3index-gate] Native TypeScript'
npm run compile-check-ts-native

printf '%s\n' '[v3index-gate] React assets'
npm run buildreact

printf '%s\n' '[v3index-gate] Full client compilation'
npm run gulp compile-client

printf '%s\n' '[v3index-gate] Focused editor integration tests'
./node_modules/.bin/mocha \
	--ui tdd \
	--timeout 10000 \
	--exit \
	out/vs/workbench/contrib/void/test/common/cloudIndexConfiguration.test.js \
	out/vs/workbench/contrib/void/test/browser/cloudIndexSyncer.test.js \
	out/vs/workbench/contrib/void/test/common/cloudIndexRepositoryIdentity.test.js \
	out/vs/workbench/contrib/void/test/common/federatedIndex.test.js \
	out/vs/workbench/contrib/void/test/common/llamaEmbedderPure.test.js

printf '%s\n' '[v3index-gate] Immutable real-Qwen retrieval gate'
node scripts/retrieval-eval/run-eval.mjs \
	--embedder qwen \
	--max-files 800 \
	--goldset docs/v3index-beast-packet/eval/golden-vselite-v2.jsonl \
	--configs +headers \
	--baseline scripts/retrieval-eval/baselines/golden-vselite-v2_qwen-hdr2_800-files_advanced-profile_2026-07-31.json \
	--release-gate

printf '%s\n' '[v3index-gate] PASS'
