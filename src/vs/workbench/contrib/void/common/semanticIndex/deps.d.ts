/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Type shims for runtime-only dependencies of the semantic index.
 *
 * These packages are loaded dynamically at runtime and may not be installed at
 * compile time. The shapes here are the minimum we touch — replace with proper
 * `@types/...` packages once the deps are committed.
 *
 *   npm install -E sqlite-vec @xenova/transformers web-tree-sitter node-llama-cpp
 *
 * Until then, the `as any` cast at each dynamic-import site combined with these
 * declarations keeps the rest of the codebase strongly typed without forcing a
 * `npm install` before compilation succeeds.
 */

declare module 'sqlite-vec' {
	/** Loads the sqlite-vec extension into a `@vscode/sqlite3` Database instance. */
	export function load(db: unknown): void;
}

declare module '@xenova/transformers' {
	export interface PipelineOutput {
		data: Float32Array | number[];
		dims: number[];
	}

	export type FeatureExtractionPipeline = (
		texts: string | string[],
		options?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean }
	) => Promise<PipelineOutput>;

	export interface TransformersEnv {
		localModelPath?: string;
		allowRemoteModels?: boolean;
		cacheDir?: string;
		backends?: { onnx?: { wasm?: { numThreads?: number } } };
	}

	export const env: TransformersEnv;

	export function pipeline(
		task: 'feature-extraction',
		modelId: string,
		options?: { quantized?: boolean; cache_dir?: string }
	): Promise<FeatureExtractionPipeline>;
}

declare module 'node-llama-cpp' {
	export class LlamaModel {
		constructor(options: { modelPath: string; gpuLayers?: number });
	}
	export class LlamaContext {
		constructor(options: { model: LlamaModel; contextSize?: number });
	}
	export class LlamaChatSession {
		constructor(options: { context: LlamaContext; systemPrompt?: string });
		prompt(text: string, options?: { temperature?: number; maxTokens?: number }): Promise<string>;
	}
}

