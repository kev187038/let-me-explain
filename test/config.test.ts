import { describe, expect, it } from 'vitest';
import { parseConfig, type LmeConfig } from '../src/core/config.js';

const VALID: LmeConfig = {
  version: 1,
  role: { preset: 'ai-engineer' },
  seniority: 'junior',
  focuses: { presets: ['frameworks', 'bug-logic'], custom: ['SQL performance'] },
  harnesses: ['claude-code', 'codex'],
  updatedAt: '2026-07-17T00:00:00.000Z',
};

describe('parseConfig', () => {
  it('accepts a valid config and round-trips through JSON', () => {
    const parsed = parseConfig(JSON.parse(JSON.stringify(VALID)));
    expect(parsed).toEqual({ ok: true, value: VALID });
  });

  it('accepts the ml-engineer role preset', () => {
    const parsed = parseConfig({ ...VALID, role: { preset: 'ml-engineer' } });
    expect(parsed.ok).toBe(true);
  });

  it('requires custom text for role "other"', () => {
    expect(parseConfig({ ...VALID, role: { preset: 'other' } }).ok).toBe(false);
    expect(
      parseConfig({ ...VALID, role: { preset: 'other', custom: 'Game Developer' } }).ok,
    ).toBe(true);
  });

  const rejects: Array<[name: string, raw: unknown]> = [
    ['null', null],
    ['array', []],
    ['string', 'nope'],
    ['missing version', { ...VALID, version: undefined }],
    ['future version', { ...VALID, version: 2 }],
    ['bad role preset', { ...VALID, role: { preset: 'wizard' } }],
    ['bad seniority', { ...VALID, seniority: 'principal' }],
    ['bad focus preset', { ...VALID, focuses: { presets: ['vibes'], custom: [] } }],
    ['non-string custom focus', { ...VALID, focuses: { presets: [], custom: [42] } }],
    ['non-array harnesses', { ...VALID, harnesses: 'claude-code' }],
    ['missing updatedAt', { ...VALID, updatedAt: undefined }],
  ];

  for (const [name, raw] of rejects) {
    it(`rejects: ${name}`, () => {
      expect(parseConfig(raw).ok).toBe(false);
    });
  }
});
