/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/*
 * Adapted from Continue (https://github.com/continuedev/continue), Apache-2.0.
 * Copyright 2023-2026 Continue Dev, Inc. Modifications Copyright 2026 Glass Devtools, Inc.
 */
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Mid-stream filter pipeline for FIM autocomplete output. Ported from Continue's
 * core/autocomplete/filtering/streamTransforms/StreamTransformPipeline.ts, preserving the
 * transform ordering exactly: char-level transforms first, then line split, then line
 * filters, then re-join with newlines.
 */

import {
	avoidEmptyComments,
	avoidPathLine,
	noDoubleNewLine,
	showWhateverWeHaveAtXMs,
	skipPrefixes,
	stopAtLines,
	stopAtLinesExact,
	stopAtRepeatingLines,
	stopAtSimilarLine,
	stopAtStartOf,
	stopAtStopTokens,
	streamLines,
	streamWithNewLines,
} from './autocompleteStreamTransforms.js';
import { StreamFilterOptions } from './autocompleteTypes.js';

/** If the model starts echoing a git diff header, it has stopped completing code. */
const STOP_AT_PATTERNS = ['diff --git'];

/** Options for a single pipeline run. */
export interface StreamPipelineOptions extends StreamFilterOptions {
	/** Workspace-relative path of the file being completed. */
	filepath: string;
	/**
	 * Full stop means to stop the LLM's generation, instead of just truncating the
	 * displayed completion.
	 */
	fullStop: () => void;
}

export class AutocompleteStreamPipeline {

	async *transform(
		generator: AsyncGenerator<string>,
		opts: StreamPipelineOptions,
	): AsyncGenerator<string> {
		const { suffix, stopTokens, commentPrefix, fullStop } = opts;

		let charGenerator = generator;

		charGenerator = stopAtStopTokens(generator, [
			...stopTokens,
			...STOP_AT_PATTERNS,
		]);
		charGenerator = stopAtStartOf(charGenerator, suffix);

		let lineGenerator = streamLines(charGenerator);

		lineGenerator = stopAtLines(lineGenerator, fullStop);
		const lineBelowCursor = this.getLineBelowCursor(suffix);
		if (lineBelowCursor.trim() !== '') {
			lineGenerator = stopAtLinesExact(lineGenerator, fullStop, [lineBelowCursor]);
		}
		lineGenerator = stopAtRepeatingLines(lineGenerator, fullStop);
		lineGenerator = avoidEmptyComments(lineGenerator, commentPrefix);
		lineGenerator = avoidPathLine(lineGenerator, commentPrefix);
		lineGenerator = skipPrefixes(lineGenerator);
		lineGenerator = noDoubleNewLine(lineGenerator);

		lineGenerator = stopAtSimilarLine(lineGenerator, lineBelowCursor, fullStop);

		// Continue always applies this with the model timeout; here 0/undefined disables it.
		if (opts.showWhateverWeHaveAtMs) {
			lineGenerator = showWhateverWeHaveAtXMs(lineGenerator, opts.showWhateverWeHaveAtMs);
		}

		const finalGenerator = streamWithNewLines(lineGenerator);
		for await (const update of finalGenerator) {
			yield update;
		}
	}

	/**
	 * First non-blank line strictly below the cursor. Continue derives this from the open
	 * editor's file lines; the suffix is exactly the file text after the cursor, so
	 * everything past the suffix's first '\n' is the lines below the cursor.
	 */
	private getLineBelowCursor(suffix: string): string {
		const suffixLines = suffix.split('\n');
		for (let i = 1; i < suffixLines.length; i++) {
			if (suffixLines[i].trim() !== '') {
				return suffixLines[i];
			}
		}
		return '';
	}
}

/**
 * Runs the full pipeline over already-complete text by wrapping it as a single-chunk
 * stream and collecting the output — the non-streaming fallback path.
 */
export async function runPipelineOnFullText(
	text: string,
	opts: StreamPipelineOptions,
): Promise<string> {
	const singleChunkStream = async function* (): AsyncGenerator<string> {
		yield text;
	};

	const pipeline = new AutocompleteStreamPipeline();
	let result = '';
	for await (const chunk of pipeline.transform(singleChunkStream(), opts)) {
		result += chunk;
	}
	return result;
}
