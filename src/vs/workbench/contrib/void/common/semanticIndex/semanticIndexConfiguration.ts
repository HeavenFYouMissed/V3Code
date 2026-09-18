/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { localize } from '../../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'v3code.semanticIndex',
	order: 200,
	title: localize('v3code.semanticIndex.title', 'V3Code Semantic Index'),
	type: 'object',
	properties: {
		'v3code.semanticIndex.enabled': {
			type: 'boolean',
			default: true,
			description: localize('v3code.semanticIndex.enabled', 'Enable the V3Code semantic code index.'),
		},
		'v3code.semanticIndex.autoRebuildOnStartup': {
			type: 'boolean',
			default: true,
			description: localize('v3code.semanticIndex.autoRebuild', 'Rebuild the index automatically when V3Code opens this workspace.'),
		},
		'v3code.semanticIndex.embedModel': {
			type: 'string',
			enum: ['auto', 'qwen3-embed', 'potion-code'],
			enumDescriptions: [
				localize('v3code.semanticIndex.embedModel.auto', 'Qwen3 when its model is already downloaded, otherwise the static code embedder. Machine-dependent: two computers with this same setting can end up running different models.'),
				localize('v3code.semanticIndex.embedModel.qwen3', 'Qwen3-Embedding-0.6B (1024d, ~610MB download, GPU-accelerated via llama.cpp) — best retrieval quality. Needs roughly 16GB of RAM; below that V3Code stays on the static embedder and tells you it did.'),
				localize('v3code.semanticIndex.embedModel.potion', 'Default. minishlab/potion-code-16M (256d static) — code-specialized, near-instant on CPU, runs well on every machine.'),
			],
			// The static embedder is the default on every machine, deliberately. The quality path is a
			// large llama.cpp model whose behaviour varies with RAM, GPU driver, and whether a 610MB
			// download ever completed — so 'auto' quietly produced DIFFERENT engines on different
			// computers with identical settings, and every failure fell back to potion without saying
			// so. Making the safe engine the default and the quality engine an explicit opt-in deletes
			// that entire class of machine-dependent behaviour: everyone gets an index that works, and
			// anyone who asks for Qwen3 is told plainly when it cannot run instead of silently getting
			// potion and wondering why retrieval feels worse than someone else's install.
			default: 'potion-code',
			description: localize('v3code.semanticIndex.embedModel.desc', 'Embedding model used for semantic retrieval. The default runs well on any machine; Qwen3 gives better retrieval on machines with roughly 16GB of RAM or more. Changing this re-embeds the index in the background.'),
		},
		'v3code.semanticIndex.localReranker': {
			type: 'string',
			enum: ['auto', 'on', 'off'],
			enumDescriptions: [
				localize('v3code.semanticIndex.localReranker.auto', 'Use the local cross-encoder when its model (~610MB) is already downloaded; otherwise skip.'),
				localize('v3code.semanticIndex.localReranker.on', 'Always use it — downloads Qwen3-Reranker-0.6B on first search if needed.'),
				localize('v3code.semanticIndex.localReranker.off', 'Never rerank locally.'),
			],
			default: 'off',
			description: localize('v3code.semanticIndex.localReranker.desc', 'EXPERIMENTAL: GPU cross-encoder precision pass (Qwen3-Reranker-0.6B via llama.cpp) that re-reads the top search candidates against the query. Order-only; falls back to fused ranking on any failure. Off by default: running a second llama model beside the embedder in one process can trip the macOS GPU watchdog under sustained load (observed ggml abort) — enable only for testing until reranking moves to an isolated process.'),
		},
		'v3code.semanticIndex.queryExpander': {
			type: 'string',
			enum: ['heuristic', 'local-llama', 'chat-model'],
			enumDescriptions: [
				localize('v3code.semanticIndex.qx.h', 'Identifier extraction only (fastest, no model).'),
				localize('v3code.semanticIndex.qx.l', 'Bundled tiny local model (Qwen2.5-Coder-0.5B). Best quality offline.'),
				localize('v3code.semanticIndex.qx.c', 'Route through the configured V3Code chat model. Higher latency, uses your API quota.'),
			],
			default: 'heuristic',
			description: localize('v3code.semanticIndex.qx.desc', 'Strategy for expanding short prompts into richer retrieval queries (HyDE-style).'),
		},
		'v3code.semanticIndex.exclude': {
			type: 'array',
			items: { type: 'string' },
			default: ['node_modules', '.git', 'out', 'dist', 'build', '.next', '.cache', '.tmp', '.venv', 'venv', '__pycache__', 'target', 'bin', 'obj', '.v3code'],
			description: localize('v3code.semanticIndex.exclude.desc', 'Directory names to skip during indexing.'),
		},
		'v3code.semanticIndex.maxFileSizeKB': {
			type: 'number',
			default: 1024,
			minimum: 1,
			maximum: 4096,
			description: localize('v3code.semanticIndex.maxFile.desc', 'Files larger than this (in KB) are skipped to keep memory bounded.'),
		},
		'v3code.semanticIndex.concurrency': {
			type: 'number',
			default: 4,
			minimum: 1,
			maximum: 8,
			description: localize('v3code.semanticIndex.concurrency.desc', 'Parallel file workers during a rebuild. Higher = faster, lower = lighter on the renderer.'),
		},
		'v3code.semanticIndex.nodeBackend': {
			type: 'boolean',
			default: false,
			description: localize('v3code.semanticIndex.nodeBackend.desc', 'EXPERIMENTAL: Route semantic retrieval through the main-process SQLite engine (FTS5 keyword search + sqlite-vec ANN + query expansion with 4-channel rank fusion). Note: recency boost, dependency-graph neighbor expansion and the cross-branch CAS cache do NOT yet apply on this path; on any backend error or empty result, retrieval falls back to the in-memory index.'),
		},
		'v3code.semanticIndex.lspGraphEdges': {
			type: 'boolean',
			default: true,
			description: localize('v3code.semanticIndex.lspGraphEdges.desc', 'Enrich the dependency graph with REAL edges resolved by the language service (document symbols + references + definitions) instead of relying only on text-derived guesses (~60-70% recall). Runs as a strictly budgeted background pass over files you open, edit, or that surface in retrieval: max 5 symbols per file, 20 files per idle cycle, one pass at a time, with a 250ms pause between files — so language-server cost stays negligible. Turn off to skip all language-service calls from the indexer.'),
		},
		'v3code.semanticIndex.modelDownloadHost': {
			type: 'string',
			default: '',
			description: localize('v3code.semanticIndex.host.desc', 'Optional mirror URL for embedding model downloads (for offline / enterprise environments). Leave blank to use Hugging Face.'),
		},
		'v3code.semanticIndex.beastEnabled': {
			type: 'boolean',
			default: true,
			description: localize('v3code.semanticIndex.beastEnabled.desc', 'Use the beast sidecar (native trigram + symbol index) alongside the semantic index when its binary is installed. Missing binary or any sidecar failure silently disables it — search never breaks.'),
		},
		'v3code.semanticIndex.beastBinaryPath': {
			type: 'string',
			default: '',
			description: localize('v3code.semanticIndex.beastBinaryPath.desc', 'Path to the beast sidecar binary. Leave blank for the default ~/.v3code/bin/beast.'),
		},
		'v3code.semanticIndex.beastFusion': {
			type: 'boolean',
			default: false,
			description: localize('v3code.semanticIndex.beastFusion.desc', 'EXPERIMENTAL: Fuse beast sidecar trigram hits into hybrid retrieval as a 4th ranking channel. Off until the offline golden-set eval shows no per-query regressions and a net win.'),
		},
		'v3code.semanticIndex.beastWeight': {
			type: 'number',
			default: 0.4,
			minimum: 0,
			maximum: 2,
			description: localize('v3code.semanticIndex.beastWeight.desc', 'Fusion weight of the beast channel in hybrid retrieval. Only takes effect once the beast channel joins ranking (eval-gated Phase B); has no effect today.'),
		},
	},
});
