import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/core/paths.js';
import { modePath } from '../src/core/paths.js';
import { createLogger } from '../src/daemon/log.js';
import { createModeStore } from '../src/daemon/mode.js';
import { createApp } from '../src/daemon/routes.js';
import { createTicketStore, type TicketStore } from '../src/daemon/tickets.js';
import { createTryStore } from '../src/daemon/try.js';
import { createToolNames } from '../src/daemon/tool-name.js';
import { fsIo } from '../src/io/fs-io.js';

// The default surface is now `window`, where /hook blocks until a human
// decides. These suites are about what happens around that decision, so they
// pin the prompt surface, where the hook answers straight away.
async function promptMode(e: Env) {
  const store = await createModeStore(fsIo, modePath(e));
  await store.setSurface('prompt');
  return store;
}


// Integration over the real Hono app and the real filesystem, against a
// mkdtemp HOME. No agent, no browser, no mocks.

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const WATCHING = { ...AUTH, 'x-let-me-explain-client': 'buttons/1' };

const EDIT = {
  sessionId: 's1',
  cwd: '/repo',
  toolName: 'Edit',
  toolInput: { file_path: '/repo/a.ts', old_string: 'const a = 0', new_string: 'const a = 1' },
};

let home: string;
let env: Env;
let app: Hono;
let store: TicketStore;

// These exercise the blocking `window` surface, so it is pinned rather than
// inherited from the default.
// Holding a change open only happens when something is watching, so these
// suites poll /active once the way the VS Code status bar does. Without it the
// hook falls back to Claude Code's prompt rather than parking forever.
async function build(decisionTimeoutMs = 150) {
  store = createTicketStore();
  const mode = await promptMode(env);
  await mode.setSurface('window');
  app = createApp({
    store,
    tries: createTryStore(env, fsIo, () => {}),
    env,
    mode,
    log: createLogger(fsIo, env),
    toolNames: createToolNames(),
    token: TOKEN,
    decisionTimeoutMs,
  });
  await app.request('/active', { headers: WATCHING });
  return { app, store, mode };
}

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

const get = (path: string) => app.request(path, { headers: AUTH });

async function decisionOf(res: Response) {
  const body = (await res.json()) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
  };
  return body.hookSpecificOutput;
}

const goodExplanation = (ticket: string) => ({
  ticket,
  lines: [{ n: 1, note: 'sets a to one' }],
  why: 'the counter started at zero and skipped the first item',
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-loop-'));
  env = { home, xdgStateHome: join(home, 'state') };
  await build();
});

afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

