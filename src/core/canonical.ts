import { createHash } from 'node:crypto';

// Key order in a JS object is insertion order, and a retried tool call is a
// fresh generation from the model — so {a,b} and {b,a} are the same value
// with different bytes. Sorting recursively is what makes the retry hash
// match the original.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashToolCall(toolName: string, toolInput: unknown): string {
  return createHash('sha256').update(canonicalJson({ toolName, toolInput })).digest('hex');
}