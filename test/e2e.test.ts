import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDaemonAddress } from '../src/core/discovery.js';
import type { Env } from '../src/core/paths.js';
import { listTutorials } from '../src/core/cleanup.js';
import {
  activeTry,
  allow,
  buttonLabel,
  fileName,
  finishTry,
  letMeTry,
  pendingDecision,
} from '../vscode-extension/src/daemon.js';

// The whole journey a learner takes, with every piece real except the model:
// the actual hook shim binary, the actual daemon, the actual MCP server driven
// through a real MCP client, and the actual code behind the VS Code button.
// The test makes the tool calls a real agent would, in the order it makes them.

const root = new URL('..', import.meta.url).pathname;
const SESSION = 'e2e-session';

let home: string;
let repo: string;
let env: Env;
let daemon: ChildProcess;
let mcp: Client;

function childEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_RUNTIME_DIR: join(home, 'run'),
    // Without this the daemon opens a real editor window for every try.
    LET_ME_EXPLAIN_NO_LAUNCH: '1',
    ...extra,
  };
}

/** Runs one of our real hook entry points with a payload on stdin. */
function runHook(entry: string, payload: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', join(root, entry)], {
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

const toolCall = (target: string, content: string) => ({
  session_id: SESSION,
  cwd: repo,
  tool_name: 'Write',
  tool_input: { file_path: target, content },
});

async function decisionOf(raw: string) {
  const out = (
    JSON.parse(raw) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason?: string;
        additionalContext?: string;
        updatedInput?: Record<string, unknown>;
      };
    }
  ).hookSpecificOutput;
  return { ...out, permissionDecisionReason: out.permissionDecisionReason ?? out.additionalContext };
}

