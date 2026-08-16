import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __TOOL_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['test/**/*.test.ts'],
    // The live journey has its own config: real model, credentials, minutes.
    exclude: ['test/live/**'],
  },
});