import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, parseModeFile, resolveSettings } from '../src/core/mode-file.js';
import type { Env } from '../src/core/paths.js';
import { modePath } from '../src/core/paths.js';
import { createLogger } from '../src/daemon/log.js';
import { createModeStore, type ModeStore } from '../src/daemon/mode.js';
import { explanationForPrompt } from '../src/daemon/prompts.js';
import { createApp } from '../src/daemon/routes.js';
import { createTicketStore, type TicketStore } from '../src/daemon/tickets.js';
import { createTryStore } from '../src/daemon/try.js';
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

const preExplanation = {
  sessionId: SESSION,
  target: '/repo/a.ts',
  lines: [
    { n: 1, note: 'sets a to one' },
    { n: 2, note: 'hands it back' },
  ],
  why: 'the counter started at zero',
};

let home: string;
let env: Env;
let app: Hono;
let store: TicketStore;
let mode: ModeStore;

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

async function hookOutput(body: unknown) {
  const res = await post('/hook', body);
  const json = (await res.json()) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
  };
  return json.hookSpecificOutput;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-surface-'));
  env = { home, xdgStateHome: join(home, 'state') };
  store = createTicketStore();
  mode = await createModeStore(fsIo, modePath(env));
  // This file exercises the prompt surface specifically.
  await mode.setSurface('prompt');
  app = createApp({
    store,
    tries: createTryStore(env, fsIo, () => {}),
    env,
    mode,
    log: createLogger(fsIo, env),
    toolNames: createToolNames(),
    token: TOKEN,
    decisionTimeoutMs: 100,
  });
});

afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

describe('mode file compatibility', () => {
  // The terminal menu makes let-me-try reachable here, so `window` is no
  // longer the only surface where it is a real choice.
  it('defaults to the prompt surface', () => {
    expect(parseModeFile(null).global).toEqual(DEFAULTS);
    expect(DEFAULTS.surface).toBe('prompt');
  });

  // Existing installs have this shape on disk right now.
  it('still reads the old bare-mode-string format', () => {
    const file = parseModeFile(JSON.stringify({ global: 'off', sessions: { s1: 'on' } }));
    expect(resolveSettings(file)).toEqual({ mode: 'off', surface: 'prompt' });
    expect(resolveSettings(file, 's1')).toEqual({ mode: 'on', surface: 'prompt' });
  });

  it('reads the new object format', () => {
    const file = parseModeFile(
      JSON.stringify({ global: { mode: 'on', surface: 'window' }, sessions: {} }),
    );
    expect(resolveSettings(file).surface).toBe('window');
  });

  it('lets a session override only the surface, inheriting the mode', () => {
    const file = parseModeFile(
      JSON.stringify({ global: { mode: 'off', surface: 'prompt' }, sessions: { s1: { surface: 'window' } } }),
    );
    expect(resolveSettings(file, 's1')).toEqual({ mode: 'off', surface: 'window' });
  });

  it('survives a corrupt file', () => {
    expect(parseModeFile('{not json').global).toEqual(DEFAULTS);
  });
});

