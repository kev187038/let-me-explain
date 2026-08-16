import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { daemonUrl, readDaemonAddress } from '../core/discovery.js';
import { envFromProcess } from '../io/env.js';

// Claude Code injects this hook's stdout into the session as context, so the
// only thing printed here is the instruction block — and nothing at all if
// anything goes wrong. A session with no instructions still works.

const env = envFromProcess();

async function ensureDaemon(): Promise<void> {
  if (await readDaemonAddress(env)) return;

  const entry = new URL('../daemon/main.js', import.meta.url);
  spawn(process.execPath, [entry.pathname], { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (await readDaemonAddress(env)) return;
  }
}

async function main(): Promise<void> {
  if (process.env.LET_ME_EXPLAIN === '0') return;

  await ensureDaemon();
  const address = await readDaemonAddress(env);
  if (!address) return;

  const res = await fetch(daemonUrl(address, '/instructions'), {
    headers: { authorization: `Bearer ${address.token}` },
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) return;

  process.stdout.write(await res.text());
}

main().catch(() => {});