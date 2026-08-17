import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDaemonAddress } from '../../src/core/discovery.js';
import type { Env } from '../../src/core/paths.js';

// The same journey as test/e2e.test.ts, but with a real `claude -p` session
// instead of scripted tool calls. It is the only thing that catches the model
// no longer following the injected instructions — which is silent everywhere
// else — so it reports deny-rate at the end.
//
// Not part of `npm test`: it needs credentials and a network, takes minutes,
// and is nondeterministic. `npm run test:e2e`.

const run = promisify(execFile);
const root = new URL('../..', import.meta.url).pathname;

let home: string;
let repo: string;
let env: Env;
let daemon: ChildProcess;
// Decided at load time so `describe.skipIf` can report a genuine skip. A guard
// inside the test body would make an unavailable environment look like a pass.
const available = await (async () => {
  try {
    const { stdout } = await run('claude', ['plugin', 'list']);
    return /let-me-explain@let-me-explain[\s\S]{0,80}enabled/.test(stdout);
  } catch {
    return false;
  }
})();
if (!available) {
  process.stderr.write(
    '\n  live journey SKIPPED: the plugin is not installed and enabled.\n' +
      '  claude plugin marketplace add ./ && claude plugin install let-me-explain@let-me-explain --scope user\n\n',
  );
}

// HOME is deliberately NOT overridden: `claude` resolves user-scope plugins
// through it, so pointing it at a temp directory gave the spawned sessions no
// plugin at all — the first run of this suite failed for exactly that reason.
// Only our own state is isolated.
function childEnv() {
  return {
    ...process.env,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_RUNTIME_DIR: join(home, 'run'),
    LET_ME_EXPLAIN_NO_LAUNCH: '1',
  };
}

