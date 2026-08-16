import { describe, expect, it } from 'vitest';
import { createTicketStore } from '../src/daemon/tickets.js';
import type { HookEvent } from '../src/contracts/index.js';

const event = (over: Partial<HookEvent> = {}): HookEvent => ({
  sessionId: 's1',
  cwd: '/repo',
  toolName: 'Edit',
  toolInput: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
  ...over,
});

const explanation = { lines: [{ n: 1, note: 'sets y' }], why: 'fixing a bug', at: 0 };

describe('ticket store', () => {
  it('mints on first sight and recognises the retry as the same ticket', () => {
    const store = createTicketStore();
    const first = store.lookup(event());
    expect(first.kind).toBe('minted');

    const retry = store.lookup(
      event({ toolInput: { new_string: 'y', file_path: '/a.ts', old_string: 'x' } }),
    );
    expect(retry.kind).toBe('awaiting_explanation');
    expect(retry.ticket.id).toBe(first.ticket.id);
  });

  it('walks explain then decide, and unblocks the parked request', async () => {
    const store = createTicketStore();
    const { ticket } = store.lookup(event());

    expect(store.attachExplanation(ticket.id, explanation)).toBe(true);
    expect(store.lookup(event()).kind).toBe('awaiting_decision');

    const parked = store.awaitDecision(ticket.id, 5_000);
    expect(store.decide(ticket.id, 'allow')).toBe(true);
    await expect(parked).resolves.toBe('allow');
  });

  it('resolves every parked request for the same ticket', async () => {
    const store = createTicketStore();
    const { ticket } = store.lookup(event());
    store.attachExplanation(ticket.id, explanation);

    const a = store.awaitDecision(ticket.id, 5_000);
    const b = store.awaitDecision(ticket.id, 5_000);
    store.decide(ticket.id, 'allow');
    await expect(Promise.all([a, b])).resolves.toEqual(['allow', 'allow']);
  });

  it('times out rather than parking forever', async () => {
    const store = createTicketStore();
    const { ticket } = store.lookup(event());
    store.attachExplanation(ticket.id, explanation);
    await expect(store.awaitDecision(ticket.id, 10)).resolves.toBe('timeout');
  });

  it('keeps saying "you write it" instead of restarting the explain dance', () => {
    const store = createTicketStore();
    const { ticket } = store.lookup(event());
    store.attachExplanation(ticket.id, explanation);
    store.decide(ticket.id, 'try');

    const retry = store.lookup(event());
    expect(retry.kind).toBe('declined');
    expect(retry.ticket.id).toBe(ticket.id);
  });

  it('honours a decision that landed before the agent retried', async () => {
    const store = createTicketStore();
    const { ticket } = store.lookup(event());
    store.attachExplanation(ticket.id, explanation);

    store.decide(ticket.id, 'allow');
    expect(store.lookup(event()).kind).toBe('decided');
    await expect(store.awaitDecision(ticket.id, 10)).resolves.toBe('allow');
  });

  it('consumes an approval so it authorises exactly one tool call', () => {
    const store = createTicketStore();
    const { ticket } = store.lookup(event());
    store.attachExplanation(ticket.id, explanation);
    store.decide(ticket.id, 'allow');

    store.consume(ticket.id);
    expect(store.lookup(event()).kind).toBe('minted');
    expect(store.size()).toBe(1);
  });

  it('scopes tickets to a session — an identical edit elsewhere gets its own', () => {
    const store = createTicketStore();
    const a = store.lookup(event({ sessionId: 's1' }));
    const b = store.lookup(event({ sessionId: 's2' }));
    expect(b.kind).toBe('minted');
    expect(b.ticket.id).not.toBe(a.ticket.id);
  });

  it('expires tickets past their TTL', () => {
    let clock = 1_000;
    const store = createTicketStore({ now: () => clock, ttlMs: 100 });
    const first = store.lookup(event());

    clock += 500;
    const later = store.lookup(event());
    expect(later.kind).toBe('minted');
    expect(later.ticket.id).not.toBe(first.ticket.id);
    expect(store.size()).toBe(1);
  });

  it('refuses to explain a ticket that is already resolved', () => {
    const store = createTicketStore();
    const { ticket } = store.lookup(event());
    store.attachExplanation(ticket.id, explanation);
    store.decide(ticket.id, 'try');
    expect(store.attachExplanation(ticket.id, explanation)).toBe(false);
  });

  it('exposes pending work with code and notes lined up', () => {
    const store = createTicketStore();
    const { ticket } = store.lookup(
      event({ toolInput: { file_path: '/a.ts', old_string: '', new_string: 'one\ntwo' } }),
    );
    store.attachExplanation(ticket.id, {
      lines: [
        { n: 1, note: 'first' },
        { n: 2, note: 'second' },
      ],
      why: 'because',
      at: 0,
    });

    expect(store.pending()).toEqual([
      {
        ticket: ticket.id,
        sessionId: 's1',
        toolName: 'Edit',
        state: 'awaiting_decision',
        target: '/a.ts',
        lines: [
          { n: 1, code: 'one', note: 'first' },
          { n: 2, code: 'two', note: 'second' },
        ],
        why: 'because',
      },
    ]);
  });
});
