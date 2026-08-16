import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { type DaemonAddress, daemonUrl, readDaemonAddress } from './core/discovery.js';
import { envFromProcess } from './io/env.js';
import { TOOL_VERSION } from './version.js';

const env = envFromProcess();

const USAGE = `let-me-explain ${TOOL_VERSION}

  status              is it running, and which mode
  on | off            teaching on, or plain Claude Code back
  start | stop        run the background daemon
  pending             what the agent is waiting on
  allow <ticket>      let this change through
  write <ticket>      take it over and write it yourself

  --session <id>      scope on/off to one session instead of globally
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function connected(): Promise<DaemonAddress> {
  const address = await readDaemonAddress(env);
  if (!address) fail('let-me-explain is not running. Start it with: let-me-explain start');
  return address;
}

async function call(
  address: DaemonAddress,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(daemonUrl(address, path), {
    ...init,
    headers: {
      authorization: `Bearer ${address.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${path}: ${(body as { error?: string }).error ?? res.status}`);
  return body;
}

async function start(): Promise<void> {
  if (await readDaemonAddress(env)) {
    process.stdout.write('already running\n');
    return;
  }
  const entry = new URL('./daemon/main.js', import.meta.url);
  const child = spawn(process.execPath, [entry.pathname], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await readDaemonAddress(env)) {
      process.stdout.write('started\n');
      return;
    }
  }
  fail('daemon did not come up within 5s');
}

async function stop(): Promise<void> {
  const address = await readDaemonAddress(env);
  if (!address?.pid) {
    process.stdout.write('not running\n');
    return;
  }
  try {
    process.kill(address.pid, 'SIGTERM');
    process.stdout.write('stopped\n');
  } catch {
    process.stdout.write('not running\n');
  }
}

async function status(): Promise<void> {
  const address = await readDaemonAddress(env);
  if (!address) {
    process.stdout.write('let-me-explain: not running (agent runs unaffected)\n');
    return;
  }
  const mode = (await call(address, '/mode')) as { mode: string; global: string };
  const { pending } = (await call(address, '/pending')) as { pending: unknown[] };
  process.stdout.write(
    `let-me-explain: running on 127.0.0.1:${address.port}\n` +
      `  mode:    ${mode.global}\n` +
      `  pending: ${pending.length}\n`,
  );
}

async function pending(): Promise<void> {
  const address = await connected();
  const { pending: items } = (await call(address, '/pending')) as {
    pending: {
      ticket: string;
      state: string;
      toolName: string;
      target: string;
      why?: string;
      lines: { n: number; code: string; note?: string }[];
    }[];
  };

  if (items.length === 0) {
    process.stdout.write('nothing waiting\n');
    return;
  }

  for (const item of items) {
    process.stdout.write(`\n${item.ticket}  ${item.toolName}  ${item.target}  [${item.state}]\n`);
    if (item.why) process.stdout.write(`  why: ${item.why}\n`);
    for (const line of item.lines) {
      process.stdout.write(`  ${String(line.n).padStart(3)} │ ${line.code}\n`);
      if (line.note) process.stdout.write(`      └ ${line.note}\n`);
    }
  }
  process.stdout.write('\n');
}

async function decide(ticket: string | undefined, decision: 'allow' | 'write'): Promise<void> {
  if (!ticket) fail(`usage: let-me-explain ${decision} <ticket>`);
  const address = await connected();
  await call(address, '/decision', {
    method: 'POST',
    body: JSON.stringify({ ticket, decision }),
  });
  process.stdout.write(`${ticket}: ${decision}\n`);
}

async function setMode(mode: 'on' | 'off', sessionId?: string): Promise<void> {
  const address = await connected();
  await call(address, '/mode', {
    method: 'POST',
    body: JSON.stringify({ mode, ...(sessionId ? { sessionId } : {}) }),
  });
  process.stdout.write(
    mode === 'on' ? 'teaching on\n' : 'teaching off — plain Claude Code until you turn it back on\n',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const sessionFlag = args.indexOf('--session');
  const sessionId = sessionFlag === -1 ? undefined : args[sessionFlag + 1];

  switch (command) {
    case 'status':
      return status();
    case 'on':
      return setMode('on', sessionId);
    case 'off':
      return setMode('off', sessionId);
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'pending':
      return pending();
    case 'allow':
      return decide(args[1], 'allow');
    case 'write':
      return decide(args[1], 'write');
    default:
      process.stdout.write(USAGE);
      process.exit(command === undefined || command === '--help' ? 0 : 1);
  }
}

main().catch((e: unknown) => fail(String(e)));