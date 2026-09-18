/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
    buildTurboDraftPrompt,
    buildTurboDraftRepairPrompt,
    classifyTurboDraftHunk,
    classifyTurboDraftResponse,
    editTrailLabel,
    isProsePath,
    isScaffoldFile,
    isTurboDraftNoChanges,
    TURBO_DRAFT_MAX_INLINE_LINES,
    TURBO_DRAFT_SYSTEM_PROMPT,
    TurboDraftInput,
    turboDraftSystemPromptFor,
    windowFileForTurbo,
} from '../../common/turboDraftPrompt.js';
import { ORIGINAL, DIVIDER, FINAL } from '../../common/prompt/prompts.js';
import { EditEntry } from '../../common/recentEditsTypes.js';

const edit = (): EditEntry => ({
    id: 'e1',
    fileUri: '/w/src/a.ts',
    relativePath: 'src/a.ts',
    timestamp: 1,
    range: { startLine: 1, endLine: 1 },
    oldText: 'const a = 1',
    newText: 'const a = 2',
    summary: 'src/a.ts:1 — const a = 2',
});

const input = (over: Partial<TurboDraftInput> = {}): TurboDraftInput => ({
    filePath: '/w/src/a.ts',
    fileContents: 'const a = 2\nexport { a }\n',
    cursorLine: 1,
    editHistory: [edit()],
    contextSnippets: [{ path: 'src/b.ts', content: 'export function helper() {}' }],
    mode: 'fast',
    ...over,
});

