import { join } from 'node:path';

// Env is a plain value built once at the process edge (io/env.ts) and passed
// down. Core never reads process.env directly — that's what makes every
// path function trivially testable with a fake Env.
export interface Env {
  home: string;
  xdgConfigHome?: string;
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
