export interface LogLine {
  at?: number;
  type?: string;
  ticket?: string;
  reason?: string;
  outcome?: string;
  decision?: string;
  [key: string]: unknown;
}

export interface Stats {
  intercepted: number;
  upfront: number;
  denied: number;
  denyRate: number | null;
  mismatched: number;
  rejected: number;
  topRejection: { reason: string; count: number } | null;
  allow: number;
  write: number;
  medianWaitMs: number | null;
}

export function parseLogLines(text: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) continue;
    try {
      lines.push(JSON.parse(raw) as LogLine);
    } catch {
      // A truncated final line is normal for an append-only log being written
      // to concurrently; skipping it is better than refusing to report.
    }
  }
  return lines;
}

// Rejection reasons carry line numbers, so group by the sentence rather than
// the whole string or every rejection looks unique.
function reasonKey(reason: string): string {
  return reason.split(/[.:]/)[0]?.trim() ?? reason;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

export function summarise(lines: LogLine[]): Stats {
  let upfront = 0;
  let denied = 0;
  let mismatched = 0;
  let rejected = 0;
  let allow = 0;
  let write = 0;
  const reasons = new Map<string, number>();
  const awaitingAt = new Map<string, number>();
  const waits: number[] = [];

  for (const line of lines) {
    switch (line.type) {
      case 'explain.prebound':
        upfront++;
        break;
      case 'ticket.minted':
        denied++;
        break;
      case 'explain.mismatched':
        mismatched++;
        break;
      case 'explain.rejected': {
        rejected++;
        const key = reasonKey(typeof line.reason === 'string' ? line.reason : 'unknown');
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
        break;
      }
      case 'decision.awaiting':
        if (line.ticket && typeof line.at === 'number') awaitingAt.set(line.ticket, line.at);
        break;
      case 'decision.made': {
        if (line.outcome === 'allow') allow++;
        if (line.outcome === 'write') write++;
        const started = line.ticket ? awaitingAt.get(line.ticket) : undefined;
        if (started !== undefined && typeof line.at === 'number') waits.push(line.at - started);
        break;
      }
    }
  }

  const intercepted = upfront + denied;
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    intercepted,
    upfront,
    denied,
    denyRate: intercepted === 0 ? null : denied / intercepted,
    mismatched,
    rejected,
    topRejection: top ? { reason: top[0], count: top[1] } : null,
    allow,
    write,
    medianWaitMs: median(waits),
  };
}