suite('turboDraftPrompt', () => {
    ensureNoDisposablesAreLeakedInTestSuite();

    test('prompt carries file, history, context, mode', () => {
        const p = buildTurboDraftPrompt(input({
            editHistory: [{ ...edit(), source: 'tab' }],
            recentChatSummary: 'User: finish the helper\nAssistant: on it',
        }));
        assert.ok(p.includes('Mode: FAST'));
        assert.ok(p.includes('whole-file high-confidence'));
        assert.ok(p.includes('[accepted tab] src/a.ts:1 — const a = 2'));
        assert.ok(p.includes('--- src/b.ts'));
        assert.ok(p.includes('const a = 2'));
        assert.ok(p.includes('User: finish the helper'));
        assert.ok(p.includes(ORIGINAL));
        assert.ok(p.includes(FINAL));
    });

    test('deep mode hint', () => {
        const p = buildTurboDraftPrompt(input({ mode: 'deep' }));
        assert.ok(p.includes('Mode: DEEP'));
    });

    test('edit trail labels a deletion as intentional', () => {
        const deletion: EditEntry = { ...edit(), oldText: 'function old() {}', newText: '', source: 'edit' };
        const p = buildTurboDraftPrompt(input({ editHistory: [deletion] }));
        assert.ok(p.includes('[developer deleted]'), 'deletion must be labelled');
        assert.ok(
            TURBO_DRAFT_SYSTEM_PROMPT.includes('Never restore code the developer just removed'),
            'system prompt must forbid resurrecting deleted code',
        );
        assert.strictEqual(editTrailLabel(deletion), '[developer deleted]');
        assert.strictEqual(editTrailLabel({ ...edit(), source: 'edit' }), '[developer typed]');
        assert.strictEqual(editTrailLabel({ ...edit(), source: 'nes' }), '[accepted nes]');
    });

    test('whitespace-only replacement is not treated as a deletion', () => {
        assert.strictEqual(editTrailLabel({ ...edit(), oldText: '   ', newText: '' }), '[developer typed]');
    });

    test('small files are sent whole', () => {
        const src = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
        const w = windowFileForTurbo(src, 5, TURBO_DRAFT_MAX_INLINE_LINES);
        assert.strictEqual(w.windowed, false);
        assert.strictEqual(w.text, src);
        assert.strictEqual(w.startLine, 1);
        assert.strictEqual(w.endLine, 10);
    });

    test('huge files window around the cursor with elision markers', () => {
        const total = 3000;
        const src = Array.from({ length: total }, (_, i) => `line ${i + 1}`).join('\n');
        const w = windowFileForTurbo(src, 2000, 900);
        assert.strictEqual(w.windowed, true);
        assert.strictEqual(w.totalLines, total);
        assert.ok(w.endLine - w.startLine + 1 <= 900, 'window respects the cap');
        assert.ok(w.startLine <= 2000 && w.endLine >= 2000, 'window contains the cursor');
        assert.ok(w.text.includes('line 2000'));
        assert.ok(w.text.includes('omitted'), 'elision marker present');
        assert.ok(!w.text.includes('line 1\n'), 'far-away head is not included');
    });

    test('window near end of file stays within bounds', () => {
        const total = 2000;
        const src = Array.from({ length: total }, (_, i) => `line ${i + 1}`).join('\n');
        const w = windowFileForTurbo(src, total, 900);
        assert.strictEqual(w.endLine, total);
        assert.ok(w.startLine >= 1);
        assert.ok(w.text.includes(`line ${total}`));
    });

    test('prose files get editorial rules, code files get code rules', () => {
        assert.ok(isProsePath('/w/docs/SECURITY.md'));
        assert.ok(isProsePath('/w/notes.TXT'));
        assert.ok(!isProsePath('/w/src/a.ts'));
        assert.ok(!isProsePath('/w/Makefile'));

        const proseSystem = turboDraftSystemPromptFor('/w/README.md');
        assert.ok(proseSystem.includes('whole-document editor'));
        assert.ok(proseSystem.includes('existing voice'));
        assert.ok(!proseSystem.includes('idiomatic'), 'code idiom rules must not leak into prose');

        const codeSystem = turboDraftSystemPromptFor('/w/src/a.ts');
        assert.ok(codeSystem.includes('whole-file rewrite agent'));
    });

    test('code system prompt demands why-headers and forbids narration', () => {
        assert.ok(TURBO_DRAFT_SYSTEM_PROMPT.includes('says WHY it exists'));
        assert.ok(TURBO_DRAFT_SYSTEM_PROMPT.includes('Never narrate the code'));
        assert.ok(TURBO_DRAFT_SYSTEM_PROMPT.includes('Do not add or reformat headers on code you are not otherwise changing'));
    });

    test('prose prompt uses document wording', () => {
        const p = buildTurboDraftPrompt(input({ filePath: '/w/README.md', mode: 'deep' }));
        assert.ok(p.includes('finish the whole document'));
    });

    test('windowed prompt tells the model it sees only part of the file', () => {
        const src = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n');
        const p = buildTurboDraftPrompt(input({ fileContents: src, cursorLine: 1200 }));
        assert.ok(p.includes('of 2500'));
        assert.ok(p.includes('Every ORIGINAL must match text inside the shown window'));
    });

    test('a described but unwritten file asks for the whole thing, not NO_CHANGES', () => {
        const p = buildTurboDraftPrompt(input({
            filePath: '/w/src/events.py',
            fileContents: '#create events.py\n',
            editHistory: [],
        }));
        assert.ok(p.includes('empty apart from a note'), 'scaffold section must be present');
        assert.ok(p.includes('NO_CHANGES is wrong here'));
        assert.ok(p.includes('Write its full intended contents'));
    });

    test('a real file gets no scaffold section', () => {
        const src = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i}`).join('\n');
        const p = buildTurboDraftPrompt(input({ fileContents: src }));
        assert.ok(!p.includes('empty apart from a note'));
    });

    test('isScaffoldFile needs an anchor line to attach a block to', () => {
        assert.strictEqual(isScaffoldFile('#create events.py'), true);
        assert.strictEqual(isScaffoldFile('// a\n// b\n\n// c'), true);
        assert.strictEqual(isScaffoldFile(''), false, 'nothing to anchor ORIGINAL on');
        assert.strictEqual(isScaffoldFile('\n  \n\t\n'), false, 'whitespace is not an anchor');
        assert.strictEqual(isScaffoldFile(Array.from({ length: 9 }, (_, i) => `l${i}`).join('\n')), false);
    });

    test('a prose file scaffolds with document wording', () => {
        const p = buildTurboDraftPrompt(input({ filePath: '/w/notes.md', fileContents: '# draft the release notes\n' }));
        assert.ok(p.includes('This document is empty apart from a note'));
    });

    test('classifyTurboDraftResponse — exact NO_CHANGES only', () => {
        assert.strictEqual(classifyTurboDraftResponse('NO_CHANGES').kind, 'no-changes');
        assert.strictEqual(classifyTurboDraftResponse('no_changes').kind, 'no-changes');
        assert.strictEqual(classifyTurboDraftResponse('').kind, 'empty');
        assert.strictEqual(classifyTurboDraftResponse('', { hasReasoning: true }).kind, 'reasoning-only');
        assert.strictEqual(classifyTurboDraftResponse('NO_CHANGES\nplease see above').kind, 'malformed');
        assert.strictEqual(classifyTurboDraftResponse('Here are edits').kind, 'malformed');
        assert.strictEqual(
            classifyTurboDraftResponse(`${ORIGINAL}\nx\n${DIVIDER}\ny\n${FINAL}`).kind,
            'valid-blocks',
        );
    });

    test('isTurboDraftNoChanges is exact-only (empty is not no-changes)', () => {
        assert.strictEqual(isTurboDraftNoChanges('NO_CHANGES'), true);
        assert.strictEqual(isTurboDraftNoChanges(''), false);
        assert.strictEqual(isTurboDraftNoChanges(`${ORIGINAL}\nx\n${DIVIDER}\ny\n${FINAL}`), false);
    });

    test('repair prompt includes previous response and file', () => {
        const p = buildTurboDraftRepairPrompt({
            filePath: '/w/a.ts',
            fileContents: 'const x = 1\n',
            previousResponse: 'sorry I cannot',
        });
		assert.ok(p.includes('sorry I cannot'));
		assert.ok(p.includes('const x = 1'));
		assert.ok(p.includes(ORIGINAL));
	});

	test('repair prompt names the failure so the model can act on it', () => {
		const p = buildTurboDraftRepairPrompt({
			filePath: '/w/a.ts',
			fileContents: 'const x = 1\n',
			previousResponse: 'huge blob',
			rejectReasons: ['too-large', 'partial-reject'],
		});
		assert.ok(p.includes('Why it was rejected'));
		assert.ok(p.includes('Split the work into several small blocks'));
		assert.ok(p.includes('Keep the good edits and fix only the broken ones'));
	});

	test('unknown reject reasons do not produce an empty diagnosis section', () => {
		const p = buildTurboDraftRepairPrompt({
			filePath: '/w/a.ts',
			fileContents: 'const x = 1\n',
			previousResponse: 'blob',
			rejectReasons: ['something-new'],
		});
		assert.ok(!p.includes('Why it was rejected'));
	});

	test('a repair of a response that had edits may not answer NO_CHANGES', () => {
		const p = buildTurboDraftRepairPrompt({
			filePath: '/w/a.ts',
			fileContents: 'const x = 1\n',
			previousResponse: `${ORIGINAL}\nconst x = 1\n${DIVIDER}\nconst x = 2\n${FINAL}`,
			hadEdits: true,
		});
		assert.ok(p.includes('Do NOT answer NO_CHANGES'));
		assert.ok(p.includes('drop that edit and return the rest'));
	});

	test('a repair of a response with no edits keeps the NO_CHANGES escape hatch', () => {
		const p = buildTurboDraftRepairPrompt({
			filePath: '/w/a.ts',
			fileContents: 'const x = 1\n',
			previousResponse: 'I could not find anything to do',
			hadEdits: false,
		});
		assert.ok(!p.includes('Do NOT answer NO_CHANGES'));
		assert.ok(p.includes('or exactly NO_CHANGES'));
	});

    test('classifyTurboDraftHunk', () => {
        assert.strictEqual(classifyTurboDraftHunk('a', ''), 'remove');
        assert.strictEqual(classifyTurboDraftHunk('', 'a'), 'add');
        assert.strictEqual(classifyTurboDraftHunk('a', 'b'), 'change');
    });
});
