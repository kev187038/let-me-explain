import { readFile } from 'node:fs/promises';
import type { PreToolUseOutput } from '../contracts/index.js';
import { daemonUrl, readDaemonAddress } from '../core/discovery.js';
import { parseModeFile, resolveMode } from '../core/mode-file.js';
import { modePath } from '../core/paths.js';
import { envFromProcess } from '../io/env.js';
import { isOwnMachinery } from './policy.js';

// This runs on every intercepted tool call, so it carries no dependencies and
// every failure path ends in "allow". A broken plugin must degrade to plain
// Claude Code, never to a blocked agent.

const HEALTH_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 5_000;
// Under the hook timeout set in hooks.json (3600s), so the daemon's answer
// always wins. A let-me-try can hold this open for the best part of an hour.
const DECISION_TIMEOUT_MS = 3_570_000;

const ALLOW: PreToolUseOutput = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
};

function emit(output: PreToolUseOutput): never {
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref()),
  ]);
}

async function reachable(base: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (process.env.LET_ME_EXPLAIN === '0') emit(ALLOW);

  const raw = await withTimeout(readStdin(), STDIN_TIMEOUT_MS, '');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    emit(ALLOW);
  }

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const permissionMode =
    typeof payload.permission_mode === 'string' ? payload.permission_mode : undefined;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const toolInput =
    typeof payload.tool_input === 'object' && payload.tool_input !== null
      ? (payload.tool_input as Record<string, unknown>)
      : {};

  if (!toolName || !sessionId) emit(ALLOW);

  const env = envFromProcess();

  // Read off disk, before any network call: switching off has to be as cheap
  // as not having the plugin installed.
  const modeFile = await readFile(modePath(env), 'utf8').catch(() => null);
  if (resolveMode(parseModeFile(modeFile), sessionId) === 'off') emit(ALLOW);

  const address = await readDaemonAddress(env);
  if (!address) emit(ALLOW);

  const base = daemonUrl(address, '');
  const headers = { authorization: `Bearer ${address.token}`, 'content-type': 'application/json' };

  if (isOwnMachinery(toolName, toolInput)) {
    // Still worth telling the daemon, so it learns the real name the harness
    // gave our tool and can name it exactly in the next denial.
    await fetch(`${base}/observed`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ toolName }),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    }).catch(() => {});
    emit(ALLOW);
  }

  if (!(await reachable(base, address.token))) emit(ALLOW);

  try {
    const res = await fetch(`${base}/hook`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId, cwd, toolName, toolInput, permissionMode }),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    });
    if (!res.ok) emit(ALLOW);
    emit((await res.json()) as PreToolUseOutput);
  } catch {
    emit(ALLOW);
  }
}

main().catch(() => emit(ALLOW));