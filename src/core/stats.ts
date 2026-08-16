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
  /** Explanations the daemon refused: wrong line coverage, too wordy. */
  rejected: number;
  topRejection: { reason: string; count: number } | null;
  /** What the learner chose. */
  approved: number;
  declined: number;
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
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

export function summarise(lines: LogLine[]): Stats {
  let upfront = 0;
  let denied = 0;
  let mismatched = 0;
  let rejected = 0;
  let approved = 0;
  let declined = 0;
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
      // Surface `window`: the daemon held the request and knows the answer.
      case 'decision.made': {
        if (line.outcome === 'allow') approved++;
        if (line.outcome === 'write') declined++;
        const started = line.ticket ? awaitingAt.get(line.ticket) : undefined;
        if (started !== undefined && typeof line.at === 'number') waits.push(line.at - started);
        break;
      }
      // Surface `prompt`: Claude Code owns the approval, so the outcome comes
      // back afterwards from PostToolUse / PermissionDenied instead.
      case 'decision.approved':
        approved++;
        break;
      case 'decision.rejected':
        declined++;
        break;
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
    approved,
    declined,
    medianWaitMs: median(waits),
  };
}
