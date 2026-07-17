import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __TOOL_VERSION__: JSON.stringify(pkg.version) },
});
