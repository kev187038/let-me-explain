import { join } from 'node:path';
export interface Env {
  home: string;
  xdgConfigHome?: string;
  xdgStateHome?: string;
  xdgRuntimeDir?: string;
  appData?: string;
}

// XDG Base Directory convention: user config belongs in $XDG_CONFIG_HOME,
// defaulting to ~/.config. On Windows the closest equivalent is %APPDATA%.
export function configDir(env: Env): string {
  if (env.xdgConfigHome) return join(env.xdgConfigHome, 'let-me-explain');
  if (env.appData) return join(env.appData, 'let-me-explain');
  return join(env.home, '.config', 'let-me-explain');
}

export function configFilePath(env: Env): string {
  return join(configDir(env), 'config.json');
}

export function manifestPath(env: Env): string {
  return join(configDir(env), 'manifest.json');
}

// State is data we want to survive a reboot: the mode the user last chose,
// and the session logs.
export function stateDir(env: Env): string {
  if (env.xdgStateHome) return join(env.xdgStateHome, 'let-me-explain');
  if (env.appData) return join(env.appData, 'let-me-explain', 'state');
  return join(env.home, '.local', 'state', 'let-me-explain');
}

export function modePath(env: Env): string {
  return join(stateDir(env), 'mode.json');
}

export function logDir(env: Env): string {
  return join(stateDir(env), 'log');
}

export function logPath(env: Env, sessionId: string): string {
  return join(logDir(env), `${sanitizeId(sessionId)}.jsonl`);
}

// Runtime is data that is meaningless once the machine reboots: which port
// the daemon happens to be on today. $XDG_RUNTIME_DIR is cleared on logout,
// which is exactly the lifetime we want; elsewhere we fall back to state.
export function runtimeDir(env: Env): string {
  if (env.xdgRuntimeDir) return join(env.xdgRuntimeDir, 'let-me-explain');
  return join(stateDir(env), 'run');
}

export function portFilePath(env: Env): string {
  return join(runtimeDir(env), 'daemon.json');
}

export function lockFilePath(env: Env): string {
  return join(runtimeDir(env), 'daemon.lock');
}

// Session ids reach us from the harness and end up as filenames.
function sanitizeId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe.length > 0 ? safe : 'unknown';
}