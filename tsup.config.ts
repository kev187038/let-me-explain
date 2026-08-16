import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: [
    'src/cli.ts',
    'src/daemon/main.ts',
    'src/hook/pretooluse.ts',
    'src/hook/session-start.ts',
    'src/hook/outcome.ts',
    'src/mcp/server.ts',
  ],
  format: ['esm'],
  clean: true,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  define: { __TOOL_VERSION__: JSON.stringify(pkg.version) },
});