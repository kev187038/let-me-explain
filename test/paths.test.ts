import { describe, expect, it } from 'vitest';
import { configDir, configFilePath, manifestPath } from '../src/core/paths.js';

describe('paths', () => {
  it('defaults to ~/.config/let-me-explain', () => {
    expect(configDir({ home: '/home/x' })).toBe('/home/x/.config/let-me-explain');
  });

  it('respects XDG_CONFIG_HOME over the default', () => {
    expect(configDir({ home: '/home/x', xdgConfigHome: '/xdg' })).toBe('/xdg/let-me-explain');
  });

  it('falls back to APPDATA when no XDG (Windows)', () => {
    expect(configDir({ home: 'C:\\Users\\x', appData: '/appdata' })).toBe(
      '/appdata/let-me-explain',
    );
  });

  it('derives config and manifest file paths from the dir', () => {
    const env = { home: '/home/x' };
    expect(configFilePath(env)).toBe('/home/x/.config/let-me-explain/config.json');
    expect(manifestPath(env)).toBe('/home/x/.config/let-me-explain/manifest.json');
  });
});
