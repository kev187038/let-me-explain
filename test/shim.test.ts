import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDaemonAddress } from '../src/core/discovery.js';
import type { Env } from '../src/core/paths.js';
import { modePath } from '../src/core/paths.js';

// A positive control for the shim. Every other shim test asserts "allow",
// which a shim that did nothing at all would also pass — this one proves it
// really talks to the daemon and really blocks.

const root = new URL('..', import.meta.url).pathname;
const shim = join(root, 'src/hook/pretooluse.ts');
const daemonEntry = join(root, 'src/daemon/main.ts');

let home: string;
let env: Env;
let daemon: ChildProcess;

function childEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_RUNTIME_DIR: join(home, 'run'),
    ...extra,
  };
}

function runShim(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', shim], {
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.write(input);
    child.stdin.end();
  });
}

const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 'shim-test',
    cwd: '/repo',
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'const a = 1' },
    ...over,
  });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-shim-'));
  env = { home, xdgStateHome: join(home, 'state'), xdgRuntimeDir: join(home, 'run') };

  daemon = spawn('npx', ['tsx', daemonEntry], { env: childEnv(), stdio: 'ignore' });

  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await readDaemonAddress(env)) return;
  }
  throw new Error('daemon did not start');
}, 30_000);

afterAll(async () => {
  daemon?.kill('SIGTERM');
  await rm(home, { recursive: true, force: true });
});

describe('shim against a live daemon', () => {
  it('denies an unexplained edit and hands back a ticket', async () => {
    const out = JSON.parse(await runShim(payload()));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/t_[0-9a-f]+/);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('__explain');
  }, 30_000);

  it('never intercepts our own control command', async () => {
    const out = JSON.parse(
      await runShim(payload({ tool_name: 'Bash', tool_input: { command: 'let-me-explain off' } })),
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  }, 30_000);

  it('passes straight through once the mode file says off', async () => {
    await mkdir(join(home, 'state', 'let-me-explain'), { recursive: true });
    await writeFile(modePath(env), JSON.stringify({ global: 'off', sessions: {} }));

    const out = JSON.parse(await runShim(payload()));
    expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
  }, 30_000);
});