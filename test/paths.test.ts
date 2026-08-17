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
    hookSpecificOutput: {
      permissionDecision: string;
      permissionDecisionReason?: string;
      additionalContext?: string;
      updatedInput?: Record<string, unknown>;
    };
  };
  const out = body.hookSpecificOutput;
  // The handback arrives as a deny reason when the write had to be refused, and
  // as `additionalContext` when it was neutralised instead. Tests care that the
  // learner's code reached the agent, not which field carried it.
  return { ...out, permissionDecisionReason: out.permissionDecisionReason ?? out.additionalContext };
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
    // Neutralised rather than refused: the write runs with the learner's own
    // bytes, so the flow that succeeded does not render as a red error.
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput).toMatchObject({ content: 'const a = 1\n' });
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
    expect(out.permissionDecisionReason).toContain('typed src/a.ts themselves');
    expect(out.permissionDecisionReason).not.toContain('already typed this');
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
    expect((await decision(parked)).permissionDecisionReason).toContain('typed src/a.ts');
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
    await decision(parked);

    // The protection is the content, not the verdict: whether the write was
    // refused or neutralised, their bytes are what is on disk.
    expect(await readFile(join(repo, 'src/a.ts'), 'utf8')).toBe('const a = 1\n');
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
    expect((await decision(parked)).permissionDecision).toBe('allow');
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

// ------------------------------------------------- G. the shape of the handback

// A denial renders as a red error, which is wrong for a flow that succeeded.
// Where the write can be made harmless it is allowed instead — but only where
// that is provably safe, and the learner's bytes are what matters either way.
describe('G. handing back without an error', () => {
  async function tryRound(target: string, tool: string, input: Record<string, unknown>) {
    await explain(target);
    await chooseTry(target);
    const parked = app.request('/hook', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ sessionId: S, cwd: repo, toolName: tool, toolInput: input }),
    });
    await settle();
    await learnerTypes(target, 'MINE\n').catch(() => {});
    await done();
    return decision(parked);
  }

  it('G1. a Write is neutralised, not refused', async () => {
    const out = await tryRound('src/a.ts', 'Write', {
      file_path: 'src/a.ts',
      content: 'const a = 1',
    });
    expect(out.permissionDecision).toBe('allow');
    // The whole input is replaced, so untouched fields must be carried over.
    expect(out.updatedInput).toEqual({ file_path: 'src/a.ts', content: 'MINE\n' });
    // A reason on an allow is never shown; it would be dead weight in context.
    expect(out.permissionDecisionReason).toBe(out.additionalContext);
    expect(await readFile(join(repo, 'src/a.ts'), 'utf8')).toBe('MINE\n');
  });

  it('G2. an Edit still denies — a no-op edit is not expressible', async () => {
    const out = await tryRound('src/b.ts', 'Edit', {
      file_path: 'src/b.ts',
      old_string: 'a',
      new_string: 'const b = 2',
    });
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('what they wrote');
  });

  it('G3. a Bash command still denies — there is no file to hand back', async () => {
    await explain('shell');
    await chooseTry('shell');
    const parked = app.request('/hook', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        sessionId: S,
        cwd: repo,
        toolName: 'Bash',
        toolInput: { command: 'ls -la' },
      }),
    });
    await settle();
    await done();
    expect((await decision(parked)).permissionDecision).toBe('deny');
  });

  it('G4. a permission mode that ignores updatedInput keeps denying', async () => {
    await explain('src/c.ts');
    await chooseTry('src/c.ts');
    const parked = app.request('/hook', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        sessionId: S,
        cwd: repo,
        toolName: 'Write',
        toolInput: { file_path: 'src/c.ts', content: 'const c = 3' },
        // Measured: under acceptEdits the rewrite lands only ~1 time in 3,
        // because the write is pre-approved and the hook no longer satisfies
        // the permission interaction. Denying is the safe answer there.
        permissionMode: 'acceptEdits',
      }),
    });
    await settle();
    await learnerTypes('src/c.ts', 'MINE\n');
    await done();

    const out = await decision(parked);
    expect(out.permissionDecision).toBe('deny');
    expect(await readFile(join(repo, 'src/c.ts'), 'utf8')).toBe('MINE\n');
  });

  it('G5. still typing always denies, because the deny is what extends the wait', async () => {
    await explain('src/d.ts');
    await chooseTry('src/d.ts');
    const short = createApp({
      store,
      tries,
      env,
      mode,
      log: createLogger(fsIo, env),
      toolNames: createToolNames(),
      token: TOKEN,
      tryWaitMs: 60,
    });
    const out = await decision(
      short.request('/hook', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          sessionId: S,
          cwd: repo,
          toolName: 'Write',
          toolInput: { file_path: 'src/d.ts', content: 'const d = 4' },
        }),
      }),
    );
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('still typing');
  });

  it('G6. the learner is told what happened, in neutral styling', async () => {
    await explain('src/e.ts');
    await chooseTry('src/e.ts');
    const parked = app.request('/hook', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        sessionId: S,
        cwd: repo,
        toolName: 'Write',
        toolInput: { file_path: 'src/e.ts', content: 'const e = 5' },
      }),
    });
    await settle();
    await learnerTypes('src/e.ts', 'MINE\n');
    await done();

    const body = (await (await parked).json()) as { systemMessage?: string };
    expect(body.systemMessage).toContain('e.ts is yours');
  });
});

// --------------------------------------------------------- H. the safety net

// `updatedInput` is honoured by the harness we measured, but this is the one
// path in the system that must not fail open: if the rewrite were ever dropped,
// the agent's version would land on the learner's file.
describe('H. if the rewrite were ever ignored', () => {
  async function neutralisedWrite(target: string, agentCode: string, learnerCode: string) {
    await explain(target);
    await chooseTry(target);
    const parked = toolCall(target, agentCode);
    await settle();
    await learnerTypes(target, learnerCode);
    await done();
    expect((await decision(parked)).permissionDecision).toBe('allow');
  }

  it('H1. restores the learner’s file if the agent’s version landed', async () => {
    await neutralisedWrite('src/a.ts', 'const a = 1', 'MINE\n');
    // Simulate a harness that ignored `updatedInput`.
    await learnerTypes('src/a.ts', 'const a = 1');

    await new Promise((r) => setTimeout(r, 600));
    expect(await readFile(join(repo, 'src/a.ts'), 'utf8')).toBe('MINE\n');
  });

  it('H2. leaves a later edit of the learner’s own alone', async () => {
    await neutralisedWrite('src/b.ts', 'const b = 2', 'MINE\n');
    // They kept typing after clicking done. This is not the agent's version, so
    // restoring it would destroy work — the net must stay out of the way.
    await learnerTypes('src/b.ts', 'MINE, IMPROVED\n');

    await new Promise((r) => setTimeout(r, 600));
    expect(await readFile(join(repo, 'src/b.ts'), 'utf8')).toBe('MINE, IMPROVED\n');
  });

  it('H3. does nothing when both versions already agree', async () => {
    await neutralisedWrite('src/c.ts', 'const c = 3', 'const c = 3');
    await new Promise((r) => setTimeout(r, 600));
    expect(await readFile(join(repo, 'src/c.ts'), 'utf8')).toBe('const c = 3');
  });
});