async function api(path: string, body?: unknown): Promise<unknown> {
  const at = await readDaemonAddress(env);
  if (!at) throw new Error('daemon is not running');
  const res = await fetch(`http://127.0.0.1:${at.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${at.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.json();
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await mcp.callTool({ name, arguments: args })) as {
    content?: { text?: string }[];
    isError?: boolean;
  };
  return res.content?.map((c) => c.text ?? '').join('\n') ?? '';
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-e2e-'));
  repo = join(home, 'repo');
  await mkdir(repo, { recursive: true });
  env = { home, xdgStateHome: join(home, 'state'), xdgRuntimeDir: join(home, 'run') };

  // detached so the whole group can be killed: `npx` wraps `tsx`, and killing
  // only the wrapper leaves the daemon running and vitest unable to exit.
  daemon = spawn('npx', ['tsx', join(root, 'src/daemon/main.ts')], {
    env: childEnv(),
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await readDaemonAddress(env)) break;
  }
  const at = await readDaemonAddress(env);
  if (!at) throw new Error('daemon did not start');

  // The shipped default is `window`; this journey is the `prompt` one, and the
  // window journey below switches it back for itself.
  await api('/surface', { surface: 'prompt' });

  // A real MCP client against our real MCP server, exactly as Claude Code does.
  mcp = new Client({ name: 'e2e', version: '0' });
  await mcp.connect(
    new StdioClientTransport({
      command: 'npx',
      args: ['tsx', join(root, 'src/mcp/server.ts')],
      env: { ...childEnv(), CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: repo },
    }),
  );
}, 60_000);

afterAll(async () => {
  await mcp?.close().catch(() => {});
  if (daemon?.pid) {
    try {
      process.kill(-daemon.pid, 'SIGTERM');
    } catch {
      daemon.kill('SIGTERM');
    }
  }
  await rm(home, { recursive: true, force: true });
});

describe('the whole journey', () => {
  it('1. activating the plugin injects instructions naming the real tool', async () => {
    const text = await runHook('src/hook/session-start.ts', '{}');
    expect(text).toContain('<let-me-explain>');
    expect(text).toContain('__explain');
    expect(text).toContain('let_me_try');
  }, 60_000);

  it('2–4. the agent explains, the change is held, and the learner sees why', async () => {
    const said = await callTool('explain', {
      target: 'src/greet.ts',
      lines: [
        { n: 1, note: 'names the person being greeted' },
        { n: 2, note: 'prints the greeting' },
      ],
      why: 'there was no way to greet anyone yet',
    });
    expect(said).toContain('Recorded');

    const out = await decisionOf(
      await runHook(
        'src/hook/pretooluse.ts',
        toolCall('src/greet.ts', "const who = 'world'\nconsole.log(`hello ${who}`)"),
      ),
    );

    // Claude Code collects the answer; we hand it the explanation.
    expect(out.permissionDecision).toBe('ask');
    expect(out.permissionDecisionReason).toContain('there was no way to greet anyone yet');
    expect(out.permissionDecisionReason).toContain('names the person being greeted');
    expect(out.permissionDecisionReason).toContain('prints the greeting');

    // The learner approves, so the tool runs.
    await writeFile(join(repo, 'src/greet.ts'), "const who = 'world'\n", { flag: 'w' }).catch(
      async () => {
        await mkdir(join(repo, 'src'), { recursive: true });
        await writeFile(join(repo, 'src/greet.ts'), "const who = 'world'\n");
      },
    );
  }, 60_000);

  it('5–7. on the second change the learner takes over, and a tutorial opens', async () => {
    await callTool('explain', {
      target: 'src/ttl.ts',
      lines: [{ n: 1, note: 'how long the token stays valid, in seconds' }],
      why: 'tokens never expired, so a stolen one worked forever',
    });

    const asked = await decisionOf(
      await runHook('src/hook/pretooluse.ts', toolCall('src/ttl.ts', 'const ttl = 900')),
    );
    expect(asked.permissionDecision).toBe('ask');

    // The learner rejects with "I'll write it myself"; the agent responds by
    // calling let_me_try, which opens the tutorial and returns at once.
    const opened = await callTool('let_me_try', { target: 'src/ttl.ts' });
    expect(opened).toContain('make the original tool call');

    const [tutorial] = await listTutorials(env);
    expect(tutorial).toBeTruthy();
    const text = await readFile(tutorial as string, 'utf8');
    expect(text).toContain('const ttl = 900');
    expect(text).toContain('└ how long the token stays valid');
    expect(text).toContain("- [ ] I'm done");
  }, 60_000);

  it('8–12. the retry parks, the button ends it, and the agent gets the learner’s code', async () => {
    // The agent retries; this parks until the learner is finished.
    const parked = runHook('src/hook/pretooluse.ts', toolCall('src/ttl.ts', 'const ttl = 900'));
    await sleep(2_000);

    // The learner types their own version.
    await writeFile(join(repo, 'src/ttl.ts'), 'const ttl = 60 * 15 // 15 minutes\n');

    // Pressing the button — the extension's own code, against the real daemon.
    const attempt = await activeTry(childEnv());
    expect(attempt).toBeTruthy();
    expect(attempt?.target).toContain('ttl.ts');
    expect(buttonLabel(attempt!)).toContain("I'm done");
    expect(await finishTry(attempt!, childEnv())).toBe(true);

    const out = await decisionOf(await parked);
    // Allowed with the learner's bytes substituted, so the write is a no-op and
    // the successful handback does not render as a red error. The real shim
    // carried the wider JSON through untouched.
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput).toMatchObject({
      content: 'const ttl = 60 * 15 // 15 minutes\n',
    });
    expect(out.permissionDecisionReason).toContain('const ttl = 60 * 15 // 15 minutes');
    expect(out.permissionDecisionReason).toContain('const ttl = 900');

    // The tutorial stays, marked, so the learner can still read it.
    const [tutorial] = await listTutorials(env);
    expect(await readFile(tutorial as string, 'utf8')).toContain('Handed back');
  }, 90_000);

  // The surface the plugin now ships with. Claude Code's own prompt has three
  // fixed entries and a plugin cannot add a fourth, so "let me try" only
  // becomes something you *pick* here, where the daemon holds the tool call
  // open and the buttons are ours to draw.
  describe('the window surface, where the buttons are the menu', () => {
    // The real extension polls /active every 2s, and that poll is also how the
    // daemon knows a status bar exists — without it the hook refuses to hold a
    // change open. Simulating the poll is therefore part of simulating VS Code.
    let polling: NodeJS.Timeout;

    beforeAll(async () => {
      await api('/surface', { surface: 'window' });
      polling = setInterval(() => void pendingDecision(childEnv()).catch(() => {}), 1_000);
      await sleep(1_100);
    });

    afterAll(async () => {
      clearInterval(polling);
      await api('/surface', { surface: 'prompt' });
    });

    it('holds the change and offers Allow / Let me try, and Allow lets it through', async () => {
      await callTool('explain', {
        target: 'src/allow.ts',
        lines: [{ n: 1, note: 'the port the server listens on' }],
        why: 'the port was hard-coded in three places',
      });
      const parked = runHook('src/hook/pretooluse.ts', toolCall('src/allow.ts', 'const port = 8080'));
      await sleep(2_000);

      const held = await pendingDecision(childEnv());
      expect(held).toBeTruthy();
      expect(fileName(held!.target)).toBe('allow.ts');
      // Everything the learner needs to decide is on the button itself.
      expect(held!.explanation).toContain('the port was hard-coded in three places');
      expect(held!.explanation).toContain('the port the server listens on');

      expect(await allow(held!, childEnv())).toBe(true);
      expect((await decisionOf(await parked)).permissionDecision).toBe('allow');
      expect(await pendingDecision(childEnv())).toBeNull();
    }, 60_000);

    it('Let me try stands the agent down and opens the tutorial', async () => {
      await callTool('explain', {
        target: 'src/mine.ts',
        lines: [{ n: 1, note: 'how many times a failed call is retried' }],
        why: 'one flaky call took the whole request down',
      });
      const parked = runHook('src/hook/pretooluse.ts', toolCall('src/mine.ts', 'const retries = 3'));
      await sleep(2_000);

      const held = await pendingDecision(childEnv());
      expect(held).toBeTruthy();
      expect(await letMeTry(held!, childEnv())).toBe(true);

      // The agent is told to stand down rather than allowed to write.
      const out = await decisionOf(await parked);
      expect(out.permissionDecision).toBe('deny');
      expect(out.permissionDecisionReason).toContain('let_me_try');

      // Which is exactly the call it then makes — and the tutorial appears.
      const opened = await callTool('let_me_try', { target: 'src/mine.ts' });
      expect(opened).toContain('make the original tool call');
      const tutorial = (await listTutorials(env)).find((t) => t.includes('mine'));
      expect(tutorial).toBeTruthy();
      expect(await readFile(tutorial as string, 'utf8')).toContain('const retries = 3');

      // And the "I'm done" button takes over from there, as before.
      await writeFile(join(repo, 'src/mine.ts'), 'const retries = 5\n');
      const attempt = await activeTry(childEnv());
      expect(attempt?.target).toContain('mine.ts');
      expect(await finishTry(attempt!, childEnv())).toBe(true);
    }, 90_000);
  });

  it('the journey left an honest record', async () => {
    const dir = join(home, 'state', 'let-me-explain', 'log');
    const files = await readFile(join(dir, `${SESSION}.jsonl`), 'utf8');
    const types = files
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);

    // Explained up front every time — no denial was ever needed.
    expect(types.filter((t) => t === 'explain.shelved')).toHaveLength(4);
    expect(types.filter((t) => t === 'explain.prebound')).toHaveLength(4);
    expect(types).not.toContain('ticket.minted');
    expect(types).toContain('try.begin');
    expect(types).toContain('try.done');
    // Coverage is measured now that it is no longer enforced.
    expect(types.filter((t) => t === 'explain.coverage').length).toBeGreaterThanOrEqual(4);
  }, 60_000);
});
