/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { InlineCompletion, } from '../../../../editor/common/languages.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';

/**
 * URI schemes autocomplete may fire in — real editable files only.
 *
 * Everything else (chat composers, output, debug console, search editors, previews, custom input
 * widgets) is a Monaco model the user is not writing code into, and completing there is noise.
 */
const AUTOCOMPLETE_ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
	Schemas.file,
	Schemas.vscodeRemote,
	Schemas.untitled,
	Schemas.vscodeNotebookCell,
	Schemas.vscodeUserData,
]);
import { EditorResourceAccessor } from '../../../common/editor.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { extractCodeFromRegular } from '../common/helpers/extractCodeFromResult.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { isWindows } from '../../../../base/common/platform.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { FeatureName } from '../common/voidSettingsTypes.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { ISemanticIndexService, Hit } from '../common/semanticIndex/semanticIndexTypes.js';
import { FIMRepoContext, FIMRepoContextFile } from '../common/helpers/fimRepoContext.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Schemas } from '../../../../base/common/network.js';
import { AutocompleteDebouncer } from '../common/autocomplete/autocompleteDebouncer.js';
import { AutocompleteStreamPipeline } from '../common/autocomplete/autocompleteStreamPipeline.js';
import { postprocessCompletion } from '../common/autocomplete/autocompletePostprocessing.js';
import { shouldCompleteMultiline, getSingleLineCommentPrefix } from '../common/autocomplete/autocompleteMultiline.js';
import { renderFimPrompt } from '../common/autocomplete/autocompleteTemplating.js';
import { AutocompleteCodeSnippet, AutocompleteSnippetType } from '../common/autocomplete/autocompleteTypes.js';
import { workspaceIndexPath } from '../common/semanticIndex/workspaceIndexPath.js';
// import { IContextGatheringService } from './contextGatheringService.js';



const allLinebreakSymbols = ['\r\n', '\n']
const _ln = isWindows ? allLinebreakSymbols[0] : allLinebreakSymbols[1]

// The extension this was called from is here - https://github.com/voideditor/void/blob/autocomplete/extensions/void/src/extension/extension.ts
// Pipeline stages (templating, stream filtering, postprocessing, multiline, debounce) are ports
// from Continue (github.com/continuedev/continue, Apache-2.0) living in common/autocomplete/.


/*
A summary of autotab:

Postprocessing
-one common problem for all models is outputting unbalanced parentheses
we solve this by trimming all extra closing parentheses from the generated string
in future, should make sure parentheses are always balanced

-another problem is completing the middle of a string, eg. "const [x, CURSOR] = useState()"
we complete up to first matchup character
but should instead complete the whole line / block (difficult because of parenthesis accuracy)

-too much info is bad. usually we want to show the user 1 line, and have a preloaded response afterwards
this should happen automatically with caching system
should break preloaded responses into \n\n chunks

Preprocessing
- we don't generate if cursor is at end / beginning of a line (no spaces)
- we generate 1 line if there is text to the right of cursor
- we generate 1 line if variable declaration
- (in many cases want to show 1 line but generate multiple)

State
- cache based on prefix (and do some trimming first)
- when press tab on one line, should have an immediate followup response
to do this, show autocompletes before they're fully finished
- [todo] remove each autotab when accepted
!- [todo] provide type information

Details
-generated results are trimmed up to 1 leading/trailing space
-prefixes are cached up to 1 trailing newline
-
*/

class LRUCache<K, V> {
	public items: Map<K, V>;
	private keyOrder: K[];
	private maxSize: number;
	private disposeCallback?: (value: V, key?: K) => void;

	constructor(maxSize: number, disposeCallback?: (value: V, key?: K) => void) {
		if (maxSize <= 0) throw new Error('Cache size must be greater than 0');

		this.items = new Map();
		this.keyOrder = [];
		this.maxSize = maxSize;
		this.disposeCallback = disposeCallback;
	}

	set(key: K, value: V): void {
		// If key exists, remove it from the order list
		if (this.items.has(key)) {
			this.keyOrder = this.keyOrder.filter(k => k !== key);
		}
		// If cache is full, remove least recently used item
		else if (this.items.size >= this.maxSize) {
			const key = this.keyOrder[0];
			const value = this.items.get(key);

			// Call dispose callback if it exists
			if (this.disposeCallback && value !== undefined) {
				this.disposeCallback(value, key);
			}

			this.items.delete(key);
			this.keyOrder.shift();
		}

		// Add new item
		this.items.set(key, value);
		this.keyOrder.push(key);
	}

	delete(key: K): boolean {
		const value = this.items.get(key);

		if (value !== undefined) {
			// Call dispose callback if it exists
			if (this.disposeCallback) {
				this.disposeCallback(value, key);
			}

			this.items.delete(key);
			this.keyOrder = this.keyOrder.filter(k => k !== key);
			return true;
		}

		return false;
	}

	clear(): void {
		// Call dispose callback for all items if it exists
		if (this.disposeCallback) {
			for (const [key, value] of this.items.entries()) {
				this.disposeCallback(value, key);
			}
		}

		this.items.clear();
		this.keyOrder = [];
	}

	get size(): number {
		return this.items.size;
	}

	has(key: K): boolean {
		return this.items.has(key);
	}
}

type AutocompletionPredictionType =
	| 'single-line-fill-middle'
	| 'single-line-redo-suffix'
	| 'multi-line-start-here'
	| 'multi-line-start-on-next-line'
	| 'do-not-predict'

type Autocompletion = {
	id: number,
	prefix: string,
	suffix: string,
	llmPrefix: string,
	llmSuffix: string,
	startTime: number,
	endTime: number | undefined,
	status: 'pending' | 'finished' | 'error',
	type: AutocompletionPredictionType,
	llmPromise: Promise<string> | undefined,
	insertText: string,
	requestId: string | null,
	_newlineCount: number,
}

