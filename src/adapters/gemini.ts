import { join } from 'node:path';
import type { HarnessAdapter } from './types.js';

export const gemini: HarnessAdapter = {
  id: 'gemini',
  displayName: 'Gemini CLI',
  detectDirs: (env) => [join(env.home, '.gemini')],
  targetFile: (env) => join(env.home, '.gemini', 'GEMINI.md'),
  docsHint: 'Install: https://github.com/google-gemini/gemini-cli',
};
