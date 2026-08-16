import { describe, expect, it } from 'vitest';
import { validateExplanation } from '../src/core/explanation.js';
import { explainableLines, requiredLineNumbers } from '../src/core/lines.js';

describe('explainableLines', () => {
  it('reads the new side of an Edit, never the old', () => {
    const ex = explainableLines('Edit', {
      file_path: '/a.ts',
      old_string: 'gone\nalso gone',
      new_string: 'one\ntwo',
    });
    expect(ex).toEqual({ target: '/a.ts', lines: ['one', 'two'] });
  });

  it('reads Write content and Bash commands', () => {
    expect(explainableLines('Write', { file_path: '/b.ts', content: 'a\nb' })?.lines).toEqual([
      'a',
      'b',
    ]);
    expect(explainableLines('Bash', { command: 'ls -la' })).toEqual({
      target: 'shell',
      lines: ['ls -la'],
    });
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
    expect(requiredLineNumbers(['a', '', '  ', 'b'])).toEqual([1, 4]);
  });
});

describe('validateExplanation', () => {
  const ex = { target: '/a.ts', lines: ['const a = 1', '', 'return a'] };

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

  it('names the lines it is missing', () => {
    const r = validateExplanation(ex, { lines: [{ n: 1, note: 'declares a' }], why: 'because' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('3');
  });

  it('rejects a line number past the end of the change', () => {
    const r = validateExplanation(ex, { lines: [{ n: 9, note: 'nope' }], why: 'because' });
    expect(r.ok === false && r.error).toContain('does not exist');
  });

  it('rejects the same line explained twice', () => {
    const r = validateExplanation(ex, {
      lines: [
        { n: 1, note: 'a' },
        { n: 1, note: 'b' },
      ],
      why: 'because',
    });
    expect(r.ok === false && r.error).toContain('twice');
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
