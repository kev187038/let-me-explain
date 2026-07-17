// The single source of truth: the wizard's answers. The instruction Markdown
// is always RENDERED from this — never edited directly — so config.json and
// the installed blocks can't drift apart without us detecting it.

export type RolePreset = 'ai-engineer' | 'fullstack' | 'frontend' | 'backend' | 'other' | 'ml-engineer';
export type Seniority = 'junior' | 'medior' | 'senior'; 
export type FocusPreset = 'frameworks' | 'bug-logic' | 'best-practices' | 'language-rules';

export interface LmeConfig {
  version: 1;
  role: { preset: RolePreset; custom?: string };
  seniority: Seniority;
  focuses: { presets: FocusPreset[]; custom: string[] };
  harnesses: string[]; // adapter ids the user selected
  updatedAt: string; // ISO timestamp
}

export const ROLE_PRESETS: readonly RolePreset[] = [
  'ai-engineer',
  'ml-engineer',
  'fullstack',
  'frontend',
  'backend',
  'other',
];

export const ROLE_LABELS: Record<RolePreset, string> = {
  'ai-engineer': 'AI Engineer',
  'ml-engineer': 'ML Engineer',
  fullstack: 'Fullstack Developer',
  frontend: 'Frontend Developer',
  backend: 'Backend Developer',
  other: 'Other',
};

export const SENIORITIES: readonly Seniority[] = ['junior', 'medior', 'senior'];

export const SENIORITY_LABELS: Record<Seniority, string> = {
  junior: 'Junior',
  medior: 'Medior',
  senior: 'Senior',
};

export const FOCUS_PRESETS: readonly FocusPreset[] = [
  'frameworks',
  'bug-logic',
  'best-practices',
  'language-rules',
];

export const FOCUS_LABELS: Record<FocusPreset, string> = {
  frameworks: 'Frameworks under the hood',
  'bug-logic': 'Bug root causes',
  'best-practices': 'Best practices',
  'language-rules': 'Language rules & quirks',
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((e) => typeof e === 'string');
}

// Hand-rolled validation instead of a schema library: the shape is 5 fields,
// and keeping runtime deps at 2 keeps `npx` cold-start fast.
export function parseConfig(raw: unknown): ParseResult<LmeConfig> {
  if (!isRecord(raw)) return { ok: false, error: 'config is not an object' };
  if (raw.version !== 1) return { ok: false, error: `unknown config version: ${String(raw.version)}` };

  const role = raw.role;
  if (!isRecord(role) || !ROLE_PRESETS.includes(role.preset as RolePreset)) {
    return { ok: false, error: 'invalid role' };
  }
  if (role.preset === 'other' && typeof role.custom !== 'string') {
    return { ok: false, error: 'role preset "other" requires a custom role name' };
  }

  if (!SENIORITIES.includes(raw.seniority as Seniority)) {
    return { ok: false, error: 'invalid seniority' };
  }

  const focuses = raw.focuses;
  if (
    !isRecord(focuses) ||
    !Array.isArray(focuses.presets) ||
    !focuses.presets.every((f) => FOCUS_PRESETS.includes(f as FocusPreset)) ||
    !isStringArray(focuses.custom)
  ) {
    return { ok: false, error: 'invalid focuses' };
  }

  if (!isStringArray(raw.harnesses)) return { ok: false, error: 'invalid harnesses' };
  if (typeof raw.updatedAt !== 'string') return { ok: false, error: 'invalid updatedAt' };

  return {
    ok: true,
    value: {
      version: 1,
      role: {
        preset: role.preset as RolePreset,
        ...(typeof role.custom === 'string' ? { custom: role.custom } : {}),
      },
      seniority: raw.seniority as Seniority,
      focuses: {
        presets: focuses.presets as FocusPreset[],
        custom: focuses.custom,
      },
      harnesses: raw.harnesses,
      updatedAt: raw.updatedAt,
    },
  };
}
