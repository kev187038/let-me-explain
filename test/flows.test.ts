import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS } from '../src/adapters/index.js';
import { runInstall } from '../src/commands/install.js';
import { runStatus } from '../src/commands/status.js';
import { runUninstall } from '../src/commands/uninstall.js';
import type { Deps, InstallUi, WizardAnswers } from '../src/commands/types.js';
import { scanBlock } from '../src/core/managed-block.js';
import type { Env } from '../src/core/paths.js';
import { fsIo } from '../src/io/fs-io.js';

// Integration tests over the injected-deps seam: real fs against a mkdtemp
// HOME, canned wizard answers instead of a TTY. No mocks.

let home: string;
let env: Env;

const ANSWERS: WizardAnswers = {
  role: { preset: 'ai-engineer' },
  seniority: 'junior',
  focuses: { presets: ['frameworks', 'bug-logic'], custom: [] },
  harnesses: ['claude-code', 'codex'],
};

function deps(): Deps {
  return { env, io: fsIo, adapters: ADAPTERS, now: () => '2026-07-17T12:00:00.000Z' };
}

function ui(overrides: Partial<InstallUi> & { answers?: WizardAnswers | null } = {}): InstallUi {
  return {
    runWizard: async () => (overrides.answers === undefined ? ANSWERS : overrides.answers),
    confirmPreview: overrides.confirmPreview ?? (async () => true),
    resolveCorruption: overrides.resolveCorruption ?? (async () => 'skip'),
  };
}

const claudeMd = () => join(home, '.claude', 'CLAUDE.md');
const codexMd = () => join(home, '.codex', 'AGENTS.md');
const configJson = () => join(home, '.config', 'let-me-explain', 'config.json');
const manifestJson = () => join(home, '.config', 'let-me-explain', 'manifest.json');

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lme-test-'));
  env = { home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('install', () => {
  it('fresh install: appends to an existing file, creates a missing one', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeMd(), '# my existing notes\n');
    // ~/.codex does not exist at all

    const result = await runInstall(deps(), ui());
    expect(result.exitCode).toBe(0);
    expect(result.reports.map((r) => r.outcome)).toEqual([
      { kind: 'written', action: 'appended' },
      { kind: 'written', action: 'created-file' },
    ]);

    const claude = await readFile(claudeMd(), 'utf8');
    expect(claude.startsWith('# my existing notes\n')).toBe(true);
    expect(scanBlock(claude).state).toBe('present');
    expect(scanBlock(await readFile(codexMd(), 'utf8')).state).toBe('present');

    const manifest = JSON.parse(await readFile(manifestJson(), 'utf8'));
    expect(manifest.targets).toHaveLength(2);
    expect(manifest.targets.find((t: { path: string }) => t.path === codexMd()).createdFile).toBe(true);

    const config = JSON.parse(await readFile(configJson(), 'utf8'));
    expect(config.role.preset).toBe('ai-engineer');
  });

  it('re-install is idempotent: block replaced, not duplicated', async () => {
    await runInstall(deps(), ui());
    const first = await readFile(claudeMd(), 'utf8');
    const result = await runInstall(deps(), ui());
    expect(result.reports[0]!.outcome).toEqual({ kind: 'written', action: 'replaced' });
    expect(await readFile(claudeMd(), 'utf8')).toBe(first);
  });

  it('re-install keeps createdFile sticky in the manifest', async () => {
    await runInstall(deps(), ui());
    await runInstall(deps(), ui());
    const manifest = JSON.parse(await readFile(manifestJson(), 'utf8'));
    expect(manifest.targets.find((t: { path: string }) => t.path === codexMd()).createdFile).toBe(true);
  });

  it('cancelling the wizard writes nothing', async () => {
    const result = await runInstall(deps(), ui({ answers: null }));
    expect(result.exitCode).toBe(0);
    expect(await fsIo.fileExists(configJson())).toBe(false);
    expect(await fsIo.fileExists(claudeMd())).toBe(false);
  });

  it('declining the preview writes nothing', async () => {
    const result = await runInstall(deps(), ui({ confirmPreview: async () => false }));
    expect(result.exitCode).toBe(0);
    expect(await fsIo.fileExists(configJson())).toBe(false);
  });

  it('corrupted sentinels: skip leaves the file untouched', async () => {
    const corrupted = '# notes\n<!-- BEGIN let-me-explain v0.0.1 -->\nno end marker\n';
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeMd(), corrupted);

    const result = await runInstall(deps(), ui({ resolveCorruption: async () => 'skip' }));
    expect(result.reports[0]!.outcome.kind).toBe('skipped');
    expect(await readFile(claudeMd(), 'utf8')).toBe(corrupted);
    // skipped target is not recorded as written
    const manifest = JSON.parse(await readFile(manifestJson(), 'utf8'));
    expect(manifest.targets.map((t: { adapterId: string }) => t.adapterId)).toEqual(['codex']);
  });

  it('corrupted sentinels: append-fresh adds a working block after the mess', async () => {
    const corrupted = '# notes\n<!-- BEGIN let-me-explain v0.0.1 -->\nno end marker\n';
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeMd(), corrupted);

    const result = await runInstall(deps(), ui({ resolveCorruption: async () => 'append-fresh' }));
    expect(result.reports[0]!.outcome).toEqual({ kind: 'written', action: 'appended' });
    const content = await readFile(claudeMd(), 'utf8');
    expect(content.startsWith(corrupted)).toBe(true);
    expect(content).toContain('<!-- END let-me-explain -->');
  });
});

