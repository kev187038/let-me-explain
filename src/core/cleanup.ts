import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Env, tutorialDir, tutorialRoot } from './paths.js';

export interface CleanResult {
  removed: number;
}

// Tutorials accumulate one file per attempt, so they are cleaned at three
// levels: when a try finishes, when its session ends, and by age as a backstop
// for sessions that were killed rather than closed.

export async function cleanSession(env: Env, sessionId: string): Promise<CleanResult> {
  const dir = tutorialDir(env, sessionId);
  const files = await readdir(dir).catch(() => null);
  if (!files) return { removed: 0 };
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return { removed: files.length };
}

export async function cleanAll(env: Env): Promise<CleanResult> {
  const removed = await count(env);
  await rm(tutorialRoot(env), { recursive: true, force: true }).catch(() => {});
  return { removed };
}

export async function cleanOlderThan(env: Env, maxAgeMs: number, now = Date.now()): Promise<CleanResult> {
  const root = tutorialRoot(env);
  const sessions = await readdir(root).catch(() => null);
  if (!sessions) return { removed: 0 };

  let removed = 0;
  for (const session of sessions) {
    const dir = join(root, session);
    const files = await readdir(dir).catch(() => []);
    let left = files.length;
    for (const file of files) {
      const path = join(dir, file);
      const info = await stat(path).catch(() => null);
      if (!info || now - info.mtimeMs < maxAgeMs) continue;
      await rm(path, { force: true }).catch(() => {});
      removed++;
      left--;
    }
    if (left === 0) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { removed };
}

export async function listTutorials(env: Env): Promise<string[]> {
  const root = tutorialRoot(env);
  const sessions = await readdir(root).catch(() => null);
  if (!sessions) return [];

  const out: string[] = [];
  for (const session of sessions) {
    for (const file of await readdir(join(root, session)).catch(() => [])) {
      out.push(join(root, session, file));
    }
  }
  return out.sort();
}

async function count(env: Env): Promise<number> {
  return (await listTutorials(env)).length;
}