const DEBOUNCE_TIME = 300
const TIMEOUT_TIME = 60000
const MAX_CACHE_SIZE = 20
const MAX_PENDING_REQUESTS = 2
// Hard cap on the semantic-index query so a cold/slow index never blocks a completion
// (matches the tabtab packet sec.6; was 120ms with a comment claiming 150).
const REPO_CONTEXT_TIMEOUT_MS = 150
// Providers whose FIM endpoint benefits from a client-rendered, model-specific FIM prompt
// (their raw/legacy completions can't be trusted to assemble FIM server-side — LM Studio and
// vLLM ignore `suffix` entirely). Mistral has a real server-side FIM API and the built-in
// local engine renders Qwen special tokens itself, so both keep the native prefix/suffix path.
const RENDERED_PROMPT_PROVIDERS = new Set(['openAICompatible', 'openAICompatible2', 'openAICompatible3', 'openRouter', 'vLLM', 'lmStudio', 'liteLLM', 'ollama'])

const isAbortedAutocomplete = (e: unknown): boolean => String(e ?? '').includes('Aborted autocomplete')

// postprocesses the result
const processStartAndEndSpaces = (result: string) => {

	// trim all whitespace except for a single leading/trailing space
	// return result.trim()

	[result,] = extractCodeFromRegular({ text: result, recentlyAddedTextLen: result.length })

	const hasLeadingSpace = result.startsWith(' ');
	const hasTrailingSpace = result.endsWith(' ');

	return (hasLeadingSpace ? ' ' : '')
		+ result.trim()
		+ (hasTrailingSpace ? ' ' : '');

}


// trims the end of the prefix to improve cache hit rate
const removeLeftTabsAndTrimEnds = (s: string): string => {
	const trimmedString = s.trimEnd();
	const trailingEnd = s.slice(trimmedString.length);

	// keep only a single trailing newline
	if (trailingEnd.includes(_ln)) {
		s = trimmedString + _ln;
	}

	s = s.replace(/^\s+/gm, ''); // remove left tabs

	return s;
}



const removeAllWhitespace = (str: string): string => str.replace(/\s+/g, '');



function getIsSubsequence({ of, subsequence }: { of: string, subsequence: string }): [boolean, string] {
	if (subsequence.length === 0) return [true, ''];
	if (of.length === 0) return [false, ''];

	let subsequenceIndex = 0;
	let lastMatchChar = '';

	for (let i = 0; i < of.length; i++) {
		if (of[i] === subsequence[subsequenceIndex]) {
			lastMatchChar = of[i];
			subsequenceIndex++;
		}
		if (subsequenceIndex === subsequence.length) {
			return [true, lastMatchChar];
		}
	}

	return [false, lastMatchChar];
}


