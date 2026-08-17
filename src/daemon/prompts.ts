import { LIMITS, type PendingView } from '../contracts/index.js';

// An unreadable prompt is worse than no explanation, so long changes are
// truncated rather than flooding the approval screen.
const MAX_PROMPT_LINES = 25;

// Claude Code already renders the tool input in the approval prompt, so the
// notes reference line numbers instead of repeating the code. Flip this if
// that ever stops being true.
const INCLUDE_CODE = false;

/**
 * `prompt` — Claude Code owns the buttons, so the footer has to teach the
 * phrase. `buttons` — this is a VS Code tooltip and the choice is on screen.
 */
export type Footer = 'prompt' | 'buttons';

/** Shown where a note was expected and none arrived. */
export const NO_NOTE = '— not explained —';

export function explanationForPrompt(view: PendingView, footer: Footer = 'prompt'): string {
  // A line is listed if it carries a note or a note was expected: a gap the
  // learner can see beats a change they never see because we refused it.
  // Context lines carried into an Edit are neither, and marking them as gaps
  // would blame the agent for skipping what it was never asked for.
  const listed = view.lines.filter((l) => l.note !== undefined || l.required);
  const shown = listed.slice(0, MAX_PROMPT_LINES);
  const hidden = listed.length - shown.length;

  const out = [`[let-me-explain] ${view.target}`];
  if (view.why) out.push(`Why: ${view.why}`);
  out.push('');

  for (const line of shown) {
    const note = line.note ?? NO_NOTE;
    out.push(INCLUDE_CODE ? `  ${line.n} │ ${line.code}\n    └ ${note}` : `  ${line.n}  ${note}`);
  }

  if (hidden > 0) {
    out.push(`  … ${hidden} more line(s) — run \`let-me-explain pending\` for the rest`);
  }

  out.push('');
  out.push(
    footer === 'buttons'
      ? `✓ Allow · ✎ Let me try — type it yourself`
      : // Claude Code owns the prompt's buttons, so "let me try" can only be
        // reached by rejecting and saying so. Buried in a sentence, nobody
        // found it.
        `Approve · reject with "let me try" to type it yourself · reject with a question`,
  );
  return out.join('\n');
}

// These strings are prompts, not error messages: they land in the agent's
// context and are the only thing steering it back into the loop. Wording
// changes here change behaviour.

/**
 * Sent back from `explain` so the learner gets a real menu.
 *
 * Claude Code's permission prompt takes exactly three fixed entries and a
 * plugin cannot add a fourth — the hook may only allow, deny or ask. But
 * `AskUserQuestion` is a built-in tool that renders a genuine multiple-choice
 * list, and the agent can call it. We cannot, so we ask at the one moment it is
 * relevant rather than spending session-start tokens on it.
 *
 * Deliberately no way to report the answer back: the hook stays the only gate,
 * so a model that skips this simply lands on the ordinary prompt.
 */
export function chooseHowToProceed(target: string, tryTool: string): string {
  const what = target === 'shell' ? 'this command' : target;
  return [
    `Recorded. Before the tool call, ask the learner how they want to handle it —`,
    `call AskUserQuestion with:`,
    `  question: "How do you want to handle ${what}?"`,
    `  header:   "This change"`,
    `  options:  "Yes, go ahead"`,
    `            "Let me try — I'll type it myself"`,
    `            "Explain more first"`,
    ``,
    `Then act on their answer:`,
    `  Yes         → make the tool call as normal.`,
    `  Let me try  → call \`${tryTool}\` with target "${target}", then make the tool call`,
    `                anyway — it waits while they type and returns what they wrote.`,
    `  Explain more→ answer their question, then ask again.`,
    ``,
    `No AskUserQuestion tool? Skip the menu and make the tool call as normal.`,
  ].join('\n');
}

export function explainRequest(ticket: string, tool: string, lineCount: number): string {
  return [
    `[let-me-explain] The learner reads this before it runs.`,
    ``,
    `Call \`${tool}\` with:`,
    `  ticket: "${ticket}"`,
    `  lines:  one {n, note} per non-blank line of the new content, numbered from 1 (${lineCount} line(s) here)`,
    `  why:    one or two sentences on the problem this solves`,
    ``,
    `Each note: under ${LIMITS.maxNoteWords} words, plain language, no jargon, say what that line does.`,
    `Then retry this exact tool call, unchanged.`,
    ``,
    `Next time, call \`${tool}\` with {sessionId, target} *before* the tool call and this`,
    `round trip disappears.`,
  ].join('\n');
}

export function explainMismatch(
  ticket: string,
  tool: string,
  target: string,
  error: string,
): string {
  return [
    `[let-me-explain] Your explanation did not match what you then tried to do to ${target}.`,
    `${error}`,
    ``,
    `Call \`${tool}\` again with ticket: "${ticket}" and notes for the lines this change actually`,
    `has, then retry the tool call.`,
  ].join('\n');
}

export const LEARNER_IS_TRYING = [
  `[let-me-explain] The learner is typing this one themselves, to learn it.`,
  ``,
  `Call the let_me_try tool with this file as \`target\`. It opens a tutorial beside the file`,
  `in their editor and returns when they are done, with what they wrote.`,
  `Do not retry this edit and do not write the file yourself.`,
].join('\n');
export function stillTyping(target: string): string {
  return [
    `[let-me-explain] The learner is still typing ${target}.`,
    ``,
    `Say nothing and retry this exact tool call to keep waiting. Do not write the file.`,
  ].join('\n');
}

export function learnerAlreadyWrote(target: string): string {
  return [
    `[let-me-explain] The learner already typed ${target} themselves — this is that same change.`,
    ``,
    `Do not write the file. Their version is on disk and is the one that counts.`,
    `If you have feedback on it, say it in chat.`,
  ].join('\n');
}

/**
 * The handback. Delivered either as a deny reason or, when the write could be
 * neutralised, as `additionalContext`.
 *
 * Phrased as statements rather than commands on purpose: Claude Code wraps
 * `additionalContext` in a system reminder, and text that reads like an
 * out-of-band instruction trips the model's prompt-injection defences — it then
 * surfaces the text to the user instead of acting on it. Measured: a probe
 * worded as an order was refused outright.
 */
export function learnerFinished(
  target: string,
  learnerWrote: string,
  agentIntended: string,
  opts: { ran: boolean } = { ran: false },
): string {
  return [
    `[let-me-explain] The learner typed ${target} themselves. What is on disk is theirs.`,
    ``,
    `--- what they wrote ---`,
    learnerWrote,
    ``,
    `--- what you intended ---`,
    agentIntended,
    ``,
    `Their version is the one that counts, and the file needs no further writing.`,
    opts.ran
      ? `The write you just made was replaced with their content, so the file is unchanged.`
      : `Do not retry this edit.`,
    `A short, kind comparison helps them: what matches, what differs, and whether`,
    `theirs is a different valid choice rather than wrong.`,
  ].join('\n');
}
