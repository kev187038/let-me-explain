import {
  type Mode,
  type ModeFile,
  type Settings,
  type Surface,
  parseModeFile,
  resolveSettings,
} from '../core/mode-file.js';
import type { FsIo } from '../io/fs-io.js';

export async function createModeStore(io: FsIo, path: string) {
  let state = parseModeFile(await io.readFileIfExists(path));

  async function persist(): Promise<void> {
    await io.writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  }

  return {
    get(sessionId?: string): Mode {
      return resolveSettings(state, sessionId).mode;
    },

    surface(sessionId?: string): Surface {
      return resolveSettings(state, sessionId).surface;
    },

    settings(sessionId?: string): Settings {
      return resolveSettings(state, sessionId);
    },

    // Setting the global mode clears session overrides: "off" typed without a
    // session means off everywhere, not off except where you forgot.
    async set(mode: Mode, sessionId?: string): Promise<void> {
      if (sessionId) state.sessions[sessionId] = { ...state.sessions[sessionId], mode };
      else state = { global: { ...state.global, mode }, sessions: {} };
      await persist();
    },

    async setSurface(surface: Surface, sessionId?: string): Promise<void> {
      if (sessionId) state.sessions[sessionId] = { ...state.sessions[sessionId], surface };
      else state = { global: { ...state.global, surface }, sessions: {} };
      await persist();
    },

    snapshot(): ModeFile {
      return { global: { ...state.global }, sessions: { ...state.sessions } };
    },
  };
}

export type ModeStore = Awaited<ReturnType<typeof createModeStore>>;