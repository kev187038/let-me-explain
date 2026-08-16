import { readFile } from 'node:fs/promises';
import { type Env, portFilePath } from './paths.js';

export interface DaemonAddress {
  port: number;
  token: string;
  pid?: number;
}

// Imported by the hook shim, so this module must stay free of dependencies
// and of side effects.
export async function readDaemonAddress(env: Env): Promise<DaemonAddress | null> {
  try {
    const data = JSON.parse(await readFile(portFilePath(env), 'utf8')) as Record<string, unknown>;
    if (typeof data.port !== 'number' || typeof data.token !== 'string') return null;
    return {
      port: data.port,
      token: data.token,
      ...(typeof data.pid === 'number' ? { pid: data.pid } : {}),
    };
  } catch {
    return null;
  }
}

export function daemonUrl(address: DaemonAddress, path: string): string {
  return `http://127.0.0.1:${address.port}${path}`;
}