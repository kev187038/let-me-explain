import { daemonUrl, readDaemonAddress } from '../core/discovery.js';
import { envFromProcess } from '../io/env.js';

// Tutorials are scratch: once the session that produced them is over they are
// noise. Fire-and-forget, with a short budget — SessionEnd hooks share a tight
// timeout and nothing here is worth delaying a shutdown for.

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

  let sessionId = '';
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (typeof payload.session_id === 'string') sessionId = payload.session_id;
  } catch {
    return;
  }
  if (!sessionId) return;

  const address = await readDaemonAddress(envFromProcess());
  if (!address) return;

  await fetch(daemonUrl(address, '/clean'), {
    method: 'POST',
    headers: { authorization: `Bearer ${address.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(1_000),
  }).catch(() => {});
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));