import { z } from 'zod';

export type { Mode, Surface } from '../core/mode-file.js';

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

// Either identifies a change already denied (ticket), or claims one that has
// not happened yet (sessionId + target). One of the two must be present.
export const ExplainInputSchema = z
  .object({
    ticket: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    lines: z.array(LineNoteSchema),
    why: z.string().trim().min(1),
  })
  .refine((v) => v.ticket !== undefined || (v.sessionId !== undefined && v.target !== undefined), {
    message: 'Provide either a ticket, or the target file/command you are about to change.',
  });
export type ExplainInput = z.infer<typeof ExplainInputSchema>;

export interface PreExplanation {
  sessionId: string;
  target: string;
  lines: LineNote[];
  why: string;
  createdAt: number;
}

export const DecisionSchema = z.enum(['allow', 'try']);

export const TryRequestSchema = z.object({
  sessionId: z.string().min(1),
  target: z.string().min(1),
  cwd: z.string().optional(),
  termProgram: z.string().optional(),
  claudeSsePort: z.string().optional(),
  editor: z.string().optional(),
});

// Both optional: the learner running `let-me-explain done` has no way to know
// their session id, so with one try in flight neither is needed.
export const DoneRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const DecisionRequestSchema = z.object({
  ticket: z.string().min(1),
  decision: DecisionSchema,
});

export const ModeRequestSchema = z.object({
  mode: ModeSchema,
  sessionId: z.string().min(1).optional(),
});

export const SurfaceSchema = z.enum(['prompt', 'window']);

export const SurfaceRequestSchema = z.object({
  surface: SurfaceSchema,
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
  /**
   * `required` marks a line a note was expected for. Blank lines and context
   * carried unchanged into an Edit are not, so a missing note there is not a
   * gap and must not be drawn as one.
   */
  lines: { n: number; code: string; note?: string; required?: boolean }[];
  why?: string;
}

// The JSON Claude Code expects on stdout from a PreToolUse hook.
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

export const LIMITS = {
  maxNoteWords: 25,
  // A shell line is one note for a whole command, flags included.
  maxShellNoteWords: 45,
  maxWhyWords: 90,
  // A ticket that has sat unresolved this long can no longer authorise an
  // edit — the code it was minted for has probably moved on.
  ticketTtlMs: 10 * 60_000,
  // Shorter: a pre-explanation describes a change the agent is about to make,
  // so it is stale much sooner than a ticket for one already attempted.
  preExplanationTtlMs: 2 * 60_000,
  // Must stay well under the harness's 600s hook budget so the agent gets a
  // decision from us rather than a timeout from the harness.
  decisionTimeoutMs: 5 * 60_000,
  daemonHealthTimeoutMs: 2_000,
  // The waiting happens in the PreToolUse hook, not in an MCP call: the hook's
  // budget is set by us in hooks.json, while an MCP request is capped at the
  // SDK's 60s default. Kept just under the configured hook timeout so the
  // daemon always answers first — a hook killed by the harness would let the
  // agent's edit run and overwrite what the learner typed.
  // Measured: a PreToolUse hook configured for 3600s ran a full 620s, past the
  // 600s default, and its decision was still honoured. So the budget is ours to
  // set. Each layer must be shorter than the one above so *we* answer rather
  // than the harness killing the hook — a killed hook is a non-blocking error,
  // and the tool would run and overwrite what the learner typed.
  //   hooks.json 3600s  >  shim fetch 3570s  >  this 3540s
  tryHookWaitMs: 3_540_000,
  hookTimeoutSeconds: 3600,
  tutorialMaxAgeMs: 7 * 24 * 60 * 60_000,
} as const;