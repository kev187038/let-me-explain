import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanAll, cleanOlderThan, cleanSession, listTutorials } from '../src/core/cleanup.js';
import type { Env } from '../src/core/paths.js';
import { modePath, tutorialPath } from '../src/core/paths.js';
import { createLogger } from '../src/daemon/log.js';
import { createModeStore } from '../src/daemon/mode.js';
import { createApp } from '../src/daemon/routes.js';
import { createTicketStore, type TicketStore } from '../src/daemon/tickets.js';
import { createToolNames } from '../src/daemon/tool-name.js';
import { createTryStore, type TryStore } from '../src/daemon/try.js';
import { fsIo } from '../src/io/fs-io.js';

// The default surface is now `window`, where /hook blocks until a human
// decides. These suites are about what happens around that decision, so they
// pin the prompt surface, where the hook answers straight away.
async function promptMode(e: Env) {
  const store = await createModeStore(fsIo, modePath(e));
  await store.setSurface('prompt');
  return store;
}


const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const SESSION = 's1';

let home: string;
let repo: string;
let env: Env;
let app: Hono;
let store: TicketStore;
let tries: TryStore;
let launched: { tutorialPath: string; targetPath: string; line: number }[];

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

const get = (path: string) => app.request(path, { headers: AUTH });

// Puts a ticket into `awaiting_decision` the way a real session would.
async function pendingChange(target: string, code: string, notes: string[]) {
  await post('/explain', {
    sessionId: SESSION,
    target,
    lines: notes.map((note, i) => ({ n: i + 1, note })),
    why: 'the counter started at zero',
  });
  await post('/hook', {
    sessionId: SESSION,
    cwd: repo,
    toolName: 'Write',
    toolInput: { file_path: target, content: code },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-try-'));
  repo = join(home, 'repo');
  env = { home, xdgStateHome: join(home, 'state') };
  launched = [];
  store = createTicketStore();
  tries = createTryStore(env, fsIo, (_e, paths) => launched.push(paths));
  app = createApp({
    store,
    tries,
    env,
    mode: await promptMode(env),
    log: createLogger(fsIo, env),
    toolNames: createToolNames(),
    token: TOKEN,
    tryWaitMs: 400,
  });
});

afterEach(async () => {
  tries.close();
  store.close();
  await rm(home, { recursive: true, force: true });
});

describe('let-me-try', () => {
  const retry = (target: string, content: string) =>
    post('/hook', {
      sessionId: SESSION,
      cwd: repo,
      toolName: 'Write',
      toolInput: { file_path: target, content },
    });

  async function reasonOf(res: Response) {
    const body = (await res.json()) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
    };
    return body.hookSpecificOutput;
  }

  it('refuses when nothing is pending for that file', async () => {
    const res = await post('/try', { sessionId: SESSION, target: 'src/nope.ts' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('Explain the change first');
  });

  // The flow the menu created, and the one that broke in real use: the learner
  // picks "let me try" straight after the explanation, before the agent has
  // made its tool call at all. There is no ticket then, and no code — the
  // tutorial cannot be written until the tool call carries it.
  describe('chosen from the menu, before the tool call', () => {
    const explain = (target: string) =>
      post('/explain', {
        sessionId: SESSION,
        target,
        lines: [
          { n: 1, note: 'names the greeting' },
          { n: 2, note: 'hands it back' },
        ],
        why: 'greeting broke on blank names',
      });

    it('accepts the choice and waits for the code', async () => {
      await explain('src/greet.js');

      const res = await post('/try', { sessionId: SESSION, target: 'src/greet.js', cwd: repo });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('armed');
      // Nothing to open yet — the daemon has the notes but not the code.
      expect(launched).toHaveLength(0);
    });

    it('opens the tutorial and parks as soon as the tool call brings the code', async () => {
      await explain('src/greet.js');
      await post('/try', { sessionId: SESSION, target: 'src/greet.js', cwd: repo });

      const parked = retry('src/greet.js', 'const hi = "hello"\nreturn hi');
      await new Promise((r) => setTimeout(r, 60));

      const tutorial = await readFile(tutorialPath(env, SESSION, 'src/greet.js'), 'utf8');
      expect(tutorial).toContain('const hi = "hello"');
      expect(tutorial).toContain('└ names the greeting');
      expect(launched).toHaveLength(1);

      // The learner types their own version and says they are done.
      await writeFile(join(repo, 'src/greet.js'), 'const hi = "hi there"\nreturn hi\n');
      expect((await tries.finish(SESSION, 'src/greet.js')).ok).toBe(true);

      const out = await reasonOf(await parked);
      expect(out.permissionDecision).toBe('deny');
      expect(out.permissionDecisionReason).toContain('hi there');
    });

    it('does not ambush a later change once the intent has gone stale', async () => {
      await explain('src/greet.js');
      await post('/try', { sessionId: SESSION, target: 'src/greet.js', cwd: repo });
      // Consumed by the first tool call; a second must not re-open a tutorial.
      await retry('src/greet.js', 'const a = 1');
      await tries.finish(SESSION, 'src/greet.js');
      launched.length = 0;

      await explain('src/greet.js');
      await retry('src/greet.js', 'const b = 2');
      expect(launched).toHaveLength(0);
    });
  });

  it('opens the tutorial and the file, and returns at once', async () => {
    await pendingChange('src/auth.ts', 'const ttl = 900\nreturn ttl', [
      'how long the token stays valid',
      'hands it back',
    ]);

    const started = Date.now();
    const res = await post('/try', { sessionId: SESSION, target: 'src/auth.ts', cwd: repo });
    // Opening must not park — the hook does the waiting.
    expect(Date.now() - started).toBeLessThan(200);
    expect(((await res.json()) as { status: string }).status).toBe('open');

    const tutorial = await readFile(tutorialPath(env, SESSION, 'src/auth.ts'), 'utf8');
    expect(tutorial).toContain('const ttl = 900');
    expect(tutorial).toContain('└ how long the token stays valid');

    // Created empty so the editor never opens a phantom buffer.
    expect(await fsIo.fileExists(join(repo, 'src/auth.ts'))).toBe(true);

    // Tutorial first, target second: focus has to land where they type.
    expect(launched).toHaveLength(1);
    expect(launched[0]?.tutorialPath).toContain('TRY-auth.ts-');
    expect(launched[0]?.targetPath).toBe(join(repo, 'src/auth.ts'));
  });

  it('parks the retried tool call, then hands back what they typed', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });

    const parked = retry('src/a.ts', 'const a = 1');
    await tick(30);

    await writeFile(join(repo, 'src/a.ts'), 'const a = 2 // my version\n');
    await post('/done', { sessionId: SESSION, target: 'src/a.ts' });

    const out = await reasonOf(await parked);
    // Never allow: running the tool would overwrite what they just wrote.
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('const a = 2 // my version');
    expect(out.permissionDecisionReason).toContain('const a = 1');
    expect(out.permissionDecisionReason).toContain('Do not retry');
  });

  it('says "still typing" rather than allowing when the wait expires', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });

    const out = await reasonOf(await retry('src/a.ts', 'const a = 1'));
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('still typing');
  });

  // Deleting it used to pull the document out from under the learner while it
  // was still open in their editor, taking the explanation with it exactly when
  // they were reading Claude's feedback on their code.
  it('keeps the tutorial after the try, and marks it handed back', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });
    expect(await listTutorials(env)).toHaveLength(1);

    const parked = retry('src/a.ts', 'const a = 1');
    await tick(30);
    await post('/done', { sessionId: SESSION });
    await parked;

    const [tutorial] = await listTutorials(env);
    expect(tutorial).toBeTruthy();
    const text = await readFile(tutorial as string, 'utf8');
    expect(text).toContain('Handed back');
    // The explanation the learner was reading survives.
    expect(text).toContain('└ sets a');
  });

  // The bug: the ticket outlived the try, so the agent's next identical call
  // asked the learner to approve overwriting the file they had just typed.
  it('refuses the same change again once the learner has written it', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });
    const parked = retry('src/a.ts', 'const a = 1');
    await tick(30);
    await writeFile(join(repo, 'src/a.ts'), 'const a = 1 // mine\n');
    await post('/done', { sessionId: SESSION });
    await parked;

    const again = await reasonOf(await retry('src/a.ts', 'const a = 1'));
    expect(again.permissionDecision).toBe('deny');
    expect(again.permissionDecisionReason).toContain('already typed');
  });

  it('still gates a genuinely different change to the same file', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });
    const parked = retry('src/a.ts', 'const a = 1');
    await tick(30);
    await post('/done', { sessionId: SESSION });
    await parked;

    // Different content, so the learner has not already written this one.
    const next = await reasonOf(await retry('src/a.ts', 'const b = 2'));
    expect(next.permissionDecisionReason).not.toContain('already typed');
  });

  it('does not open a second editor when the agent calls try twice', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });
    expect(launched).toHaveLength(1);
  });

  it('finishes when the checkbox is ticked in the tutorial', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });

    const parked = retry('src/a.ts', 'const a = 1');
    await tick(30);
    await writeFile(join(repo, 'src/a.ts'), 'const a = 2\n');

    const tut = tutorialPath(env, SESSION, 'src/a.ts');
    const text = await readFile(tut, 'utf8');
    await writeFile(tut, text.replace("- [ ] I'm done", "- [x] I'm done"));

    const out = await reasonOf(await parked);
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('const a = 2');
  });

  // Saving the code file is not a finish signal: a pause is thinking.
  it('keeps waiting while the learner saves and thinks', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });

    const parked = retry('src/a.ts', 'const a = 1');
    await tick(20);
    await writeFile(join(repo, 'src/a.ts'), 'const a = 2 // half done\n');
    await tick(40);

    // Untouched checkbox: the wait must still expire rather than complete.
    const out = await reasonOf(await parked);
    expect(out.permissionDecisionReason).toContain('still typing');
  });

  it('ignores a tutorial save that leaves the box unticked', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });

    const parked = retry('src/a.ts', 'const a = 1');
    await tick(20);
    const tut = tutorialPath(env, SESSION, 'src/a.ts');
    await writeFile(tut, `${await readFile(tut, 'utf8')}\nmy own note\n`);

    const out = await reasonOf(await parked);
    expect(out.permissionDecisionReason).toContain('still typing');
  });

  // Turning the plugin off is documented and encouraged; doing it mid-try must
  // not let the agent's write land on top of what the learner is typing.
  it('keeps parking even if the plugin is switched off mid-try', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });
    await post('/mode', { mode: 'off' });

    const out = await reasonOf(await retry('src/a.ts', 'const a = 1'));
    expect(out.permissionDecision).not.toBe('allow');
  });

  it('still passes a fresh call straight through when off', async () => {
    await post('/mode', { mode: 'off' });
    const out = await reasonOf(await retry('src/untouched.ts', 'x'));
    expect(out.permissionDecision).toBe('allow');
  });

  // A timer armed by one retry must not end a later retry's wait.
  it('gives each wait its own full timeout', async () => {
    await pendingChange('src/a.ts', 'const a = 1', ['sets a']);
    await post('/try', { sessionId: SESSION, target: 'src/a.ts', cwd: repo });

    await reasonOf(await retry('src/a.ts', 'const a = 1')); // first wait expires
    const started = Date.now();
    await reasonOf(await retry('src/a.ts', 'const a = 1')); // second must wait again
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  // On the window surface the learner answers through the CLI, and `try`
  // resolves the ticket. /try used to look tickets up via pending(), which
  // filters resolved ones out — so let-me-try 404'd on that surface entirely.
  it('opens after a `try` decision on the window surface', async () => {
    const mode = await promptMode(env);
    await mode.setSurface('window');
    const windowApp = createApp({
      store,
      tries,
      env,
      mode,
      log: createLogger(fsIo, env),
      toolNames: createToolNames(),
      token: TOKEN,
      decisionTimeoutMs: 150,
      tryWaitMs: 400,
    });
    const send = (path: string, body: unknown) =>
      windowApp.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

    await send('/explain', {
      sessionId: SESSION,
      target: 'src/win.ts',
      lines: [{ n: 1, note: 'sets a' }],
      why: 'because',
    });
    const parked = send('/hook', {
      sessionId: SESSION,
      cwd: repo,
      toolName: 'Write',
      toolInput: { file_path: 'src/win.ts', content: 'const a = 1' },
    });
    await tick(30);

    const ticket = store.pending().find((p) => p.target === 'src/win.ts')?.ticket;
    await send('/decision', { ticket, decision: 'try' });
    await parked;

    const res = await send('/try', { sessionId: SESSION, target: 'src/win.ts', cwd: repo });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('open');
  });

  it('says so when nothing was waiting', async () => {
    const res = await post('/done', { sessionId: 'nobody' });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  // The agent retries every few minutes while the learner types, so a try that
  // outlives the 10 minute ticket TTL must not fall over mid-typing.
  it('survives the ticket ageing out while the learner is still typing', async () => {
    let clock = 1_000;
    const shortLived = createTicketStore({ now: () => clock, ttlMs: 100 });
    const tryStore = createTryStore(env, fsIo, (_e, p) => launched.push(p));
    const app2 = createApp({
      store: shortLived,
      tries: tryStore,
      env,
      mode: await promptMode(env),
      log: createLogger(fsIo, env),
      toolNames: createToolNames(),
      token: TOKEN,
      tryWaitMs: 60,
    });

    const send = (path: string, body: unknown) =>
      app2.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

    await send('/explain', {
      sessionId: SESSION,
      target: 'src/slow.ts',
      lines: [{ n: 1, note: 'sets a' }],
      why: 'because',
    });
    await send('/hook', {
      sessionId: SESSION,
      cwd: repo,
      toolName: 'Write',
      toolInput: { file_path: 'src/slow.ts', content: 'const a = 1' },
    });
    await send('/try', { sessionId: SESSION, target: 'src/slow.ts', cwd: repo });

    clock += 10_000; // the ticket ages out while they are still typing

    const out = (await (
      await send('/hook', {
        sessionId: SESSION,
        cwd: repo,
        toolName: 'Write',
        toolInput: { file_path: 'src/slow.ts', content: 'const a = 1' },
      })
    ).json()) as { hookSpecificOutput: { permissionDecisionReason?: string } };
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('still typing');

    tryStore.close();
    shortLived.close();
  });
});

describe('tutorial cleanup', () => {
  const write = async (session: string, name: string) => {
    await fsIo.writeFileAtomic(tutorialPath(env, session, name), '# tutorial\n');
  };

  it('lists what is there', async () => {
    await write('s1', 'a.ts');
    await write('s2', 'b.ts');
    expect(await listTutorials(env)).toHaveLength(2);
  });

  it('removes one session without touching the others', async () => {
    await write('s1', 'a.ts');
    await write('s2', 'b.ts');
    expect((await cleanSession(env, 's1')).removed).toBe(1);
    expect(await listTutorials(env)).toHaveLength(1);
  });

  it('removes everything', async () => {
    await write('s1', 'a.ts');
    await write('s2', 'b.ts');
    expect((await cleanAll(env)).removed).toBe(2);
    expect(await listTutorials(env)).toHaveLength(0);
  });

  it('sweeps only what is past the age limit', async () => {
    await write('s1', 'a.ts');
    expect((await cleanOlderThan(env, 60_000, Date.now())).removed).toBe(0);
    expect((await cleanOlderThan(env, 60_000, Date.now() + 120_000)).removed).toBe(1);
    expect(await listTutorials(env)).toHaveLength(0);
  });

  it('is quiet when there is nothing to clean', async () => {
    expect((await cleanAll(env)).removed).toBe(0);
    expect((await cleanSession(env, 'ghost')).removed).toBe(0);
    expect(await listTutorials(env)).toEqual([]);
  });
});

function tick(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}