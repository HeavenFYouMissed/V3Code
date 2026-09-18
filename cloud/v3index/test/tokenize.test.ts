import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/core/tokenize.js';

/*--------------------------------------------------------------------------------------
 *  Linear identifier tokenizer. Proves camelCase/acronym parity, the all-caps
 *  recall fix, and — critically — that the O(n^2) backtracking that killed the
 *  DO isolate during ingest is gone.
 *--------------------------------------------------------------------------------------*/

describe('tokenize: identifier splitting', () => {
	it('splits camelCase / PascalCase / snake / kebab', () => {
		expect(tokenize('greetUser')).toEqual(['greet', 'user']);
		expect(tokenize('GreetUser')).toEqual(['greet', 'user']);
		expect(tokenize('greet_user')).toEqual(['greet', 'user']);
		expect(tokenize('greet-user')).toEqual(['greet', 'user']);
	});

	it('handles acronym boundaries like the editor', () => {
		expect(tokenize('HTTPServer')).toEqual(['http', 'server']);
		expect(tokenize('getHTTPResponse')).toEqual(['get', 'http', 'response']);
		expect(tokenize('parseURL')).toEqual(['parse', 'url']);
		expect(tokenize('IOError')).toEqual(['io', 'error']);
	});

	it('keeps digit runs attached and drops <2-char tokens', () => {
		expect(tokenize('foo123')).toEqual(['foo123']);
		expect(tokenize('utf8Encode')).toEqual(['utf8', 'encode']);
		expect(tokenize('A')).toEqual([]);
		expect(tokenize('x')).toEqual([]);
	});

	it('emits all-caps segments before punctuation (recall fix vs the old regex)', () => {
		// The old /[A-Z]+(?=[A-Z][a-z]|\d|$)/ dropped MAX / HTTP here entirely.
		expect(tokenize('MAX_SIZE')).toEqual(['max', 'size']);
		expect(tokenize('HTTP.get')).toEqual(['http', 'get']);
		expect(tokenize('const MAX = 5;')).toEqual(['const', 'max']);
	});

	it('tokenizes realistic code content', () => {
		expect(tokenize('export function chargeAccount(a: Account) { return chargeCard(a); }'))
			.toEqual(['export', 'function', 'charge', 'account', 'account', 'return', 'charge', 'card']);
	});
});

describe('tokenize: no catastrophic backtracking (the ingest CPU killer)', () => {
	it('is fast on a long uppercase run + trailing char (old O(n^2) trigger)', () => {
		const payload = 'A'.repeat(200_000) + '.';
		const t0 = Date.now();
		const toks = tokenize(payload);
		const ms = Date.now() - t0;
		// The old tokenizer took tens of seconds at 80k chars; linear finishes in ms.
		expect(ms).toBeLessThan(500);
		expect(toks.length).toBe(1); // one big lowercased run
	});

	it('is fast on a long uppercase run followed by lowercase', () => {
		const payload = 'A'.repeat(150_000) + 'a';
		const t0 = Date.now();
		tokenize(payload);
		expect(Date.now() - t0).toBeLessThan(500);
	});

	it('is fast on a large minified-ish blob', () => {
		const blob = 'function aB(){return XYZ.doThing(ABC_DEF)}'.repeat(5_000);
		const t0 = Date.now();
		const toks = tokenize(blob);
		expect(Date.now() - t0).toBeLessThan(500);
		expect(toks.length).toBeGreaterThan(0);
	});
});
