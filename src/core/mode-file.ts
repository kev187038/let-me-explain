// Shared by the daemon and the hook shim. The shim reads the mode straight
// off disk so that switching off costs no network round trip at all — and so
// the escape hatch keeps working even if the daemon stops answering.
// Hand-rolled rather than zod: the shim carries no dependencies.

export type Mode = 'on' | 'off';
export type Surface = 'prompt' | 'window';

export interface Settings {
  mode: Mode;
  surface: Surface;
}

export interface ModeFile {
  global: Settings;
  sessions: Record<string, Partial<Settings>>;
}

// `prompt` by default: the explanation lands inline where the learner already
// is, and nothing can hold a tool call open. This was briefly `window`, on the
// grounds that only there could "let me try" be a real choice — the terminal
// menu removes that reason, so the default goes back.
export const DEFAULTS: Settings = { mode: 'on', surface: 'prompt' };

function asMode(value: unknown): Mode | null {
  return value === 'on' || value === 'off' ? value : null;
}

function asSurface(value: unknown): Surface | null {
  return value === 'prompt' || value === 'window' ? value : null;
}

// Accepts both shapes. Before surfaces existed an entry was a bare mode
// string, and those files are on disk in existing installs.
function asSettings(value: unknown): Partial<Settings> {
  const mode = asMode(value);
  if (mode) return { mode };
  if (typeof value !== 'object' || value === null) return {};

  const record = value as Record<string, unknown>;
  const settings: Partial<Settings> = {};
  const m = asMode(record.mode);
  const s = asSurface(record.surface);
  if (m) settings.mode = m;
  if (s) settings.surface = s;
  return settings;
}

export function parseModeFile(raw: string | null): ModeFile {
  if (raw === null) return { global: { ...DEFAULTS }, sessions: {} };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const sessions: Record<string, Partial<Settings>> = {};
    for (const [id, value] of Object.entries((data.sessions ?? {}) as Record<string, unknown>)) {
      const settings = asSettings(value);
      if (settings.mode || settings.surface) sessions[id] = settings;
    }
    return { global: { ...DEFAULTS, ...asSettings(data.global) }, sessions };
  } catch {
    return { global: { ...DEFAULTS }, sessions: {} };
  }
}

export function resolveSettings(file: ModeFile, sessionId?: string): Settings {
  const session = sessionId ? (file.sessions[sessionId] ?? {}) : {};
  return { ...file.global, ...session };
}

export function resolveMode(file: ModeFile, sessionId?: string): Mode {
  return resolveSettings(file, sessionId).mode;
}