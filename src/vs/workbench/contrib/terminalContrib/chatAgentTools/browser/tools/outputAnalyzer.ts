/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

export interface IOutputAnalyzerOptions {
	readonly exitCode: number | undefined;
	readonly exitResult: string;
	readonly commandLine: string;
	readonly isSandboxWrapped: boolean;
}

export interface IOutputAnalyzer {
	analyze(options: IOutputAnalyzerOptions): Promise<string | undefined>;
}
