#!/usr/bin/env bash
# V3Code release-source gate. Run before either platform is allowed to sign.
# Keep the focused list here so local macOS and Windows CI cannot drift apart.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
	echo "release-source-gate: source tree is dirty; freeze and commit the candidate before running release evidence." >&2
	git status --short >&2
	exit 1
fi

PINNED_NODE_MAJOR="$(tr -d 'v[:space:]' < .nvmrc | cut -d. -f1)"
ACTIVE_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$ACTIVE_NODE_MAJOR" != "$PINNED_NODE_MAJOR" ]; then
	echo "release-source-gate: Node $ACTIVE_NODE_MAJOR is active, but .nvmrc requires Node $PINNED_NODE_MAJOR." >&2
	echo "Use the pinned Node runtime before building or signing." >&2
	exit 1
fi

echo "==> Release source gate: artifact manifest parity"
node build/verify/verify-package.mjs --parity

echo "==> Release source gate: MCP package assertions match current settings"
node --test build/verify/mcp-package-contract.test.mjs

echo "==> Release source gate: Google SDK package entry matches the pinned dependency"
node --test build/verify/google-genai-package-contract.test.mjs

echo "==> Release source gate: Mac source archives cannot reach notarization"
node --test build/verify/mac-package-script.test.mjs

echo "==> Release source gate: Linux package path and smoke isolation (skips on non-Linux hosts)"
node --test build/verify/linux-package-script.test.mjs

echo "==> Release source gate: generated React hosts"
npm run buildreact

echo "==> Release source gate: native TypeScript contracts"
npm run compile-check-ts-native

echo "==> Release source gate: compiled test output"
npm run compile-client

echo "==> Release source gate: MCP discovery/auth and provider schema tests"
node test/unit/node/index.js \
	--run src/vs/workbench/contrib/mcp/test/common/v3codeMcpDiscoveryAdapter.test.ts \
	--run src/vs/workbench/contrib/void/test/electron-main/v3codeMcpServerAuth.test.ts \
	--run src/vs/workbench/contrib/void/test/node/v3codeMcpAuth.test.ts \
	--run src/vs/workbench/contrib/void/test/node/geminiToolSchema.test.ts \
	--run src/vs/workbench/contrib/void/test/common/openAICompatibleTool.test.ts \
	--run src/vs/workbench/contrib/void/test/browser/toolsRegistryDrift.test.ts

echo "==> Release source gate: 0097 compaction, task authority, provider, and prompt regressions"
node test/unit/node/index.js \
	--run src/vs/workbench/contrib/void/test/common/compactionBoundarySqliteSmoke.test.ts \
	--run src/vs/workbench/contrib/void/test/common/sessionStateSqliteSmoke.test.ts \
	--run src/vs/workbench/contrib/void/test/common/memoryCompaction.test.ts \
	--run src/vs/workbench/contrib/void/test/common/condenseMiddle.test.ts \
	--run src/vs/workbench/contrib/void/test/common/digestIntegrityPolicy.test.ts \
	--run src/vs/workbench/contrib/void/test/common/durableTask.test.ts \
	--run src/vs/workbench/contrib/void/test/common/uniqueToolNames.test.ts \
	--run src/vs/workbench/contrib/void/test/common/planModeTools.test.ts \
	--run src/vs/workbench/contrib/void/test/common/v3codeFreeRouteManifest.test.ts \
	--run src/vs/workbench/contrib/void/test/common/cursorLocalModels.test.ts \
	--run src/vs/workbench/contrib/void/test/common/openaiPlanModels.test.ts \
	--run src/vs/workbench/contrib/void/test/common/promptAssemblyProfiles.test.ts \
	--run src/vs/workbench/contrib/void/test/common/subagentPolicy.test.ts

echo "==> Release source gate PASS"
