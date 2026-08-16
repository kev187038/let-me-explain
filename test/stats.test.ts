import { describe, expect, it } from 'vitest';
import { parseLogLines, summarise } from '../src/core/stats.js';

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe('parseLogLines', () => {
  it('skips a truncated final line rather than refusing to report', () => {
    const text = `${line({ type: 'a' })}\n${line({ type: 'b' })}\n{"type":"c`;
    expect(parseLogLines(text).map((l) => l.type)).toEqual(['a', 'b']);
  });

  it('ignores blank lines', () => {
    expect(parseLogLines(`\n${line({ type: 'a' })}\n\n`)).toHaveLength(1);
  });
});

describe('summarise', () => {
  it('reports nothing when nothing was intercepted', () => {
    const s = summarise([]);
    expect(s.intercepted).toBe(0);
    expect(s.denyRate).toBeNull();
    expect(s.medianWaitMs).toBeNull();
  });

  it('splits upfront explanations from denials', () => {
    const s = summarise(
      parseLogLines(
        [
          line({ type: 'explain.prebound' }),
          line({ type: 'explain.prebound' }),
          line({ type: 'explain.prebound' }),
          line({ type: 'ticket.minted' }),
        ].join('\n'),
      ),
    );
    expect(s.intercepted).toBe(4);
    expect(s.upfront).toBe(3);
    expect(s.denied).toBe(1);
    expect(s.denyRate).toBeCloseTo(0.25);
  });

  it('does not count a re-ask as a second interception', () => {
    const s = summarise(
      parseLogLines([line({ type: 'ticket.minted' }), line({ type: 'ticket.reasked' })].join('\n')),
    );
    expect(s.intercepted).toBe(1);
  });

  it('groups rejection reasons by their first sentence, not the line numbers', () => {
    const s = summarise(
      parseLogLines(
        [
          line({ type: 'explain.rejected', reason: 'Missing notes for line(s): 2. Every line…' }),
          line({ type: 'explain.rejected', reason: 'Missing notes for line(s): 7, 9. Every line…' }),
          line({ type: 'explain.rejected', reason: 'Line 9 does not exist. Number lines from 1.' }),
        ].join('\n'),
      ),
    );
    expect(s.rejected).toBe(3);
    expect(s.topRejection).toEqual({ reason: 'Missing notes for line(s)', count: 2 });
  });

  it('counts decisions and measures how long the agent waited', () => {
    const s = summarise(
      parseLogLines(
        [
          line({ type: 'decision.awaiting', ticket: 't1', at: 1_000 }),
          line({ type: 'decision.made', ticket: 't1', at: 3_000, outcome: 'allow' }),
          line({ type: 'decision.awaiting', ticket: 't2', at: 5_000 }),
          line({ type: 'decision.made', ticket: 't2', at: 6_000, outcome: 'write' }),
        ].join('\n'),
      ),
    );
    expect(s.allow).toBe(1);
    expect(s.write).toBe(1);
    expect(s.medianWaitMs).toBe(1_500);
  });

  it('ignores a decision it never saw the agent start waiting for', () => {
    const s = summarise(
      parseLogLines(line({ type: 'decision.made', ticket: 'orphan', at: 9, outcome: 'allow' })),
    );
    expect(s.allow).toBe(1);
    expect(s.medianWaitMs).toBeNull();
  });

  it('counts mismatched pre-explanations separately from rejections', () => {
    const s = summarise(parseLogLines(line({ type: 'explain.mismatched' })));
    expect(s.mismatched).toBe(1);
    expect(s.rejected).toBe(0);
  });
});