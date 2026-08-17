// Our own machinery must never be intercepted: explaining the command that
// turns explanations off would be a trap, and intercepting explain() itself
// would be an infinite regress.
//
// The name has to appear as the command being run, not merely somewhere in the
// string — a substring test also exempts every command that happens to mention
// a path containing "let-me-explain", which silently disables interception for
// anyone working inside a directory of that name.
// Requiring one of our own subcommands keeps `grep -r let-me-explain src/` out
// of the exemption. Erring strict is the right direction: a missed exemption
// costs one explanation, a false one silently stops teaching altogether.
const SUBCOMMANDS = 'status|on|off|start|stop|pending|allow|write|stats';
const CONTROL_COMMAND = new RegExp(
  `(?:^|[\\s;&|(])(?:npx\\s+)?(?:let-me-explain|\\S*dist/cli\\.js)\\s+(?:${SUBCOMMANDS})\\b`,
);

export function isOwnMachinery(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (/^mcp__.+__(explain|answer|let_me_try)$/.test(toolName)) return true;
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    return CONTROL_COMMAND.test(command);
  }
  return false;
}

export function isExplainTool(toolName: string): boolean {
  return /^mcp__.+__explain$/.test(toolName);
}