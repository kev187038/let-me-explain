import { join } from 'node:path';
import type { HarnessAdapter } from './types.js';

export const claudeCode: HarnessAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  detectDirs: (env) => [join(env.home, '.claude')],
  targetFile: (env) => join(env.home, '.claude', 'CLAUDE.md'),
  docsHint: 'Install: https://claude.com/claude-code',
};
