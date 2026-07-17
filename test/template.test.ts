import { describe, expect, it } from 'vitest';
import { renderInstructionBody } from '../src/core/template.js';
import { FOCUS_PRESETS, type LmeConfig } from '../src/core/config.js';

function cfg(overrides: Partial<LmeConfig> = {}): LmeConfig {
  return {
    version: 1,
    role: { preset: 'ai-engineer' },
    seniority: 'junior',
    focuses: { presets: [...FOCUS_PRESETS], custom: [] },
    harnesses: ['claude-code'],
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderInstructionBody', () => {
  it('is deterministic (same config → byte-identical output)', () => {
    expect(renderInstructionBody(cfg())).toBe(renderInstructionBody(cfg()));
  });

  it('does not depend on updatedAt or harnesses (only teaching answers matter)', () => {
    const a = renderInstructionBody(cfg());
    const b = renderInstructionBody(
      cfg({ harnesses: ['codex', 'gemini'], updatedAt: '2030-01-01T00:00:00.000Z' }),
    );
    expect(b).toBe(a);
  });

  it('stays lean — every line costs context tokens in every session', () => {
    const words = renderInstructionBody(cfg({ focuses: { presets: [...FOCUS_PRESETS], custom: ['X'] } }))
      .split(/\s+/).length;
    expect(words).toBeLessThan(320);
  });

  it('omits bullets for unselected focuses', () => {
    const body = renderInstructionBody(cfg({ focuses: { presets: ['bug-logic'], custom: [] } }));
    expect(body).toContain('Root-cause bugs');
    expect(body).not.toContain("framework's hood");
    expect(body).not.toContain('Teach the habit');
    expect(body).not.toContain('Language rules');
  });

  it('always includes the two core bullets', () => {
    const body = renderInstructionBody(cfg({ focuses: { presets: [], custom: [] } }));
    expect(body).toContain('Explain the why');
    expect(body).toContain('Name the patterns');
  });

  it('renders custom focuses as bullets', () => {
    const body = renderInstructionBody(
      cfg({ focuses: { presets: [], custom: ['SQL query plans'] } }),
    );
    expect(body).toContain('- **SQL query plans.**');
  });

  it('seniority changes only the opening pitch', () => {
    const junior = renderInstructionBody(cfg({ seniority: 'junior' }));
    const senior = renderInstructionBody(cfg({ seniority: 'senior' }));
    expect(junior).not.toBe(senior);
    // everything after the opening paragraph is identical
    const tail = (s: string) => s.split('\n').slice(3).join('\n');
    expect(tail(junior)).toBe(tail(senior));
    expect(junior).toContain('junior level');
    expect(senior).toContain('terse');
  });

  it('uses the custom role text for preset "other"', () => {
    const body = renderInstructionBody(
      cfg({ role: { preset: 'other', custom: 'Game Developer' } }),
    );
    expect(body).toContain('becoming a Game Developer');
    expect(body).toContain('My goal role is Game Developer');
  });

  // Snapshots pin the exact wording: any edit to the template must be a
  // conscious snapshot update, and drift detection depends on determinism.
  const combos: Array<[string, LmeConfig]> = [
    ['ai-engineer junior, all focuses', cfg()],
    ['ml-engineer medior, defaults', cfg({ role: { preset: 'ml-engineer' }, seniority: 'medior' })],
    ['backend senior, minimal focuses', cfg({ role: { preset: 'backend' }, seniority: 'senior', focuses: { presets: [], custom: [] } })],
    ['frontend junior with custom focus', cfg({ role: { preset: 'frontend' }, focuses: { presets: ['frameworks'], custom: ['CSS layout engines'] } })],
    ['fullstack medior', cfg({ role: { preset: 'fullstack' }, seniority: 'medior' })],
  ];

  for (const [name, config] of combos) {
    it(`snapshot: ${name}`, () => {
      expect(renderInstructionBody(config)).toMatchSnapshot();
    });
  }
});
