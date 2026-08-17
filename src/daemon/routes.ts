import { Hono } from 'hono';
import {
  DecisionRequestSchema,
  ExplainInputSchema,
  HookEventSchema,
  LIMITS,
  ModeRequestSchema,
  SurfaceRequestSchema,
  TryRequestSchema,
  DoneRequestSchema,
  type PreToolUseOutput,
} from '../contracts/index.js';
import { cleanAll, cleanSession, listTutorials } from '../core/cleanup.js';
import type { Env } from '../core/paths.js';
import { alignNotes, unexplained, validateExplanation } from '../core/explanation.js';
import { explainableLines, requiredLineNumbers } from '../core/lines.js';
import { TOOL_VERSION } from '../version.js';
import type { Logger } from './log.js';
import type { ModeStore } from './mode.js';
import { renderInstructions } from './instructions.js';
import {
  LEARNER_IS_TRYING,
  chooseHowToProceed,
  explainMismatch,
  learnerAlreadyWrote,
  explainRequest,
  explanationForPrompt,
  learnerFinished,
  stillTyping,
} from './prompts.js';
import type { TicketStore } from './tickets.js';
import type { TryStore } from './try.js';
import type { ToolNames } from './tool-name.js';

export interface DaemonDeps {
  store: TicketStore;
  mode: ModeStore;
  log: Logger;
  toolNames: ToolNames;
  tries: TryStore;
  env: Env;
  token: string;
  decisionTimeoutMs?: number;
  tryWaitMs?: number;
  /** Test seam: pretend a status bar has been polling since this timestamp. */
  watcherSeenAt?: number;
}

// The VS Code status bar polls /active every 2s. Three missed polls means the
// window is gone, reloading, or the extension was never installed.
const WATCHER_TTL_MS = 6_000;

// A poll only proves someone is *watching*; it does not prove they can show a
// choice. The pre-buttons extension polled /active for tries alone, which was
// enough to convince the daemon a decider existed and left a change held with
// nothing on screen. So a decider now has to say so.
const CLIENT_HEADER = 'x-let-me-explain-client';
const BUTTONS_CLIENT = /\bbuttons\b/;

const NO_WATCHER_HINT =
  '(surface: window, but no VS Code buttons are listening — deciding here instead. ' +
  'Update the let-me-explain extension and reload the VS Code window, ' +
  'or run `let-me-explain surface prompt`.)';

const allow = (): PreToolUseOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
});

const deny = (reason: string): PreToolUseOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

// Hands the decision to Claude Code's own approval prompt, with the
// explanation as the context shown to the learner.
const ask = (reason: string): PreToolUseOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: reason,
  },
});