const cli = (...args: string[]) =>
  run('npx', ['tsx', join(root, 'src/cli.ts'), ...args], { env: childEnv() })
    .then((r) => r.stdout)
    .catch((e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`);

/** Ask the real agent for something, in the temp project, without blocking forever. */
function ask(prompt: string): ChildProcess {
  return spawn('claude', ['-p', prompt], { cwd: repo, env: childEnv(), stdio: 'ignore' });
}

/** Poll `pending` until the agent has explained something and is waiting. */
async function waitForPending(seconds = 120): Promise<string> {
  for (let i = 0; i < seconds * 2; i++) {
    const out = await cli('pending');
    const ticket = out.match(/t_[0-9a-f]+/)?.[0];
    if (ticket && out.includes('awaiting_decision')) return ticket;
    await sleep(500);
  }
  throw new Error('the agent never explained anything');
}

/** Every session log the daemon has written — `claude -p` picks its own id. */
async function allLogs(): Promise<string> {
  const dir = join(home, 'state', 'let-me-explain', 'log');
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    f.endsWith('.jsonl'),
  );
  const parts = await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')));
  return parts.join('\n');
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-live-'));
  repo = join(home, 'repo');
  await mkdir(repo, { recursive: true });
  env = { home, xdgStateHome: join(home, 'state'), xdgRuntimeDir: join(home, 'run') };

  // Build so the installed plugin and this checkout agree. Any failure here is
  // a real failure — the suite has already decided it can run.
  await run('npm', ['run', 'build'], { cwd: root });

  daemon = spawn('npx', ['tsx', join(root, 'src/daemon/main.ts')], {
    env: childEnv(),
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await readDaemonAddress(env)) break;
  }
  // The shipped default. `window` would need a VS Code extension polling to
  // hold anything, and there is none here.
  await cli('surface', 'prompt');
  await cli('on');
}, 120_000);

afterAll(async () => {
  if (daemon?.pid) {
    try {
      process.kill(-daemon.pid, 'SIGTERM');
    } catch {
      daemon.kill('SIGTERM');
    }
  }
  if (home) await rm(home, { recursive: true, force: true });
});

describe.skipIf(!available)('a real session, end to end', () => {
  it('explains before it acts, and the learner approves', async () => {
    const session = ask('Create greet.sh: a bash script that prints "hello". Nothing else.');
    const ticket = await waitForPending();

    const pending = await cli('pending');
    expect(pending).toMatch(/why:/i);
    expect(pending).toMatch(/└/); // at least one per-line note

    await cli('allow', ticket);
    session.kill();
  }, 300_000);

  it('hands over when the learner says they will write it', async () => {
    const session = ask('Now create ttl.sh containing a single line that sets TTL to 900.');
    const ticket = await waitForPending();

    // The learner takes it over. The agent should respond by calling let_me_try.
    await cli('try', ticket);

    let tutorial = '';
    for (let i = 0; i < 120; i++) {
      const list = await cli('clean', '--list');
      if (list.includes('TRY-')) {
        tutorial = list.trim().split('\n')[0] as string;
        break;
      }
      await sleep(500);
    }
    expect(tutorial, 'the agent never called let_me_try').toContain('TRY-');
    expect(await readFile(tutorial, 'utf8')).toContain("- [ ] I'm done");

    // The learner types their own version, then presses done.
    await writeFile(join(repo, 'ttl.sh'), 'TTL=900 # mine\n');
    expect(await cli('done')).toContain('handed');

    session.kill();
  }, 300_000);

  // The failure that came back from real use three times running: editing an
  // existing file, where the agent's new_string carries unchanged context and
  // its line numbers refer to positions in the file. Creating a new file never
  // reproduced it, so the earlier tests all passed while this was broken.
  it('accepts an edit to an existing file, context lines and all', async () => {
    await writeFile(
      join(repo, 'greet.js'),
      'function greet(name) {\n  return name\n}\n\nmodule.exports = { greet }\n',
    );

    const session = ask(
      'In greet.js, make greet trim the name and fall back to "there" when it is empty. ' +
        'Edit the existing function; do not rewrite the file.',
    );
    const ticket = await waitForPending();

    const pending = await cli('pending');
    expect(pending).toMatch(/greet\.js/);
    expect(pending).toMatch(/└/);

    await cli('allow', ticket);
    session.kill();

    // The whole point: no round trip was wasted arguing about which lines
    // needed a note.
    // Every session's log, since `claude -p` picks its own session id.
    const log = await allLogs();
    expect(log).toContain('explain.coverage');
    expect(log).not.toContain('explain.rejected');
    expect(log).not.toContain('explain.mismatched');
  }, 300_000);

  // Claude Code's permission prompt takes three fixed entries and a plugin
  // cannot add a fourth, so "let me try" only becomes a thing you pick if the
  // model calls AskUserQuestion. That tool does not exist in `-p` mode — there
  // is nobody to answer — so this asserts the half we control: that the
  // instruction actually reaches the model. Whether it acts on it is a model
  // property and can only be seen in a real interactive session.
  it('puts the menu in front of the model', async () => {
    const { stdout } = await run(
      'claude',
      [
        '-p',
        'Create menu.sh containing a single line that echoes "hi". Nothing else.',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      { cwd: repo, env: childEnv(), maxBuffer: 64 * 1024 * 1024 },
    ).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));

    const tools: string[] = [];
    const results: string[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          message?: { content?: { type?: string; name?: string; content?: unknown }[] };
        };
        for (const part of event.message?.content ?? []) {
          if (part.type === 'tool_use' && part.name) tools.push(part.name);
          if (part.type === 'tool_result') results.push(JSON.stringify(part.content));
        }
      } catch {
        // stream-json interleaves other line shapes; only these two matter.
      }
    }

    expect(tools.some((t) => t.endsWith('__explain')), `saw ${tools.join(', ')}`).toBe(true);
    const menu = results.find((r) => r.includes('AskUserQuestion'));
    expect(menu, 'the explain reply never carried the menu').toBeTruthy();
    expect(menu).toContain('Let me try');
    // And it degrades rather than stalling where the tool does not exist.
    expect(menu).toContain('No AskUserQuestion tool');
  }, 300_000);

  it('reports a deny-rate near zero — the instructions are still landing', async () => {
    const stats = await cli('stats');
    const denied = Number(stats.match(/needed a denial\s+(\d+)/)?.[1] ?? '0');
    const intercepted = Number(stats.match(/intercepted\s+(\d+)/)?.[1] ?? '0');

    expect(intercepted).toBeGreaterThan(0);
    // A rise here means the model has stopped explaining before it acts.
    expect(denied / intercepted).toBeLessThanOrEqual(0.5);
  }, 60_000);
});
