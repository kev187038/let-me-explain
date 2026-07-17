import { parseConfig, type LmeConfig } from '../core/config.js';
import { scanBlock } from '../core/managed-block.js';
import { configFilePath } from '../core/paths.js';
import { renderInstructionBody } from '../core/template.js';
import type { Deps } from './types.js';

export type TargetStatus =
  | { state: 'ok'; version?: string }
  | { state: 'drifted'; version?: string } // body hand-edited since install
  | { state: 'absent' }
  | { state: 'file-missing' }
  | { state: 'corrupted'; corruption: string };

export interface StatusReport {
  config: LmeConfig | null;
  targets: Array<{ adapterId: string; displayName: string; path: string; status: TargetStatus }>;
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

export async function runStatus(deps: Deps): Promise<StatusReport> {
  const raw = await deps.io.readFileIfExists(configFilePath(deps.env));
  let config: LmeConfig | null = null;
  if (raw !== null) {
    try {
      const parsed = parseConfig(JSON.parse(raw));
      if (parsed.ok) config = parsed.value;
    } catch {
      // fall through: config stays null, reported as "not configured"
    }
  }

  const expectedBody = config ? renderInstructionBody(config) : null;
  const targets: StatusReport['targets'] = [];

  const ids = config?.harnesses ?? deps.adapters.map((a) => a.id);
  for (const id of ids) {
    const adapter = deps.adapters.find((a) => a.id === id);
    if (!adapter) continue;
    const path = adapter.targetFile(deps.env);
    const content = await deps.io.readFileIfExists(path);

    let status: TargetStatus;
    if (content === null) {
      status = { state: 'file-missing' };
    } else {
      const scan = scanBlock(content);
      if (scan.state === 'absent') status = { state: 'absent' };
      else if (scan.state === 'corrupted') status = { state: 'corrupted', corruption: scan.corruption! };
      else if (expectedBody !== null && normalize(scan.body!) !== normalize(expectedBody)) {
        status = scan.version !== undefined ? { state: 'drifted', version: scan.version } : { state: 'drifted' };
      } else {
        status = scan.version !== undefined ? { state: 'ok', version: scan.version } : { state: 'ok' };
      }
    }
    targets.push({ adapterId: id, displayName: adapter.displayName, path, status });
  }

  return { config, targets };
}
