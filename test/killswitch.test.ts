import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/core/paths.js';
import { modePath } from '../src/core/paths.js';
import { createLogger } from '../src/daemon/log.js';
import { createModeStore, type ModeStore } from '../src/daemon/mode.js';
import { createApp } from '../src/daemon/routes.js';
import { createTicketStore, type TicketStore } from '../src/daemon/tickets.js';
import { createToolNames } from '../src/daemon/tool-name.js';
import { isOwnMachinery } from '../src/hook/policy.js';
import { fsIo } from '../src/io/fs-io.js';


const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const EDIT = {
  sessionId: 's1',
  cwd: '/repo',
  toolName: 'Edit',
  toolInput: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' },
};

let home: string;
let env: Env;
let app: Hono;
let store: TicketStore;
let mode: ModeStore;

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

async function decisionOf(res: Response) {
  const body = (await res.json()) as { hookSpecificOutput: { permissionDecision: string } };
  return body.hookSpecificOutput.permissionDecision;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-kill-'));
  env = { home, xdgStateHome: join(home, 'state'), xdgRuntimeDir: join(home, 'run') };
  store = createTicketStore();
  mode = await createModeStore(fsIo, modePath(env));
  app = createApp({
    store,
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

describe('mode', () => {
  it('off passes the call straight through and mints nothing', async () => {
    await mode.set('off');
    expect(await decisionOf(await post('/hook', EDIT))).toBe('allow');
    expect(store.size()).toBe(0);
  });

  it('on blocks the same call', async () => {
    expect(await decisionOf(await post('/hook', EDIT))).toBe('deny');
  });

  it('scopes a session switch so other projects are untouched', async () => {
    await mode.set('off', 's1');
    expect(await decisionOf(await post('/hook', EDIT))).toBe('allow');
    expect(await decisionOf(await post('/hook', { ...EDIT, sessionId: 's2' }))).toBe('deny');
  });

  it('survives a restart by reading back what it wrote', async () => {
    await mode.set('off');
    const reloaded = await createModeStore(fsIo, modePath(env));
    expect(reloaded.get()).toBe('off');
  });

  it('ignores a corrupt mode file rather than refusing to start', async () => {
    await fsIo.writeFileAtomic(modePath(env), 'not json {');
    const reloaded = await createModeStore(fsIo, modePath(env));
    expect(reloaded.get()).toBe('on');
  });
});

describe('never-intercept list', () => {
  it('lets our own control command through, so the switch can be thrown', () => {
    expect(isOwnMachinery('Bash', { command: 'let-me-explain off' })).toBe(true);
    expect(isOwnMachinery('Bash', { command: 'npx let-me-explain status' })).toBe(true);
  });

  it('lets our own MCP tools through, so explain() is not an infinite regress', () => {
    expect(isOwnMachinery('mcp__plugin_let-me-explain_lme__explain', {})).toBe(true);
    expect(isOwnMachinery('mcp__plugin_let-me-explain_lme__answer', {})).toBe(true);
  });

  it('exempts our CLI invoked by path, so the switch works when installed', () => {
    expect(
      isOwnMachinery('Bash', {
        command: 'node /home/x/.claude/plugins/cache/let-me-explain/let-me-explain/0.2.0/dist/cli.js off',
      }),
    ).toBe(true);
  });

  it('still intercepts ordinary work', () => {
    expect(isOwnMachinery('Bash', { command: 'npm test' })).toBe(false);
    expect(isOwnMachinery('Edit', { file_path: '/a.ts' })).toBe(false);
    expect(isOwnMachinery('mcp__other__explain_thing', {})).toBe(false);
  });

  // Found live: the substring test exempted every command mentioning a path
  // that contained the project name, silently disabling interception.
  it('does not exempt a command that merely mentions the name in a path', () => {
    expect(
      isOwnMachinery('Bash', { command: 'chmod +x /tmp/stuff-let-me-explain/scratch/greet.sh' }),
    ).toBe(false);
    expect(isOwnMachinery('Bash', { command: 'cd ~/Desktop/let-me-explain && npm test' })).toBe(
      false,
    );
    expect(isOwnMachinery('Bash', { command: 'grep -r let-me-explain src/' })).toBe(false);
  });
});

describe('unknown tools', () => {
  it('passes through anything with nothing to explain', async () => {
    expect(
      await decisionOf(await post('/hook', { ...EDIT, toolName: 'Read', toolInput: { file_path: '/a' } })),
    ).toBe('allow');
  });

  it('passes through an empty change', async () => {
    expect(
      await decisionOf(
        await post('/hook', { ...EDIT, toolInput: { file_path: '/a.ts', new_string: '' } }),
      ),
    ).toBe('allow');
  });
});

describe('the shim fails open', () => {
  const shim = new URL('../src/hook/pretooluse.ts', import.meta.url).pathname;

  // execFile has no `input` option — writing and closing stdin ourselves is
  // the only way the shim actually receives a payload.
  const runShim = (input: string, extraEnv: Record<string, string> = {}) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn('npx', ['tsx', shim], {
        env: {
          ...process.env,
          HOME: home,
          XDG_STATE_HOME: join(home, 'state'),
          XDG_RUNTIME_DIR: join(home, 'run'),
          ...extraEnv,
        },
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

  const payload = JSON.stringify({
    session_id: 's1',
    cwd: '/repo',
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/a.ts', new_string: 'b' },
  });

  it('allows when no daemon is running', async () => {
    const stdout = await runShim(payload);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows when handed malformed JSON', async () => {
    const stdout = await runShim('not json at all {');
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows when LET_ME_EXPLAIN=0, without touching the network', async () => {
    const stdout = await runShim(payload, { LET_ME_EXPLAIN: '0' });
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });
}, 30_000);
