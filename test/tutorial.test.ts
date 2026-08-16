import { describe, expect, it } from 'vitest';
import { type LaunchEnv, isVsCode, planLaunch } from '../src/core/open-editor.js';
import { tutorialPath } from '../src/core/paths.js';
import { isFinished, renderTutorial, wrap } from '../src/core/tutorial.js';

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    n: i + 1,
    code: `const value${i + 1} = ${i + 1}`,
    note: `sets value${i + 1}`,
  }));

describe('wrap', () => {
  it('breaks on words, never mid-word', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('keeps a word longer than the width on its own line', () => {
    expect(wrap('supercalifragilistic x', 5)).toEqual(['supercalifragilistic', 'x']);
  });

  it('returns nothing for empty input', () => {
    expect(wrap('   ', 10)).toEqual([]);
  });
});

describe('renderTutorial', () => {
  const short = { target: 'src/auth.ts', why: 'tokens never expired', lines: lines(2) };

  it('is deterministic', () => {
    expect(renderTutorial(short)).toBe(renderTutorial(short));
  });

  it('names the file and the reason', () => {
    const text = renderTutorial(short);
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('Why: tokens never expired');
  });

  it('shows a copyable block and the line-by-line for a short change', () => {
    const text = renderTutorial(short);
    expect(text).toContain('## Type this');
    expect(text).toContain('## Line by line');
    expect(text).toContain('└ sets value1');
  });

  // The block costs a row per line; past this it pushes the notes off screen.
  it('drops the copyable block once the change is long', () => {
    const text = renderTutorial({ target: 'a.ts', lines: lines(20) });
    expect(text).not.toContain('## Type this');
    expect(text).toContain('## Line by line');
    expect(text).toContain('sets value20');
  });

  it('fences with the language of the target', () => {
    expect(renderTutorial({ target: 'x.py', lines: lines(1) })).toContain('```python');
    expect(renderTutorial({ target: 'shell', lines: lines(1) })).toContain('```bash');
    expect(renderTutorial({ target: 'x.unknown', lines: lines(1) })).toContain('```\n');
  });

  // It is read in a ~50 column editor split.
  it('keeps every line inside the narrow pane', () => {
    const text = renderTutorial({
      target: 'src/auth.ts',
      why: 'a genuinely long reason '.repeat(12),
      lines: [{ n: 1, code: 'const a = 1', note: 'a very long note about this line '.repeat(6) }],
    });
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
  });

  it('aligns wrapped notes under the arrow, not repeating it', () => {
    const text = renderTutorial({
      target: 'a.ts',
      lines: [{ n: 1, code: 'x', note: 'word '.repeat(30) }],
    });
    expect(text.match(/└/g)).toHaveLength(1);
  });

  it('right-aligns line numbers so the code column stays straight', () => {
    const text = renderTutorial({ target: 'a.ts', lines: lines(10) });
    expect(text).toContain(' 1  const value1');
    expect(text).toContain('10  const value10');
  });

  it('ends with the checkbox that is the finish button', () => {
    const text = renderTutorial(short);
    expect(text).toContain("- [ ] I'm done");
    expect(text).toContain('let-me-explain done');
    expect(isFinished(text)).toBe(false);
  });
});

describe('isFinished', () => {
  it('is false until the box is ticked', () => {
    expect(isFinished(renderTutorial({ target: 'a.ts', lines: lines(1) }))).toBe(false);
  });

  it('accepts any spacing or case the learner types', () => {
    expect(isFinished('- [x] done')).toBe(true);
    expect(isFinished('- [X] done')).toBe(true);
    expect(isFinished('-  [ x ] done')).toBe(true);
    expect(isFinished('notes\n\n- [x] I am done\n')).toBe(true);
  });

  // A pause in typing is thinking, not finishing.
  it('is not fooled by an x elsewhere in the file', () => {
    expect(isFinished('const x = 1\n- [ ] not yet')).toBe(false);
  });
});

describe('tutorialPath', () => {
  const env = { home: '/home/x' };

  it('keeps same-named files in different folders apart', () => {
    const a = tutorialPath(env, 's1', 'src/a/index.ts');
    const b = tutorialPath(env, 's1', 'src/b/index.ts');
    expect(a).not.toBe(b);
    expect(a).toContain('index.ts');
  });

  it('is stable for the same target', () => {
    expect(tutorialPath(env, 's1', 'src/a/index.ts')).toBe(tutorialPath(env, 's1', 'src/a/index.ts'));
  });
});

describe('planLaunch', () => {
  const env = (over: Partial<LaunchEnv> = {}): LaunchEnv => ({
    platform: 'linux',
    has: () => false,
    ...over,
  });

  const target = { tutorialPath: '/state/TRY-auth.ts.md', targetPath: 'src/auth.ts', line: 14 };

  it('detects VS Code from either signal', () => {
    expect(isVsCode(env({ termProgram: 'vscode' }))).toBe(true);
    expect(isVsCode(env({ claudeSsePort: '55177' }))).toBe(true);
    expect(isVsCode(env())).toBe(false);
  });

  it('opens the tutorial first so the target takes focus', () => {
    const plan = planLaunch(env({ termProgram: 'vscode', has: (c) => c === 'code' }), target);
    expect(plan).toEqual([
      { command: 'code', args: ['-r', '/state/TRY-auth.ts.md'] },
      { command: 'code', args: ['-r', '-g', 'src/auth.ts:14'] },
    ]);
  });

  it('puts the caret where the change starts', () => {
    const plan = planLaunch(env({ termProgram: 'vscode', has: (c) => c === 'code' }), {
      ...target,
      line: 1,
    });
    expect(plan[1]?.args).toContain('src/auth.ts:1');
  });

  it('accepts a VS Code fork', () => {
    const plan = planLaunch(env({ termProgram: 'vscode', has: (c) => c === 'cursor' }), target);
    expect(plan[0]?.command).toBe('cursor');
  });

  it('falls back to a terminal when VS Code is not in use', () => {
    const plan = planLaunch(env({ has: (c) => c === 'gnome-terminal' || c === 'nano' }), target);
    expect(plan).toEqual([
      {
        command: 'gnome-terminal',
        args: ['--title=let-me-try — auth.ts', '--', 'nano', 'src/auth.ts'],
      },
    ]);
  });

  it('respects $EDITOR over what happens to be installed', () => {
    const plan = planLaunch(
      env({ editor: 'vim', has: (c) => c === 'gnome-terminal' || c === 'nano' }),
      target,
    );
    expect(plan[0]?.args).toContain('vim');
  });

  it('uses the right flag shape per terminal', () => {
    const xterm = planLaunch(env({ has: (c) => c === 'xterm' }), target);
    expect(xterm[0]?.args.slice(0, 2)).toEqual(['-T', 'let-me-try — auth.ts']);
    expect(xterm[0]?.args).toContain('-e');
  });

  // Asserting only the command name let a broken macOS branch ship: `open -a
  // Terminal <file>` hands the file to Terminal as an argument rather than
  // opening an editor on it. Assert the whole argv.
  it('runs the editor in a new Terminal window on macOS', () => {
    const plan = planLaunch(env({ platform: 'darwin', editor: 'vim' }), target);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.command).toBe('osascript');
    const script = plan[0]?.args.join(' ') ?? '';
    expect(script).toContain('do script');
    expect(script).toContain('vim');
    expect(script).toContain('src/auth.ts');
  });

  it('uses Windows Terminal when it is installed', () => {
    const plan = planLaunch(env({ platform: 'win32', has: (c) => c === 'wt' }), target);
    expect(plan[0]?.command).toBe('wt');
    expect(plan[0]?.args).toContain('src/auth.ts');
    expect(plan[0]?.args).toContain('nano');
  });

  // Windows Terminal is not present on older Windows; without a fallback the
  // spawn fails silently and nothing opens.
  it('falls back to cmd when Windows Terminal is missing', () => {
    const plan = planLaunch(env({ platform: 'win32' }), target);
    expect(plan[0]?.command).toBe('cmd');
    expect(plan[0]?.args.join(' ')).toContain('start');
    expect(plan[0]?.args.join(' ')).toContain('src/auth.ts');
  });

  it('gives up rather than guessing when nothing is available', () => {
    expect(planLaunch(env(), target)).toEqual([]);
  });

  // Being in VS Code is not enough — the CLI has to exist too.
  it('falls back to a terminal if the code CLI is missing', () => {
    const plan = planLaunch(env({ termProgram: 'vscode', has: (c) => c === 'xterm' }), target);
    expect(plan[0]?.command).toBe('xterm');
  });
});