import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

// The daemon's discovery and path rules are duplicated here rather than
// imported: this is a separate build targeting the VS Code runtime, and the
// twenty lines below are cheaper than wiring a shared package into it. They
// must stay in step with src/core/paths.ts and src/core/discovery.ts.

const POLL_MS = 2_000;

interface Address {
  port: number;
  token: string;
}

interface Attempt {
  sessionId: string;
  target: string;
}

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return join(xdg, 'let-me-explain');
  if (process.env.APPDATA) return join(process.env.APPDATA, 'let-me-explain', 'state');
  return join(process.env.HOME ?? homedir(), '.local', 'state', 'let-me-explain');
}

function portFile(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime
    ? join(runtime, 'let-me-explain', 'daemon.json')
    : join(stateDir(), 'run', 'daemon.json');
}

async function address(): Promise<Address | null> {
  try {
    const data = JSON.parse(await readFile(portFile(), 'utf8')) as Partial<Address>;
    return typeof data.port === 'number' && typeof data.token === 'string'
      ? { port: data.port, token: data.token }
      : null;
  } catch {
    return null;
  }
}

async function call(path: string, init: RequestInit = {}): Promise<unknown | null> {
  const at = await address();
  if (!at) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${at.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${at.token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    // The daemon not running is the normal state, not an error worth showing.
    return null;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const button = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  button.command = 'letMeExplain.done';
  button.tooltip = 'Hand your work back to Claude for review';
  button.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  let current: Attempt | null = null;

  const finish = vscode.commands.registerCommand('letMeExplain.done', async () => {
    if (!current) {
      void vscode.window.showInformationMessage('let-me-explain: nothing is waiting on you.');
      return;
    }
    const body = (await call('/done', {
      method: 'POST',
      body: JSON.stringify({ sessionId: current.sessionId, target: current.target }),
    })) as { ok?: boolean } | null;

    if (body?.ok) {
      button.hide();
      current = null;
      void vscode.window.setStatusBarMessage('let-me-explain: handed back to Claude', 4_000);
    } else {
      void vscode.window.showWarningMessage('let-me-explain: could not reach the daemon.');
    }
  });

  // Polling rather than a socket: the daemon may not be running, may restart,
  // and may be on a different port each time. A 2s poll of a loopback endpoint
  // costs nothing and needs no reconnection logic.
  const timer = setInterval(() => {
    void (async () => {
      const body = (await call('/active')) as { tries?: Attempt[] } | null;
      const attempt = body?.tries?.[0] ?? null;
      current = attempt;

      if (!attempt) {
        button.hide();
        return;
      }
      const name = attempt.target.split(/[\\/]/).pop() ?? attempt.target;
      button.text = `$(check) I'm done — ${name}`;
      button.show();
    })();
  }, POLL_MS);

  context.subscriptions.push(button, finish, { dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
  // Nothing to tear down: the interval is disposed with the context.
}