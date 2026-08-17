import { describe, expect, it } from 'vitest';
import { alignNotes, unexplained, validateExplanation } from '../src/core/explanation.js';
import { explainableLines, requiredLineNumbers } from '../src/core/lines.js';

describe('explainableLines', () => {
  it('reads the new side of an Edit, never the old', () => {
    const ex = explainableLines('Edit', {
      file_path: '/a.ts',
      old_string: 'gone\nalso gone',
      new_string: 'one\ntwo',
    });
    expect(ex?.target).toBe('/a.ts');
    expect(ex?.lines).toEqual(['one', 'two']);
  });

  it('reads Write content and Bash commands', () => {
    expect(explainableLines('Write', { file_path: '/b.ts', content: 'a\nb' })?.lines).toEqual([
      'a',
      'b',
    ]);
    const bash = explainableLines('Bash', { command: 'ls -la' });
    expect(bash?.target).toBe('shell');
    expect(bash?.lines).toEqual(['ls -la']);
  });

  it('flattens every edit of a MultiEdit', () => {
    const ex = explainableLines('MultiEdit', {
      file_path: '/c.ts',
      edits: [{ new_string: 'a' }, { new_string: 'b\nc' }],
    });
    expect(ex?.lines).toEqual(['a', 'b', 'c']);
  });

  it('returns null for tools it does not know, so they pass through', () => {
    expect(explainableLines('Read', { file_path: '/a.ts' })).toBeNull();
  });
});

describe('requiredLineNumbers', () => {
  it('is 1-indexed and skips blank lines', () => {
    expect(
      requiredLineNumbers({ target: '/a.ts', lines: ['a', '', '  ', 'b'], context: new Set() }),
    ).toEqual([1, 4]);
  });
});

// An Edit carries unchanged context inside new_string so the match is unique.
// Demanding a note for those lines rejected every real code edit once.
describe('context lines in an Edit', () => {
  const edit = () =>
    explainableLines('Edit', {
      file_path: '/repo/greet.js',
      old_string: 'function greet(name) {\n  return name\n}',
      new_string:
        'function greet(name) {\n  const trimmed = name.trim()\n  const safe = trimmed || "there"\n  return `hello ${safe}`\n}',
    });

  it('marks lines carried over from the old text as context', () => {
    const ex = edit();
    // 1 `function greet(name) {` and 5 `}` are unchanged; 2–4 are new.
    expect([...(ex?.context ?? [])].sort((a, b) => a - b)).toEqual([1, 5]);
  });

  it('only asks for notes on the lines that changed', () => {
    expect(requiredLineNumbers(edit()!)).toEqual([2, 3, 4]);
  });

  it('accepts an explanation covering just the change', () => {
    const r = validateExplanation(edit()!, {
      lines: [
        { n: 2, note: 'strips surrounding spaces' },
        { n: 3, note: 'falls back when the name is empty' },
        { n: 4, note: 'builds the greeting' },
      ],
      why: 'greeting broke on blank names',
    });
    expect(r).toEqual({ ok: true });
  });

  // Coverage is shown, not enforced: a missing note must never cost the learner
  // the whole change.
  it('accepts a partial explanation and reports the gap', () => {
    const notes = [
      { n: 2, note: 'strips surrounding spaces' },
      { n: 4, note: 'builds the greeting' },
    ];
    expect(validateExplanation(edit()!, { lines: notes, why: 'because' })).toEqual({ ok: true });
    expect(unexplained(edit()!, notes)).toEqual([3]);
  });

  it('treats a whole new file as all-new', () => {
    const ex = explainableLines('Write', { file_path: '/a.ts', content: 'a\nb' });
    expect(ex?.context.size).toBe(0);
    expect(requiredLineNumbers(ex!)).toEqual([1, 2]);
  });
});

// Real sessions kept failing because the agent numbers lines by their position
// in the *file* — it inserts at line 9 and says "line 9" — while we numbered
// from 1 within new_string. Asking either side to translate was the mistake.
describe('line numbering the agent actually uses', () => {
  const insert = () =>
    explainableLines('Edit', {
      file_path: '/repo/greet.js',
      old_string: 'const a = 1',
      new_string: 'const a = 1\nconst b = 2\nconst c = 3',
    })!;

  it('accepts notes numbered by file position, pairing them in order', () => {
    const r = validateExplanation(insert(), {
      lines: [
        { n: 9, note: 'declares b' },
        { n: 10, note: 'declares c' },
      ],
      why: 'the two new values were missing',
    });
    expect(r).toEqual({ ok: true });
  });

  it('still prefers the agent’s numbering when it is valid', () => {
    const r = validateExplanation(insert(), {
      lines: [
        { n: 2, note: 'declares b' },
        { n: 3, note: 'declares c' },
      ],
      why: 'because',
    });
    expect(r).toEqual({ ok: true });
  });

  it('takes what it is given and marks the rest', () => {
    const notes = [{ n: 9, note: 'declares b' }];
    expect(validateExplanation(insert(), { lines: notes, why: 'because' })).toEqual({ ok: true });
    expect(unexplained(insert(), notes)).toEqual([3]);
  });
});

