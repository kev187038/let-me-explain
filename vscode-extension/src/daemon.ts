import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Everything the button does, with no `vscode` import — so the end-to-end test
// presses the button by calling the same functions the click path runs, rather
// than a copy of them.
//
// The path and discovery rules are duplicated from the main package's
// src/core/paths.ts and src/core/discovery.ts, because this is a separate build
// targeting the VS Code runtime. They have to stay in step.

export interface Address {
  port: number;
  token: string;
}

export interface Attempt {
  sessionId: string;
  /** The name the agent used; this is what /done matches on. */
  target: string;
  /** The resolved file on disk, for display. */
  path?: string;
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'let-me-explain');
  if (env.APPDATA) return join(env.APPDATA, 'let-me-explain', 'state');
  return join(env.HOME ?? homedir(), '.local', 'state', 'let-me-explain');
}

export function portFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, 'let-me-explain', 'daemon.json')
    : join(stateDir(env), 'run', 'daemon.json');
}

export async function address(env: NodeJS.ProcessEnv = process.env): Promise<Address | null> {
  try {
    const data = JSON.parse(await readFile(portFile(env), 'utf8')) as Partial<Address>;
    return typeof data.port === 'number' && typeof data.token === 'string'
      ? { port: data.port, token: data.token }
      : null;
  } catch {
    return null;
  }
}

async function call(
  path: string,
  init: RequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown | null> {
  const at = await address(env);
  if (!at) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${at.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${at.token}`,
        'content-type': 'application/json',
        'x-let-me-explain-client': 'buttons/1',
        ...init.headers,
      },
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    // The daemon not running is the normal state, not an error worth surfacing.
    return null;
  }
}

export interface Held {
  ticket: string;
  sessionId: string;
  target: string;
  why?: string;
  /** The full line-by-line explanation, shown in the button's tooltip. */
  explanation: string;
}

type Active = { tries?: Attempt[]; held?: Held[] };

/** What the button polls for: the try waiting on the learner, if there is one. */
export async function activeTry(env: NodeJS.ProcessEnv = process.env): Promise<Attempt | null> {
  return ((await call('/active', {}, env)) as Active | null)?.tries?.[0] ?? null;
}

/**
 * A change held for the learner's decision. This is the menu Claude Code's own
 * prompt cannot give us: on this surface the daemon holds the tool call open,
 * so the choice is ours to present.
 */
export async function pendingDecision(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Held | null> {
  return ((await call('/active', {}, env)) as Active | null)?.held?.[0] ?? null;
}

async function decide(
  held: Held,
  decision: 'allow' | 'try',
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const body = (await call(
    '/decision',
    { method: 'POST', body: JSON.stringify({ ticket: held.ticket, decision }) },
    env,
  )) as { ok?: boolean } | null;
  return body?.ok === true;
}

/** ✓ Allow — let the agent's change through. */
export function allow(held: Held, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return decide(held, 'allow', env);
}

/** ✎ Let me try — the agent stands down and the learner writes it. */
export function letMeTry(held: Held, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return decide(held, 'try', env);
}

export function fileName(target: string): string {
  return target.split(/[\\/]/).pop() ?? target;
}

/** What the button does when clicked. */
export async function finishTry(
  attempt: Attempt,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const body = (await call(
    '/done',
    {
      method: 'POST',
      body: JSON.stringify({ sessionId: attempt.sessionId, target: attempt.target }),
    },
    env,
  )) as { ok?: boolean } | null;
  return body?.ok === true;
}

/** The label shown on the button, kept here so the test can assert it. */
export function buttonLabel(attempt: Attempt): string {
  const name = (attempt.path ?? attempt.target).split(/[\\/]/).pop() ?? attempt.target;
  return `$(check) I'm done — ${name}`;
}
