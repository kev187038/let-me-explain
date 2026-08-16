import { defineConfig } from 'vitest/config';

// The live journey only. It needs credentials, a network and minutes, so it is
// deliberately not in `npm test` — a suite that flakes is one people stop
// trusting.
export default defineConfig({
  define: { __TOOL_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
