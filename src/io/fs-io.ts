import { mkdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// The only module that touches the filesystem. Core stays pure; commands
// receive this as an injected dependency, so flow tests run against a temp
// directory with the real implementation — no mocks needed.

export interface FsIo {
  readFileIfExists(path: string): Promise<string | null>;
  writeFileAtomic(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  dirExists(path: string): Promise<boolean>;
  deleteFileIfExists(path: string): Promise<boolean>;
  removeDirIfEmpty(path: string): Promise<void>;
}

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e;
}

export const fsIo: FsIo = {
  async readFileIfExists(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (e) {
      if (isErrnoException(e) && e.code === 'ENOENT') return null;
      throw e;
    }
  },

  // Write-to-temp-then-rename: rename within the same directory is atomic on
  // POSIX, so a crash mid-write can never leave the target half-written —
  // readers see either the old file or the new one, nothing in between.
  async writeFileAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, content, 'utf8');
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  },

  async fileExists(path) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },

  async dirExists(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },

  async deleteFileIfExists(path) {
    try {
      await unlink(path);
      return true;
    } catch (e) {
      if (isErrnoException(e) && e.code === 'ENOENT') return false;
      throw e;
    }
  },

  async removeDirIfEmpty(path) {
    try {
      await rmdir(path); // rmdir (non-recursive) fails on non-empty — exactly what we want
    } catch (e) {
      if (isErrnoException(e) && (e.code === 'ENOENT' || e.code === 'ENOTEMPTY')) return;
      throw e;
    }
  },
};