function getStringUpToUnbalancedClosingParenthesis(s: string, prefix: string): string {

	const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };

	// process all bracets in prefix
	let stack: string[] = []
	const firstOpenIdx = prefix.search(/[[({]/);
	if (firstOpenIdx !== -1) {
		const brackets = prefix.slice(firstOpenIdx).split('').filter(c => '()[]{}'.includes(c));

		for (const bracket of brackets) {
			if (bracket === '(' || bracket === '{' || bracket === '[') {
				stack.push(bracket);
			} else {
				if (stack.length > 0 && stack[stack.length - 1] === pairs[bracket]) {
					stack.pop();
				} else {
					stack.push(bracket);
				}
			}
		}
	}

	// iterate through each character
	for (let i = 0; i < s.length; i++) {
		const char = s[i];

		if (char === '(' || char === '{' || char === '[') { stack.push(char); }
		else if (char === ')' || char === '}' || char === ']') {
			if (stack.length === 0 || stack.pop() !== pairs[char]) { return s.substring(0, i); }
		}
	}
	return s;
}


// further trim the autocompletion
const postprocessAutocompletion = ({ autocompletionMatchup, autocompletion, prefixAndSuffix }: { autocompletionMatchup: AutocompletionMatchupBounds, autocompletion: Autocompletion, prefixAndSuffix: PrefixAndSuffixInfo }) => {

	const { prefix, prefixToTheLeftOfCursor, suffixToTheRightOfCursor } = prefixAndSuffix

	const generatedMiddle = autocompletion.insertText

	let startIdx = autocompletionMatchup.startIdx
	let endIdx = generatedMiddle.length // exclusive bounds

	// const naiveReturnValue = generatedMiddle.slice(startIdx)
	// console.log('naiveReturnValue: ', JSON.stringify(naiveReturnValue))
	// return [{ insertText: naiveReturnValue, }]

	// do postprocessing for better ux
	// this is a bit hacky but may change a lot

	// if there is space at the start of the completion and user has added it, remove it
	const charToLeftOfCursor = prefixToTheLeftOfCursor.slice(-1)[0] || ''
	const userHasAddedASpace = charToLeftOfCursor === ' ' || charToLeftOfCursor === '\t'
	const rawFirstNonspaceIdx = generatedMiddle.slice(startIdx).search(/[^\t ]/)
	if (rawFirstNonspaceIdx > -1 && userHasAddedASpace) {
		const firstNonspaceIdx = rawFirstNonspaceIdx + startIdx;
		// console.log('p0', startIdx, rawFirstNonspaceIdx)
		startIdx = Math.max(startIdx, firstNonspaceIdx)
	}

	// if user is on a blank line and the generation starts with newline(s), remove them
	const numStartingNewlines = generatedMiddle.slice(startIdx).match(new RegExp(`^${_ln}+`))?.[0].length || 0;
	if (
		!prefixToTheLeftOfCursor.trim()
		&& !suffixToTheRightOfCursor.trim()
		&& numStartingNewlines > 0
	) {
		// console.log('p1', numStartingNewlines)
		startIdx += numStartingNewlines
	}

	// if the generated FIM text matches with the suffix on the current line, stop
	if (autocompletion.type === 'single-line-fill-middle' && suffixToTheRightOfCursor.trim()) { // completing in the middle of a line
		// complete until there is a match
		const rawMatchIndex = generatedMiddle.slice(startIdx).lastIndexOf(suffixToTheRightOfCursor.trim()[0])
		if (rawMatchIndex > -1) {
			// console.log('p2', rawMatchIndex, startIdx, suffixToTheRightOfCursor.trim()[0], 'AAA', generatedMiddle.slice(startIdx))
			const matchIdx = rawMatchIndex + startIdx;
			const matchChar = generatedMiddle[matchIdx]
			if (`{}()[]<>\`'"`.includes(matchChar)) {
				endIdx = Math.min(endIdx, matchIdx)
			}
		}
	}

	const restOfLineToGenerate = generatedMiddle.slice(startIdx).split(_ln)[0] ?? ''
	// condition to complete as a single line completion
	if (
		prefixToTheLeftOfCursor.trim()
		&& !suffixToTheRightOfCursor.trim()
		&& restOfLineToGenerate.trim()
	) {

		const rawNewlineIdx = generatedMiddle.slice(startIdx).indexOf(_ln)
		if (rawNewlineIdx > -1) {
			// console.log('p3', startIdx, rawNewlineIdx)
			const newlineIdx = rawNewlineIdx + startIdx;
			endIdx = Math.min(endIdx, newlineIdx)
		}
	}

	// // if a generated line matches with a suffix line, stop
	// if (suffixLines.length > 1) {
	// 	console.log('4')
	// 	const lines = []
	// 	for (const generatedLine of generatedLines) {
	// 		if (suffixLines.slice(0, 10).some(suffixLine =>
	// 			generatedLine.trim() !== '' && suffixLine.trim() !== ''
	// 			&& generatedLine.trim().startsWith(suffixLine.trim())
	// 		)) break;
	// 		lines.push(generatedLine)
	// 	}
	// 	endIdx = lines.join('\n').length // this is hacky, remove or refactor in future
	// }

	// console.log('pFinal', startIdx, endIdx)
	let completionStr = generatedMiddle.slice(startIdx, endIdx)

	// filter out unbalanced parentheses
	completionStr = getStringUpToUnbalancedClosingParenthesis(completionStr, prefix)
	// console.log('originalCompletionStr: ', JSON.stringify(generatedMiddle.slice(startIdx)))
	// console.log('finalCompletionStr: ', JSON.stringify(completionStr))


	return completionStr

}

// returns the text in the autocompletion to display, assuming the prefix is already matched
const toInlineCompletions = ({ autocompletionMatchup, autocompletion, prefixAndSuffix, position, debug }: { autocompletionMatchup: AutocompletionMatchupBounds, autocompletion: Autocompletion, prefixAndSuffix: PrefixAndSuffixInfo, position: Position, debug?: boolean }): { insertText: string, range: Range }[] => {

	let trimmedInsertText = postprocessAutocompletion({ autocompletionMatchup, autocompletion, prefixAndSuffix, })
	let rangeToReplace: Range = new Range(position.lineNumber, position.column, position.lineNumber, position.column)

	// handle special cases

	// if we redid the suffix, replace the suffix
	if (autocompletion.type === 'single-line-redo-suffix') {

		const oldSuffix = prefixAndSuffix.suffixToTheRightOfCursor
		const newSuffix = autocompletion.insertText

		const [isSubsequence, lastMatchingChar] = getIsSubsequence({ // check that the old text contains the same brackets + symbols as the new text
			subsequence: removeAllWhitespace(oldSuffix), // old suffix
			of: removeAllWhitespace(newSuffix), // new suffix
		})
		if (isSubsequence) {
			rangeToReplace = new Range(position.lineNumber, position.column, position.lineNumber, Number.MAX_SAFE_INTEGER)
		}
		else {

			const lastMatchupIdx = trimmedInsertText.lastIndexOf(lastMatchingChar)
			trimmedInsertText = trimmedInsertText.slice(0, lastMatchupIdx + 1)
			const numCharsToReplace = oldSuffix.lastIndexOf(lastMatchingChar) + 1
			rangeToReplace = new Range(position.lineNumber, position.column, position.lineNumber, position.column + numCharsToReplace)
			// console.log('show____', trimmedInsertText, rangeToReplace)
		}
	}

	return [{
		insertText: trimmedInsertText,
		range: rangeToReplace,
	}]

}





// returns whether this autocompletion is in the cache
// const doesPrefixMatchAutocompletion = ({ prefix, autocompletion }: { prefix: string, autocompletion: Autocompletion }): boolean => {

// 	const originalPrefix = autocompletion.prefix
// 	const generatedMiddle = autocompletion.result
// 	const originalPrefixTrimmed = trimPrefix(originalPrefix)
// 	const currentPrefixTrimmed = trimPrefix(prefix)

// 	if (currentPrefixTrimmed.length < originalPrefixTrimmed.length) {
// 		return false
// 	}

// 	const isMatch = (originalPrefixTrimmed + generatedMiddle).startsWith(currentPrefixTrimmed)
// 	return isMatch

// }


type PrefixAndSuffixInfo = { prefix: string, suffix: string, prefixLines: string[], suffixLines: string[], prefixToTheLeftOfCursor: string, suffixToTheRightOfCursor: string }
const getPrefixAndSuffixInfo = (model: ITextModel, position: Position): PrefixAndSuffixInfo => {

	const fullText = model.getValue(EndOfLinePreference.LF);

	const cursorOffset = model.getOffsetAt(position)
	const prefix = fullText.substring(0, cursorOffset)
	const suffix = fullText.substring(cursorOffset)


	const prefixLines = prefix.split(_ln)
	const suffixLines = suffix.split(_ln)

	const prefixToTheLeftOfCursor = prefixLines.slice(-1)[0] ?? ''
	const suffixToTheRightOfCursor = suffixLines[0] ?? ''

	return { prefix, suffix, prefixLines, suffixLines, prefixToTheLeftOfCursor, suffixToTheRightOfCursor }

}

const getIndex = (str: string, line: number, char: number) => {
	return str.split(_ln).slice(0, line).join(_ln).length + (line > 0 ? 1 : 0) + char;
}
const getLastLine = (s: string): string => {
	const matches = s.match(new RegExp(`[^${_ln}]*$`))
	return matches ? matches[0] : ''
}

type AutocompletionMatchupBounds = {
	startLine: number,
	startCharacter: number,
	startIdx: number,
}
// returns the startIdx of the match if there is a match, or undefined if there is no match
// all results are wrt `autocompletion.result`
const getAutocompletionMatchup = ({ prefix, autocompletion }: { prefix: string, autocompletion: Autocompletion }): AutocompletionMatchupBounds | undefined => {

	const trimmedCurrentPrefix = removeLeftTabsAndTrimEnds(prefix)
	const trimmedCompletionPrefix = removeLeftTabsAndTrimEnds(autocompletion.prefix)
	const trimmedCompletionMiddle = removeLeftTabsAndTrimEnds(autocompletion.insertText)

	// console.log('@result: ', JSON.stringify(autocompletion.insertText))
	// console.log('@trimmedCurrentPrefix: ', JSON.stringify(trimmedCurrentPrefix))
	// console.log('@trimmedCompletionPrefix: ', JSON.stringify(trimmedCompletionPrefix))
	// console.log('@trimmedCompletionMiddle: ', JSON.stringify(trimmedCompletionMiddle))

	if (trimmedCurrentPrefix.length < trimmedCompletionPrefix.length) { // user must write text beyond the original prefix at generation time
		// console.log('@undefined1')
		return undefined
	}

	if ( // check that completion starts with the prefix
		!(trimmedCompletionPrefix + trimmedCompletionMiddle)
			.startsWith(trimmedCurrentPrefix)
	) {
		// console.log('@undefined2')
		return undefined
	}

	// reverse map to find position wrt `autocompletion.result`
	const lineStart =
		trimmedCurrentPrefix.split(_ln).length -
		trimmedCompletionPrefix.split(_ln).length;

	if (lineStart < 0) {
		// console.log('@undefined3')

		console.error('Error: No line found.');
		return undefined;
	}
	const currentPrefixLine = getLastLine(trimmedCurrentPrefix)
	const completionPrefixLine = lineStart === 0 ? getLastLine(trimmedCompletionPrefix) : ''
	const completionMiddleLine = autocompletion.insertText.split(_ln)[lineStart]
	const fullCompletionLine = completionPrefixLine + completionMiddleLine

	// console.log('currentPrefixLine', currentPrefixLine)
	// console.log('completionPrefixLine', completionPrefixLine)
	// console.log('completionMiddleLine', completionMiddleLine)

	const charMatchIdx = fullCompletionLine.indexOf(currentPrefixLine)
	if (charMatchIdx < 0) {
		// console.log('@undefined4', charMatchIdx)

		console.error('Warning: Found character with negative index. This should never happen.')
		return undefined
	}

	const character = (charMatchIdx +
		currentPrefixLine.length
		- completionPrefixLine.length
	)

	const startIdx = getIndex(autocompletion.insertText, lineStart, character)

	return {
		startLine: lineStart,
		startCharacter: character,
		startIdx,
	}


}


type CompletionOptions = {
	predictionType: AutocompletionPredictionType,
	shouldGenerate: boolean,
	llmPrefix: string,
	llmSuffix: string,
	stopTokens: string[],
	maxTokens: number,
}
const getCompletionOptions = (prefixAndSuffix: PrefixAndSuffixInfo, justAcceptedAutocompletion: boolean, multilineAllowed: boolean): CompletionOptions => {

	let { prefix, suffix, prefixToTheLeftOfCursor, suffixToTheRightOfCursor, suffixLines, prefixLines } = prefixAndSuffix

	// trim prefix and suffix to not be very large
	suffixLines = suffix.split(_ln).slice(0, 25)
	prefixLines = prefix.split(_ln).slice(-25)
	prefix = prefixLines.join(_ln)
	suffix = suffixLines.join(_ln)

	let completionOptions: CompletionOptions

	// if line is empty, do multiline completion
	const isLineEmpty = !prefixToTheLeftOfCursor.trim() && !suffixToTheRightOfCursor.trim()
	const isLinePrefixEmpty = removeAllWhitespace(prefixToTheLeftOfCursor).length === 0
	const isLineSuffixEmpty = removeAllWhitespace(suffixToTheRightOfCursor).length === 0

	// if we just accepted an autocompletion, predict a multiline completion starting on the next line
	if (justAcceptedAutocompletion && isLineSuffixEmpty) {
		const prefixWithNewline = prefix + _ln
		completionOptions = {
			predictionType: 'multi-line-start-on-next-line',
			shouldGenerate: true,
			llmPrefix: prefixWithNewline,
			llmSuffix: suffix,
			stopTokens: [`${_ln}${_ln}`], // double newlines
			// Keep the next-line prediction SHORT: it's the slow path (a multi-line block generated
			// token-by-token after every Tab-accept). At ~30 tok/s on a laptop GPU this cap is the
			// dominant cost, so 32 keeps it ~1s; the user just Tabs again for the followup.
			maxTokens: 32,
		}
	}
	// if the current line is empty, predict a whole block when the multiline classifier
	// approves (Continue behavior: empty line = natural block start), else a single line
	else if (isLineEmpty) {
		if (multilineAllowed) {
			completionOptions = {
				predictionType: 'multi-line-start-here',
				shouldGenerate: true,
				llmPrefix: prefix,
				llmSuffix: suffix,
				stopTokens: [`${_ln}${_ln}`], // a blank line ends the block
				maxTokens: 160,
			}
		} else {
			completionOptions = {
				predictionType: 'single-line-fill-middle',
				shouldGenerate: true,
				llmPrefix: prefix,
				llmSuffix: suffix,
				stopTokens: allLinebreakSymbols,
				maxTokens: 128, // single-line: stops at the first newline anyway, so this rarely binds
			}
		}
	}
	// if suffix is 3 or fewer characters, attempt to complete the line ignorning it
	else if (removeAllWhitespace(suffixToTheRightOfCursor).length <= 3) {
		const suffixLinesIgnoringThisLine = suffixLines.slice(1)
		const suffixStringIgnoringThisLine = suffixLinesIgnoringThisLine.length === 0 ? '' : _ln + suffixLinesIgnoringThisLine.join(_ln)
		completionOptions = {
			predictionType: 'single-line-redo-suffix',
			shouldGenerate: true,
			llmPrefix: prefix,
			llmSuffix: suffixStringIgnoringThisLine,
			stopTokens: allLinebreakSymbols,
			maxTokens: 128, // single-line: stops at the first newline anyway, so this rarely binds
		}
	}
	// else attempt to complete the middle of the line if there is a prefix (the completion looks bad if there is no prefix)
	else if (!isLinePrefixEmpty) {
		completionOptions = {
			predictionType: 'single-line-fill-middle',
			shouldGenerate: true,
			llmPrefix: prefix,
			llmSuffix: suffix,
			stopTokens: allLinebreakSymbols,
			maxTokens: 128, // single-line: stops at the first newline anyway, so this rarely binds
		}
	} else {
		completionOptions = {
			predictionType: 'do-not-predict',
			shouldGenerate: false,
			llmPrefix: prefix,
			llmSuffix: suffix,
			stopTokens: [],
			maxTokens: 0,
		}
	}

	return completionOptions

}

export interface IAutocompleteService {
	readonly _serviceBrand: undefined;
}

export const IAutocompleteService = createDecorator<IAutocompleteService>('AutocompleteService');

export class AutocompleteService extends Disposable implements IAutocompleteService {

	static readonly ID = 'void.autocompleteService'

	_serviceBrand: undefined;

	private _autocompletionId: number = 0;
	private _autocompletionsOfDocument: { [docUriStr: string]: LRUCache<number, Autocompletion> } = {}
	// One debouncer per document (a global timestamp let typing in file B debounce file A)
	private _debouncerOfDocument: { [docUriStr: string]: AutocompleteDebouncer } = {}

	private _lastCompletionAccept = 0
	// private _lastPrefix: string = ''

	// used internally by vscode
	// fires after every keystroke and returns the completion to show
	async _provideInlineCompletionItems(
		model: ITextModel,
		position: Position,
		token: CancellationToken,
	): Promise<InlineCompletion[]> {

		const isEnabled = this._settingsService.state.globalSettings.enableAutocomplete
		if (!isEnabled) return []

		// Only complete in things that are actually FILES the user is writing.
		//
		// This used to deny exactly one scheme (chatSessionInput, the chat composer), which meant
		// every OTHER non-file editor still got completions: output channels, the debug console,
		// search editors, walkthroughs, rendered previews, and any input widget backed by a Monaco
		// model — including custom ones this fork adds, which the single-scheme check could never
		// know about. That is the "it fires everywhere and keeps going" behaviour.
		//
		// An allow-list is the right shape here: a new non-file surface is silently correct, whereas
		// a new deny entry has to be remembered every time one is added. Notebook cells are included
		// because they hold real code; untitled is included because a scratch buffer is where people
		// paste code to work on it.
		if (!AUTOCOMPLETE_ALLOWED_SCHEMES.has(model.uri.scheme)) {
			return []
		}

		// NOTE: we deliberately do NOT abort the in-flight LLM request when this token cancels —
		// completions that outlive their request populate the cache and are re-surfaced by
		// _refreshInlineSuggestion. The token is only used to skip work that has no consumer.
		if (token.isCancellationRequested) return []

		const testMode = false

		const docUriStr = model.uri.fsPath;

		const prefixAndSuffix = getPrefixAndSuffixInfo(model, position)
		const { prefix, suffix } = prefixAndSuffix

		// initialize cache if it doesnt exist
		// note that whenever an autocompletion is accepted, it is removed from cache
		if (!this._autocompletionsOfDocument[docUriStr]) {
			this._autocompletionsOfDocument[docUriStr] = new LRUCache<number, Autocompletion>(
				MAX_CACHE_SIZE,
				(autocompletion: Autocompletion) => {
					if (autocompletion.requestId)
						this._llmMessageService.abort(autocompletion.requestId)
				}
			)
		}
		// this._lastPrefix = prefix

		// print all pending autocompletions
		// let _numPending = 0
		// this._autocompletionsOfDocument[docUriStr].items.forEach((a: Autocompletion) => { if (a.status === 'pending') _numPending += 1 })
		// console.log('@numPending: ' + _numPending)

		// get autocompletion from cache
		let cachedAutocompletion: Autocompletion | undefined = undefined
		let autocompletionMatchup: AutocompletionMatchupBounds | undefined = undefined
		for (const autocompletion of this._autocompletionsOfDocument[docUriStr].items.values()) {
			// the suffix must be unchanged too — a prefix-only match served stale completions
			// after the user edited BELOW the cursor (typing through a suggestion only ever
			// grows the prefix, so exact suffix equality doesn't hurt the hit rate)
			if (autocompletion.suffix !== suffix) continue
			// if the user's change matches with the autocompletion
			autocompletionMatchup = getAutocompletionMatchup({ prefix, autocompletion })
			if (autocompletionMatchup !== undefined) {
				cachedAutocompletion = autocompletion
				break;
			}
		}

		// if there is a cached autocompletion, return it
		if (cachedAutocompletion && autocompletionMatchup) {

			if (cachedAutocompletion.status === 'finished') {

				const inlineCompletions = toInlineCompletions({ autocompletionMatchup, autocompletion: cachedAutocompletion, prefixAndSuffix, position, debug: true })
				return inlineCompletions

			} else if (cachedAutocompletion.status === 'pending') {

				try {
					await cachedAutocompletion.llmPromise;
					const inlineCompletions = toInlineCompletions({ autocompletionMatchup, autocompletion: cachedAutocompletion, prefixAndSuffix, position })
					return inlineCompletions

				} catch (e) {
					this._autocompletionsOfDocument[docUriStr].delete(cachedAutocompletion.id)
					if (!isAbortedAutocomplete(e)) {
						console.error('Error creating autocompletion (1): ' + e)
					}
				}

			}

			return []
		}

		// else if no more typing happens, then go forwards with the request

		// wait DEBOUNCE_TIME for the user to stop typing (per-document: typing in another
		// editor must not debounce this one)
		const justAcceptedAutocompletion = Date.now() - this._lastCompletionAccept < 500

		if (!this._debouncerOfDocument[docUriStr]) {
			this._debouncerOfDocument[docUriStr] = new AutocompleteDebouncer()
		}
		const didTypingHappenDuringDebounce = await this._debouncerOfDocument[docUriStr].delayAndShouldDebounce(DEBOUNCE_TIME)

		// if more typing happened, then do not go forwards with the request
		if (didTypingHappenDuringDebounce || token.isCancellationRequested) {
			return []
		}


		// if there are too many pending requests, cancel the oldest one
		let numPending = 0
		let oldestPending: Autocompletion | undefined = undefined
		for (const autocompletion of this._autocompletionsOfDocument[docUriStr].items.values()) {
			if (autocompletion.status === 'pending') {
				numPending += 1
				if (oldestPending === undefined) {
					oldestPending = autocompletion
				}
				if (numPending >= MAX_PENDING_REQUESTS) {
					// cancel the oldest pending request and remove it from cache
					this._autocompletionsOfDocument[docUriStr].delete(oldestPending.id)
					break
				}
			}
		}


		// gather relevant context from the code around the user's selection and definitions
		// const relevantSnippetsList = await this._contextGatheringService.readCachedSnippets(model, position, 3);
		// const relevantSnippetsList = this._contextGatheringService.getCachedSnippets();
		// const relevantSnippets = relevantSnippetsList.map((text) => `${text}`).join('\n-------------------------------\n')
		// console.log('@@---------------------\n' + relevantSnippets)
		const languageId = model.getLanguageId()

		// ported multiline classifier: may an empty-line completion be a whole block?
		const multilineAllowed = shouldCompleteMultiline({
			prefix: prefixAndSuffix.prefix,
			suffix: prefixAndSuffix.suffix,
			language: languageId,
			multilineSetting: 'auto',
		})

		const { shouldGenerate, predictionType, llmPrefix, llmSuffix, stopTokens, maxTokens } = getCompletionOptions(prefixAndSuffix, justAcceptedAutocompletion, multilineAllowed)

		if (!shouldGenerate) return []

		// Repo-level context costs a semantic query + extra prefill on every completion. Skip it for
		// the next-line prediction: that path is already the heavy one (a multi-line block), and
		// cross-file context helps it least (it's continuing local code). Big latency win on the
		// slow path; the single-line paths still get neighbor files.
		let repoContext: FIMRepoContext | undefined = undefined
		if (predictionType !== 'multi-line-start-on-next-line') {
			const prefixForQuery = prefixAndSuffix.prefixToTheLeftOfCursor.trim() ? prefixAndSuffix.prefixToTheLeftOfCursor : prefixAndSuffix.prefix
			repoContext = await this._gatherRepoContext(model, prefixForQuery.slice(-400))
		}

		if (testMode && this._autocompletionId !== 0) { // TODO remove this
			return []
		}



		// create a new autocompletion and add it to cache
		const newAutocompletion: Autocompletion = {
			id: this._autocompletionId++,
			prefix: prefix, // the actual prefix and suffix
			suffix: suffix,
			llmPrefix: llmPrefix, // the prefix and suffix the llm sees
			llmSuffix: llmSuffix,
			startTime: Date.now(),
			endTime: undefined,
			type: predictionType,
			status: 'pending',
			llmPromise: undefined,
			insertText: '',
			requestId: null,
			_newlineCount: 0,
		}

		const featureName: FeatureName = 'Autocomplete'
		const overridesOfModel = this._settingsService.state.overridesOfModel
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName]
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined

		// prepend AI instructions to the prefix (capped) — must happen BEFORE template rendering
		// so the instructions land inside the rendered prompt too
		const prepared = this._convertToLLMMessageService.prepareFIMMessage({
			messages: { prefix: llmPrefix, suffix: llmSuffix, stopTokens, repoContext, maxTokens }
		})

		// per-model FIM template (ported): renders the FULL prompt client-side — real multi-file
		// formats (qwen repo-level / codestral "+++++" blocks) instead of a comment dump, and fixes
		// providers whose /completions silently ignores `suffix` (LM Studio, vLLM, Ollama raw mode)
		const relPath = this._relativePath(model.uri) ?? model.uri.path
		let renderedPrompt: string | undefined = undefined
		let stopTokensForRequest = prepared.stopTokens
		if (modelSelection && RENDERED_PROMPT_PROVIDERS.has(modelSelection.providerName)) {
			const snippets: AutocompleteCodeSnippet[] = (repoContext?.files ?? []).map(f => ({
				type: AutocompleteSnippetType.Code,
				filepath: f.path,
				content: f.content,
			}))
			const rendered = renderFimPrompt(modelSelection.modelName, {
				prefix: prepared.prefix,
				suffix: prepared.suffix,
				filepath: relPath,
				reponame: repoContext?.repoName ?? this._workspaceContextService.getWorkspace().folders[0]?.name ?? 'repo',
				language: languageId,
				snippets,
			})
			if (rendered) {
				renderedPrompt = rendered.prompt
				stopTokensForRequest = [...new Set([...prepared.stopTokens, ...rendered.stopTokens])]
			}
		}

		// stream plumbing: onText/onFinalMessage push deltas into a queue that an async
		// generator drains; the ported filter pipeline consumes the generator and can
		// early-stop the request the moment the completion goes bad (repeats, suffix echo,
		// stop patterns) instead of waiting for the model to finish
		const chunkQueue: string[] = []
		let receivedLen = 0
		let sourceDone = false
		let sourceError: string | null = null
		let finalized = false
		let notifyChunk: (() => void) | null = null
		const wake = () => { notifyChunk?.(); notifyChunk = null }
		const pushDelta = (fullText: string) => {
			const delta = fullText.slice(receivedLen)
			receivedLen = fullText.length
			if (delta) chunkQueue.push(delta)
		}
		const sourceStream = async function* (): AsyncGenerator<string> {
			while (true) {
				while (chunkQueue.length > 0) { yield chunkQueue.shift()! }
				if (sourceDone) return
				await new Promise<void>(res => { notifyChunk = res })
			}
		}

		newAutocompletion.llmPromise = (async (): Promise<string> => {

			const requestId = this._llmMessageService.sendLLMMessage({
				messagesType: 'FIMMessage',
				messages: { ...prepared, stopTokens: stopTokensForRequest, renderedPrompt },
				modelSelection,
				modelSelectionOptions,
				overridesOfModel,
				logging: { loggingName: 'Autocomplete' },
				onText: ({ fullText }) => { pushDelta(fullText); wake() },
				onFinalMessage: ({ fullText }) => { pushDelta(fullText); sourceDone = true; wake() },
				onError: ({ message }) => { sourceError = message; sourceDone = true; wake() },
				// our own early-stop aborts the request AFTER the pipeline finished — not an error then
				onAbort: () => { if (!finalized) { sourceError = 'Aborted autocomplete'; sourceDone = true; wake() } },
			})
			newAutocompletion.requestId = requestId

			// the old timeout rejected but left the request running; now it aborts it too
			const timeoutHandle = setTimeout(() => {
				if (!sourceDone) {
					sourceError = 'Timeout receiving message to LLM.'
					sourceDone = true
					wake()
					if (requestId) { this._llmMessageService.abort(requestId) }
				}
			}, TIMEOUT_TIME)

			try {
				let earlyStopped = false
				const pipeline = new AutocompleteStreamPipeline()
				let filtered = ''
				for await (const chunk of pipeline.transform(sourceStream(), {
					prefix: prepared.prefix,
					suffix: prepared.suffix,
					multiline: predictionType.startsWith('multi-line'),
					stopTokens: stopTokensForRequest,
					commentPrefix: getSingleLineCommentPrefix(languageId),
					filepath: relPath,
					fullStop: () => { earlyStopped = true },
				})) {
					filtered += chunk
				}

				// pipeline finished while the model is still generating -> stop paying for tokens
				finalized = true
				if ((earlyStopped || !sourceDone) && requestId) {
					this._llmMessageService.abort(requestId)
				}

				if (sourceError !== null && !filtered.trim()) {
					throw sourceError
				}

				// ported model-quirk fixups + rejection rules (blank, line-above repeat, extreme repetition)
				const post = postprocessCompletion({
					completion: filtered,
					prefix: prepared.prefix,
					suffix: prepared.suffix,
					modelName: modelSelection?.modelName ?? '',
				})

				newAutocompletion.endTime = Date.now()
				newAutocompletion.status = 'finished'

				if (post === undefined) {
					newAutocompletion.insertText = ''
					return ''
				}

				let insertText = processStartAndEndSpaces(post)

				// handle special case for predicting starting on the next line, add a newline character
				if (newAutocompletion.type === 'multi-line-start-on-next-line') {
					insertText = _ln + insertText
				}
				newAutocompletion.insertText = insertText

				// The original request may have been cancelled while the model was generating (the
				// provider's returned list is then discarded). Re-query so the now-cached result
				// renders. Cheap + safe: the re-query hits the finished cache entry synchronously
				// and does NOT start another generation, so there's no loop.
				if (insertText.trim()) { this._refreshInlineSuggestion() }

				return insertText
			}
			catch (e) {
				newAutocompletion.endTime = Date.now()
				newAutocompletion.status = 'error'
				throw e
			}
			finally {
				clearTimeout(timeoutHandle)
			}
		})()



		// add autocompletion to cache
		this._autocompletionsOfDocument[docUriStr].set(newAutocompletion.id, newAutocompletion)

		// show autocompletion
		try {
			await newAutocompletion.llmPromise
			// console.log('id: ' + newAutocompletion.id)

			// rejected by the postprocessor (blank/garbage) — drop the cache entry so it can't
			// shadow future generations for the same prefix
			if (!newAutocompletion.insertText.trim()) {
				this._autocompletionsOfDocument[docUriStr].delete(newAutocompletion.id)
				return []
			}

			const autocompletionMatchup: AutocompletionMatchupBounds = { startIdx: 0, startLine: 0, startCharacter: 0 }
			const inlineCompletions = toInlineCompletions({ autocompletionMatchup, autocompletion: newAutocompletion, prefixAndSuffix, position })
			return inlineCompletions

		} catch (e) {
			this._autocompletionsOfDocument[docUriStr].delete(newAutocompletion.id)
			if (!isAbortedAutocomplete(e)) {
				console.error('Error creating autocompletion (2): ' + e)
			}
			return []
		}

	}

	// Repo-level FIM context: gather a few RELATED files (not just chunks) so the model understands
	// code beyond the file being edited — cross-file types, signatures, recently-touched code. The
	// built-in local engine renders these with Qwen's native `<|file_sep|>` tokens; cloud FIM folds
	// them into a comment. Hard-capped at 150ms (a cold/slow index never blocks a completion) and
	// budgeted in size so the small local model stays fast. Undefined on any failure or timeout.
	private async _gatherRepoContext(model: ITextModel, query: string): Promise<FIMRepoContext | undefined> {
		if (!query.trim()) { return undefined }
		try {
			const hits = await Promise.race<Hit[]>([
				this._semanticIndexService.retrieve(query, { topK: 6 }),
				new Promise<Hit[]>(resolve => setTimeout(() => resolve([]), REPO_CONTEXT_TIMEOUT_MS)),
			])
			if (!hits || hits.length === 0) { return undefined }

			// Keep the neighbor context LEAN: the model prefills every char of it on each completion,
			// so this is the dominant latency knob. A couple of small, relevant files give most of the
			// cross-file benefit without the prefill cost of a big dump.
			const currentPath = this._relativePath(model.uri)
			const PER_FILE_CHARS = 1100
			const MAX_FILES = 2
			let totalBudget = 2000

			// Group the relevant units (chunks) by their source file, most-relevant first, so each
			// neighbor file shows the model the actual pieces that matched — not just its header.
			const byFile = new Map<string, string[]>()
			for (const h of hits) {
				const path = h.chunk.file
				if (!path || path === currentPath) { continue } // skip the file being edited
				const piece = h.content.trim()
				if (!piece) { continue }
				if (!byFile.has(path)) {
					if (byFile.size >= MAX_FILES) { continue }
					byFile.set(path, [])
				}
				byFile.get(path)!.push(piece)
			}

			const files: FIMRepoContextFile[] = []
			for (const [path, pieces] of byFile) {
				if (totalBudget <= 0) { break }
				const content = pieces.join('\n\n').slice(0, Math.min(PER_FILE_CHARS, totalBudget))
				if (!content) { continue }
				files.push({ path, content })
				totalBudget -= content.length
			}

			if (files.length === 0) { return undefined }
			const repoName = this._workspaceContextService.getWorkspace().folders[0]?.name
			return { repoName, currentPath: currentPath ?? undefined, files }
		} catch { return undefined }
	}

	// A completion can finish AFTER VS Code has cancelled the request that asked for it (the model
	// gen — heavier now with repo context, or slow on CPU-only machines — outruns the cancellation
	// window, and NES's periodic trigger cancels in-flight requests too). The provider still returns
	// the text, but VS Code discards a result for a cancelled token, so no ghost text appears. The
	// finished completion is already in the cache, so we just ask VS Code to re-query: the fresh
	// request hits the cache synchronously and renders immediately. Mirrors NES's refresh.
	private _refreshInlineSuggestion(): void {
		const editor = this._codeEditorService.getFocusedCodeEditor();
		if (!editor?.hasTextFocus()) { return; }
		void this._commandService.executeCommand('editor.action.inlineSuggest.trigger');
	}

	/** Workspace-relative path for a file uri, or undefined if it's outside the workspace. */
	private _relativePath(uri: URI): string | undefined {
		return workspaceIndexPath(this._workspaceContextService.getWorkspace().folders, uri)
	}

	constructor(
		@ILanguageFeaturesService private _langFeatureService: ILanguageFeaturesService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IEditorService private readonly _editorService: IEditorService,
		@IModelService private readonly _modelService: IModelService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessageService: IConvertToLLMMessageService,
		@ISemanticIndexService private readonly _semanticIndexService: ISemanticIndexService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly _commandService: ICommandService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		// @IContextGatheringService private readonly _contextGatheringService: IContextGatheringService,
	) {
		super()

		this._register(this._langFeatureService.inlineCompletionsProvider.register('*', {
			groupId: 'v3code-fim', // primary autocomplete group; the NES provider yields to this
			provideInlineCompletions: async (model, position, context, token) => {
				const items = await this._provideInlineCompletionItems(model, position, token)

				// console.log('item: ', items?.[0]?.insertText)
				return { items: items, }
			},
			disposeInlineCompletions: (completions, _reason) => {
				// get the `docUriStr` and the `position` of the cursor
				const activePane = this._editorService.activeEditorPane;
				if (!activePane) return;
				const control = activePane.getControl();
				if (!control || !isCodeEditor(control)) return;
				const position = control.getPosition();
				if (!position) return;
				const resource = EditorResourceAccessor.getCanonicalUri(this._editorService.activeEditor);
				if (!resource) return;
				const model = this._modelService.getModel(resource)
				if (!model) return;
				const docUriStr = resource.fsPath;
				if (!this._autocompletionsOfDocument[docUriStr]) return;

				const { prefix, } = getPrefixAndSuffixInfo(model, position)

				// go through cached items and remove matching ones
				// autocompletion.prefix + autocompletion.insertedText ~== insertedText
				this._autocompletionsOfDocument[docUriStr].items.forEach((autocompletion: Autocompletion) => {

					// we can do this more efficiently, I just didn't want to deal with all of the edge cases
					const matchup = removeAllWhitespace(prefix) === removeAllWhitespace(autocompletion.prefix + autocompletion.insertText)

					if (matchup) {
						this._lastCompletionAccept = Date.now()
						this._autocompletionsOfDocument[docUriStr].delete(autocompletion.id);
					}
				});

			},
		}))
	}


}

registerWorkbenchContribution2(AutocompleteService.ID, AutocompleteService, WorkbenchPhase.BlockRestore);

