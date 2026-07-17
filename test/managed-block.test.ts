import { describe, expect, it } from 'vitest';
import {
  BlockCorruptionError,
  removeBlock,
  scanBlock,
  upsertBlock,
} from '../src/core/managed-block.js';

const BODY = '## Teach me\n\nExplain the why.';
const BODY2 = '## Teach me v2\n\nExplain everything.';
const V = '0.1.0';

function block(body = BODY, version = V): string {
  return upsertBlock(null, body, version).content;
}

describe('upsertBlock — insert/append', () => {
  it('creates a new file when content is null', () => {
    const { content, action } = upsertBlock(null, BODY, V);
    expect(action).toBe('created-file');
    expect(content).toMatch(/^<!-- BEGIN let-me-explain v0\.1\.0 /);
    expect(content).toMatch(/<!-- END let-me-explain -->\n$/);
    expect(content).toContain(BODY);
  });

  it('appends to an empty existing file', () => {
    const { content, action } = upsertBlock('', BODY, V);
    expect(action).toBe('appended');
    expect(content).toBe(block());
  });

  it('appends after existing content with one blank-line separator', () => {
    const { content, action } = upsertBlock('# My notes\n', BODY, V);
    expect(action).toBe('appended');
    expect(content).toBe(`# My notes\n\n${block()}`);
  });

  it('terminates an unterminated last line before appending', () => {
    const { content } = upsertBlock('# My notes', BODY, V);
    expect(content).toBe(`# My notes\n\n${block()}`);
  });

  it('preserves existing trailing blank lines byte-for-byte', () => {
    const { content } = upsertBlock('# My notes\n\n\n', BODY, V);
    expect(content).toBe(`# My notes\n\n\n\n${block()}`);
  });
});

describe('upsertBlock — replace', () => {
  it('replaces an existing block in place, preserving prefix and suffix bytes', () => {
    const pre = '# before\nweird  spacing\t\n\n';
    const post = '\n\n# after\nno trailing newline';
    const original = pre + block() + post;
    const { content, action } = upsertBlock(original, BODY2, '0.2.0');
    expect(action).toBe('replaced');
    expect(content.startsWith(pre)).toBe(true);
    expect(content.endsWith(post)).toBe(true);
    expect(content).toContain(BODY2);
    expect(content).not.toContain(BODY);
    expect(content).toContain('v0.2.0');
  });

  it('replaces a block from an older version (sentinel matches any v*)', () => {
    const original = block(BODY, '0.0.1');
    const { content, action } = upsertBlock(original, BODY2, V);
    expect(action).toBe('replaced');
    expect(scanBlock(content)).toMatchObject({ state: 'present', version: V, body: BODY2 });
  });

  it('replaces a hand-edited body', () => {
    const original = block().replace('Explain the why.', 'user vandalized this');
    const { content } = upsertBlock(original, BODY, V);
    expect(scanBlock(content).body).toBe(BODY);
  });

  it('is idempotent: upserting twice is byte-equal to upserting once', () => {
    const once = upsertBlock('# notes\n', BODY, V).content;
    const twice = upsertBlock(once, BODY, V).content;
    expect(twice).toBe(once);
  });
});

describe('CRLF handling', () => {
  it('emits the block with CRLF when the file uses CRLF', () => {
    const { content } = upsertBlock('# notes\r\n', BODY, V);
    expect(content).toContain('\r\n<!-- BEGIN');
    expect(content).toMatch(/<!-- END let-me-explain -->\r\n$/);
    expect(content).toContain('## Teach me\r\n');
    // no bare-LF lines snuck in
    expect(content.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('round-trips a CRLF file', () => {
    const original = '# notes\r\n';
    const installed = upsertBlock(original, BODY, V).content;
    expect(removeBlock(installed).content).toBe(original);
  });

  it('scan normalizes body to LF regardless of file line endings', () => {
    const installed = upsertBlock('# notes\r\n', BODY, V).content;
    expect(scanBlock(installed).body).toBe(BODY);
  });
});

describe('round-trips: removeBlock(upsertBlock(x)) === x', () => {
  const cases: Array<[name: string, original: string]> = [
    ['empty file', ''],
    ['single line with newline', '# hello\n'],
    ['multi-line content', '# a\n\nsome text\n- bullet\n'],
    ['content with trailing blank lines', '# a\n\n\n'],
    ['content that mentions BEGIN casually', 'BEGIN let-me-explain is cool\n'],
  ];

  for (const [name, original] of cases) {
    it(`round-trips: ${name}`, () => {
      const installed = upsertBlock(original, BODY, V).content;
      expect(removeBlock(installed)).toEqual({ content: original, removed: true });
    });
  }

  it('file without trailing newline gains exactly one (documented exception)', () => {
    const installed = upsertBlock('# hello', BODY, V).content;
    expect(removeBlock(installed).content).toBe('# hello\n');
  });

  it('removing from a block-only file leaves an empty string', () => {
    expect(removeBlock(block()).content).toBe('');
  });

  it('remove is a no-op on content without a block', () => {
    expect(removeBlock('# nothing here\n')).toEqual({
      content: '# nothing here\n',
      removed: false,
    });
  });

  it('removes a block sitting between two sections', () => {
    const original = '# before\n\n# after\n';
    // simulate block installed mid-file (e.g. user moved it)
    const midFile = `# before\n\n${block()}\n# after\n`;
    const { content, removed } = removeBlock(midFile);
    expect(removed).toBe(true);
    expect(content).toBe(original);
  });
});

describe('scanBlock', () => {
  it('reports absent on empty and block-free content', () => {
    expect(scanBlock('').state).toBe('absent');
    expect(scanBlock('# just notes\n').state).toBe('absent');
  });

  it('reports present with version and body', () => {
    expect(scanBlock(`# pre\n\n${block()}`)).toEqual({
      state: 'present',
      version: V,
      body: BODY,
    });
  });

  it('does not match sentinel text that is not on its own line', () => {
    const scan = scanBlock('text <!-- BEGIN let-me-explain v1 --> more\n');
    expect(scan.state).toBe('absent');
  });

  const corruptions: Array<[name: string, content: string, corruption: string]> = [
    [
      'BEGIN without END',
      '<!-- BEGIN let-me-explain v0.1.0 -- managed block -->\nbody\n',
      'begin-without-end',
    ],
    ['END without BEGIN', 'body\n<!-- END let-me-explain -->\n', 'end-without-begin'],
    [
      'END before BEGIN',
      '<!-- END let-me-explain -->\n<!-- BEGIN let-me-explain v0.1.0 -->\n',
      'end-without-begin',
    ],
    ['two full blocks', block() + '\n' + block(), 'multiple-blocks'],
  ];

  for (const [name, content, corruption] of corruptions) {
    it(`flags corruption: ${name}`, () => {
      expect(scanBlock(content)).toEqual({ state: 'corrupted', corruption });
    });

    it(`upsertBlock throws on corruption: ${name}`, () => {
      expect(() => upsertBlock(content, BODY, V)).toThrow(BlockCorruptionError);
    });

    it(`removeBlock throws on corruption: ${name}`, () => {
      expect(() => removeBlock(content)).toThrow(BlockCorruptionError);
    });
  }
});
