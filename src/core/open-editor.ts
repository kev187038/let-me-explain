// Deciding *what* to launch is pure and testable; actually spawning it is not.
// They are separated here so every platform's argv can be asserted without a
// window ever opening.

export interface LaunchEnv {
  platform: NodeJS.Platform;
  termProgram?: string;
  claudeSsePort?: string;
  editor?: string;
  /** PATH lookup, injected so tests can fake an environment. */
  has: (command: string) => boolean;
}

export interface LaunchTarget {
  tutorialPath: string;
  targetPath: string;
  /** Where the change starts, so the caret lands there rather than at the top. */
  line: number;
}

export interface Launch {
  command: string;
  args: string[];
}

const VSCODE_CLIS = ['code', 'code-insiders', 'cursor', 'windsurf'];
const TERMINALS = ['gnome-terminal', 'x-terminal-emulator', 'konsole', 'alacritty', 'kitty', 'xterm'];
const EDITORS = ['nano', 'vim', 'nvim', 'micro', 'helix'];

// The path is embedded in an AppleScript string literal, so quotes and
// backslashes in it have to survive two levels of escaping.
function shellQuote(path: string): string {
  return path.replace(/(["\\$`])/g, '\\\\$1');
}

export function isVsCode(env: LaunchEnv): boolean {
  return env.termProgram === 'vscode' || Boolean(env.claudeSsePort);
}

function vsCodeCli(env: LaunchEnv): string | null {
  return VSCODE_CLIS.find((c) => env.has(c)) ?? null;
}

function terminalEditor(env: LaunchEnv): string {
  if (env.editor) return env.editor;
  return EDITORS.find((e) => env.has(e)) ?? 'nano';
}

// Ordered: the tutorial opens first so the target takes focus, because focus
// has to land where the learner types.
export function planLaunch(env: LaunchEnv, target: LaunchTarget): Launch[] {
  const cli = vsCodeCli(env);
  if (isVsCode(env) && cli) {
    return [
      { command: cli, args: ['-r', target.tutorialPath] },
      { command: cli, args: ['-r', '-g', `${target.targetPath}:${target.line}`] },
    ];
  }

  const editor = terminalEditor(env);
  const title = `let-me-try — ${target.targetPath.split(/[\\/]/).pop() ?? ''}`;

  // `open -a Terminal <file>` passes the file to Terminal as an argument, which
  // tries to *run* it. AppleScript is how you get a command into a new window.
  if (env.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "${editor} ${shellQuote(target.targetPath)}"`;
    return [{ command: 'osascript', args: ['-e', script] }];
  }

  if (env.platform === 'win32') {
    if (env.has('wt')) {
      return [
        { command: 'wt', args: ['-w', '0', 'nt', '--title', title, editor, target.targetPath] },
      ];
    }
    // Windows Terminal is absent on older Windows; `start` is always there.
    return [{ command: 'cmd', args: ['/c', 'start', title, editor, target.targetPath] }];
  }

  const terminal = TERMINALS.find((t) => env.has(t));
  if (!terminal) return [];

  if (terminal === 'xterm') {
    return [{ command: terminal, args: ['-T', title, '-e', editor, target.targetPath] }];
  }
  if (terminal === 'konsole') {
    return [{ command: terminal, args: ['-p', `tabtitle=${title}`, '-e', editor, target.targetPath] }];
  }
  if (terminal === 'alacritty' || terminal === 'kitty') {
    return [{ command: terminal, args: ['-T', title, '-e', editor, target.targetPath] }];
  }
  return [{ command: terminal, args: [`--title=${title}`, '--', editor, target.targetPath] }];
}