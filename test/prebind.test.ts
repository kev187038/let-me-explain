import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/core/paths.js';
import { modePath } from '../src/core/paths.js';
import { renderInstructions } from '../src/daemon/instructions.js';
import { createLogger } from '../src/daemon/log.js';
import { createModeStore } from '../src/daemon/mode.js';
import { createApp } from '../src/daemon/routes.js';
import { createTicketStore, type TicketStore } from '../src/daemon/tickets.js';
import { createToolNames } from '../src/daemon/tool-name.js';
import { fsIo } from '../src/io/fs-io.js';

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const SESSION = 's1';

const EDIT = {
  sessionId: SESSION,
  cwd: '/repo',
  toolName: 'Edit',
  toolInput: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'const a = 1\nreturn a' },
};

let home: string;
let env: Env;
let app: Hono;
let store: TicketStore;

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

async function decisionOf(res: Response) {
  const body = (await res.json()) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
  };
  return body.hookSpecificOutput;
}

const preExplanation = {
  sessionId: SESSION,
  target: '/repo/a.ts',
  lines: [
    { n: 1, note: 'sets a to one' },
    { n: 2, note: 'hands it back' },
  ],
  why: 'the counter started at zero and skipped the first item',
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-pre-'));
  env = { home, xdgStateHome: join(home, 'state') };
  store = createTicketStore();
  app = createApp({
    store,
    mode: await createModeStore(fsIo, modePath(env)),
    log: createLogger(fsIo, env),
    toolNames: createToolNames(),
    token: TOKEN,
    decisionTimeoutMs: 150,
  });
});

afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

describe('explaining before the change', () => {
  it('blocks straight away, with no denial at all', async () => {
    const shelved = await post('/explain', preExplanation);
    expect(shelved.status).toBe(200);
    expect(await shelved.json()).toEqual({ ok: true, pending: true });

    const parked = post('/hook', EDIT);
    await tick();

    const view = store.pending()[0];
    expect(view?.state).toBe('awaiting_decision');
    expect(view?.lines[0]).toEqual({ n: 1, code: 'const a = 1', note: 'sets a to one' });

    await post('/decision', { ticket: view?.ticket, decision: 'allow' });
    expect((await decisionOf(await parked)).permissionDecision).toBe('allow');
  });

  it('an explanation authorises exactly one change', async () => {
    await post('/explain', preExplanation);

    const first = post('/hook', EDIT);
    await tick();
    const ticket = store.pending()[0]?.ticket;
    await post('/decision', { ticket, decision: 'allow' });
    await first;

    const second = await decisionOf(
      await post('/hook', {
        ...EDIT,
        toolInput: { file_path: '/repo/a.ts', old_string: 'y', new_string: 'const b = 2' },
      }),
    );
    expect(second.permissionDecision).toBe('deny');
  });

  it('falls back to a denial when the notes do not fit the change', async () => {
    await post('/explain', { ...preExplanation, lines: [{ n: 1, note: 'sets a to one' }] });

    const out = await decisionOf(await post('/hook', EDIT));
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('did not match');
    expect(out.permissionDecisionReason).toMatch(/t_[0-9a-f]+/);
  });

  it('does not cross sessions', async () => {
    await post('/explain', preExplanation);
    const other = await decisionOf(await post('/hook', { ...EDIT, sessionId: 's2' }));
    expect(other.permissionDecision).toBe('deny');
    expect(other.permissionDecisionReason).toContain('Call');
  });

  it('does not bind an explanation for a different file', async () => {
    await post('/explain', { ...preExplanation, target: '/repo/other.ts' });
    expect((await decisionOf(await post('/hook', EDIT))).permissionDecision).toBe('deny');
  });

  it('rejects an explanation with neither a ticket nor a target', async () => {
    const res = await post('/explain', { lines: [{ n: 1, note: 'x' }], why: 'y' });
    expect(res.status).toBe(400);
  });

  it('expires a pre-explanation that was never used', () => {
    let clock = 1_000;
    const s = createTicketStore({ now: () => clock, preTtlMs: 100 });
    s.addPreExplanation({ ...preExplanation, createdAt: clock });
    expect(s.preExplanationCount()).toBe(1);

    clock += 500;
    expect(s.lookup(EDIT).kind).toBe('minted');
    expect(s.preExplanationCount()).toBe(0);
  });
});

describe('instructions', () => {
  it('names the tool the harness actually exposed', async () => {
    const res = await app.request('/instructions', { headers: AUTH });
    const text = await res.text();
    expect(text).toContain('mcp__plugin_let-me-explain_lme__explain');
    expect(text).toContain('<let-me-explain>');
  });

  it('renders deterministically', () => {
    const a = renderInstructions({ explainTool: 'x__explain' });
    const b = renderInstructions({ explainTool: 'x__explain' });
    expect(a).toBe(b);
  });

  it('stays short enough to prepend to every session', () => {
    const words = renderInstructions({ explainTool: 'x__explain' }).split(/\s+/).length;
    expect(words).toBeLessThan(320);
  });
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}