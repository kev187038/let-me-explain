import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTutorials } from '../src/core/cleanup.js';
import type { Env } from '../src/core/paths.js';
import { modePath, tutorialPath } from '../src/core/paths.js';
import { createLogger } from '../src/daemon/log.js';
import { createModeStore, type ModeStore } from '../src/daemon/mode.js';
import { createApp } from '../src/daemon/routes.js';
import { createTicketStore, type TicketStore } from '../src/daemon/tickets.js';
import { createToolNames } from '../src/daemon/tool-name.js';
import { createTryStore, type TryStore } from '../src/daemon/try.js';
import { fsIo } from '../src/io/fs-io.js';

// Every route a learner can take through a change, walked end to end against a
// real daemon app. The unit suites cover pieces; this covers the *sequences*,
// which is where every bug that reached real use has come from — a second round
// replaying the first, a finished try leaving a ticket alive, a fix mistaken
// for a repeat. Sequences are the thing worth being exhaustive about.

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const WATCHING = { ...AUTH, 'x-let-me-explain-client': 'buttons/1' };
const S = 'session-one';

let home: string;
let repo: string;
let env: Env;
let app: Hono;
let store: TicketStore;
let tries: TryStore;
let mode: ModeStore;
let launched: { tutorialPath: string; targetPath: string; line: number }[];

const post = (path: string, body: unknown, headers = AUTH) =>
  app.request(path, { method: 'POST', headers, body: JSON.stringify(headers ? body : body) });

async function decision(res: Response | Promise<Response>) {
  const body = (await (await res).json()) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
  };
  return body.hookSpecificOutput;
}

/** The agent explains a change it has not yet made — the pre-explanation path. */
const explain = (target: string, why = 'because', session = S, lines = [{ n: 1, note: 'sets a' }]) =>
  post('/explain', { sessionId: session, target, lines, why });

/** The learner picks "Let me try" from the menu. */
const chooseTry = (target: string, session = S) =>
  post('/try', { sessionId: session, target, cwd: repo });

/** The agent makes its tool call. */
const toolCall = (target: string, content: string, session = S) =>
  post('/hook', {
    sessionId: session,
    cwd: repo,
    toolName: 'Write',
    toolInput: { file_path: target, content },
  });

const learnerTypes = (target: string, text: string) => writeFile(join(repo, target), text);

const done = (body: Record<string, unknown> = {}) => post('/done', body);

const settle = () => new Promise((r) => setTimeout(r, 40));

/** Ticking the checkbox at the bottom of the tutorial, as the learner does. */
async function tickBox(target: string, session = S) {
  const path = tutorialPath(env, session, target);
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('- [ ]', '- [x]'));
  // The watcher collapses editor writes over a short quiet period.
  await new Promise((r) => setTimeout(r, 160));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-paths-'));
  repo = join(home, 'repo');
  await mkdir(repo, { recursive: true });
  env = { home, xdgStateHome: join(home, 'state') };
  launched = [];
  store = createTicketStore();
  tries = createTryStore(env, fsIo, (_e, paths) => launched.push(paths), (t) => store.consume(t));
  mode = await createModeStore(fsIo, modePath(env));
  await mode.setSurface('prompt');
  app = createApp({
    store,
    tries,
    env,
    mode,
    log: createLogger(fsIo, env),
    toolNames: createToolNames(),
    token: TOKEN,
    decisionTimeoutMs: 200,
  });
});

