import { spawn } from 'node:child_process';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { accessSync, constants } from 'node:fs';
import type { PendingView } from '../contracts/index.js';
import { type LaunchEnv, planLaunch } from '../core/open-editor.js';
import { type Env, tutorialDir, tutorialPath } from '../core/paths.js';
import { isFinished, renderTutorial } from '../core/tutorial.js';
import type { FsIo } from '../io/fs-io.js';

// Reading the tutorial back after a save is cheap, but editors can emit
// several events for one write; this collapses them.
const SETTLE_MS = 50;

export interface TryOutcome {
  status: 'done' | 'waiting';
  target: string;
  /** What is on disk — the learner's own work. */
  learnerWrote: string;
  /** The code the agent proposed, captured before the learner touched it. */
  agentIntended: string;
  tutorial: string;
}

export interface SessionEnv {
  termProgram?: string;
  claudeSsePort?: string;
  editor?: string;
}

function onPath(command: string): boolean {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  return dirs.some((dir) => {
    try {
      accessSync(resolve(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export type Launcher = (
  env: LaunchEnv,
  paths: { tutorialPath: string; targetPath: string; line: number },
) => void;

// Injected so tests never open a real window.
export const spawnLauncher: Launcher = (env, paths) => {
  for (const { command, args } of planLaunch(env, paths)) {
    try {
      spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // A window that will not open must not take the session down with it.
    }
  }
};

/**
 * `onFinished` retires the ticket a try was answering. Without it the ticket
 * outlives the try — `viewFor` deliberately keeps try-resolved tickets visible
 * so a tutorial can be reopened, and nothing ever told it the try was over.
 */
export function createTryStore(
  env: Env,
  io: FsIo,
  launch: Launcher = spawnLauncher,
  onFinished: (ticket: string) => void = () => {},
) {
  interface Attempt {
    target: string;
    /** The ticket this try answers, retired when the try ends. */
    ticket?: string;
    tutorial: string;
    agentIntended: string;
    waiters: ((o: TryOutcome) => void)[];
    watcher?: FSWatcher;
    quiet?: NodeJS.Timeout;
    deadline?: NodeJS.Timeout;
  }

  const attempts = new Map<string, Attempt>();
  // Tries chosen before the agent made its tool call, so there was no code to
  // put in the tutorial yet. Held here until the hook arrives carrying it.
  const armed = new Map<string, { at: number; cwd: string; sessionEnv: SessionEnv }>();
  // Tries the learner has finished. Kept so a repeat of the same tool call is
  // refused outright instead of asking them to approve overwriting their work.
  const finished = new Map<string, { at: number; agentIntended: string }>();
  const key = (sessionId: string, target: string) => `${sessionId}:${target}`;

  // Rewrites the tutorial in place so an open editor buffer updates rather
  // than vanishing. Best-effort: losing the banner must not fail the handoff.
  async function markFinished(tutorial: string): Promise<void> {
    try {
      const text = await readFile(tutorial, 'utf8');
      await io.writeFileAtomic(
        tutorial,
        `${text.trimEnd()}\n\n---\n\n## Handed back ✓\n\nClaude has your version and is comparing it with what it would have written.\nThis file is yours to keep — \`let-me-explain clean\` removes it when you are done.\n`,
      );
    } catch {
      // The tutorial may already be gone; nothing here is worth failing for.
    }
  }

  async function settle(id: string, status: TryOutcome['status']): Promise<void> {
    const attempt = attempts.get(id);
    if (!attempt) return;

    if (attempt.quiet) clearTimeout(attempt.quiet);
    if (attempt.deadline) clearTimeout(attempt.deadline);
    attempt.deadline = undefined;
    attempt.watcher?.close();

    const learnerWrote = await readFile(attempt.target, 'utf8').catch(() => '');
    const outcome: TryOutcome = {
      status,
      target: attempt.target,
      learnerWrote,
      agentIntended: attempt.agentIntended,
      tutorial: attempt.tutorial,
    };

    for (const resolveWaiter of attempt.waiters) resolveWaiter(outcome);
    attempt.waiters = [];

    if (status === 'done') {
      attempts.delete(id);
      if (attempt.ticket) onFinished(attempt.ticket);
      finished.set(id, { at: Date.now(), agentIntended: attempt.agentIntended });
      // The tutorial is kept, not deleted. Removing it pulled the document out
      // from under the learner while it was still open in their editor, taking
      // the explanation with it exactly when they were reading the feedback.
      // It ages out with the rest, or goes on `let-me-explain clean`.
      await markFinished(attempt.tutorial);
    }
  }

  return {
    // Waiting is separate from opening because the two happen in different
    // places: `let_me_try` opens and returns at once, and the *hook* on the
    // agent's retry is what parks. The hook has a far larger timeout budget
    // than an MCP call, so the learner gets one long wait instead of dozens of
    // short ones. Returns null when no try is in flight for this target.
    waitFor(sessionId: string, target: string, timeoutMs: number): Promise<TryOutcome> | null {
      const id = key(sessionId, target);
      const attempt = attempts.get(id);
      if (!attempt) return null;
      return new Promise<TryOutcome>((resolveWaiter) => {
        attempt.waiters.push(resolveWaiter);
        // One deadline per attempt, re-armed by each new wait. Leaving the old
        // timer running would let a deadline armed by an earlier retry cut a
        // later one short, shrinking the budget every time.
        if (attempt.deadline) clearTimeout(attempt.deadline);
        attempt.deadline = setTimeout(() => void settle(id, 'waiting'), timeoutMs);
        attempt.deadline.unref();
      });
    },

    inFlight(sessionId: string, target: string): boolean {
      return attempts.has(key(sessionId, target));
    },

    /**
     * True when this tool call is the agent re-attempting a change the learner
     * has already taken over — the *same code it proposed last time*, arriving
     * again after they typed their own version.
     *
     * It compares against what the agent intended, not what the learner wrote,
     * and that is deliberate: the learner's version is usually different (that
     * is the point), so comparing to it would let the repeat through and the
     * learner would be asked to approve overwriting their own work.
     *
     * Callers must skip this when a new round is already under way — see
     * `isArmed` — or a legitimate follow-up gets mistaken for a repeat.
     */
    alreadyWritten(sessionId: string, target: string, code: string, ttlMs: number): boolean {
      const done = finished.get(key(sessionId, target));
      if (!done) return false;
      if (Date.now() - done.at > ttlMs) {
        finished.delete(key(sessionId, target));
        return false;
      }
      return done.agentIntended.trim() === code.trim();
    },

    // The learner said "let me try" from the menu, before the tool call.
    arm(sessionId: string, target: string, cwd: string, sessionEnv: SessionEnv): void {
      armed.set(key(sessionId, target), { at: Date.now(), cwd, sessionEnv });
    },

    /** Whether the learner has asked to type this one, without consuming it. */
    isArmed(sessionId: string, target: string): boolean {
      return armed.has(key(sessionId, target));
    },

    /** The armed intent, if one is still fresh. Reading it clears it. */
    takeArmed(
      sessionId: string,
      target: string,
      ttlMs: number,
    ): { cwd: string; sessionEnv: SessionEnv } | null {
      const id = key(sessionId, target);
      const intent = armed.get(id);
      if (!intent) return null;
      armed.delete(id);
      // An intent the agent never followed up on must not ambush a later,
      // unrelated change to the same file.
      return Date.now() - intent.at > ttlMs
        ? null
        : { cwd: intent.cwd, sessionEnv: intent.sessionEnv };
    },

    async begin(
      view: PendingView,
      sessionId: string,
      cwd: string,
      sessionEnv: SessionEnv,
    ): Promise<{ tutorial: string; target: string }> {
      const id = key(sessionId, view.target);
      const existing = attempts.get(id);
      if (existing) return { tutorial: existing.tutorial, target: existing.target };

      const targetPath = resolve(cwd, view.target);
      const tutorial = tutorialPath(env, sessionId, view.target);
      const agentIntended = view.lines.map((l) => l.code).join('\n');

      await mkdir(tutorialDir(env, sessionId), { recursive: true });
      await io.writeFileAtomic(
        tutorial,
        renderTutorial({ target: view.target, ...(view.why ? { why: view.why } : {}), lines: view.lines }),
      );

      // Created empty first so the editor never opens a phantom buffer.
      await mkdir(dirname(targetPath), { recursive: true }).catch(() => {});
      if (!(await io.fileExists(targetPath))) await io.writeFileAtomic(targetPath, '');

      const attempt: Attempt = {
        target: targetPath,
        tutorial,
        agentIntended,
        waiters: [],
        ...(view.ticket ? { ticket: view.ticket } : {}),
      };
      attempts.set(id, attempt);

      launch(
        { platform: process.platform, has: onPath, ...sessionEnv },
        { tutorialPath: tutorial, targetPath, line: 1 },
      );

      // The *tutorial* is watched, not the code file. A pause in typing is
      // thinking, not finishing — the learner says when they are done by
      // ticking the checkbox at the bottom of the tutorial.
      try {
        const name = basename(tutorial);
        attempt.watcher = watch(dirname(tutorial), (_event, changed) => {
          if (changed !== name) return;
          if (attempt.quiet) clearTimeout(attempt.quiet);
          attempt.quiet = setTimeout(() => {
            void readFile(tutorial, 'utf8')
              .then((text) => {
                if (isFinished(text)) void settle(id, 'done');
              })
              .catch(() => {});
          }, SETTLE_MS);
        });
      } catch {
        // No watcher: `let-me-explain done` still works.
      }

      return { tutorial, target: targetPath };
    },

    // Callers usually know neither the session id nor the target — the learner
    // types `let-me-explain done` and expects the obvious thing to happen. Only
    // ask them to disambiguate when there genuinely is a choice.
    async finish(
      sessionId?: string,
      target?: string,
    ): Promise<{ ok: true; target: string } | { ok: false; error: string }> {
      const candidates = [...attempts.entries()].filter(([id]) => {
        if (sessionId && !id.startsWith(`${sessionId}:`)) return false;
        if (target && !id.endsWith(`:${target}`)) return false;
        return true;
      });

      if (candidates.length === 0) return { ok: false, error: 'nothing is waiting on you' };
      if (candidates.length > 1) {
        const targets = candidates.map(([, a]) => a.target).join(', ');
        return { ok: false, error: `more than one is waiting: ${targets}. Name one with --target.` };
      }

      const [id, attempt] = candidates[0] as [string, Attempt];
      await settle(id, 'done');
      return { ok: true, target: attempt.target };
    },

    active(): number {
      return attempts.size;
    },

    // `target` is the key's target — the name the agent used — because that is
    // what finish() matches on. `path` is the resolved file, for display only.
    // Reporting the resolved path as `target` made the button post something
    // the daemon could not find.
    list(): { sessionId: string; target: string; path: string; tutorial: string }[] {
      return [...attempts.entries()].map(([id, attempt]) => {
        const split = id.indexOf(':');
        return {
          sessionId: id.slice(0, split),
          target: id.slice(split + 1),
          path: attempt.target,
          tutorial: attempt.tutorial,
        };
      });
    },

    close(): void {
      armed.clear();
      finished.clear();
      for (const attempt of attempts.values()) {
        if (attempt.quiet) clearTimeout(attempt.quiet);
        if (attempt.deadline) clearTimeout(attempt.deadline);
        attempt.watcher?.close();
      }
      attempts.clear();
    },
  };
}

export type TryStore = ReturnType<typeof createTryStore>;