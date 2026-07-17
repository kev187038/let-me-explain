import { parseConfig, type LmeConfig } from '../core/config.js';
import {
  forceAppendBlock,
  scanBlock,
  upsertBlock,
} from '../core/managed-block.js';
import { mergeTargets, parseManifest, type Manifest, type ManifestTarget } from '../core/manifest.js';
import { configFilePath, manifestPath } from '../core/paths.js';
import { renderInstructionBody } from '../core/template.js';
import { TOOL_VERSION } from '../version.js';
import type { CommandResult, Deps, DetectedHarness, InstallUi, TargetReport } from './types.js';

async function detectHarnesses(deps: Deps): Promise<DetectedHarness[]> {
  const out: DetectedHarness[] = [];
  for (const adapter of deps.adapters) {
    const dirs = adapter.detectDirs(deps.env);
    let detected = false;
    for (const d of dirs) if (await deps.io.dirExists(d)) detected = true;
    out.push({ adapter, detected });
  }
  return out;
}

async function loadPrevious<T>(
  deps: Deps,
  path: string,
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string },
): Promise<T | null> {
  const raw = await deps.io.readFileIfExists(path);
  if (raw === null) return null;
  try {
    const parsed = parse(JSON.parse(raw));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

export async function runInstall(deps: Deps, ui: InstallUi): Promise<CommandResult> {
  const previous = await loadPrevious(deps, configFilePath(deps.env), parseConfig);

  const detected = await detectHarnesses(deps);
  const answers = await ui.runWizard(detected, previous);
  if (answers === null) {
    return { exitCode: 0, reports: [], notes: ['Cancelled — nothing was written.'] };
  }

  const config: LmeConfig = { version: 1, ...answers, updatedAt: deps.now() };
  const body = renderInstructionBody(config);

  if (!(await ui.confirmPreview(body))) {
    return { exitCode: 0, reports: [], notes: ['Cancelled — nothing was written.'] };
  }

  // Write config.json first: it doubles as a writability probe for the config
  // dir, so we never modify the user's harness files and then find ourselves
  // unable to record what we did in the manifest.
  await deps.io.writeFileAtomic(configFilePath(deps.env), JSON.stringify(config, null, 2) + '\n');

  const reports: TargetReport[] = [];
  const written: ManifestTarget[] = [];

  for (const id of config.harnesses) {
    const adapter = deps.adapters.find((a) => a.id === id);
    if (!adapter) {
      reports.push({
        adapterId: id,
        path: '(unknown)',
        outcome: { kind: 'error', message: `unknown harness id: ${id}` },
      });
      continue;
    }
    const path = adapter.targetFile(deps.env);
    // One failing target must not abort the others: report per target,
    // aggregate the exit code at the end.
    try {
      const content = await deps.io.readFileIfExists(path);

      if (content !== null && scanBlock(content).state === 'corrupted') {
        const scan = scanBlock(content);
        const choice = await ui.resolveCorruption(path, scan.corruption!);
        if (choice === 'skip') {
          reports.push({
            adapterId: id,
            path,
            outcome: { kind: 'skipped', reason: `corrupted sentinels (${scan.corruption})` },
          });
          continue;
        }
        await deps.io.writeFileAtomic(path, forceAppendBlock(content, body, TOOL_VERSION));
        reports.push({ adapterId: id, path, outcome: { kind: 'written', action: 'appended' } });
        written.push({ adapterId: id, path, createdFile: false, action: 'appended' });
        continue;
      }

      const { content: next, action } = upsertBlock(content, body, TOOL_VERSION);
      await deps.io.writeFileAtomic(path, next);
      reports.push({ adapterId: id, path, outcome: { kind: 'written', action } });
      written.push({ adapterId: id, path, createdFile: action === 'created-file', action });
    } catch (e) {
      reports.push({
        adapterId: id,
        path,
        outcome: { kind: 'error', message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  const previousManifest = await loadPrevious(deps, manifestPath(deps.env), parseManifest);
  const manifest: Manifest = {
    version: 1,
    toolVersion: TOOL_VERSION,
    installedAt: deps.now(),
    targets: mergeTargets(previousManifest?.targets ?? [], written),
  };
  await deps.io.writeFileAtomic(manifestPath(deps.env), JSON.stringify(manifest, null, 2) + '\n');

  const failed = reports.some((r) => r.outcome.kind === 'error');
  return { exitCode: failed ? 1 : 0, reports, notes: [] };
}
