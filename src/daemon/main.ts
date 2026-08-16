import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, unlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { lockFilePath, modePath, portFilePath, runtimeDir } from '../core/paths.js';
import { envFromProcess } from '../io/env.js';
import { fsIo } from '../io/fs-io.js';
import { TOOL_VERSION } from '../version.js';
import { createLogger } from './log.js';
import { createModeStore } from './mode.js';
import { createApp } from './routes.js';
import { createTicketStore } from './tickets.js';
import { createToolNames } from './tool-name.js';

const env = envFromProcess();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// O_EXCL makes creation atomic, so two daemons racing to start cannot both
// win. A lock left behind by a crash is detected by checking its pid.
async function acquireLock(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch {
      const owner = Number((await fsIo.readFileIfExists(path)) ?? '0');
      if (owner && owner !== process.pid && isAlive(owner)) return false;
      await fsIo.deleteFileIfExists(path);
    }
  }
  return false;
}

async function main(): Promise<void> {
  const dir = runtimeDir(env);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => {});

  if (!(await acquireLock(lockFilePath(env)))) {
    process.stderr.write('let-me-explain: daemon already running\n');
    process.exit(0);
  }

  const token = randomBytes(32).toString('hex');
  const store = createTicketStore();
  const app = createApp({
    store,
    mode: await createModeStore(fsIo, modePath(env)),
    log: createLogger(fsIo, env),
    toolNames: createToolNames(),
    token,
  });

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });

  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const portFile = portFilePath(env);
  await fsIo.writeFileAtomic(
    portFile,
    `${JSON.stringify({ port, token, pid: process.pid, version: TOOL_VERSION })}\n`,
  );
  // The token authorises approving file edits, so keep it owner-only.
  await chmod(portFile, 0o600).catch(() => {});

  process.stdout.write(`let-me-explain daemon on 127.0.0.1:${port}\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    store.close();
    server.close();
    await unlink(portFile).catch(() => {});
    await unlink(lockFilePath(env)).catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    store.close();
  });
}

main().catch((e: unknown) => {
  process.stderr.write(`let-me-explain daemon failed: ${String(e)}\n`);
  process.exit(1);
});