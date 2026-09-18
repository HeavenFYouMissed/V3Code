/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  Lexical tokenizer — camelCase/PascalCase/acronym-aware identifier splitter,
 *  editor parity (the FTS body and the query MUST tokenize identically or
 *  identifiers never match: unicode61 keeps `greetUser` as one token, we split it).
 *
 *  LINEAR, single pass. The previous implementation used
 *    /[A-Z]?[a-z0-9]+|[A-Z]+(?=[A-Z][a-z]|\d|$)/g
 *  whose second branch backtracked QUADRATICALLY on long uppercase runs (minified
 *  bundles, base64/hex blobs, SCREAMING_CASE) — a single such chunk could burn the
 *  DO/Worker CPU limit during ingest and kill the isolate (the /chunks 500 that
 *  returned a Cloudflare HTML page). This scanner is O(n) on any input. It also
 *  fixes a latent bug in the old regex: an all-caps segment followed by a
 *  non-alphanumeric (e.g. the `MAX` in `MAX_SIZE`, or `HTTP` in `HTTP.get`) was
 *  dropped entirely; it is now emitted, improving recall on constants/acronyms.
 *--------------------------------------------------------------------------------------*/

function isLower(c: number): boolean { return c >= 97 && c <= 122; } // a-z
function isUpper(c: number): boolean { return c >= 65 && c <= 90; }  // A-Z
function isLowerOrDigit(c: number): boolean { return (c >= 97 && c <= 122) || (c >= 48 && c <= 57); }

export function tokenize(text: string): string[] {
	const out: string[] = [];
	const n = text.length;
	let i = 0;
	while (i < n) {
		const c = text.charCodeAt(i);
		if (!isUpper(c) && !isLowerOrDigit(c)) { i++; continue; } // skip separators
		let j = i + 1;
		if (isUpper(c)) {
			const next = j < n ? text.charCodeAt(j) : -1;
			if (isLowerOrDigit(next)) {
				// PascalCase word: one uppercase + a run of [a-z0-9] (greetUser → User).
				while (j < n && isLowerOrDigit(text.charCodeAt(j))) j++;
			} else {
				// Acronym run: consume the uppercase run; if it is immediately followed
				// by a lowercase, the LAST uppercase begins the next word
				// (HTTPServer → HTTP | Server), so give it back.
				while (j < n && isUpper(text.charCodeAt(j))) j++;
				if (j < n && isLower(text.charCodeAt(j)) && j - 1 > i) j--;
			}
		} else {
			// lower/digit run: [a-z0-9]+
			while (j < n && isLowerOrDigit(text.charCodeAt(j))) j++;
		}
		if (j - i >= 2) out.push(text.slice(i, j).toLowerCase());
		i = j;
	}
	return out;
}
