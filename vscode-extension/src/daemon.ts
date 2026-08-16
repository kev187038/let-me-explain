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

/** What the button polls for: the try waiting on the learner, if there is one. */
export async function activeTry(env: NodeJS.ProcessEnv = process.env): Promise<Attempt | null> {
  const body = (await call('/active', {}, env)) as { tries?: Attempt[] } | null;
  return body?.tries?.[0] ?? null;
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
