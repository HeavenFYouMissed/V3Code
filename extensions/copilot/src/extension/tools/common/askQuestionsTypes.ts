/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

/**
 * Shared types for the core `vscode_askQuestions` tool responses.
 * Used by any consumer that invokes the tool and needs to parse its result.
 */

export interface IQuestionAnswer {
	selected: string[];
	freeText: string | null;
	skipped: boolean;
}

export interface IAnswerResult {
	answers: Record<string, IQuestionAnswer>;
}
