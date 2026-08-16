import { daemonUrl, readDaemonAddress } from '../core/discovery.js';
import { envFromProcess } from '../io/env.js';

// With surface `prompt`, Claude Code owns the approval, so the PreToolUse hook
// never learns what the learner chose. These two events are where the outcome
// comes back: PostToolUse means it ran, PermissionDenied means it did not.
// Purely observational — it reports and exits, and never blocks anything.

const TIMEOUT_MS = 2_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  if (process.env.LET_ME_EXPLAIN === '0') return;

  const raw = await Promise.race([
    readStdin(),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), TIMEOUT_MS).unref()),
  ]);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
  if (!sessionId || !toolName) return;

  const address = await readDaemonAddress(envFromProcess());
  if (!address) return;

  await fetch(daemonUrl(address, '/outcome'), {
    method: 'POST',
    headers: { authorization: `Bearer ${address.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, toolName, event }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {});
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
