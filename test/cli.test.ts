import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daemonUrl, readDaemonAddress } from '../src/core/discovery.js';
import type { Env } from '../src/core/paths.js';

// The CLI had no tests at all, and that is exactly where `done` was broken: it
// sent a sentinel session id that could never match, so the one finish signal
// available outside VS Code always failed. These run the real binary against a
// real daemon in a temp state directory.

const root = new URL('..', import.meta.url).pathname;
const cli = join(root, 'src/cli.ts');
const daemonEntry = join(root, 'src/daemon/main.ts');

let home: string;
let env: Env;
let daemon: ChildProcess;

function childEnv() {
  return {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_RUNTIME_DIR: join(home, 'run'),
  };
}

function run(...args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', cli, ...args], {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ out, code: code ?? 0 }));
  });
}

async function api(path: string, init: RequestInit = {}) {
  const address = await readDaemonAddress(env);
  if (!address) throw new Error('daemon not running');
  return fetch(daemonUrl(address, path), {
    ...init,
    headers: {
      authorization: `Bearer ${address.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

// Puts a try in flight the way a real session would.
async function startTry(target: string) {
  await api('/explain', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'cli-session',
      target,
      lines: [{ n: 1, note: 'sets a' }],
      why: 'because',
    }),
  });
  await api('/hook', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'cli-session',
      cwd: join(home, 'repo'),
      toolName: 'Write',
      toolInput: { file_path: target, content: 'const a = 1' },
    }),
  });
  await api('/try', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'cli-session', target, cwd: join(home, 'repo') }),
  });
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-cli-'));
  env = { home, xdgStateHome: join(home, 'state'), xdgRuntimeDir: join(home, 'run') };

  daemon = spawn('npx', ['tsx', daemonEntry], { env: childEnv(), stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await readDaemonAddress(env)) return;
  }
  throw new Error('daemon did not start');
}, 40_000);

afterAll(async () => {
  daemon?.kill('SIGTERM');
  await rm(home, { recursive: true, force: true });
});

describe('let-me-explain done', () => {
  it('finishes the only try without being told which one', async () => {
    await startTry('src/solo.ts');

    const { out, code } = await run('done');
    expect(code).toBe(0);
    expect(out).toContain('handed');
    expect(out).toContain('solo.ts');
  }, 40_000);

  it('says plainly when nothing is waiting', async () => {
    const { out, code } = await run('done');
    expect(code).toBe(1);
    expect(out).toContain('nothing is waiting');
  }, 40_000);

  it('asks which one when several are in flight, rather than guessing', async () => {
    await startTry('src/one.ts');
    await startTry('src/two.ts');

    const { out, code } = await run('done');
    expect(code).toBe(1);
    expect(out).toContain('more than one');
    expect(out).toContain('--target');

    // Naming one resolves it, and leaves the other alone.
    const named = await run('done', '--target', 'src/one.ts');
    expect(named.code).toBe(0);
    expect(named.out).toContain('one.ts');

    const rest = await run('done');
    expect(rest.out).toContain('two.ts');
  }, 60_000);
});

describe('other commands', () => {
  it('reports status without a session', async () => {
    const { out } = await run('status');
    expect(out).toContain('running on 127.0.0.1');
    expect(out).toMatch(/mode:\s+on/);
    expect(out).toMatch(/surface:\s+prompt/);
  }, 40_000);

  it('switches mode and surface', async () => {
    expect((await run('off')).out).toContain('teaching off');
    expect((await run('status')).out).toMatch(/mode:\s+off/);
    expect((await run('on')).out).toContain('teaching on');

    expect((await run('surface', 'window')).out).toContain('surface: window');
    expect((await run('surface', 'prompt')).out).toContain('surface: prompt');
  }, 60_000);

  it('rejects an unknown surface instead of silently accepting it', async () => {
    const { out, code } = await run('surface', 'sideways');
    expect(code).toBe(1);
    expect(out).toContain('usage');
  }, 40_000);

  it('lists and cleans tutorials', async () => {
    await startTry('src/cleanme.ts');
    expect((await run('clean', '--list')).out).toContain('TRY-cleanme.ts');
    expect((await run('clean')).out).toMatch(/removed \d+ tutorial/);
    expect((await run('clean', '--list')).out).toContain('no tutorial files');
  }, 60_000);

  it('prints usage for an unknown command', async () => {
    const { out, code } = await run('wibble');
    expect(code).toBe(1);
    expect(out).toContain('let-me-explain');
  }, 40_000);
});