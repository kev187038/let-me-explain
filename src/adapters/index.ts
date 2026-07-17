import type { HarnessAdapter } from './types.js';
import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { gemini } from './gemini.js';

export type { HarnessAdapter } from './types.js';

export const ADAPTERS: readonly HarnessAdapter[] = [claudeCode, codex, gemini];

export function adapterById(id: string): HarnessAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
