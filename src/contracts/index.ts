import { z } from 'zod';

export type { Mode } from '../core/mode-file.js';

export const ModeSchema = z.enum(['on', 'off']);

// The harness-neutral shape. Every adapter's only job is producing one of
// these from whatever its harness sends.
export const HookEventSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string(),
  toolName: z.string().min(1),
  toolInput: z.record(z.unknown()),
});
export type HookEvent = z.infer<typeof HookEventSchema>;

export const LineNoteSchema = z.object({
  n: z.number().int().positive(),
  note: z.string().trim().min(1),
});
export type LineNote = z.infer<typeof LineNoteSchema>;

export const ExplainInputSchema = z.object({
  ticket: z.string().min(1),
  lines: z.array(LineNoteSchema),
  why: z.string().trim().min(1),
});
export type ExplainInput = z.infer<typeof ExplainInputSchema>;

export const DecisionSchema = z.enum(['allow', 'write']);
export type Decision = z.infer<typeof DecisionSchema>;

export const DecisionRequestSchema = z.object({
  ticket: z.string().min(1),
  decision: DecisionSchema,
});

export const ModeRequestSchema = z.object({
  mode: ModeSchema,
  sessionId: z.string().min(1).optional(),
});

export type TicketState = 'awaiting_explanation' | 'awaiting_decision' | 'resolved';

export interface Explanation {
  lines: LineNote[];
  why: string;
  at: number;
}

export interface Ticket {
  id: string;
  sessionId: string;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  hash: string;
  state: TicketState;
  createdAt: number;
  explanation?: Explanation;
  decision?: Decision;
}

// What GET /pending exposes. Deliberately a projection rather than the raw
// ticket, so internal fields can change without breaking clients.
export interface PendingView {
  ticket: string;
  sessionId: string;
  toolName: string;
  state: TicketState;
  target: string;
  lines: { n: number; code: string; note?: string }[];
  why?: string;
}

// The JSON Claude Code expects on stdout from a PreToolUse hook.
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

export const LIMITS = {
  maxNoteWords: 25,
  maxWhyWords: 90,
  // A ticket that has sat unresolved this long can no longer authorise an
  // edit — the code it was minted for has probably moved on.
  ticketTtlMs: 10 * 60_000,
  // Must stay well under the harness's 600s hook budget so the agent gets a
  // decision from us rather than a timeout from the harness.
  decisionTimeoutMs: 5 * 60_000,
  daemonHealthTimeoutMs: 2_000,
} as const;