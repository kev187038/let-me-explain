// Shared by the daemon and the hook shim. The shim reads the mode straight
// off disk so that switching off costs no network round trip at all — and so
// the escape hatch keeps working even if the daemon stops answering.
// Hand-rolled rather than zod: the shim carries no dependencies.

export type Mode = 'on' | 'off';

export interface ModeFile {
  global: Mode;
  sessions: Record<string, Mode>;
}

function asMode(value: unknown): Mode | null {
  return value === 'on' || value === 'off' ? value : null;
}

export function parseModeFile(raw: string | null): ModeFile {
  if (raw === null) return { global: 'on', sessions: {} };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const sessions: Record<string, Mode> = {};
    const raws = (data.sessions ?? {}) as Record<string, unknown>;
    for (const [id, value] of Object.entries(raws)) {
      const mode = asMode(value);
      if (mode) sessions[id] = mode;
    }
    return { global: asMode(data.global) ?? 'on', sessions };
  } catch {
    return { global: 'on', sessions: {} };
  }
}

export function resolveMode(file: ModeFile, sessionId?: string): Mode {
  if (sessionId && file.sessions[sessionId]) return file.sessions[sessionId];
  return file.global;
}