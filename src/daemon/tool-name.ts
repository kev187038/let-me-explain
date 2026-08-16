// The harness decides how our MCP tool is exposed (Claude Code renders it as
// mcp__plugin_<plugin>_<server>__<tool>). Guessing wrong would point the agent
// at a tool that does not exist, so we watch for the real name going past and
// use it from then on; the computed default only covers the very first call.
export const DEFAULT_EXPLAIN_TOOL = 'mcp__plugin_let-me-explain_lme__explain';

export function createToolNames(fallback: string = DEFAULT_EXPLAIN_TOOL) {
  let learned: string | null = null;

  return {
    observe(toolName: string): void {
      if (/^mcp__.+__explain$/.test(toolName)) learned = toolName;
    },
    explain(): string {
      return learned ?? fallback;
    },
  };
}

export type ToolNames = ReturnType<typeof createToolNames>;