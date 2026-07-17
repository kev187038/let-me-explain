import pc from 'picocolors';
import type { CommandResult, TargetReport } from '../commands/types.js';
import type { StatusReport } from '../commands/status.js';
import { FOCUS_LABELS, ROLE_LABELS, SENIORITY_LABELS } from '../core/config.js';

function describeOutcome(r: TargetReport): string {
  switch (r.outcome.kind) {
    case 'written':
      return pc.green(
        r.outcome.action === 'created-file'
          ? 'created'
          : r.outcome.action === 'appended'
            ? 'block appended'
            : 'block updated',
      );
    case 'removed':
      return pc.green(r.outcome.deletedFile ? 'file removed (we created it)' : 'block removed');
    case 'skipped':
      return pc.yellow(`skipped — ${r.outcome.reason}`);
    case 'missing':
      return pc.dim('already gone');
    case 'error':
      return pc.red(`failed — ${r.outcome.message}`);
  }
}

export function printResult(result: CommandResult): void {
  for (const note of result.notes) console.log(note);
  for (const r of result.reports) {
    console.log(`  ${pc.bold(r.path)}  ${describeOutcome(r)}`);
  }
  if (result.reports.length > 0) {
    console.log(
      result.exitCode === 0
        ? pc.green('\nDone.')
        : pc.red('\nFinished with errors (see above).'),
    );
  }
}

const STATE_LABEL: Record<string, string> = {
  ok: pc.green('✓ installed'),
  drifted: pc.yellow('≠ modified since install — re-run `npx let-me-explain` to restore'),
  absent: pc.yellow('– no managed block'),
  'file-missing': pc.dim('– file does not exist'),
  corrupted: pc.red('✗ corrupted markers'),
};

export function printStatus(report: StatusReport): void {
  if (!report.config) {
    console.log('Not configured yet — run `npx let-me-explain` to set up.');
  } else {
    const c = report.config;
    const role =
      c.role.preset === 'other' ? (c.role.custom ?? 'custom') : ROLE_LABELS[c.role.preset];
    const focuses = [
      ...c.focuses.presets.map((f) => FOCUS_LABELS[f]),
      ...c.focuses.custom,
    ].join(', ');
    console.log(`${pc.bold('Role:')}      ${role} (${SENIORITY_LABELS[c.seniority]})`);
    console.log(`${pc.bold('Focuses:')}   ${focuses || pc.dim('none')}`);
    console.log(`${pc.bold('Updated:')}   ${c.updatedAt}`);
  }
  console.log('');
  for (const t of report.targets) {
    const version = 'version' in t.status && t.status.version ? pc.dim(` (v${t.status.version})`) : '';
    console.log(`  ${t.displayName.padEnd(18)} ${STATE_LABEL[t.status.state]}${version}`);
    console.log(`  ${pc.dim(t.path)}`);
  }
}