export function createApp(deps: DaemonDeps): Hono {
  const { store, mode, log, toolNames, tries, env, token } = deps;
  const decisionTimeoutMs = deps.decisionTimeoutMs ?? LIMITS.decisionTimeoutMs;
  // Last time anything polled /active. The VS Code extension polls every 2s, so
  // a gap much larger than that means no buttons are on screen.
  let watcherSeenAt = deps.watcherSeenAt ?? 0;
  const tryWaitMs = deps.tryWaitMs ?? LIMITS.tryHookWaitMs;
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    if (c.req.header('authorization') !== `Bearer ${token}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  app.get('/health', (c) => c.json({ ok: true, version: TOOL_VERSION, pid: process.pid }));

  app.post('/hook', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = HookEventSchema.safeParse(body);
    if (!parsed.success) return c.json(allow());

    const event = parsed.data;
    toolNames.observe(event.toolName);

    const explainable = explainableLines(event.toolName, event.toolInput);
    if (!explainable || explainable.lines.length === 0) return c.json(allow());

    // The learner is typing this one themselves. Park here rather than in the
    // MCP call: this hook's budget is minutes, an MCP request's is 60s.
    const parkIfTyping = async (): Promise<PreToolUseOutput | null> => {
      const typing = tries.waitFor(event.sessionId, explainable.target, tryWaitMs);
      if (!typing) return null;
      const outcome = await typing;
      await log.append({
        type: `try.${outcome.status}`,
        sessionId: event.sessionId,
        target: explainable.target,
      });
      // Never `allow` here: letting the tool run would overwrite what they
      // just wrote. Both branches deny.
      return deny(
        outcome.status === 'done'
          ? learnerFinished(explainable.target, outcome.yours, outcome.theirs)
          : stillTyping(explainable.target),
      );
    };

    const alreadyTyping = await parkIfTyping();
    if (alreadyTyping) return c.json(alreadyTyping);

    // They already typed this one. Falling through would find the ticket still
    // awaiting a decision and ask them to approve overwriting their own work.
    if (
      tries.alreadyWritten(
        event.sessionId,
        explainable.target,
        explainable.lines.join('\n'),
        LIMITS.ticketTtlMs,
      )
    ) {
      await log.append({
        type: 'try.already-written',
        sessionId: event.sessionId,
        target: explainable.target,
      });
      return c.json(deny(learnerAlreadyWrote(explainable.target)));
    }

    // Only *after* the try check: switching off stops future interception, it
    // does not abandon work the learner is part-way through typing.
    if (mode.get(event.sessionId) === 'off') return c.json(allow());

    const found = store.lookup(event);
    const { ticket } = found;

    if (found.kind === 'declined') return c.json(deny(LEARNER_IS_TRYING));

    if (found.kind === 'decided') {
      store.consume(ticket.id);
      return c.json(allow());
    }

    if (found.kind === 'mismatched') {
      await log.append({
        type: 'explain.mismatched',
        sessionId: event.sessionId,
        ticket: ticket.id,
        target: explainable.target,
        reason: found.error,
      });
      return c.json(
        deny(explainMismatch(ticket.id, toolNames.explain(), explainable.target, found.error)),
      );
    }

    if (found.kind === 'minted' || found.kind === 'awaiting_explanation') {
      await log.append({
        type: found.kind === 'minted' ? 'ticket.minted' : 'ticket.reasked',
        sessionId: event.sessionId,
        ticket: ticket.id,
        toolName: event.toolName,
        target: explainable.target,
      });
      return c.json(
        deny(explainRequest(ticket.id, toolNames.explain(), explainable.lines.length)),
      );
    }

    if (found.kind === 'prebound') {
      await log.append({
        type: 'explain.prebound',
        sessionId: event.sessionId,
        ticket: ticket.id,
        toolName: event.toolName,
        target: explainable.target,
      });
    }

    // Coverage is no longer enforced, so it is measured instead: this is the
    // only point where the notes and the real change are both in hand.
    const gaps = unexplained(explainable, ticket.explanation?.lines ?? []);
    await log.append({
      type: 'explain.coverage',
      sessionId: event.sessionId,
      ticket: ticket.id,
      target: explainable.target,
      needed: requiredLineNumbers(explainable).length,
      missing: gaps.length,
    });

    // The learner picked "let me try" from the menu, which happens *before* the
    // agent makes its tool call — so there was no code for the tutorial yet.
    // This is that code arriving, and the only point where both halves exist.
    const intent = tries.takeArmed(event.sessionId, explainable.target, LIMITS.ticketTtlMs);
    if (intent) {
      const view = store.pending().find((p) => p.ticket === ticket.id);
      if (view) {
        await log.append({
          type: 'try.begin',
          sessionId: event.sessionId,
          target: explainable.target,
        });
        // The hook's cwd is the real project directory; the MCP server could
        // only guess at it.
        await tries.begin(view, event.sessionId, event.cwd || intent.cwd, intent.sessionEnv);
        const parked = await parkIfTyping();
        if (parked) return c.json(parked);
      }
    }

    // The explanation exists; who shows it and collects the answer depends on
    // the surface — but `window` only works if something is actually watching.
    // Holding a tool call open with no VS Code extension polling and no one at
    // a terminal is a silent hang with nothing on screen, so we detect the
    // watcher rather than trusting the setting.
    const surface = mode.surface(event.sessionId);
    const unwatched = surface === 'window' && Date.now() - watcherSeenAt >= WATCHER_TTL_MS;
    if (surface === 'prompt' || unwatched) {
      const view = store.pending().find((p) => p.ticket === ticket.id);
      await log.append({
        type: unwatched ? 'decision.unwatched' : 'decision.asked',
        sessionId: event.sessionId,
        ticket: ticket.id,
        toolName: event.toolName,
      });
      // Deliberately not consumed: if the agent retries this same change the
      // ticket is still here, so it re-asks rather than demanding a fresh
      // explanation. It ages out with the normal TTL.
      const explanation = view
        ? explanationForPrompt(view)
        : 'Change explained by let-me-explain.';
      // Falling back silently would be as confusing as the hang it prevents.
      return c.json(ask(unwatched ? `${explanation}\n${NO_WATCHER_HINT}` : explanation));
    }

    await log.append({
      type: 'decision.awaiting',
      sessionId: event.sessionId,
      ticket: ticket.id,
    });

    const outcome = await store.awaitDecision(ticket.id, decisionTimeoutMs);
    await log.append({
      type: 'decision.made',
      sessionId: event.sessionId,
      ticket: ticket.id,
      outcome,
    });

    if (outcome === 'try') return c.json(deny(LEARNER_IS_TRYING));
    // A timeout must never leave the agent hanging: allow, and record that
    // nobody was watching.
    if (outcome === 'timeout') store.decide(ticket.id, 'allow');
    store.consume(ticket.id);
    return c.json(allow());
  });

  app.post('/explain', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ExplainInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' }, 400);
    }

    // No ticket means the agent is explaining ahead of the change. Shelve it;
    // the hook binds it when the matching tool call turns up.
    if (parsed.data.ticket === undefined) {
      const { sessionId, target, lines, why } = parsed.data;
      store.addPreExplanation({
        sessionId: sessionId as string,
        target: target as string,
        lines,
        why,
        createdAt: Date.now(),
      });
      await log.append({
        type: 'explain.shelved',
        sessionId: sessionId as string,
        target: target as string,
        lines: lines.length,
      });
      return c.json({
        ok: true,
        pending: true,
        next: chooseHowToProceed(target as string, toolNames.letMeTry()),
      });
    }

    const ticket = store.get(parsed.data.ticket);
    if (!ticket) {
      return c.json(
        {
          ok: false,
          error: `Unknown or expired ticket "${parsed.data.ticket}". Retry the tool call to get a fresh one.`,
        },
        404,
      );
    }

    const explainable = explainableLines(ticket.toolName, ticket.toolInput);
    if (!explainable) return c.json({ ok: false, error: 'nothing to explain' }, 400);

    const valid = validateExplanation(explainable, parsed.data);
    if (!valid.ok) {
      await log.append({
        type: 'explain.rejected',
        sessionId: ticket.sessionId,
        ticket: ticket.id,
        reason: valid.error,
      });
      return c.json({ ok: false, error: valid.error }, 400);
    }

    store.attachExplanation(ticket.id, {
      ...parsed.data,
      lines: alignNotes(explainable, parsed.data.lines),
      at: Date.now(),
    });
    await log.append({
      type: 'explain.accepted',
      sessionId: ticket.sessionId,
      ticket: ticket.id,
      lines: parsed.data.lines.length,
    });
    return c.json({ ok: true, ticket: ticket.id });
  });

  // The shim reports our own MCP tool as the harness actually named it, so
  // later denials can point at a tool that provably exists.
  app.post('/observed', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { toolName?: unknown } | null;
    if (typeof body?.toolName === 'string') toolNames.observe(body.toolName);
    return c.json({ ok: true, explain: toolNames.explain() });
  });

  // Rendered here rather than in the hook because only the daemon knows the
  // name the harness actually gave our MCP tool.
  app.get('/instructions', (c) =>
    c.text(
      renderInstructions({ explainTool: toolNames.explain(), tryTool: toolNames.letMeTry() }),
    ),
  );

  // How the outcome comes back when Claude Code owns the approval prompt.
  app.post('/outcome', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) return c.json({ ok: false }, 400);

    await log.append({
      type: body?.event === 'PermissionDenied' ? 'decision.rejected' : 'decision.approved',
      sessionId,
      toolName: typeof body?.toolName === 'string' ? body.toolName : null,
    });
    return c.json({ ok: true });
  });

  // The learner said they would write it. Lay out the tutorial, open their
  // editor, and park until they are done.
  app.post('/try', async (c) => {
    const parsed = TryRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid try request' }, 400);

    const { sessionId, target, cwd, ...sessionEnv } = parsed.data;

    // Already open: say so rather than opening a second editor window.
    if (tries.inFlight(sessionId, target)) {
      return c.json({ ok: true, status: 'open' });
    }

    const view = store.viewFor(sessionId, target);
    if (!view) {
      // Explained but not yet attempted — the normal path now that the learner
      // chooses from a menu before the tool call. Remember the choice; the
      // tutorial is written when the tool call brings the code.
      if (store.hasPreExplanation(sessionId, target)) {
        tries.arm(sessionId, target, cwd ?? '', sessionEnv);
        await log.append({ type: 'try.armed', sessionId, target });
        return c.json({ ok: true, status: 'armed' });
      }
      return c.json(
        {
          ok: false,
          error: `Nothing pending for "${target}". Explain the change first, then call this.`,
        },
        404,
      );
    }

    await log.append({ type: 'try.begin', sessionId, target });
    const opened = await tries.begin(view, sessionId, cwd ?? '', sessionEnv);
    return c.json({ ok: true, status: 'open', ...opened });
  });

  app.post('/done', async (c) => {
    const parsed = DoneRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid done request' }, 400);
    const finished = await tries.finish(parsed.data.sessionId, parsed.data.target);
    return c.json(finished);
  });

  app.post('/clean', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessionId?: unknown } | null;
    const result =
      typeof body?.sessionId === 'string'
        ? await cleanSession(env, body.sessionId)
        : await cleanAll(env);
    return c.json({ ok: true, ...result });
  });

  app.get('/tutorials', async (c) => c.json({ tutorials: await listTutorials(env) }));

  // Polled by the editor extension so it can show its "I'm done" button only
  // while the learner is actually typing something.
  // Both things a status bar can be waiting on: a change held for a decision,
  // and a try the learner is part-way through. One poll covers both.
  app.get('/active', (c) => {
    // Polling is also how we know a status bar exists at all — see the hook,
    // which will not hold a change open when nobody can answer. Older clients
    // are still served; they just do not count.
    if (BUTTONS_CLIENT.test(c.req.header(CLIENT_HEADER) ?? '')) watcherSeenAt = Date.now();
    return c.json({
      tries: tries.list(),
      held: store
        .pending()
        .filter((p) => p.state === 'awaiting_decision' && store.isHeld(p.ticket))
        .map((p) => ({
          ticket: p.ticket,
          sessionId: p.sessionId,
          target: p.target,
          why: p.why,
          explanation: explanationForPrompt(p, 'buttons'),
        })),
    });
  });

  app.get('/pending', (c) => c.json({ pending: store.pending() }));

  app.post('/decision', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = DecisionRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid decision' }, 400);

    const ticket = store.get(parsed.data.ticket);
    if (!store.decide(parsed.data.ticket, parsed.data.decision)) {
      return c.json({ error: 'ticket is not waiting for a decision' }, 409);
    }
    if (ticket) {
      await log.append({
        type: 'decision.sent',
        sessionId: ticket.sessionId,
        ticket: ticket.id,
        decision: parsed.data.decision,
      });
    }
    return c.json({ ok: true });
  });

  app.get('/mode', (c) => {
    const sessionId = c.req.query('sessionId');
    return c.json({ ...mode.settings(sessionId), ...mode.snapshot() });
  });

  app.post('/surface', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SurfaceRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid surface' }, 400);
    await mode.setSurface(parsed.data.surface, parsed.data.sessionId);
    return c.json({ ok: true, surface: parsed.data.surface });
  });

  app.post('/mode', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ModeRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid mode' }, 400);
    await mode.set(parsed.data.mode, parsed.data.sessionId);
    return c.json({ ok: true, mode: parsed.data.mode });
  });

  return app;
}