import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
let available = true;

function childEnv() {
  return {
    ...process.env,
    HOME: home,
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

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-live-'));
  repo = join(home, 'repo');
  await mkdir(repo, { recursive: true });
  env = { home, xdgStateHome: join(home, 'state'), xdgRuntimeDir: join(home, 'run') };

  // Skip rather than fail when the CLI or a login is missing: a suite that
  // fails for the wrong reason is one people stop reading.
  try {
    await run('claude', ['--version']);
  } catch {
    available = false;
    return;
  }

  // Install the plugin into the temp project for real. Hand-writing settings
  // does not enable a plugin — it has to come from a marketplace, and the
  // marketplace has to be added from this repo, built.
  try {
    await run('npm', ['run', 'build'], { cwd: root });
    await run('claude', ['plugin', 'marketplace', 'add', root], { cwd: repo, env: childEnv() });
    await run(
      'claude',
      ['plugin', 'install', 'let-me-explain@let-me-explain', '--scope', 'project'],
      { cwd: repo, env: childEnv() },
    );
  } catch {
    available = false;
    return;
  }

  daemon = spawn('npx', ['tsx', join(root, 'src/daemon/main.ts')], {
    env: childEnv(),
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await readDaemonAddress(env)) break;
  }
  await cli('surface', 'window');
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

describe.runIf(process.env.LME_LIVE !== '0')('a real session, end to end', () => {
  it('explains before it acts, and the learner approves', async () => {
    if (!available) return expect(available, 'claude CLI not available — skipped').toBe(false);

    const session = ask('Create greet.sh: a bash script that prints "hello". Nothing else.');
    const ticket = await waitForPending();

    const pending = await cli('pending');
    expect(pending).toMatch(/why:/i);
    expect(pending).toMatch(/└/); // at least one per-line note

    await cli('allow', ticket);
    session.kill();
  }, 300_000);

  it('hands over when the learner says they will write it', async () => {
    if (!available) return;

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

  it('reports a deny-rate near zero — the instructions are still landing', async () => {
    if (!available) return;

    const stats = await cli('stats');
    const denied = Number(stats.match(/needed a denial\s+(\d+)/)?.[1] ?? '0');
    const intercepted = Number(stats.match(/intercepted\s+(\d+)/)?.[1] ?? '0');

    expect(intercepted).toBeGreaterThan(0);
    // A rise here means the model has stopped explaining before it acts.
    expect(denied / intercepted).toBeLessThanOrEqual(0.5);
  }, 60_000);
});
