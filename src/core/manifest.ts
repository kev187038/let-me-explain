import type { UpsertAction } from './managed-block.js';

// The manifest is the uninstaller's ground truth: every file the installer
// touched, recorded at install time. Uninstall reads this instead of
// re-deriving paths, so a future version with different path logic can still
// cleanly undo what an older version wrote.

export interface ManifestTarget {
  adapterId: string;
  path: string;
  createdFile: boolean; // we created this file → uninstall may delete it
  action: UpsertAction;
}

export interface Manifest {
  version: 1;
  toolVersion: string;
  installedAt: string;
  targets: ManifestTarget[];
}

import type { ParseResult } from './config.js';

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const ACTIONS: readonly UpsertAction[] = ['created-file', 'appended', 'replaced'];

export function parseManifest(raw: unknown): ParseResult<Manifest> {
  if (!isRecord(raw)) return { ok: false, error: 'manifest is not an object' };
  if (raw.version !== 1) {
    return { ok: false, error: `unknown manifest version: ${String(raw.version)}` };
  }
  if (typeof raw.toolVersion !== 'string' || typeof raw.installedAt !== 'string') {
    return { ok: false, error: 'invalid manifest metadata' };
  }
  if (!Array.isArray(raw.targets)) return { ok: false, error: 'invalid targets' };

  const targets: ManifestTarget[] = [];
  for (const t of raw.targets) {
    if (
      !isRecord(t) ||
      typeof t.adapterId !== 'string' ||
      typeof t.path !== 'string' ||
      typeof t.createdFile !== 'boolean' ||
      !ACTIONS.includes(t.action as UpsertAction)
    ) {
      return { ok: false, error: 'invalid manifest target' };
    }
    targets.push({
      adapterId: t.adapterId,
      path: t.path,
      createdFile: t.createdFile,
      action: t.action as UpsertAction,
    });
  }

  return {
    ok: true,
    value: {
      version: 1,
      toolVersion: raw.toolVersion,
      installedAt: raw.installedAt,
      targets,
    },
  };
}

/**
 * Merge freshly-written targets with a previous manifest.
 * `createdFile` is sticky: if v1 of an install created ~/.codex/AGENTS.md,
 * a later re-install only *replaces* the block — but the file is still ours
 * to delete on uninstall. Losing that bit would leak an empty file forever.
 * Targets from the previous manifest that were not touched this run are kept,
 * so deselecting a harness in the wizard doesn't orphan its installed block.
 */
export function mergeTargets(
  previous: ManifestTarget[],
  current: ManifestTarget[],
): ManifestTarget[] {
  const merged = new Map<string, ManifestTarget>();
  for (const t of previous) merged.set(t.path, t);
  for (const t of current) {
    const prev = merged.get(t.path);
    merged.set(t.path, {
      ...t,
      createdFile: t.createdFile || (prev?.createdFile ?? false),
    });
  }
  return [...merged.values()];
}
