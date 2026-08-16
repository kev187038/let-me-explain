// Our own machinery must never be intercepted: explaining the command that
// turns explanations off would be a trap, and intercepting explain() itself
// would be an infinite regress.
export function isOwnMachinery(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (/^mcp__.+__(explain|answer)$/.test(toolName)) return true;
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    return command.includes('let-me-explain');
  }
  return false;
}

export function isExplainTool(toolName: string): boolean {
  return /^mcp__.+__explain$/.test(toolName);
}