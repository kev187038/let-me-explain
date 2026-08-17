import * as vscode from 'vscode';
import {
  type Attempt,
  type Held,
  activeTry,
  allow,
  buttonLabel,
  fileName,
  finishTry,
  letMeTry,
  pendingDecision,
} from './daemon.js';

// UI wiring only. Everything that talks to the daemon lives in daemon.ts so the
// end-to-end test can run the buttons' real logic without a VS Code host.

const POLL_MS = 2_000;

export function activate(context: vscode.ExtensionContext): void {
  const warning = new vscode.ThemeColor('statusBarItem.warningBackground');

  // Rightmost first: the three items share a row, and priority orders them.
  const done = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  done.command = 'letMeExplain.done';
  done.tooltip = 'Hand your work back to Claude for review';
  done.backgroundColor = warning;

  const allowItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  allowItem.command = 'letMeExplain.allow';
  allowItem.backgroundColor = warning;

  const tryItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  tryItem.command = 'letMeExplain.letMeTry';
  tryItem.backgroundColor = warning;

  let attempt: Attempt | null = null;
  let held: Held | null = null;
  // The try we have already announced, so the notification fires once per try
  // rather than on every poll.
  let announced: string | null = null;

  const unreachable = () =>
    void vscode.window.showWarningMessage('let-me-explain: could not reach the daemon.');

  const finish = vscode.commands.registerCommand('letMeExplain.done', async () => {
    if (!attempt) {
      void vscode.window.showInformationMessage('let-me-explain: nothing is waiting on you.');
      return;
    }
    if (await finishTry(attempt)) {
      done.hide();
      attempt = null;
      void vscode.window.setStatusBarMessage('let-me-explain: handed back to Claude', 4_000);
    } else {
      unreachable();
    }
  });

  // Both decisions hide the row immediately: the daemon has been told, and
  // leaving a live-looking button up invites a second click on a dead ticket.
  function resolved(message: string) {
    held = null;
    allowItem.hide();
    tryItem.hide();
    void vscode.window.setStatusBarMessage(message, 4_000);
  }

  const approve = vscode.commands.registerCommand('letMeExplain.allow', async () => {
    if (!held) return;
    if (await allow(held)) resolved('let-me-explain: change allowed');
    else unreachable();
  });

  const takeOver = vscode.commands.registerCommand('letMeExplain.letMeTry', async () => {
    if (!held) return;
    if (await letMeTry(held)) resolved('let-me-explain: writing it yourself — a tutorial will open');
    else unreachable();
  });

  // Polling rather than a socket: the daemon may not be running, may restart,
  // and gets a fresh port each time. A 2s poll of a loopback endpoint costs
  // nothing and needs no reconnection logic.
  const timer = setInterval(() => {
    void (async () => {
      attempt = await activeTry();
      if (attempt) {
        done.text = buttonLabel(attempt);
        done.show();
        // A status-bar item in the corner is easy to miss when your attention
        // is on the file you are typing. Announce each new try once — and make
        // the notification itself the button, so it can be answered without
        // hunting for the bar.
        const id = `${attempt.sessionId}:${attempt.target}`;
        if (id !== announced) {
          announced = id;
          const name = fileName(attempt.target);
          void vscode.window
            .showInformationMessage(
              `let-me-explain: type ${name} yourself, then say when you are done.`,
              "✓ I'm done",
            )
            .then((picked) => {
              if (picked) void vscode.commands.executeCommand('letMeExplain.done');
            });
        }
      } else {
        done.hide();
        announced = null;
      }

      held = await pendingDecision();
      if (!held) {
        allowItem.hide();
        tryItem.hide();
        return;
      }
      // The explanation itself goes in the tooltip: the status bar has room for
      // a verb and a filename, and hovering is where the reading happens.
      const tooltip = new vscode.MarkdownString(`\`\`\`\n${held.explanation}\n\`\`\``);
      allowItem.text = `$(check) Allow — ${fileName(held.target)}`;
      allowItem.tooltip = tooltip;
      tryItem.text = '$(edit) Let me try';
      tryItem.tooltip = tooltip;
      allowItem.show();
      tryItem.show();
    })();
  }, POLL_MS);

  context.subscriptions.push(done, allowItem, tryItem, finish, approve, takeOver, {
    dispose: () => clearInterval(timer),
  });
}

export function deactivate(): void {
  // Nothing to tear down: the interval is disposed with the context.
}
