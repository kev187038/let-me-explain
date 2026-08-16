// Rendered for a ~50 column editor split, not a full screen: prose wraps
// short, and the code is not duplicated when the change is long enough that
// duplicating it would push the notes off screen.

const WRAP = 60;
const CODE_BLOCK_MAX_LINES = 15;

export interface TutorialLine {
  n: number;
  code: string;
  note?: string;
}

export interface TutorialInput {
  target: string;
  why?: string;
  lines: TutorialLine[];
}

const LANGUAGES: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  css: 'css',
  html: 'html',
  md: 'markdown',
};

function languageFor(target: string): string {
  if (target === 'shell') return 'bash';
  const ext = target.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGES[ext] ?? '';
}

export function wrap(text: string, width: number, indent = ''): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const out: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length + indent.length > width && line.length > 0) {
      out.push(indent + line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) out.push(indent + line);
  return out;
}

export function renderTutorial(input: TutorialInput): string {
  const { target, why, lines } = input;
  const out: string[] = [`# Write this yourself`, ``, `\`${target}\``, ``];

  if (why) {
    out.push(...wrap(`Why: ${why}`, WRAP), ``);
  }

  // Duplicating the code costs one row per line, so it only earns its place
  // while the whole tutorial still fits on one screen.
  if (lines.length <= CODE_BLOCK_MAX_LINES) {
    out.push(`## Type this`, ``, '```' + languageFor(target));
    for (const line of lines) out.push(line.code);
    out.push('```', ``);
  }

  out.push(`## Line by line`, ``, '```');
  const width = String(lines.at(-1)?.n ?? 1).length;
  const pad = ' '.repeat(width + 2);
  for (const line of lines) {
    out.push(`${String(line.n).padStart(width)}  ${line.code}`);
    if (line.note) {
      // Only the first wrapped row carries the arrow; the rest align under it.
      for (const [i, text] of wrap(line.note, WRAP - pad.length - 2).entries()) {
        out.push(`${pad}${i === 0 ? '└ ' : '  '}${text}`);
      }
    }
    out.push('');
  }
  if (out.at(-1) === '') out.pop();
  out.push('```', ``);

  // The finish signal lives here rather than in a save of the code file: a
  // pause in typing is thinking, not finishing, and guessing wrong ends the
  // try for good. Ticking a box is unambiguous. It has to be an *edit* — an
  // unmodified file is not written on save, so watching for a plain save of
  // this file would never fire.
  out.push(`---`, ``, `## Finished?`, ``);
  out.push(...wrap(`Put an x in the box and save this file.`, WRAP));
  out.push(``, `- [ ] I'm done`, ``);
  out.push(...wrap(`Take as long as you like — nothing else ends the wait.`, WRAP));
  out.push(`From a terminal instead: let-me-explain done`);

  return `${out.join('\n')}\n`;
}

// Matches "- [x]" with any spacing or case.
const TICKED = /^\s*-\s*\[\s*[xX]\s*\]/m;

export function isFinished(tutorial: string): boolean {
  return TICKED.test(tutorial);
}