describe('surface: prompt', () => {
  it('hands the decision to Claude Code instead of blocking', async () => {
    await post('/explain', preExplanation);

    const out = await hookOutput(EDIT);
    expect(out.permissionDecision).toBe('ask');
    expect(out.permissionDecisionReason).toContain('/repo/a.ts');
    expect(out.permissionDecisionReason).toContain('sets a to one');
    expect(out.permissionDecisionReason).toContain('the counter started at zero');
  });

  it('returns immediately — no waiting for a decision', async () => {
    await post('/explain', preExplanation);
    const started = Date.now();
    await hookOutput(EDIT);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('still denies when nothing explains the change', async () => {
    const out = await hookOutput(EDIT);
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(/t_[0-9a-f]+/);
  });

  it('re-asks on a retry rather than demanding a fresh explanation', async () => {
    await post('/explain', preExplanation);
    expect((await hookOutput(EDIT)).permissionDecision).toBe('ask');
    expect((await hookOutput(EDIT)).permissionDecision).toBe('ask');
  });

  it('is off when the mode is off', async () => {
    await mode.set('off');
    await post('/explain', preExplanation);
    expect((await hookOutput(EDIT)).permissionDecision).toBe('allow');
  });

  it('can be switched per session', async () => {
    await post('/surface', { surface: 'window', sessionId: SESSION });
    expect(mode.surface(SESSION)).toBe('window');
    expect(mode.surface('other')).toBe('prompt');
  });
});

describe('explanationForPrompt', () => {
  const view = (count: number) => ({
    ticket: 't_1',
    sessionId: SESSION,
    toolName: 'Edit',
    state: 'awaiting_decision' as const,
    target: '/repo/a.ts',
    why: 'because',
    lines: Array.from({ length: count }, (_, i) => ({
      n: i + 1,
      code: `line ${i + 1}`,
      note: `note ${i + 1}`,
      required: true,
    })),
  });

  it('lists a note per line, keyed by line number', () => {
    const text = explanationForPrompt(view(2));
    expect(text).toContain('1  note 1');
    expect(text).toContain('2  note 2');
  });

  // Claude Code already renders the tool input above the prompt.
  it('does not repeat the code', () => {
    expect(explanationForPrompt(view(2))).not.toContain('line 1');
  });

  it('truncates a long change rather than flooding the prompt', () => {
    const text = explanationForPrompt(view(40));
    expect(text).toContain('note 25');
    expect(text).not.toContain('note 26');
    expect(text).toContain('15 more line(s)');
  });

  // Refusing the change was worse than showing it with a hole in it: the
  // learner never saw the edit at all, and the agent burned a round trip.
  it('shows a line with no note as a gap rather than dropping it', () => {
    const v = view(2);
    delete (v.lines[1] as { note?: string }).note;
    const text = explanationForPrompt(v);
    expect(text).not.toContain('note 2');
    expect(text).toContain('— not explained —');
  });

  // Context carried into an Edit was never asked for, so calling it a gap
  // blames the agent for something it was right to skip.
  it('leaves a line that never needed a note out of the listing', () => {
    const v = view(2);
    delete (v.lines[1] as { note?: string }).note;
    delete (v.lines[1] as { required?: boolean }).required;
    const text = explanationForPrompt(v);
    expect(text).not.toContain('— not explained —');
    expect(text).toContain('note 1');
  });

  it('names the buttons instead of the prompt when it is a tooltip', () => {
    expect(explanationForPrompt(view(1), 'buttons')).toContain('✎ Let me try');
    expect(explanationForPrompt(view(1), 'buttons')).not.toContain('reject with');
  });
});

describe('what the buttons can act on', () => {
  it('offers nothing while Claude Code owns the decision', async () => {
    await post('/explain', {
      sessionId: SESSION,
      target: 'src/a.ts',
      lines: [{ n: 1, note: 'sets a' }],
      why: 'because',
    });
    await post('/hook', {
      sessionId: SESSION,
      cwd: '/repo',
      toolName: 'Write',
      toolInput: { file_path: 'src/a.ts', content: 'const a = 1' },
    });

    // The ticket is deliberately left in `awaiting_decision` so a retry re-asks
    // — but nobody is parked on it, so clicking Allow would answer a question
    // that was never put to us.
    expect(store.pending().some((p) => p.state === 'awaiting_decision')).toBe(true);
    const res = await app.request('/active', { headers: AUTH });
    const body = (await res.json()) as { held: unknown[] };
    expect(body.held).toEqual([]);
  });
});

describe('outcome reporting', () => {
  it('records an approval and a rejection', async () => {
    expect(
      (await post('/outcome', { sessionId: SESSION, toolName: 'Edit', event: 'PostToolUse' }))
        .status,
    ).toBe(200);
    expect(
      (await post('/outcome', { sessionId: SESSION, toolName: 'Edit', event: 'PermissionDenied' }))
        .status,
    ).toBe(200);
  });

  it('rejects an outcome with no session', async () => {
    expect((await post('/outcome', { toolName: 'Edit' })).status).toBe(400);
  });
});
