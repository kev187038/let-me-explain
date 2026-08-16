// __TOOL_VERSION__ is injected by tsup at build time (and by vitest's `define`).
// Under `tsx` in dev neither applies, so fall back to 'dev'.
export const TOOL_VERSION: string =
  typeof __TOOL_VERSION__ !== 'undefined' ? __TOOL_VERSION__ : 'dev';