describe('the core loop', () => {
  it('denies, takes an explanation, blocks, then releases on approval', async () => {
    const first = await decisionOf(await post('/hook', EDIT));
    expect(first.permissionDecision).toBe('deny');
    const ticket = first.permissionDecisionReason?.match(/t_[0-9a-f]+/)?.[0];
    expect(ticket).toBeTruthy();

    // The retry is a fresh generation, so the key order differs. Same ticket.
    const retry = await decisionOf(
      await post('/hook', {
        ...EDIT,
        toolInput: {
          new_string: 'const a = 1',
          file_path: '/repo/a.ts',
          old_string: 'const a = 0',
        },
      }),
    );
    expect(retry.permissionDecision).toBe('deny');
    expect(retry.permissionDecisionReason).toContain(ticket);

    const explained = await post('/explain', goodExplanation(ticket!));
    expect(explained.status).toBe(200);

    const pending = (await (await get('/pending')).json()) as {
      pending: { ticket: string; lines: { code: string; note?: string }[]; why?: string }[];
    };
    expect(pending.pending[0]?.lines[0]).toEqual({ n: 1, code: 'const a = 1', note: 'sets a to one', required: true });

    const parked = post('/hook', EDIT);
    await tick();
    expect((await post('/decision', { ticket, decision: 'allow' })).status).toBe(200);

    expect((await decisionOf(await parked)).permissionDecision).toBe('allow');
  });

  it('accepts an explanation with no notes at all being refused', async () => {
    const first = await decisionOf(
      await post('/hook', {
        ...EDIT,
        toolInput: { file_path: '/repo/a.ts', old_string: '', new_string: 'one\ntwo' },
      }),
    );
    const ticket = first.permissionDecisionReason?.match(/t_[0-9a-f]+/)?.[0];

    const res = await post('/explain', { ticket, lines: [], why: 'because' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('at least one note');
  });

  it('tells the agent to stand down when the learner takes over', async () => {
    const first = await decisionOf(await post('/hook', EDIT));
    const ticket = first.permissionDecisionReason?.match(/t_[0-9a-f]+/)?.[0];
    await post('/explain', goodExplanation(ticket!));

    const parked = post('/hook', EDIT);
    await tick();
    await post('/decision', { ticket, decision: 'try' });

    const out = await decisionOf(await parked);
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('Do not retry');

    const again = await decisionOf(await post('/hook', EDIT));
    expect(again.permissionDecision).toBe('deny');
    expect(again.permissionDecisionReason).toContain('Do not retry');
  });

  it('honours an approval that arrives before the agent retries', async () => {
    const first = await decisionOf(await post('/hook', EDIT));
    const ticket = first.permissionDecisionReason?.match(/t_[0-9a-f]+/)?.[0];
    await post('/explain', goodExplanation(ticket!));
    await post('/decision', { ticket, decision: 'allow' });

    expect((await decisionOf(await post('/hook', EDIT))).permissionDecision).toBe('allow');
  });

  // The bug this pins: the pre-buttons extension polled /active for tries and
  // nothing else. That poll was enough to convince the daemon a decider was
  // present, so a change was held open that nothing on screen could answer.
  it('does not count a poller that cannot show the choice', async () => {
    store = createTicketStore();
    const mode = await promptMode(env);
    await mode.setSurface('window');
    const solo = createApp({
      store,
      tries: createTryStore(env, fsIo, () => {}),
      env,
      mode,
      log: createLogger(fsIo, env),
      toolNames: createToolNames(),
      token: TOKEN,
    });
    const send = (path: string, body: unknown) =>
      solo.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

    // An old client: authenticated, polling, but claiming nothing.
    await solo.request('/active', { headers: AUTH });

    const first = await decisionOf(await send('/hook', EDIT));
    const ticket = first.permissionDecisionReason?.match(/t_[0-9a-f]+/)?.[0];
    await send('/explain', goodExplanation(ticket!));
    expect((await decisionOf(await send('/hook', EDIT))).permissionDecision).toBe('ask');

    // The same poll from a client that says it can decide does hold it.
    await solo.request('/active', { headers: WATCHING });
    const parked = send('/hook', EDIT);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.pending()[0]?.state).toBe('awaiting_decision');
    await send('/decision', { ticket, decision: 'allow' });
    expect((await decisionOf(await parked)).permissionDecision).toBe('allow');
  });

  // The failure this prevents: `surface: window` with no VS Code extension
  // running means nothing can decide, so Claude Code sits on a Write with no
  // option on screen and no explanation of why. A hang with no affordance is
  // worse than losing the buttons.
  it('falls back to the prompt when no status bar is polling', async () => {
    store = createTicketStore();
    const mode = await promptMode(env);
    await mode.setSurface('window');
    // Deliberately no /active poll: nothing is watching.
    const solo = createApp({
      store,
      tries: createTryStore(env, fsIo, () => {}),
      env,
      mode,
      log: createLogger(fsIo, env),
      toolNames: createToolNames(),
      token: TOKEN,
    });
    const send = (path: string, body: unknown) =>
      solo.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

    const first = await decisionOf(await send('/hook', EDIT));
    const ticket = first.permissionDecisionReason?.match(/t_[0-9a-f]+/)?.[0];
    await send('/explain', goodExplanation(ticket!));

    const out = await decisionOf(await send('/hook', EDIT));
    expect(out.permissionDecision).toBe('ask');
    // And it says why, so the missing buttons are diagnosable rather than odd.
    expect(out.permissionDecisionReason).toContain('no VS Code buttons are listening');
  });

  it('allows rather than hanging when the decision times out', async () => {
    const first = await decisionOf(await post('/hook', EDIT));
    const ticket = first.permissionDecisionReason?.match(/t_[0-9a-f]+/)?.[0];
    await post('/explain', goodExplanation(ticket!));

    expect((await decisionOf(await post('/hook', EDIT))).permissionDecision).toBe('allow');
  });

  it('needs one approval per tool call — an approval is not reusable', async () => {
    const first = await decisionOf(await post('/hook', EDIT));
    const ticket = first.permissionDecisionReason?.match(/t_[0-9a-f]+/)?.[0];
    await post('/explain', goodExplanation(ticket!));
    await post('/decision', { ticket, decision: 'allow' });
    await post('/hook', EDIT);

    const repeat = await decisionOf(await post('/hook', EDIT));
    expect(repeat.permissionDecision).toBe('deny');
    expect(repeat.permissionDecisionReason).not.toContain(ticket);
  });
});

describe('access', () => {
  it('refuses requests without the session token', async () => {
    const res = await app.request('/pending');
    expect(res.status).toBe(401);
  });

  it('leaves /health open so a human can check it', async () => {
    expect((await app.request('/health')).status).toBe(200);
  });
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
