import * as vscode from 'vscode';
import { type Attempt, activeTry, buttonLabel, finishTry } from './daemon.js';

// UI wiring only. Everything that talks to the daemon lives in daemon.ts so the
// end-to-end test can run the button's real logic without a VS Code host.

const POLL_MS = 2_000;

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
    if (await finishTry(current)) {
      button.hide();
      current = null;
      void vscode.window.setStatusBarMessage('let-me-explain: handed back to Claude', 4_000);
    } else {
      void vscode.window.showWarningMessage('let-me-explain: could not reach the daemon.');
    }
  });

  // Polling rather than a socket: the daemon may not be running, may restart,
  // and gets a fresh port each time. A 2s poll of a loopback endpoint costs
  // nothing and needs no reconnection logic.
  const timer = setInterval(() => {
    void (async () => {
      current = await activeTry();
      if (!current) {
        button.hide();
        return;
      }
      button.text = buttonLabel(current);
      button.show();
    })();
  }, POLL_MS);

  context.subscriptions.push(button, finish, { dispose: () => clearInterval(timer) });
}

export function deactivate(): void {
  // Nothing to tear down: the interval is disposed with the context.
}
