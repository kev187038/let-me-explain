import { join } from 'node:path';
import type { HarnessAdapter } from './types.js';

export const codex: HarnessAdapter = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  detectDirs: (env) => [join(env.home, '.codex')],
  targetFile: (env) => join(env.home, '.codex', 'AGENTS.md'),
  docsHint: 'Install: https://developers.openai.com/codex/cli',
};
