import { randomBytes } from 'node:crypto';
import {
  LIMITS,
  type Decision,
  type Explanation,
  type HookEvent,
  type PendingView,
  type Ticket,
} from '../contracts/index.js';
import { hashToolCall } from '../core/canonical.js';
import { explainableLines } from '../core/lines.js';

export type Lookup =
  | { kind: 'minted'; ticket: Ticket }
  | { kind: 'awaiting_explanation'; ticket: Ticket }
  | { kind: 'awaiting_decision'; ticket: Ticket }
  | { kind: 'decided'; ticket: Ticket }
  | { kind: 'declined'; ticket: Ticket };

export interface TicketStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

export function createTicketStore(opts: TicketStoreOptions = {}) {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? LIMITS.ticketTtlMs;

  const byId = new Map<string, Ticket>();
  // Content identity is per session: two sessions making the byte-identical
  // edit must each get their own approval.
  const byKey = new Map<string, string>();
  const waiters = new Map<string, ((d: Decision | 'timeout') => void)[]>();
  const timers = new Map<string, NodeJS.Timeout>();

  const key = (sessionId: string, hash: string) => `${sessionId}:${hash}`;

  function sweep(): void {
    const cutoff = now() - ttlMs;
    for (const [id, t] of byId) {
      if (t.createdAt < cutoff) {
        byId.delete(id);
        byKey.delete(key(t.sessionId, t.hash));
      }
    }
  }

  function newId(): string {
    let id = '';
    do {
      id = `t_${randomBytes(4).toString('hex')}`;
    } while (byId.has(id));
    return id;
  }

  function drop(t: Ticket): void {
    byId.delete(t.id);
    byKey.delete(key(t.sessionId, t.hash));
  }

  function settle(id: string, outcome: Decision | 'timeout'): void {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    for (const resolve of waiters.get(id) ?? []) resolve(outcome);
    waiters.delete(id);
  }

  return {
    // The one entry point the hook uses. Everything the shim needs to decide
    // comes out of this switch.
    lookup(event: HookEvent): Lookup {
      sweep();
      const hash = hashToolCall(event.toolName, event.toolInput);
      const existingId = byKey.get(key(event.sessionId, hash));
      const existing = existingId ? byId.get(existingId) : undefined;

      if (existing) {
        if (existing.state === 'awaiting_explanation') {
          return { kind: 'awaiting_explanation', ticket: existing };
        }
        if (existing.state === 'awaiting_decision') {
          return { kind: 'awaiting_decision', ticket: existing };
        }
        // The learner took this one over by hand; keep saying so until the
        // ticket ages out, rather than restarting the explain dance.
        if (existing.decision === 'write') return { kind: 'declined', ticket: existing };
        if (existing.decision === 'allow') return { kind: 'decided', ticket: existing };
        drop(existing);
      }

      const ticket: Ticket = {
        id: newId(),
        sessionId: event.sessionId,
        cwd: event.cwd,
        toolName: event.toolName,
        toolInput: event.toolInput,
        hash,
        state: 'awaiting_explanation',
        createdAt: now(),
      };
      byId.set(ticket.id, ticket);
      byKey.set(key(ticket.sessionId, hash), ticket.id);
      return { kind: 'minted', ticket };
    },

    get(id: string): Ticket | undefined {
      sweep();
      return byId.get(id);
    },

    attachExplanation(id: string, explanation: Explanation): boolean {
      const t = byId.get(id);
      if (!t || t.state === 'resolved') return false;
      t.explanation = explanation;
      t.state = 'awaiting_decision';
      return true;
    },

    // Deferred-promise registry: the /hook request parks here and /decision
    // resolves it. No polling, no second connection.
    awaitDecision(id: string, timeoutMs: number): Promise<Decision | 'timeout'> {
      const existing = byId.get(id);
      if (existing?.state === 'resolved' && existing.decision) {
        return Promise.resolve(existing.decision);
      }

      return new Promise((resolve) => {
        const list = waiters.get(id) ?? [];
        list.push(resolve);
        waiters.set(id, list);

        if (!timers.has(id)) {
          timers.set(
            id,
            setTimeout(() => settle(id, 'timeout'), timeoutMs),
          );
        }
      });
    },

    decide(id: string, decision: Decision): boolean {
      const t = byId.get(id);
      if (!t || t.state !== 'awaiting_decision') return false;
      t.state = 'resolved';
      t.decision = decision;
      settle(id, decision);
      return true;
    },

    // An approval authorises exactly one tool call. The hook consumes it the
    // moment it hands back "allow".
    consume(id: string): void {
      const t = byId.get(id);
      if (t) drop(t);
    },

    pending(): PendingView[] {
      sweep();
      return [...byId.values()]
        .filter((t) => t.state !== 'resolved')
        .map((t) => {
          const ex = explainableLines(t.toolName, t.toolInput);
          const notes = new Map(t.explanation?.lines.map((l) => [l.n, l.note]) ?? []);
          return {
            ticket: t.id,
            sessionId: t.sessionId,
            toolName: t.toolName,
            state: t.state,
            target: ex?.target ?? '',
            lines: (ex?.lines ?? []).map((code, i) => {
              const note = notes.get(i + 1);
              return note === undefined ? { n: i + 1, code } : { n: i + 1, code, note };
            }),
            ...(t.explanation ? { why: t.explanation.why } : {}),
          };
        });
    },

    close(): void {
      for (const id of [...timers.keys()]) settle(id, 'timeout');
    },

    size(): number {
      return byId.size;
    },
  };
}

export type TicketStore = ReturnType<typeof createTicketStore>;