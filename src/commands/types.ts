import type { HarnessAdapter } from '../adapters/index.js';
import type { LmeConfig } from '../core/config.js';
import type { BlockCorruption } from '../core/managed-block.js';
import type { Env } from '../core/paths.js';
import type { FsIo } from '../io/fs-io.js';

// Commands receive everything they touch as an injected dependency object.
// This seam is why flow tests can drive a full install with a canned wizard
// and a temp-dir HOME, no TTY and no mocking framework involved.

export interface DetectedHarness {
  adapter: HarnessAdapter;
  detected: boolean;
}

// The wizard's answers: LmeConfig minus the fields the tool fills in itself.
export type WizardAnswers = Omit<LmeConfig, 'version' | 'updatedAt'>;

export interface InstallUi {
  /** Returns null when the user cancels. */
  runWizard(detected: DetectedHarness[], previous: LmeConfig | null): Promise<WizardAnswers | null>;
  /** Preview the rendered block; false = user backed out. */
  confirmPreview(body: string): Promise<boolean>;
  /** A target file has corrupted sentinels — user decides. */
  resolveCorruption(path: string, corruption: BlockCorruption): Promise<'skip' | 'append-fresh'>;
}

export interface ConfirmUi {
  /** Generic yes/no, used by uninstall's no-manifest fallback. */
  confirm(message: string): Promise<boolean>;
}

export interface Deps {
  env: Env;
  io: FsIo;
  adapters: readonly HarnessAdapter[];
  now(): string; // injected clock → deterministic tests
}

export type TargetOutcome =
  | { kind: 'written'; action: 'created-file' | 'appended' | 'replaced' }
  | { kind: 'removed'; deletedFile: boolean }
  | { kind: 'skipped'; reason: string }
  | { kind: 'missing' } // file already gone
  | { kind: 'error'; message: string };

export interface TargetReport {
  adapterId: string;
  path: string;
  outcome: TargetOutcome;
}

export interface CommandResult {
  exitCode: number;
  reports: TargetReport[];
  notes: string[]; // human-readable extras for the summary
}
