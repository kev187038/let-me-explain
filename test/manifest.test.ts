import { describe, expect, it } from 'vitest';
import { mergeTargets, parseManifest, type Manifest } from '../src/core/manifest.js';

const VALID: Manifest = {
  version: 1,
  toolVersion: '0.1.0',
  installedAt: '2026-07-17T00:00:00.000Z',
  targets: [
    { adapterId: 'claude-code', path: '/home/x/.claude/CLAUDE.md', createdFile: false, action: 'appended' },
    { adapterId: 'codex', path: '/home/x/.codex/AGENTS.md', createdFile: true, action: 'created-file' },
  ],
};

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    expect(parseManifest(JSON.parse(JSON.stringify(VALID)))).toEqual({ ok: true, value: VALID });
  });

  it('rejects garbage', () => {
    expect(parseManifest(null).ok).toBe(false);
    expect(parseManifest({ version: 99 }).ok).toBe(false);
    expect(
      parseManifest({ ...VALID, targets: [{ adapterId: 'x' }] }).ok,
    ).toBe(false);
  });
});

describe('mergeTargets', () => {
  it('createdFile is sticky across re-installs', () => {
    const prev = VALID.targets;
    const rerun = [
      { adapterId: 'codex', path: '/home/x/.codex/AGENTS.md', createdFile: false, action: 'replaced' as const },
    ];
    const merged = mergeTargets(prev, rerun);
    const codex = merged.find((t) => t.adapterId === 'codex');
    expect(codex).toMatchObject({ createdFile: true, action: 'replaced' });
  });

  it('keeps previously-installed targets not touched this run', () => {
    const merged = mergeTargets(VALID.targets, []);
    expect(merged).toHaveLength(2);
  });

  it('adds brand-new targets', () => {
    const merged = mergeTargets(VALID.targets, [
      { adapterId: 'gemini', path: '/home/x/.gemini/GEMINI.md', createdFile: true, action: 'created-file' },
    ]);
    expect(merged).toHaveLength(3);
  });
});
