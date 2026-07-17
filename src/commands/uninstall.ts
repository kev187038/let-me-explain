import { BlockCorruptionError, removeBlock, scanBlock } from '../core/managed-block.js';
import { parseManifest, type ManifestTarget } from '../core/manifest.js';
import { configDir, configFilePath, manifestPath } from '../core/paths.js';
import type { CommandResult, ConfirmUi, Deps, TargetReport } from './types.js';

async function removeFromTarget(
  deps: Deps,
  target: ManifestTarget,
): Promise<TargetReport> {
  const { adapterId, path } = target;
  try {
    const content = await deps.io.readFileIfExists(path);
    if (content === null) return { adapterId, path, outcome: { kind: 'missing' } };

    const { content: stripped, removed } = removeBlock(content);
    if (!removed) {
      return { adapterId, path, outcome: { kind: 'skipped', reason: 'no managed block found' } };
    }

    // If we created the file and nothing but our block ever lived in it,
    // remove the file itself — a leftover empty file is uninstaller litter.
    if (target.createdFile && stripped.trim() === '') {
      await deps.io.deleteFileIfExists(path);
      return { adapterId, path, outcome: { kind: 'removed', deletedFile: true } };
    }

    await deps.io.writeFileAtomic(path, stripped);
    return { adapterId, path, outcome: { kind: 'removed', deletedFile: false } };
  } catch (e) {
    if (e instanceof BlockCorruptionError) {
      return {
        adapterId,
        path,
        outcome: { kind: 'skipped', reason: `corrupted sentinels (${e.corruption}) — clean up by hand` },
      };
    }
    return {
      adapterId,
      path,
      outcome: { kind: 'error', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

export async function runUninstall(deps: Deps, ui: ConfirmUi): Promise<CommandResult> {
  const notes: string[] = [];
  let targets: ManifestTarget[] | null = null;

  const rawManifest = await deps.io.readFileIfExists(manifestPath(deps.env));
  if (rawManifest !== null) {
    try {
      const parsed = parseManifest(JSON.parse(rawManifest));
      if (parsed.ok) targets = parsed.value.targets;
      else notes.push(`Manifest unreadable (${parsed.error}) — falling back to a scan.`);
    } catch {
      notes.push('Manifest is not valid JSON — falling back to a scan.');
    }
  }

  // No (usable) manifest: scan every known harness target for our block and
  // ask before touching anything — without install records we only remove
  // what the user explicitly confirms.
  if (targets === null) {
    const found: ManifestTarget[] = [];
    for (const adapter of deps.adapters) {
      const path = adapter.targetFile(deps.env);
      const content = await deps.io.readFileIfExists(path);
      if (content !== null && scanBlock(content).state === 'present') {
        found.push({ adapterId: adapter.id, path, createdFile: false, action: 'appended' });
      }
    }
    if (found.length === 0) {
      return { exitCode: 0, reports: [], notes: [...notes, 'Nothing to uninstall.'] };
    }
    const ok = await ui.confirm(
      `No install manifest, but found managed blocks in ${found.length} file(s). Remove them?`,
    );
    if (!ok) return { exitCode: 0, reports: [], notes: [...notes, 'Cancelled.'] };
    targets = found;
  }

  const reports: TargetReport[] = [];
  for (const target of targets) reports.push(await removeFromTarget(deps, target));

  await deps.io.deleteFileIfExists(configFilePath(deps.env));
  await deps.io.deleteFileIfExists(manifestPath(deps.env));
  await deps.io.removeDirIfEmpty(configDir(deps.env));

  const failed = reports.some((r) => r.outcome.kind === 'error');
  return { exitCode: failed ? 1 : 0, reports, notes };
}