describe('uninstall', () => {
  it('restores appended files byte-for-byte and deletes created ones', async () => {
    const original = '# my existing notes\n';
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeMd(), original);

    await runInstall(deps(), ui());
    const result = await runUninstall(deps(), { confirm: async () => true });

    expect(result.exitCode).toBe(0);
    expect(await readFile(claudeMd(), 'utf8')).toBe(original);
    expect(await fsIo.fileExists(codexMd())).toBe(false); // we created it → deleted
    expect(await fsIo.fileExists(configJson())).toBe(false);
    expect(await fsIo.fileExists(manifestJson())).toBe(false);
    expect(await fsIo.dirExists(join(home, '.config', 'let-me-explain'))).toBe(false);
  });

  it('never installed → friendly no-op', async () => {
    const result = await runUninstall(deps(), { confirm: async () => true });
    expect(result.exitCode).toBe(0);
    expect(result.notes).toContain('Nothing to uninstall.');
  });

  it('target deleted by the user after install → reported missing, rest continues', async () => {
    await runInstall(deps(), ui());
    await rm(claudeMd());
    const result = await runUninstall(deps(), { confirm: async () => true });
    expect(result.exitCode).toBe(0);
    const outcomes = Object.fromEntries(result.reports.map((r) => [r.adapterId, r.outcome.kind]));
    expect(outcomes).toEqual({ 'claude-code': 'missing', codex: 'removed' });
  });

  it('unparseable manifest → falls back to scanning, asks first', async () => {
    await runInstall(deps(), ui());
    await writeFile(manifestJson(), 'not json{');
    let asked = false;
    const result = await runUninstall(deps(), {
      confirm: async () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(scanBlock((await readFile(claudeMd(), 'utf8'))).state).toBe('absent');
  });

  it('fallback scan declined → nothing removed', async () => {
    await runInstall(deps(), ui());
    await rm(manifestJson());
    const before = await readFile(claudeMd(), 'utf8');
    const result = await runUninstall(deps(), { confirm: async () => false });
    expect(result.notes).toContain('Cancelled.');
    expect(await readFile(claudeMd(), 'utf8')).toBe(before);
  });
});

describe('status', () => {
  it('reports ok after a clean install', async () => {
    await runInstall(deps(), ui());
    const report = await runStatus(deps());
    expect(report.config?.seniority).toBe('junior');
    expect(report.targets.map((t) => [t.adapterId, t.status.state])).toEqual([
      ['claude-code', 'ok'],
      ['codex', 'ok'],
    ]);
  });

  it('detects drift when the block body is hand-edited', async () => {
    await runInstall(deps(), ui());
    const edited = (await readFile(claudeMd(), 'utf8')).replace(
      'Explain the why',
      'Explain the vibes',
    );
    await writeFile(claudeMd(), edited);
    const report = await runStatus(deps());
    expect(report.targets.find((t) => t.adapterId === 'claude-code')?.status.state).toBe('drifted');
  });

  it('reports absent/missing/corrupted per target', async () => {
    await runInstall(deps(), ui());
    await writeFile(claudeMd(), '# block removed by hand\n');
    await rm(codexMd());
    const report = await runStatus(deps());
    expect(report.targets.map((t) => t.status.state)).toEqual(['absent', 'file-missing']);
  });

  it('not configured → null config, scans all known adapters', async () => {
    const report = await runStatus(deps());
    expect(report.config).toBeNull();
    expect(report.targets).toHaveLength(ADAPTERS.length);
  });
});
