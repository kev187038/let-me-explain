import { type Mode, type ModeFile, parseModeFile, resolveMode } from '../core/mode-file.js';
import type { FsIo } from '../io/fs-io.js';

export async function createModeStore(io: FsIo, path: string) {
  let state = parseModeFile(await io.readFileIfExists(path));

  async function persist(): Promise<void> {
    await io.writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  }

  return {
    get(sessionId?: string): Mode {
      return resolveMode(state, sessionId);
    },

    // Setting the global mode clears session overrides: "off" typed without a
    // session means off everywhere, not off except where you forgot.
    async set(mode: Mode, sessionId?: string): Promise<void> {
      if (sessionId) state.sessions[sessionId] = mode;
      else state = { global: mode, sessions: {} };
      await persist();
    },

    snapshot(): ModeFile {
      return { global: state.global, sessions: { ...state.sessions } };
    },
  };
}

export type ModeStore = Awaited<ReturnType<typeof createModeStore>>;