afterEach(async () => {
  tries.close();
  store.close();
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------- A. one round

describe('A. a single round', () => {
  it('A1. menu → Yes: the change is put to the learner with its explanation', async () => {
    await explain('src/a.ts');
    const out = await decision(toolCall('src/a.ts', 'const a = 1'));
    expect(out.permissionDecision).toBe('ask');
    expect(out.permissionDecisionReason).toContain('sets a');
  });

  it('A2. menu → Let me try, typed correctly: both versions come back', async () => {
    await explain('src/a.ts');
    await chooseTry('src/a.ts');
    const parked = toolCall('src/a.ts', 'const a = 1');
    await settle();
    await learnerTypes('src/a.ts', 'const a = 1\n');
    await done();

    const out = await decision(parked);
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('what they wrote');
    expect(out.permissionDecisionReason).toContain('what you intended');
  });

  it('A3. typed wrongly: the agent still gets both, so it can teach', async () => {
    await explain('src/a.ts');
    await chooseTry('src/a.ts');
    const parked = toolCall('src/a.ts', 'const a = 1');
    await settle();
    await learnerTypes('src/a.ts', 'const a = // broken\n');
    await done();

    const reason = (await decision(parked)).permissionDecisionReason ?? '';
    expect(reason).toContain('const a = // broken');
    expect(reason).toContain('const a = 1');
  });

  it('A4. typed nothing: the empty file is reported rather than the intent', async () => {
    await explain('src/a.ts');
    await chooseTry('src/a.ts');
    const parked = toolCall('src/a.ts', 'const a = 1');
    await settle();
    await done();

    const reason = (await decision(parked)).permissionDecisionReason ?? '';
    const wrote = reason.split('--- what they wrote ---')[1]?.split('--- what you intended ---')[0];
    expect(wrote?.trim()).toBe('');
    // The file is created empty so the editor never opens a phantom buffer.
    expect(await fsIo.fileExists(join(repo, 'src/a.ts'))).toBe(true);
  });

  it('A5. tool call first: denied with a ticket, then allowed after explaining', async () => {
    const first = await decision(toolCall('src/a.ts', 'const a = 1'));
    expect(first.permissionDecision).toBe('deny');
    const ticket = first.permissionDecisionReason?.match(/t_[0-9a-f]+/)?.[0];
    expect(ticket).toBeTruthy();

    await post('/explain', { ticket, lines: [{ n: 1, note: 'sets a' }], why: 'because' });
    expect((await decision(toolCall('src/a.ts', 'const a = 1'))).permissionDecision).toBe('ask');
  });
});

// ------------------------------------------------------- B. two rounds, one file

describe('B. two rounds on the same file', () => {
  async function round(code: string, typed: string | null, why: string) {
    await explain('src/a.ts', why);
    await chooseTry('src/a.ts');
    const parked = toolCall('src/a.ts', code);
    await settle();
    if (typed !== null) await learnerTypes('src/a.ts', typed);
    await done();
    return decision(parked);
  }

  it('B1. right then right, different code each time', async () => {
    await round('const a = 1', 'const a = 1\n', 'one');
    const out = await round('const b = 2', 'const b = 2\n', 'two');

    const tutorial = await readFile(tutorialPath(env, S, 'src/a.ts'), 'utf8');
    expect(tutorial).toContain('const b = 2');
    expect(tutorial).not.toContain('const a = 1');
    expect(out.permissionDecisionReason).toContain('const b = 2');
    expect(out.permissionDecisionReason).not.toContain('const a = 1');
  });

  it('B2. right then right, identical code both times, is not a repeat', async () => {
    await round('const a = 1', 'const a = 1\n', 'one');
    const out = await round('const a = 1', 'const a = 1\n', 'two');
    expect(out.permissionDecisionReason).toContain('finished');
    expect(out.permissionDecisionReason).not.toContain('already typed');
  });

  it('B3. wrong then right: the fix reaches the comparison', async () => {
    await round('const a = 1', 'const a = // broken\n', 'one');
    const out = await round('const a = 1', 'const a = 1\n', 'two');
    expect(out.permissionDecisionReason).not.toContain('already typed');
    expect(out.permissionDecisionReason).toContain('const a = 1');
  });

  it('B4. nothing typed then right', async () => {
    await round('const a = 1', null, 'one');
    const out = await round('const a = 1', 'const a = 1\n', 'two');
    expect(out.permissionDecisionReason).not.toContain('already typed');
    expect(launched).toHaveLength(2);
  });

  it('B5. let me try, then Yes on the next change', async () => {
    await round('const a = 1', 'const a = 1\n', 'one');
    await explain('src/a.ts', 'two');
    const out = await decision(toolCall('src/a.ts', 'const b = 2'));
    expect(out.permissionDecision).toBe('ask');
  });

  it('B6. Yes, then let me try on the next change', async () => {
    await explain('src/a.ts', 'one');
    await decision(toolCall('src/a.ts', 'const a = 1'));

    const out = await round('const b = 2', 'const b = 2\n', 'two');
    const tutorial = await readFile(tutorialPath(env, S, 'src/a.ts'), 'utf8');
    expect(tutorial).toContain('const b = 2');
    expect(out.permissionDecisionReason).toContain('const b = 2');
  });
});

// -------------------------------------------------------- C. repeat protection

describe('C. the agent repeating itself', () => {
  async function completedTry(code = 'const a = 1', typed = 'const a = mine\n') {
    await explain('src/a.ts');
    await chooseTry('src/a.ts');
    const parked = toolCall('src/a.ts', code);
    await settle();
    await learnerTypes('src/a.ts', typed);
    await done();
    await parked;
  }

  it('C1. the same call again is refused, not put to the learner', async () => {
    await completedTry();
    const out = await decision(toolCall('src/a.ts', 'const a = 1'));
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('already typed');
    // Their work is untouched.
    expect(await readFile(join(repo, 'src/a.ts'), 'utf8')).toContain('mine');
  });

  it('C2. a genuinely different change goes through the normal gate', async () => {
    await completedTry();
    const out = await decision(toolCall('src/a.ts', 'const zzz = 9'));
    expect(out.permissionDecisionReason).not.toContain('already typed');
    // No explanation for this one yet, so it is asked for.
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(/t_[0-9a-f]+/);
  });

  it('C3. let_me_try twice in one round opens one editor', async () => {
    await explain('src/a.ts');
    await chooseTry('src/a.ts');
    await chooseTry('src/a.ts');
    const parked = toolCall('src/a.ts', 'const a = 1');
    await settle();
    expect(launched).toHaveLength(1);
    expect(await listTutorials(env)).toHaveLength(1);
    await done();
    await parked;
  });

  it('C4. an armed choice the agent never followed up is consumed, not left lying', async () => {
    await explain('src/a.ts');
    await chooseTry('src/a.ts');
    // The agent abandons it and does something else entirely.
    await explain('src/other.ts');
    const out = await decision(toolCall('src/other.ts', 'const other = 1'));
    expect(out.permissionDecision).toBe('ask');
    expect(launched).toHaveLength(0);
  });
});

// ---------------------------------------------------------- D. finish signals

describe('D. saying you are done', () => {
  // Wrapped in an object on purpose: `await` on an async function that returns
  // a promise unwraps *both* levels, so returning `parked` bare would make the
  // helper wait on the very hook the test has not answered yet.
  async function inFlight(target = 'src/a.ts'): Promise<{ parked: Promise<Response> }> {
    await explain(target);
    await chooseTry(target);
    const parked = Promise.resolve(toolCall(target, 'const a = 1'));
    await settle();
    return { parked };
  }

  it('D1. ticking the checkbox in the tutorial', async () => {
    const { parked } = await inFlight();
    await learnerTypes('src/a.ts', 'const a = 1\n');
    await tickBox('src/a.ts');
    expect((await decision(parked)).permissionDecisionReason).toContain('finished');
  });

  it('D2. `done` with no arguments, when only one is waiting', async () => {
    const { parked } = await inFlight();
    expect(((await (await done()).json()) as { ok: boolean }).ok).toBe(true);
    await parked;
  });

  it('D3. `done` names both when two are waiting, rather than guessing', async () => {
    const { parked: a } = await inFlight('src/a.ts');
    const { parked: b } = await inFlight('src/b.ts');

    const body = (await (await done()).json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('more than one');

    expect(((await (await done({ target: 'src/a.ts' })).json()) as { ok: boolean }).ok).toBe(true);
    await a;
    await done({ target: 'src/b.ts' });
    await b;
  });
});

// --------------------------------------------------------- E. cross-cutting

describe('E. more than one thing at once', () => {
  it('E1. two files in flight keep separate tutorials', async () => {
    for (const t of ['src/a.ts', 'src/b.ts']) {
      await explain(t);
      await chooseTry(t);
      void toolCall(t, `// ${t}`);
    }
    await settle();

    const tutorials = await listTutorials(env);
    expect(tutorials).toHaveLength(2);
    expect(launched).toHaveLength(2);
  });

  it('E2. two sessions on the same file do not see each other', async () => {
    await explain('src/a.ts', 'mine', S);
    await chooseTry('src/a.ts', S);
    void toolCall('src/a.ts', 'const a = 1', S);
    await settle();

    // A second session has proposed nothing, so it has nothing to take over.
    const res = await post('/try', { sessionId: 'other', target: 'src/a.ts', cwd: repo });
    expect(res.status).toBe(404);
  });

  it('E3. switching the plugin off mid-try does not abandon the typing', async () => {
    await explain('src/a.ts');
    await chooseTry('src/a.ts');
    const parked = toolCall('src/a.ts', 'const a = 1');
    await settle();

    await post('/mode', { mode: 'off' });
    await learnerTypes('src/a.ts', 'const a = 1\n');
    await done();

    // Still denied, not allowed through to overwrite what they typed.
    expect((await decision(parked)).permissionDecision).toBe('deny');
  });

  it('E4. the window surface reaches the same place through the buttons', async () => {
    await mode.setSurface('window');
    await app.request('/active', { headers: WATCHING });
    await explain('src/a.ts');

    const parked = toolCall('src/a.ts', 'const a = 1');
    await settle();

    const held = (
      (await (await app.request('/active', { headers: WATCHING })).json()) as {
        held: { ticket: string }[];
      }
    ).held;
    expect(held).toHaveLength(1);

    // Clicking "Let me try".
    await post('/decision', { ticket: held[0]?.ticket, decision: 'try' });
    expect((await decision(parked)).permissionDecisionReason).toContain('let_me_try');

    // Which is the call the agent then makes; from here it is the usual path.
    await chooseTry('src/a.ts');
    const retry = toolCall('src/a.ts', 'const a = 1');
    await settle();
    expect(await listTutorials(env)).toHaveLength(1);
    await learnerTypes('src/a.ts', 'const a = 2\n');
    await done();
    expect((await decision(retry)).permissionDecisionReason).toContain('const a = 2');
  });
});

// ------------------------------------------------------------- F. degenerate

describe('F. things that should fail cleanly', () => {
  it('F1. an explanation with no notes is refused', async () => {
    const res = await post('/explain', { sessionId: S, target: 'src/a.ts', lines: [], why: 'x' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('at least one note');
  });

  it('F2. taking over a file nobody proposed is refused with a reason', async () => {
    const res = await chooseTry('src/never.ts');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('Explain the change first');
  });

  it('F3. deleting the tutorial mid-try leaves `done` working', async () => {
    await explain('src/a.ts');
    await chooseTry('src/a.ts');
    const parked = toolCall('src/a.ts', 'const a = 1');
    await settle();

    await rm(tutorialPath(env, S, 'src/a.ts'), { force: true });
    await learnerTypes('src/a.ts', 'const a = 1\n');
    expect(((await (await done()).json()) as { ok: boolean }).ok).toBe(true);
    expect((await decision(parked)).permissionDecision).toBe('deny');
  });

  it('F4. a tool with nothing to explain passes straight through', async () => {
    const out = await decision(
      post('/hook', {
        sessionId: S,
        cwd: repo,
        toolName: 'Read',
        toolInput: { file_path: 'src/a.ts' },
      }),
    );
    expect(out.permissionDecision).toBe('allow');
  });
});
