import type { Env } from '../core/paths.js';

// An adapter is pure DATA about one harness: where its global instruction
// file lives and how to detect that the harness is installed. No fs calls
// here — the io layer does the checking — so adapters need zero mocking in
// tests, and supporting a new harness is one new file plus a registry entry.
export interface HarnessAdapter {
  id: string;
  displayName: string;
  detectDirs(env: Env): string[];
  targetFile(env: Env): string;
  docsHint: string;
}