// Explaining more than the minimum is generosity, not an error. Rejecting it
// blocked real edits: the agent explained all three lines it wrote, one was
// carried-over context, and we demanded exactly two.
describe('explaining every line, not just the changed ones', () => {
  const edit = () =>
    explainableLines('Edit', {
      file_path: '/repo/greet.js',
      old_string: 'function main() {\n}',
      new_string: 'function main() {\n  const a = 1\n  const b = 2\n}',
    })!;

  it('needs only the changed lines', () => {
    expect(requiredLineNumbers(edit())).toEqual([2, 3]);
  });

  it('also accepts a note for every line, context included', () => {
    const r = validateExplanation(edit(), {
      lines: [
        { n: 1, note: 'opens the function' },
        { n: 2, note: 'declares a' },
        { n: 3, note: 'declares b' },
        { n: 4, note: 'closes the function' },
      ],
      why: 'the function did nothing',
    });
    expect(r).toEqual({ ok: true });
  });

  it('never refuses for coverage, whatever the count', () => {
    for (const count of [1, 2, 3, 4]) {
      const lines = Array.from({ length: count }, (_, i) => ({ n: i + 1, note: `note ${i}` }));
      expect(validateExplanation(edit(), { lines, why: 'because' }).ok, `${count} notes`).toBe(true);
    }
  });
});

describe('shell notes get room for the flags', () => {
  const shell = () => explainableLines('Bash', { command: 'find . -name "*.tmp" -exec rm {} \\;' })!;

  it('accepts a note that names each flag', () => {
    const note =
      'searches from here down; -name matches the pattern, -exec runs rm on each hit, and the escaped semicolon marks where that command ends';
    expect(validateExplanation(shell(), { lines: [{ n: 1, note }], why: 'clearing temp files' })).toEqual(
      { ok: true },
    );
  });

  it('holds code to the tighter cap', () => {
    const note = 'word '.repeat(40);
    const code = explainableLines('Write', { file_path: '/a.ts', content: 'const a = 1' })!;
    expect(validateExplanation(code, { lines: [{ n: 1, note }], why: 'x' }).ok).toBe(false);
  });
});

describe('validateExplanation', () => {
  const ex = { target: '/a.ts', lines: ['const a = 1', '', 'return a'], context: new Set<number>() };

  it('accepts a note on every non-blank line', () => {
    const r = validateExplanation(ex, {
      lines: [
        { n: 1, note: 'declares a' },
        { n: 3, note: 'hands it back' },
      ],
      why: 'because',
    });
    expect(r).toEqual({ ok: true });
  });

  it('refuses only when there is no explanation at all', () => {
    const r = validateExplanation(ex, { lines: [], why: 'because' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('at least one note');
  });

  // Out-of-range numbers are no longer an error in themselves — the agent
  // numbers by file position — but the count still has to be right.
  it('accepts an out-of-range number when the count matches', () => {
    const r = validateExplanation(ex, {
      lines: [
        { n: 40, note: 'declares a' },
        { n: 42, note: 'hands it back' },
      ],
      why: 'because',
    });
    expect(r).toEqual({ ok: true });
  });

  it('lays duplicate numbering onto the lines in order rather than refusing', () => {
    const notes = [
      { n: 1, note: 'first' },
      { n: 1, note: 'second' },
    ];
    expect(validateExplanation(ex, { lines: notes, why: 'because' })).toEqual({ ok: true });
    expect(alignNotes(ex, notes)).toEqual([
      { n: 1, note: 'first' },
      { n: 3, note: 'second' },
    ]);
  });

  it('enforces the brevity cap that the README asks for', () => {
    const r = validateExplanation(ex, {
      lines: [
        { n: 1, note: 'word '.repeat(40) },
        { n: 3, note: 'fine' },
      ],
      why: 'because',
    });
    expect(r.ok === false && r.error).toContain('exceed');
  });

  it('caps the wider "why" section too', () => {
    const r = validateExplanation(ex, {
      lines: [
        { n: 1, note: 'a' },
        { n: 3, note: 'b' },
      ],
      why: 'word '.repeat(200),
    });
    expect(r.ok === false && r.error).toContain('why');
  });
});
