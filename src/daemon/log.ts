import type { Env } from '../core/paths.js';
import { logPath } from '../core/paths.js';
import type { FsIo } from '../io/fs-io.js';

export interface LogEntry {
  type: string;
  sessionId: string;
  [key: string]: unknown;
}

export interface Logger {
  append(entry: LogEntry): Promise<void>;
}

// Append-only JSONL, one file per session: replayable, greppable, and it
// survives a crash mid-write in a way a rewritten JSON blob would not.
export function createLogger(io: FsIo, env: Env, now: () => number = Date.now): Logger {
  return {
    async append(entry) {
      try {
        await io.appendLine(logPath(env, entry.sessionId), JSON.stringify({ at: now(), ...entry }));
      } catch {
        // Losing a log line must never cost the learner an edit.
      }
    },
  };
}
