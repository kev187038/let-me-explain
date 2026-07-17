import { homedir } from 'node:os';
import type { Env } from '../core/paths.js';

// The single place process.env is read. Everything downstream receives a
// plain Env value, which is what keeps core pure and tests simple.
export function envFromProcess(): Env {
  const home = process.env.HOME || homedir();
  if (!home) {
    throw new Error('Cannot determine your home directory (HOME is unset).');
  }
  return {
    home,
    ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
    ...(process.env.APPDATA ? { appData: process.env.APPDATA } : {}),
  };
}
